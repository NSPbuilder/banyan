/**
 * Export and restore EVERY company in a database, and say what came back.
 *
 *   createdb erp_restore_dryrun
 *   pg_dump -Fc "$DATABASE_URL" | pg_restore -d erp_restore_dryrun
 *   npm run db:restore-dryrun
 *
 * WHY THIS EXISTS. Five restores in a row failed on the owner's real books
 * while the suite was green (2026-09-07), because the suite restored a
 * company somebody had invented and the owner's books are a company that
 * grew. A round trip over made-up rows says what the code does; a round trip
 * over the real ones says whether the feature works.
 *
 * TWO MODES, because a backup is for restoring SOMEWHERE ELSE:
 *
 *   npm run db:restore-dryrun -- --save=<dir>
 *     write every company to a .fig file. Read-only; safe anywhere.
 *
 *   npm run db:restore-dryrun -- --load=<dir>
 *     restore every file in that directory into THIS database. Point it at a
 *     database holding nothing but the migrations and it is the real thing:
 *     a machine that has never seen these books.
 *
 * With no argument it does both in one database, which is the weaker test —
 * every id it looks for is already there.
 *
 * REFUSES ANY DATABASE NOT NAMED `*_dryrun`. It creates companies and does
 * not clean them up — a restored company holds posted entries, and nothing
 * in this system deletes those (`deleteCompany` refuses, correctly). So it
 * runs on a copy, and the copy is thrown away.
 */
import { BACKUP_ACCEPT, BACKUP_EXT } from '../src/lib/backup-name'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { exportCompany, packFigtree, readFigtree, restoreCompany } from '../src/lib/backup'
import { trialBalance } from '../src/lib/balances'

const line = (r: ReadonlyArray<{ code: string; debit: string; credit: string; balance: string }>) =>
  r.map((x) => `${x.code}:${x.debit}/${x.credit}/${x.balance}`).join(' ')

/** Every message in the chain: the driver wraps the refusal and the name is under it. */
function why(e: unknown): string {
  const chain: string[] = []
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    const err = cur as { message?: string; constraint_name?: string; cause?: unknown }
    if (err.constraint_name) chain.push(err.constraint_name)
    else if (err.message) chain.push(err.message.split('\n')[0])
    cur = err.cause
  }
  return chain.join(' | ')
}

async function main() {
  const [where] = await db.execute<{ db: string }>(raw`SELECT current_database() AS db`)
  if (!where.db.endsWith('_dryrun')) {
    console.error(`Refusing: this is ${where.db}. A dry run creates companies and cannot tidy `
      + 'them away, so it only runs on a database whose name ends in _dryrun.')
    await conn.end()
    process.exit(1)
  }

  const arg = (name: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  const saveTo = arg('save')
  const loadFrom = arg('load')

  // ---- save: every company to a file, and nothing else -------------------
  if (saveTo) {
    mkdirSync(saveTo, { recursive: true })
    const all = await db.execute<{ id: string; code: string; name: string }>(raw`
      SELECT id::text, code, name FROM entity ORDER BY code`)
    for (const co of all) {
      const doc = await exportCompany(co.id)
      writeFileSync(join(saveTo, `${co.code}${BACKUP_EXT}`), await packFigtree(doc))
      console.log(`saved ${co.code} ${co.name} — `
        + `${Object.values(doc.counts).reduce((a, b) => a + b, 0)} rows`)
    }
    await conn.end()
    return
  }

  // ---- load: every file into this database, which may be a fresh one -----
  if (loadFrom) {
    let failed = 0
    // Both names: a folder of backups taken before the rename is still a folder
    // of backups.
    for (const f of readdirSync(loadFrom)
      .filter((x) => BACKUP_ACCEPT.split(',').some((e) => x.endsWith(e)))) {
      try {
        const doc = readFigtree(readFileSync(join(loadFrom, f)))
        const made = await restoreCompany(doc, 'dry-run')
        const back = await exportCompany(made.entityId)
        const differing = Object.keys(doc.counts).filter((t) => doc.counts[t] !== back.counts[t])
        if (differing.length === 0) {
          console.log(`OK    ${f.padEnd(28)} ${made.code} ${made.name} — `
            + `${Object.values(back.counts).reduce((a, b) => a + b, 0)} rows`)
        } else {
          failed++
          console.log(`DIFF  ${f.padEnd(28)} ${differing.map((t) => `${t} ${doc.counts[t]}→${back.counts[t]}`).join(', ')}`)
        }
      } catch (e) {
        failed++
        console.log(`FAIL  ${f.padEnd(28)} ${why(e).slice(0, 170)}`)
      }
    }
    console.log(failed === 0
      ? '\nEvery file restored into a database that had never seen these books.'
      : `\n${failed} file(s) did not.`)
    await conn.end()
    process.exit(failed === 0 ? 0 : 1)
  }

  const companies = await db.execute<{ id: string; code: string; name: string }>(raw`
    SELECT id::text, code, name FROM entity WHERE code NOT LIKE '%-DR' ORDER BY code`)
  console.log(`${companies.length} company(ies) in ${where.db}\n`)

  let bad = 0
  for (const co of companies) {
    const label = `${co.code} ${co.name}`.slice(0, 34)
    try {
      const doc = await exportCompany(co.id)
      const read = readFigtree(await packFigtree(doc))
      const rows = Object.values(doc.counts).reduce((a, b) => a + b, 0)

      const lastPeriod = async (ledgerId: string | null) => {
        if (!ledgerId) return null
        const [p] = await db.execute<{ id: string }>(raw`
          SELECT id::text FROM fiscal_period WHERE ledger_id = ${ledgerId}::uuid
           ORDER BY start_date DESC LIMIT 1`)
        return p?.id ?? null
      }
      const [led] = await db.execute<{ id: string }>(raw`
        SELECT id::text FROM ledger WHERE entity_id = ${co.id}::uuid ORDER BY is_primary DESC LIMIT 1`)
      const beforeP = await lastPeriod(led?.id ?? null)
      const tbBefore = beforeP ? await trialBalance(led.id, beforeP) : []

      const made = await restoreCompany(read, 'dry-run', {
        code: `${co.code}-DR`.slice(0, 12), name: `${co.name} (dry run)`,
      })
      const after = await exportCompany(made.entityId)
      const differing = Object.keys(doc.counts).filter((t) => doc.counts[t] !== after.counts[t])
      const afterP = await lastPeriod(made.ledgerId)
      const tbAfter = afterP && made.ledgerId ? await trialBalance(made.ledgerId, afterP) : []
      const sameTb = line(tbBefore) === line(tbAfter)

      if (differing.length === 0 && sameTb) {
        console.log(`OK    ${label.padEnd(34)} ${rows} rows, ${tbBefore.length} accounts, trial balance identical`)
      } else {
        bad++
        console.log(`DIFF  ${label.padEnd(34)} `
          + (differing.length ? `tables: ${differing.map((t) => `${t} ${doc.counts[t]}→${after.counts[t]}`).join(', ')}` : '')
          + (sameTb ? '' : ' trial balance DIFFERS'))
      }
    } catch (e) {
      bad++
      console.log(`FAIL  ${label.padEnd(34)} ${why(e).slice(0, 180)}`)
    }
  }
  console.log(bad === 0
    ? '\nEvery company exported and restored, row for row.'
    : `\n${bad} company(ies) did not.`)
  await conn.end()
  process.exit(bad === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

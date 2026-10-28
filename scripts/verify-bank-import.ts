/**
 * Bank rows landing in the database, and the guards that stop the same
 * statement from arriving twice — or from arriving once when it happened twice.
 *   npm run db:verify-bank-import   (resets the database first)
 *
 * The pair that matters and is easy to get half right: importing the same file
 * again must add nothing, AND a file that genuinely contains two identical rows
 * must add both. A rule that rejects everything passes the first on its own.
 */
import './env'
import { cleanupWith, errorText, expectCode, expectDbRefusal, reporter } from './suite'
import { byHand } from './by-hand'
import { execFileSync } from 'node:child_process'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { accountStandings } from '../src/lib/bank'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { postEntry, saveDraft } from '../src/lib/posting'
import { importAccounts } from '../src/lib/accounts'
import {
  MAX_IMPORT_ROWS, bankRows, bankTotals, ignoreBankRow, importBankRows,
  importableAccounts, unignoreBankRow, withOccurrences, type ImportRow,
} from '../src/lib/bank'
import { accountInLedger } from '../src/lib/bank'
import { applyMapping, parseCsv } from '../src/lib/bank-csv'
import { formatMoney } from '../src/lib/money'
import { rowsFromField, rowsToField, WireError } from '../src/lib/bank-wire'
import { importBankFromForm } from '../src/lib/bank-forms'

const r = reporter(54)
const { pass, fail, check } = r

/** Drizzle wraps a driver error as "Failed query" and keeps the real one on `cause`. */

const expectDbError = expectDbRefusal(r, { passSlice: 78, failSlice: 150 })

/**
 * Putting state back afterwards, without taking the suite down with it.
 *
 * Three times now a check has been guarded and the line that restored the state
 * after it has not, so a mutation that broke the guard threw on the cleanup and
 * killed the run: I27b, then I28, then I53 — each fixed one at a time while the
 * next one was being written with the same shape.
 *
 * Every restore goes through here now, and a restore that cannot happen is a
 * named failure rather than the end of the run.
 *
 * It closes the restores and only the restores. A mutation that breaks the
 * import path itself still ends the run at the first bare `importBankRows` or
 * `db.execute` — blocks 64 and 66 both do, and both say so in their own prose.
 * Nothing useful follows a fixture that cannot be built, so those are left
 * alone; what is not left alone is a block quietly recording fewer failures
 * than it caused.
 */
const cleanup = cleanupWith(r)

/** The fragment of a wrapped driver error that names the guard, if it is there. */
function guardNamed(e: unknown, fragment: string): string {
  const m = errorText(e)
  return m.split(' | ').find((p) => p.includes(fragment))?.split('\n')[0].slice(0, 84) ?? m.slice(0, 84)
}

const expectError = expectCode(r, { passSlice: 76 })

const CHART = `code,name,type,parent,roles
1000,Cash — Operating,asset,,cash_and_cash_equivalents
1010,Cash — Savings,asset,,cash_and_cash_equivalents
1900,Bank accounts,asset,,
4000,Consulting Revenue,revenue,,revenue_from_contracts`

const row = (date: string, amount: bigint, description: string): ImportRow =>
  ({ date, amount, description })

/**
 * A suite that reports on a broken program must not die because the program is
 * broken. `verify-bank-csv.ts` learned this last round; this file was written
 * after it and without it, and the very first mutation run proved the point —
 * breaking the numbering made an import throw, `main` died with a stack trace
 * and no summary line, and the generator correctly refused to record the block.
 */
async function main() {
  try {
    await body()
  } catch (e) {
    fail('the suite threw before it finished', errorText(e).slice(0, 110))
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

async function body() {
  const acme = await createCompany({ code: 'ACME', name: 'Acme Consulting Inc.', province: 'BC' }, 'alicio@example.test')
  await createFiscalYear(acme.ledger.id, '2026-12-31', 'alicio@example.test')

  const chart = await importAccounts(acme.company.id, CHART.split('\n').slice(1).map((l) => {
    const [code, name, accountType] = l.split(',')
    return { entityId: acme.company.id, code, name, accountType: accountType as 'asset' }
  }), 'alicio@example.test')

  const cash = chart.find((a) => a.code === '1000')!
  const savings = chart.find((a) => a.code === '1010')!
  const heading = chart.find((a) => a.code === '1900')!

  await byHand((tx) => tx.execute(raw`UPDATE account SET is_postable = false WHERE id = ${heading.id}::uuid`))
  const inactive = chart.find((a) => a.code === '4000')!
  await byHand((tx) => tx.execute(raw`UPDATE account SET is_active = false WHERE id = ${inactive.id}::uuid`))

  const countFor = async (accountId: string) =>
    Number((await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM bank_transaction WHERE account_id = ${accountId}::uuid`))[0].n)

  // ------------------------------------------------------------- numbering --

  {
    const a = row('2026-01-05', -475n, 'COFFEE')
    const b = row('2026-01-06', -1200n, 'LUNCH')
    const numbers = withOccurrences([a, b, a]).map((r) => r.occurrence)
    check(numbers.join(',') === '1,1,2', 'I01 identical rows are numbered within their own group',
      numbers.join(','))

    // Discriminating half — and it has to assert something the code PRODUCED.
    // The first version compared against a hard-coded 1,2,3, which is a fact
    // about counting and not about `withOccurrences`: it could only go red when
    // the check above it already had, and its own output printed both sides as
    // the same string.
    //
    // The property that separates the two numberings: the largest occurrence is
    // the size of the biggest group, never the length of the file.
    const c = row('2026-01-07', -900n, 'PARKING')
    const spread = withOccurrences([a, b, c, a]).map((r) => r.occurrence)
    check(Math.max(...spread) === 2,
      'I02 and the biggest number is the biggest group, not the file length',
      `${spread.join(',')} over 4 rows whose largest group is 2`)

    // The members of a group are identical, so their order cannot matter.
    const shuffled = withOccurrences([a, a, b]).map((r) => r.occurrence)
    check(shuffled.join(',') === '1,2,1', 'I03 and the order the file happened to be in does not matter',
      shuffled.join(','))
  }

  // ------------------------------------------------------------ duplicates --

  const STATEMENT: ImportRow[] = [
    row('2026-01-05', -47500n, 'HYDRO'),
    row('2026-01-06', 320000n, 'PAYROLL DEPOSIT'),
    row('2026-01-07', -1695n, 'MONTHLY FEE'),
  ]

  {
    const first = await importBankRows({ accountId: cash.id, rows: STATEMENT, sourceFile: 'jan.csv', actor: 'alicio@example.test' })
    check(first.inserted === 3 && first.duplicates === 0, 'I04 a statement lands',
      `${first.inserted} in, ${first.duplicates} skipped`)

    const again = await importBankRows({ accountId: cash.id, rows: STATEMENT, sourceFile: 'jan.csv', actor: 'alicio@example.test' })
    check(again.inserted === 0 && again.duplicates === 3, 'I05 the same file again lands nothing',
      `${again.inserted} in, ${again.duplicates} skipped`)
    check(await countFor(cash.id) === 3, 'I06 and the account still holds three rows',
      String(await countFor(cash.id)))
  }

  {
    // The other half, and the reason a plain fingerprint cannot do this job: a
    // statement really can contain the same transaction twice.
    const twice = [row('2026-02-01', -475n, 'COFFEE'), row('2026-02-01', -475n, 'COFFEE')]
    const landed = await importBankRows({ accountId: cash.id, rows: twice, actor: 'alicio@example.test' })
    check(landed.inserted === 2, 'I07 two identical transactions both land', `${landed.inserted} in`)

    const repeat = await importBankRows({ accountId: cash.id, rows: twice, actor: 'alicio@example.test' })
    check(repeat.inserted === 0 && repeat.duplicates === 2,
      'I08 and importing that file again lands neither', `${repeat.duplicates} skipped`)

    // A third coffee appears in a later statement covering the same day.
    const thrice = [...twice, row('2026-02-01', -475n, 'COFFEE')]
    const third = await importBankRows({ accountId: cash.id, rows: thrice, actor: 'alicio@example.test' })
    check(third.inserted === 1 && third.duplicates === 2,
      'I09 a later file with one more copy lands exactly one', `${third.inserted} in`)
  }

  {
    // Statements overlap: February's file repeats the last days of January.
    const overlap = [
      row('2026-01-07', -1695n, 'MONTHLY FEE'),      // already landed
      row('2026-01-09', -8820n, 'INSURANCE'),        // new
    ]
    const r = await importBankRows({ accountId: cash.id, rows: overlap, actor: 'alicio@example.test' })
    check(r.inserted === 1 && r.duplicates === 1, 'I10 an overlapping statement lands only what is new',
      `${r.inserted} in, ${r.duplicates} skipped`)
  }

  {
    // Descriptions are optional in the reader, so two undescribed rows on the
    // same day for the same amount must still be told apart. If `description`
    // were nullable this would silently import twice every time, because two
    // NULLs never collide in Postgres.
    const blank = [row('2026-03-01', -100n, ''), row('2026-03-01', -100n, '')]
    const a = await importBankRows({ accountId: cash.id, rows: blank, actor: 'alicio@example.test' })
    const b = await importBankRows({ accountId: cash.id, rows: blank, actor: 'alicio@example.test' })
    check(a.inserted === 2 && b.inserted === 0,
      'I11 undescribed rows still deduplicate', `first ${a.inserted}, again ${b.inserted}`)
  }

  {
    // The same rows land separately for a different account, which is the point
    // of scoping uniqueness to the account.
    const r = await importBankRows({ accountId: savings.id, rows: STATEMENT, actor: 'alicio@example.test' })
    check(r.inserted === 3, 'I12 the same statement lands again for a different account',
      `${r.inserted} in`)
  }

  // ----------------------------------------------------------------- gaps --

  {
    const before = await countFor(savings.id)
    await expectDbError('I13 a row numbered 2 with no 1 before it is refused', 'OCCURRENCE_GAP', () =>
      byHand((tx) => tx.execute(raw`
        INSERT INTO bank_transaction (account_id, txn_date, amount, description, occurrence, imported_by)
        VALUES (${savings.id}::uuid, '2026-05-01', -900, 'GAP', 2, 'alicio@example.test')`)))
    check(await countFor(savings.id) === before, 'I14 and nothing was left behind',
      `${await countFor(savings.id)} rows`)

    // The pair: with 1 there, 2 is fine. Without this, a rule that refused every
    // occurrence above 1 would pass I13 and break every repeated transaction.
    await byHand((tx) => tx.execute(raw`
      INSERT INTO bank_transaction (account_id, txn_date, amount, description, occurrence, imported_by)
      VALUES (${savings.id}::uuid, '2026-05-01', -900, 'GAP', 1, 'alicio@example.test'),
             (${savings.id}::uuid, '2026-05-01', -900, 'GAP', 2, 'alicio@example.test')`))
    check(await countFor(savings.id) === before + 2, 'I15 but 2 is fine once 1 is there',
      `${await countFor(savings.id)} rows`)
  }

  {
    // All or nothing. The batch below holds one perfectly good row and one with
    // a gap, and neither survives — because the import is one transaction. Not
    // because the trigger is DEFERRABLE: that is defensive against an insert
    // order `withOccurrences` never produces, and nothing here exercises it.
    const before = await countFor(savings.id)
    await expectDbError('I16 a batch with one bad row lands none of it', 'OCCURRENCE_GAP', () =>
      db.transaction(async (tx) => {
        await tx.execute(raw`
          INSERT INTO bank_transaction (account_id, txn_date, amount, description, occurrence, imported_by)
          VALUES (${savings.id}::uuid, '2026-06-01', -100, 'GOOD', 1, 'alicio@example.test'),
                 (${savings.id}::uuid, '2026-06-02', -200, 'BAD',  2, 'alicio@example.test')`)
      }))
    check(await countFor(savings.id) === before, 'I17 and the good row went back with it',
      `${await countFor(savings.id)} rows`)
  }

  // --------------------------------------------------------------- account --

  await expectDbError('I18 a heading account cannot hold a statement', 'NOT_POSTABLE', () =>
    importBankRows({ accountId: heading.id, rows: STATEMENT, actor: 'alicio@example.test' }))
  await expectDbError('I19 nor can an inactive one', 'INACTIVE_ACCOUNT', () =>
    importBankRows({ accountId: inactive.id, rows: STATEMENT, actor: 'alicio@example.test' }))

  {
    const offered = await importableAccounts(acme.company.id)
    const codes = offered.map((a) => a.code).join(',')
    check(codes === '1000,1010', 'I20 and neither is offered for import', codes)
    check(offered.find((a) => a.code === '1000')?.landed === '9',
      'I21 the offer says how much has already landed',
      offered.find((a) => a.code === '1000')?.landed ?? '?')
  }

  // ------------------------------------------------------------ immutable --

  const [firstRow] = await bankRows(cash.id)

  await expectDbError('I22 the amount on a bank row cannot be changed', 'BANK_ROW_IMMUTABLE', () =>
    byHand((tx) => tx.execute(raw`UPDATE bank_transaction SET amount = 1 WHERE id = ${firstRow.id}::uuid`)))
  await expectDbError('I23 nor the date', 'BANK_ROW_IMMUTABLE', () =>
    byHand((tx) => tx.execute(raw`UPDATE bank_transaction SET txn_date = '2020-01-01' WHERE id = ${firstRow.id}::uuid`)))
  await expectDbError('I24 nor the description', 'BANK_ROW_IMMUTABLE', () =>
    byHand((tx) => tx.execute(raw`UPDATE bank_transaction SET description = 'edited' WHERE id = ${firstRow.id}::uuid`)))
  await expectDbError('I25 nor which account it came from', 'BANK_ROW_IMMUTABLE', () =>
    byHand((tx) => tx.execute(raw`UPDATE bank_transaction SET account_id = ${savings.id}::uuid WHERE id = ${firstRow.id}::uuid`)))

  {
    // The pair: what WE decide about the row is ours to change, or the guard
    // would just be "this table is read-only" and the feature could not exist.
    await ignoreBankRow(firstRow.id, 'a transfer between my own accounts', 'alicio@example.test')
    // Re-read BY ID, not "the first row of the account". With immutability
    // disabled the check above moves this row to another account, and reading
    // by position then silently tested a different row.
    const after = (await bankRows(cash.id)).find((r) => r.id === firstRow.id)
      ?? (await bankRows(savings.id)).find((r) => r.id === firstRow.id)
    check(after?.state === 'ignored', 'I26 but ignoring it is ours and can change',
      after?.state ?? 'the row moved and could not be found')
    check(after?.ignored_reason === 'a transfer between my own accounts',
      'I26b and the reason is kept with it', after?.ignored_reason ?? 'none')
  }

  await expectError('I26c ignoring without saying why is refused', 'NO_REASON', () =>
    ignoreBankRow(firstRow.id, '  ', 'alicio@example.test'))

  // --------------------------------------------------------------- delete --

  await expectDbError('I27 an ignored row cannot be deleted', 'BANK_ROW_IGNORED', () =>
    byHand((tx) => tx.execute(raw`DELETE FROM bank_transaction WHERE id = ${firstRow.id}::uuid`)))

  let deletedDescription = ''

  {
    // Pick a row that is actually there. Reusing `firstRow` meant that a
    // mutation which let the delete above succeed killed the suite here instead
    // of failing this check.
    const [target] = (await bankRows(cash.id)).filter((r) => r.state === 'unmatched')
    const before = await countFor(cash.id)
    deletedDescription = target.description
    await byHand((tx) => tx.execute(raw`DELETE FROM bank_transaction WHERE id = ${target.id}::uuid`))
    check(await countFor(cash.id) === before - 1, 'I28 but an unmatched one can be',
      `${await countFor(cash.id)} rows`)

    // And it comes back on the next import, because deleting it also deleted
    // the memory that it had been seen.
    const back = await importBankRows({ accountId: cash.id, rows: STATEMENT, actor: 'alicio@example.test' })
    check(back.inserted >= 1, 'I29 and re-importing brings that row back', `${back.inserted} in`)
  }

  // ---------------------------------------------------------------- audit --

  {
    const [ignored] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM audit_log WHERE action = 'bank_row_ignored'`)
    check(Number(ignored.n) >= 1, 'I30 setting a row aside is audited', `${ignored.n} rows`)

    const [del] = await db.execute<{ n: string; before: unknown }>(raw`
      SELECT count(*)::text AS n, min(before::text) AS before
        FROM audit_log WHERE action = 'bank_row_delete'`)
    // Against the row that was actually deleted, not against a description
    // hard-coded here — which quietly stopped matching the moment the check
    // above chose its victim differently.
    check(Number(del.n) === 1 && String(del.before).includes(deletedDescription),
      'I31 and so is a deletion, with what was deleted',
      `looking for "${deletedDescription}" in ${String(del.before).slice(0, 52)}`)

    const [imp] = await db.execute<{ n: string; after: string }>(raw`
      SELECT count(*)::text AS n, max(after::text) AS after
        FROM audit_log WHERE action = 'import_bank_rows'`)
    check(Number(imp.n) >= 6 && imp.after.includes('"inserted"'),
      'I32 and every import writes one row with its counts', `${imp.n} imports, last ${imp.after}`)
  }

  // ------------------------------------------------------------------ api --

  await expectError('I33 an empty import is refused', 'EMPTY', () =>
    importBankRows({ accountId: cash.id, rows: [], actor: 'alicio@example.test' }))
  await expectError('I34 an unknown account is refused', 'NO_ACCOUNT', () =>
    importBankRows({
      accountId: '00000000-0000-0000-0000-000000000000',
      rows: STATEMENT, actor: 'alicio@example.test',
    }))
  await expectError('I35 a file over the limit is refused before anything is written', 'TOO_MANY', () =>
    importBankRows({
      accountId: cash.id,
      rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) =>
        row('2026-09-01', BigInt(-i - 1), `ROW ${i}`)),
      actor: 'alicio@example.test',
    }))

  {
    const totals = await bankTotals(cash.id)
    const [check1] = await db.execute<{ s: bigint }>(raw`
      SELECT coalesce(sum(amount), 0)::bigint AS s FROM bank_transaction WHERE account_id = ${cash.id}::uuid`)
    check(typeof totals.net === 'bigint' && totals.net === check1.s,
      'I36 the total is money, not a string', `${typeof totals.net} ${totals.net}`)

    // The filter has to be given something to filter. Every row was unmatched
    // when this first ran, so a `bankRows` that ignored `opts.state` entirely
    // would have passed it.
    const [odd] = (await bankRows(cash.id)).filter((r) => r.state === 'unmatched')
    await ignoreBankRow(odd.id, 'a duplicate the bank reversed', 'alicio@example.test')
    const unmatched = await bankRows(cash.id, { state: 'unmatched' })
    const all = await bankRows(cash.id)
    // Counted, not assumed to be one: an earlier check leaves a row ignored too,
    // and hard-coding "all minus one" made this fail for a reason that had
    // nothing to do with the filter.
    const ignored = all.filter((r) => r.state === 'ignored').length
    check(ignored >= 2 && unmatched.length === all.length - ignored
      && all.length === totals.rows && !unmatched.some((r) => r.id === odd.id),
      'I37 and the state filter really narrows',
      `${unmatched.length} unmatched, ${ignored} ignored, ${all.length} in all`)
    await cleanup('un-ignore the filtered row', () => unignoreBankRow(odd.id))
  }

  // ----------------------------------------------------- what cannot be caught --

  {
    // What the database DOES catch about numbering by file position. Three
    // distinct rows numbered 1, 2, 3 leave 2 and 3 with nothing below them in
    // their own groups, and the whole import is refused.
    //
    // This half exists because the claim was written too broadly twice: first
    // that the check stops this bug (it does not stop all of it), then that it
    // stops none of it (it stops most of it).
    const positional = (rows: Array<[string, bigint, string]>) => byHand((tx) => tx.execute(raw`
      INSERT INTO bank_transaction (account_id, txn_date, amount, description, occurrence, imported_by)
      VALUES ${raw.join(rows.map(([d, a, t], i) =>
        raw`(${savings.id}::uuid, ${d}::date, ${a}::bigint, ${t}, ${i + 1}::smallint, 'probe')`), raw`, `)}`))

    await expectDbError('I52 file-order numbering is normally refused', 'OCCURRENCE_GAP', () =>
      positional([['2026-11-01', -100n, 'A'], ['2026-11-02', -200n, 'B'], ['2026-11-03', -300n, 'C']]))

    // And the one shape it cannot refuse. Monday's file is [RENT]; Tuesday's is
    // [MISC, RENT], so RENT is numbered 2 — and 1 is already taken, by the
    // import of the very row now being duplicated. No gap to object to, and the
    // INSERT is identical to the one two real coffees produce.
    //
    // Driven as two imports, the way it actually happens. Asserting the
    // duplicate lands is the point: correct numbering is the only defence,
    // which is what I01 and I02 are for. RISKS #20.
    const RENT: [string, bigint, string] = ['2026-11-10', -200000n, 'RENT']
    await importBankRows({
      accountId: savings.id,
      rows: [row(RENT[0], RENT[1], RENT[2])],
      actor: 'alicio@example.test',
    })
    await positional([['2026-11-11', -500n, 'MISC'], RENT])
    const [n] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM bank_transaction
       WHERE account_id = ${savings.id}::uuid AND description = 'RENT'`)
    check(n.n === '2', 'I52b (known gap) but not when every row has its predecessor',
      `${n.n} RENT rows where the statements held 1`)

    // A file whose rows do NOT all find their predecessors is refused whole,
    // twin or no twin — an import is one transaction.
    //
    // This is not "the boundary": where the duplicate sits in the file decides
    // nothing. What decides is whether the account already holds the
    // predecessors, which I52e shows.
    const RENT2: [string, bigint, string] = ['2026-11-20', -200000n, 'RENT2']
    await importBankRows({
      accountId: savings.id, rows: [row(RENT2[0], RENT2[1], RENT2[2])], actor: 'alicio@example.test',
    })
    await expectDbError('I52c and one gap anywhere still refuses the whole file', 'OCCURRENCE_GAP', () =>
      positional([['2026-11-21', -500n, 'MISC2'], RENT2, ['2026-11-22', -650n, 'LATTE']]))
    const [m] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM bank_transaction
       WHERE account_id = ${savings.id}::uuid AND description = 'RENT2'`)
    check(m.n === '1', 'I52d and the row with a twin below it went back too', `${m.n} RENT2 row`)
  }

  {
    // What the exposure actually is, and it is not one row at the end of a file.
    //
    // An account with a history of repeated transactions supplies the
    // predecessors a positionally-numbered file needs — and that is the ordinary
    // state of a real bank account, the case `occurrence` exists for. Here the
    // account holds one RENT and two genuine LATTEs, both landed through the
    // correct importer. A positional [MISC, RENT, LATTE] is then accepted whole
    // and lands TWO duplicates, in the middle of the file.
    //
    // Three earlier wordings of this said the duplicate had to be last, or that
    // only one landed. RISKS #20.
    const R: [string, bigint, string] = ['2027-01-01', -200000n, 'HIST RENT']
    const L: [string, bigint, string] = ['2027-01-03', -650n, 'HIST LATTE']
    await importBankRows({ accountId: cash.id, rows: [row(...R)], actor: 'alicio@example.test' })
    await importBankRows({ accountId: cash.id, rows: [row(...L), row(...L)], actor: 'alicio@example.test' })

    // Counted on the two rows that were already there. The file also brings a
    // new HIST MISC, which is not a duplicate of anything.
    const tally = async () => {
      const r = await db.execute<{ d: string; n: string }>(raw`
        SELECT description AS d, count(*)::text AS n FROM bank_transaction
         WHERE account_id = ${cash.id}::uuid AND description IN ('HIST RENT', 'HIST LATTE')
         GROUP BY description ORDER BY description`)
      return r.map((x) => `${x.d}=${x.n}`).join(', ')
    }
    const before = await tally()

    await byHand((tx) => tx.execute(raw`
      INSERT INTO bank_transaction (account_id, txn_date, amount, description, occurrence, imported_by)
      VALUES ${raw.join([['2027-01-02', -500n, 'HIST MISC'] as [string, bigint, string], R, L]
        .map(([d, a, t], i) =>
          raw`(${cash.id}::uuid, ${d}::date, ${a}::bigint, ${t}, ${i + 1}::smallint, 'probe')`), raw`, `)}`))

    const after = await tally()
    check(before === 'HIST LATTE=2, HIST RENT=1' && after === 'HIST LATTE=3, HIST RENT=2',
      'I52e (known gap) an account with history takes the whole file, duplicates and all',
      `${before}  ->  ${after}`)
  }

  {
    // 0019. Deleting the lower of two identical rows leaves the survivor above a
    // hole. That is allowed — re-importing the file puts the lower one back.
    //
    // But the gapless check used to fire on every UPDATE of that survivor, so it
    // could never be marked matched or ignored again: a row the whole feature
    // exists to reconcile, permanently unreconcilable, reported as a sentence
    // about re-reading the import file.
    const twin = row('2026-05-01', -475n, 'TWIN COFFEE')
    await importBankRows({ accountId: savings.id, rows: [twin, twin], actor: 'alicio@example.test' })
    const pair = (await bankRows(savings.id)).filter((r) => r.description === 'TWIN COFFEE')
    const lower = pair.find((r) => r.occurrence === 1)!
    const upper = pair.find((r) => r.occurrence === 2)!
    await byHand((tx) => tx.execute(raw`DELETE FROM bank_transaction WHERE id = ${lower.id}::uuid`))

    try {
      await ignoreBankRow(upper.id, 'probe: can this row be touched at all', 'alicio@example.test')
      const after = (await bankRows(savings.id)).find((r) => r.id === upper.id)
      check(after?.state === 'ignored', 'I53 a row left above a hole can still be updated',
        after?.state ?? 'gone')
    } catch (e) {
      // Name the guard, not Drizzle's wrapper. The recorded line read
      // "Failed query:" and nothing else, which is what any query failure looks
      // like — evidence that something broke, not evidence of what.
      fail('I53 a row left above a hole can still be updated',
        guardNamed(e, 'OCCURRENCE_GAP'))
    }
    await cleanup('un-ignore the survivor', () => unignoreBankRow(upper.id))
  }

  {
    // Splitting one statement into two imports loses a real transaction when the
    // split divides a group. Occurrence is computed per import, so part two's
    // only row is numbered 1 again and reads as a duplicate of part one's.
    //
    // Reachable through the app's own advice: the over-limit message says to
    // split the file. Splitting BY DATE RANGE, as it says, is safe — a group is
    // inside one date. Nothing enforces that, so it is written down. RISKS #20.
    const one = row('2026-12-01', -4200n, 'INTERAC')
    const partOne = await importBankRows({ accountId: savings.id, rows: [one], actor: 'alicio@example.test' })
    const partTwo = await importBankRows({ accountId: savings.id, rows: [one], actor: 'alicio@example.test' })
    const [n] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM bank_transaction
       WHERE account_id = ${savings.id}::uuid AND description = 'INTERAC'`)
    check(partOne.inserted === 1 && partTwo.inserted === 0 && n.n === '1',
      'I54 (known gap) a group split across two imports loses a row',
      `${n.n} landed where the statement had 2`)
  }

  {
    // An account from another company, posted with this company's ledger. The
    // dropdown never offers it; the value posted back is just a string.
    const other = await createCompany({ code: 'OTHER', name: 'Other Holdings Ltd.' }, 'alicio@example.test')
    const [otherCash] = await importAccounts(other.company.id,
      [{ entityId: other.company.id, code: '1000', name: 'Their cash', accountType: 'asset' }], 'alicio@example.test')

    check(await accountInLedger(cash.id, acme.ledger.id) === true
      && await accountInLedger(otherCash.id, acme.ledger.id) === false,
      'I55 an account is only in its own company\'s ledger',
      `own=${await accountInLedger(cash.id, acme.ledger.id)} other=${await accountInLedger(otherCash.id, acme.ledger.id)}`)

    const fd = new FormData()
    fd.set('ledgerId', acme.ledger.id)
    fd.set('accountId', otherCash.id)
    fd.set('rows', rowsToField([row('2026-10-01', -100n, 'CROSSED')]))
    const crossed = await importBankFromForm(fd, 'alicio@example.test')
    check(crossed.error === 'That account does not belong to this company.',
      'I56 and the form refuses to land a statement in another company',
      crossed.error ?? crossed.ok ?? 'no answer')
    const [n] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM bank_transaction WHERE description = 'CROSSED'`)
    check(n.n === '0', 'I57 and nothing was written', `${n.n} rows`)
  }

  // ----------------------------------------------------------- end to end --

  {
    const text = [
      'Date,Description,Amount',
      '2026-04-01,"PAYMENT, THANK YOU",-125.50',
      '2026-04-02,PAYROLL,3200.00',
      '2026-04-02,PAYROLL,3200.00',
    ].join('\n') + '\n'

    const grid = parseCsv(text, ',')
    const { rows: parsed } = applyMapping(grid, 0, {
      roles: ['date', 'description', 'amount'], order: 'ymd', flip: false,
    })
    const rows = parsed.map((r) => row(r.date, r.amount, r.description))

    const one = await importBankRows({ accountId: savings.id, rows, sourceFile: 'apr.csv', actor: 'alicio@example.test' })
    const two = await importBankRows({ accountId: savings.id, rows, sourceFile: 'apr.csv', actor: 'alicio@example.test' })
    check(one.inserted === 3 && two.inserted === 0,
      'I38 a real file read and landed, then landed again with no effect',
      `${one.inserted} then ${two.inserted}`)

    const landed = await bankRows(savings.id, { state: 'unmatched' })
    const payroll = landed.filter((r) => r.description === 'PAYROLL')
    check(payroll.length === 2 && payroll[0].amount === 320000n,
      'I39 and the two identical payroll lines are both there',
      `${payroll.length} rows of ${payroll[0]?.amount}`)
  }

  // ----------------------------------------------------------------- wire --

  {
    const rows = [row('2026-07-01', -123456789n, 'BIG, WITH A COMMA'), row('2026-07-02', 0n, '')]
    const back = rowsFromField(rowsToField(rows))
    check(back.length === 2 && back[0].amount === -123456789n && typeof back[0].amount === 'bigint'
      && back[0].description === 'BIG, WITH A COMMA' && back[1].amount === 0n,
      'I40 rows survive the trip to the server and back as money',
      `${typeof back[0].amount} ${back[0].amount}`)

    const bad = (text: string, code: string, label: string) => {
      try { rowsFromField(text); fail(label, 'it was accepted') }
      catch (e) {
        const err = e as WireError
        err.code === code ? pass(label, `-> ${err.message.slice(0, 70)}`)
                          : fail(label, `expected ${code}, got ${err.code}: ${err.message}`)
      }
    }
    // Dollars where cents are expected is the mistake that would land silently
    // if the amount were parsed with Number() instead of matched first.
    bad('[{"d":"2026-07-01","a":"12.50","t":"X"}]', 'BAD_PAYLOAD',
      'I41 dollars sent where cents belong are refused')
    bad('[{"d":"01/07/2026","a":"-100","t":"X"}]', 'BAD_PAYLOAD',
      'I42 and a date that is not ISO is refused')
    bad('not json at all', 'BAD_PAYLOAD', 'I43 and something that is not JSON')
    bad('{"d":"2026-07-01"}', 'BAD_PAYLOAD', 'I44 and something that is not a list')
    bad('[]', 'EMPTY', 'I45 and an empty list')
  }

  // ----------------------------------------------------------------- form --

  {
    const form = (accountId: string, rows: ImportRow[]) => {
      const fd = new FormData()
      fd.set('ledgerId', acme.ledger.id)
      fd.set('accountId', accountId)
      fd.set('sourceFile', 'form.csv')
      fd.set('rows', rowsToField(rows))
      return fd
    }
    const rows = [row('2026-08-01', -5000n, 'FORM ONE'), row('2026-08-02', 7500n, 'FORM TWO')]

    const first = await importBankFromForm(form(cash.id, rows), 'alicio@example.test')
    check(first.ok?.includes('2 rows saved') === true, 'I46 the form saves and says how many',
      first.ok ?? first.error ?? '')

    const again = await importBankFromForm(form(cash.id, rows), 'alicio@example.test')
    check(again.ok?.includes('0 rows saved') === true && again.ok?.includes('2 already there') === true,
      'I47 and the second time says how many it skipped', again.ok ?? again.error ?? '')

    const noAccount = await importBankFromForm(form('', rows), 'alicio@example.test')
    check(noAccount.error?.includes('Choose the account') === true,
      'I48 no account chosen is refused with a sentence', noAccount.error ?? 'no error')

    // The database guard has to arrive as something readable. Drizzle wraps the
    // driver error, so matching on `.message` alone would never see the
    // trigger's name and a stack trace would reach the screen instead.
    //
    // Caught rather than awaited bare: when the unwrapping is broken the handler
    // re-throws, and a check that dies proves its point only by killing the run.
    // This way the failure is recorded against the claim it belongs to.
    let headingRow: { error?: string; ok?: string }
    try {
      headingRow = await importBankFromForm(form(heading.id, rows), 'alicio@example.test')
    } catch (e) {
      headingRow = { error: `it threw instead of answering: ${errorText(e).slice(0, 50)}` }
    }
    check(headingRow.error === 'That is a heading account. Choose the account the statement is for.',
      'I49 and a heading account gives a sentence, not a stack trace',
      headingRow.error ?? 'no error')
  }

  // --------------------------------------------------------------- screen --

  {
    const rendered = JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-bank-screen.tsx',
      JSON.stringify({
        text: 'Date,Description,Amount\n2026-09-01,"PAID, THANKS",-125.50\n2026-09-02,PAYROLL,3200.00\n',
        order: 'ymd',
        accounts: [{ id: cash.id, code: '1000', name: 'Cash — Operating', account_type: 'asset', landed: '3' }],
      })], { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } },
    )) as {
      landFields: Record<string, string>; landAction: string | null
      accountOptions: string[]; rowCount: number
      previewRows: Array<{ date: string; description: string; amount: string }>
    }

    check(rendered.landAction === '/save' && rendered.accountOptions.includes(cash.id),
      'I50 the save form is bound to its action and offers the account',
      `${rendered.landAction}, ${rendered.accountOptions.length} options`)

    // What the form would post is what the preview SHOWS — the two sides read
    // from different places on purpose: the payload is parsed out of the hidden
    // field with the server's own reader, and the expectation is scraped out of
    // the rendered table a person looks at. Comparing the payload with the array
    // it was built from would be comparing a value with itself.
    const posted = rowsFromField(rendered.landFields.rows)
    const shown = rendered.previewRows
    const asShown = (cents: bigint) => formatMoney(cents)
    check(posted.length === shown.length
      && posted.every((r, i) => r.date === shown[i].date
        && r.description === shown[i].description
        && asShown(r.amount) === shown[i].amount),
      'I51 and it would post exactly the rows the preview shows',
      `${posted.length} posted vs ${shown.length} shown; first "${shown[0]?.amount}"`)
  }

  // I58 — THE CARDS SAY WHAT THEY MEAN. QuickBooks shows what the bank says
  //       beside what the books say; this system reads a CSV and has no bank
  //       to ask, so the pair is the BOOKS beside the last STATEMENT, and the
  //       gap is what is unreconciled. A card showing a figure this system
  //       cannot know would be a number that reads as fact (owner, 2026-09-10).
  {
    // A POSTED entry and a DRAFT, because the figure is about the difference:
    // a card sits beside a statement balance, inviting the two to be compared,
    // and a draft somebody is halfway through typing is not money yet.
    const other = chart.find((a) => a.code === '1010')!
    await postEntry({
      ledgerId: acme.ledger.id, entryDate: '2026-03-04', description: 'Posted, and real',
      actor: 'alicio@example.test',
      lines: [
        { accountId: cash.id, amount: 25000n },
        { accountId: other.id, amount: -25000n },
      ],
    })
    await saveDraft({
      ledgerId: acme.ledger.id, entryDate: '2026-03-05', description: 'Halfway through typing',
      actor: 'alicio@example.test',
      lines: [
        { accountId: cash.id, amount: 99000n },
        { accountId: other.id, amount: -99000n },
      ],
    })
    const standing = (await accountStandings(acme.company.id)).find((a) => a.id === cash.id)
    const [truth] = await db.execute<{ books: string }>(raw`
      SELECT COALESCE(SUM(jl.amount), 0)::text AS books FROM journal_line jl
        JOIN journal_entry je ON je.id = jl.entry_id
       WHERE jl.account_id = ${cash.id}::uuid AND je.status IN ('posted','reversed')`)
    check(!!standing && standing.books === BigInt(truth.books),
      'I58 an account card carries the posted books balance, and no draft',
      standing
        ? `${standing.code}: books ${standing.books}, statement ${standing.statement ?? 'none on file'}`
        : 'no card for the account')
  }
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

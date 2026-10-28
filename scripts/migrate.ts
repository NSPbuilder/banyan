/**
 * Applies db/migrations/*.sql in filename order, once each.
 * Safe to re-run: applied files are recorded in the _migration table.
 *   npm run db:migrate -- --database <exact verified database name>
 */
// ./dotenv, not ./env: ./env swaps in the TEST database, which would migrate
// the wrong one. reset.ts still points this at the test database explicitly by
// passing DATABASE_URL in the child environment, which dotenv leaves alone.
import './dotenv'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set — see .env.local')

const dir = join(process.cwd(), 'db', 'migrations')
// `CREATE TABLE IF NOT EXISTS _migration` raises a NOTICE on every run after
// the first, which postgres.js prints as a whole object — it reads like an error
// at the top of every migration, and a run that prints an error every time is a
// run nobody reads. Real notices still come through.
const sql = postgres(url, {
  max: 1,
  onnotice: (notice) => {
    if (notice.code === '42P07' && notice.message?.includes('_migration')) return
    console.log(`  ${notice.severity}: ${notice.message}`)
  },
})

/** Say which database, every time. Silence is how the wrong one goes unnoticed. */
const target = new URL(url).pathname.slice(1)

/**
 * `--dry-run` reports what would be applied and applies nothing.
 *
 * A check that runs the migrator to see where it points, and then asks whether
 * anything is pending, has just answered its own question: it applied them.
 */
const dryRun = process.argv.includes('--dry-run')
const confirmIndex = process.argv.indexOf('--database')
const confirmedTarget = confirmIndex < 0 ? undefined : process.argv[confirmIndex + 1]

async function main() {
  if (!dryRun && confirmedTarget !== target) {
    throw new Error(`Refusing migration without explicit database identity. Pass --database ${target} after verifying the target.`)
  }
  console.log(`Migrating ${target} ...${dryRun ? ' (dry run — nothing will be applied)' : ''}`)
  // On a dry run this must not create the table either, or the run has written
  // to the very database it promised to leave alone.
  const [{ exists: hasTable }] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass('public._migration') IS NOT NULL AS exists`

  if (dryRun && !hasTable) {
    console.log(`  ${target} has no _migration table — nothing has ever been applied here.`)
  }

  if (!dryRun) await sql`
    CREATE TABLE IF NOT EXISTS _migration (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`

  const rows = (dryRun && !hasTable)
    ? []
    : await sql<{ filename: string; checksum: string }[]>`SELECT filename, checksum FROM _migration`
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]))

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  let ran = 0

  for (const file of files) {
    const body = readFileSync(join(dir, file), 'utf8')
    const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16)
    const seen = applied.get(file)

    if (seen === checksum) continue
    if (seen && seen !== checksum) {
      throw new Error(
        `${file} has changed since it was applied.\n` +
        `Migrations are append-only: add a new file instead of editing this one.\n` +
        `(To rebuild a scratch database from zero: npm run db:reset)`,
      )
    }

    if (dryRun) {
      console.log(`  pending  ${file}`)
      ran++
      continue
    }

    process.stdout.write(`  applying ${file} ... `)
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`INSERT INTO _migration (filename, checksum) VALUES (${file}, ${checksum})`
    })
    console.log('ok')
    ran++
  }

  console.log(ran === 0
    ? `${target} is up to date — all ${files.length} migrations applied.`
    : dryRun
      ? `${ran} migration(s) pending on ${target}; ${files.length} in total. Nothing was applied.`
      : `Applied ${ran} migration(s) to ${target}; ${files.length} in total.`)
  await sql.end()
}

main().catch(async (e) => {
  console.error('\nMigration failed:', e.message)
  await sql.end()
  process.exit(1)
})

/**
 * Which database each command migrates, and whether the books are current.
 *   npm run db:check-migrations
 *
 * `npm run db:migrate` imported the module that swaps DATABASE_URL for the TEST
 * database, so it migrated erp_test, printed "Database is up to date", and left
 * the real books five migrations behind — with the constraints those migrations
 * add simply absent. The suites were all green throughout, because the suites
 * run against the database it was migrating.
 *
 * Runs against the REAL database on purpose, and writes nothing to it: the
 * state is read BEFORE the migrator is invoked at all, and the migrator is
 * invoked with --dry-run.
 *
 * The order matters and is the whole point. An earlier version ran the migrator
 * first and then asked whether anything was pending — which it had just
 * applied. M3 could not fail. That is the same defect this file exists to
 * catch, one level up.
 */
import './dotenv'
import { reporter } from './suite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'

const r = reporter(52)
const { pass, fail } = r

const nameOf = (url: string) => new URL(url).pathname.slice(1)

async function main() {
  const appUrl = process.env.DATABASE_URL!
  const testUrl = process.env.TEST_DATABASE_URL!
  const app = nameOf(appUrl)
  const test = nameOf(testUrl)

  const files = readdirSync(join(process.cwd(), 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql')).sort()

  // Read the state FIRST, before anything is given a chance to change it.
  const sql = postgres(appUrl, { max: 1 })
  const before = await sql<{ filename: string; checksum: string }[]>`
    SELECT filename, checksum FROM _migration ORDER BY filename`
  const applied = before.map((r) => r.filename)

  // M1 — the books have every migration on disk. Asked before the migrator
  //      runs, so it is a question about the world and not about this script.
  const missing = files.filter((f) => !applied.includes(f))
  missing.length === 0
    ? pass('M1 the books have every migration applied', `${applied.length} of ${files.length}`)
    : fail('M1 the books have every migration applied', `missing ${missing.join(' ')}`)

  // M2 — nothing applied that is not on disk either: a database ahead of the
  //      repository is a database nobody can rebuild.
  const extra = applied.filter((f) => !files.includes(f))
  extra.length === 0
    ? pass('M2 nothing applied that the repository does not have', 'rebuildable from zero')
    : fail('M2 nothing applied that the repository does not have', extra.join(' '))

  // M2b — every applied file still says what it said when it was applied.
  //
  //       This was missing, and its absence was demonstrated rather than
  //       imagined: an already-applied migration was edited, `db:migrate`
  //       refused with "has changed since it was applied", and this suite
  //       reported ALL CHECKS PASSED in the same minute. M1 counts files and M2
  //       counts rows; neither reads a byte of them. A suite about migrations
  //       that cannot tell an edited one from an untouched one is not checking
  //       the rule it is named after.
  const drifted = before.filter((r) => {
    const body = readFileSync(join(process.cwd(), 'db', 'migrations', r.filename), 'utf8')
    return createHash('sha256').update(body).digest('hex').slice(0, 16) !== r.checksum
  })
  drifted.length === 0
    ? pass('M2b applied migrations still match the files', `${before.length} checksums agree`)
    : fail('M2b applied migrations still match the files',
           drifted.map((r) => r.filename).join(' '))

  // M3 — the plain command touches the books, not the test database
  //
  // The dry run is allowed to FAIL. It exits non-zero whenever it refuses —
  // an edited migration, for one — and `execFileSync` throws on a non-zero
  // exit, which killed this whole suite before it could print a summary line.
  // A suite that dies reports a stack trace where a red check belongs, and
  // this file exists to check the thing that most often makes it refuse.
  // What M3 and M4 ask is which database it NAMED, and it names it either way.
  let out: string
  try {
    out = execFileSync('npx', ['tsx', 'scripts/migrate.ts', '--dry-run'], { encoding: 'utf8' })
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
  out.includes(`Migrating ${app} `) && !out.includes(`Migrating ${test} `)
    ? pass('M3 db:migrate targets the application database', app)
    : fail('M3 db:migrate targets the application database', out.trim().split('\n')[0])

  // M4 — and it says which one, every time. Silence is how this hid.
  const named = /Migrating \w+ \.\.\./.test(out)
  named
    ? pass('M4 it names the database before it acts', 'not "Database is up to date"')
    : fail('M4 it names the database before it acts', out)

  // M5 — the dry run left the books exactly as it found them
  const after = await sql<{ filename: string }[]>`SELECT filename FROM _migration ORDER BY filename`
  after.length === before.length && after.every((r, i) => r.filename === before[i].filename)
    ? pass('M5 asking the question did not answer it', `${after.length} rows before and after`)
    : fail('M5 asking the question did not answer it',
           `${before.length} rows before, ${after.length} after`)

  // M6 — the test path still goes to the test database. Fixing the targeting
  //      must not have pointed db:reset at the books.
  const resetSrc = readFileSync(join(process.cwd(), 'scripts', 'reset.ts'), 'utf8')
  resetSrc.includes('DATABASE_URL: testUrl')
    ? pass('M6 db:reset still migrates the test database', 'it passes DATABASE_URL explicitly')
    : fail('M6 db:reset still migrates the test database', 'reset.ts no longer overrides it')

  await sql.end()
  console.log(r.summary())
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })

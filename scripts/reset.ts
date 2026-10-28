/**
 * Drops and recreates the TEST database, then migrates. Destructive by design.
 *
 * The rule it enforces is not "this database looks empty" — a suite legitimately
 * leaves entries behind, and the next run must be able to drop them. The rule is
 * **this is provably not the database the application uses**:
 *
 *   TEST_DATABASE_URL must be set, must end in _test, and must differ from
 *   DATABASE_URL.
 *
 * The owner's real ledger lived in a database called `erp_dev`, and the earlier
 * version of this script accepted any name ending in _dev or _test. Every test
 * suite began with it. A name is a promise; this is a check.
 */
import './env'
import { execFileSync } from 'node:child_process'

import { pgTool } from '../src/lib/backup-paths'

const PSQL = pgTool('psql')

function refuse(reason: string, remedy: string): never {
  console.error(`Refusing to drop anything.\n\n${reason}\n\n${remedy}`)
  process.exit(1)
}

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL
  const appUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL

  if (!testUrl) {
    refuse(
      'TEST_DATABASE_URL is not set, so there is no database this is allowed to drop.',
      'Add one to .env.local, pointing at a database you keep nothing in:\n' +
      '  TEST_DATABASE_URL=postgresql://<user>@localhost:5432/erp_test')
  }

  const name = new URL(testUrl).pathname.slice(1)
  if (process.env.TEST_DATABASE_CONFIRMATION !== name) {
    refuse('The disposable test database has not been explicitly confirmed.',
      'Set TEST_DATABASE_CONFIRMATION to the exact name of a verified isolated disposable database.')
  }
  if (!/^[a-z][a-z0-9_]*_test$/.test(name)) {
    refuse(
      `TEST_DATABASE_URL points at "${name}", which does not end in _test.`,
      'The suites only ever run against a database named for that purpose.')
  }

  // The check that matters: the test database must not BE the application's.
  if (appUrl && new URL(testUrl).pathname === new URL(appUrl).pathname
      && new URL(testUrl).host === new URL(appUrl).host) {
    refuse(
      `TEST_DATABASE_URL and DATABASE_URL both point at "${name}".\n` +
      'That makes the test database the one the application keeps books in.',
      'Point them at different databases in .env.local.')
  }

  // There was a third check here: refuse if the test database held a company
  // with a CRA business number, on the theory that only real books would have
  // one. It was wrong, and it blocked the GST/HST suite, whose fixture needs a
  // business number because the return prints one.
  //
  // A guess about CONTENT cannot tell a fixture from real books — anything real
  // books can hold, a fixture can hold too, and it must, to be worth running.
  // What can be known is IDENTITY: this database is not the one the application
  // uses, and it is named for being disposable. Both are checked above, both
  // are structural, and neither has a false positive.
  //
  // A guard that blocks legitimate work gets worked around, and a guard that is
  // worked around protects nothing.

  const admin = new URL(testUrl)
  admin.pathname = '/postgres'

  console.log(`Dropping and recreating ${name} ...`)
  execFileSync(PSQL, ['-q','-d',admin.href,'-c',`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`], { stdio: 'inherit' })
  execFileSync(PSQL, ['-q','-d',admin.href,'-c',`CREATE DATABASE "${name}"`], { stdio: 'inherit' })
  execFileSync('npx', ['tsx','scripts/migrate.ts','--database',name], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: testUrl } })
}

main().catch((e) => { console.error(e.message); process.exit(1) })

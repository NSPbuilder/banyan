/**
 * Next.js loads .env.local automatically; standalone scripts do not.
 *
 * A test script must never reach the books, so when TEST_DATABASE_URL is set it
 * REPLACES DATABASE_URL for everything downstream — the db client included.
 * Nothing a suite does can then touch the real ledger, whatever it imports.
 */
import './dotenv'

const disposable = process.env.TEST_DATABASE_URL
if (!disposable || !/^[a-z][a-z0-9_]*_test$/.test(new URL(disposable).pathname.slice(1))
    || process.env.TEST_DATABASE_CONFIRMATION !== new URL(disposable).pathname.slice(1)) {
  throw new Error('Tests require TEST_DATABASE_URL and exact TEST_DATABASE_CONFIRMATION for a verified isolated disposable database.')
}
if (process.env.TEST_DATABASE_URL) {
  // Keep the application's own URL visible under another name, so reset.ts can
  // still compare the two and refuse when they are the same database.
  process.env.APP_DATABASE_URL ??= process.env.DATABASE_URL
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  if(process.env.TEST_ATTACHMENTS_DIR)process.env.ATTACHMENTS_DIR=process.env.TEST_ATTACHMENTS_DIR
  if(process.env.TEST_PROJECT_ATTACHMENTS_DIR)process.env.PROJECT_ATTACHMENTS_DIR=process.env.TEST_PROJECT_ATTACHMENTS_DIR
}

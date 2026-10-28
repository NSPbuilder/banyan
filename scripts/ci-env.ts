/** Generate current isolation evidence before migrating a fresh CI database. */
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { resolve } from 'node:path'
import postgres from 'postgres'

async function main() {
  const app = process.env.DATABASE_URL, test = process.env.TEST_DATABASE_URL
  if (process.env.CI !== 'true' || !app || !test) throw new Error('CI=true and distinct fresh application/test database URLs are required.')
  const a = new URL(app), t = new URL(test), appName = a.pathname.slice(1), testName = t.pathname.slice(1)
  const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!loopback(a) || !loopback(t) || a.port !== t.port || a.username !== t.username || !/^figtree_[a-z0-9_]+_test$/.test(testName) || appName === testName) throw new Error('Unsafe CI database identity.')
  const initiallyEmpty: Record<string, number> = {}
  for (const [url, name] of [[app, appName], [test, testName]]) {
    const db = postgres(url, { max: 1 })
    try {
      const [identity] = await db`SELECT current_database() AS name, current_user AS role`
      const [tables] = await db`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`
      if (identity.name !== name || tables.n !== 0) throw new Error('CI evidence requires both targets to be observed empty before migrations.')
      initiallyEmpty[name] = tables.n
    } finally { await db.end() }
  }
  const evidenceRoot = resolve('docs/evidence'), environmentPath = resolve('.env.local'), proofPath = resolve('.verification/isolation.json')
  const storageRoot = resolve('.verification/storage')
  const config: Record<string, string> = {
    DATABASE_URL: app, APP_DATABASE_URL: app, TEST_DATABASE_URL: test, TEST_DATABASE_CONFIRMATION: testName,
    ATTACHMENTS_DIR: resolve(storageRoot, 'app'), PROJECT_ATTACHMENTS_DIR: resolve(storageRoot, 'app-project'),
    TEST_ATTACHMENTS_DIR: resolve(storageRoot, 'test'), TEST_PROJECT_ATTACHMENTS_DIR: resolve(storageRoot, 'test-project'),
    AUTH_MFA_KEY: randomBytes(32).toString('base64'), AI_KEY_SECRET: randomBytes(32).toString('hex'), INTEGRATION_KEY_SECRET: randomBytes(32).toString('hex'),
    FIGTREE_TEST_ISOLATION_PROOF: proofPath, P1_BROWSER_FIXTURE: resolve('.verification/p1-fixture.json'),
    P5_PUBLIC_ORIGIN: 'https://banyan-ci.invalid', ONLINE_PAYMENTS_ENABLED: 'false', INBOUND_MAIL_ENABLED: 'false',
  }
  const text = Object.entries(config).map(([k, v]) => `${k}=${v}\n`).join('')
  writeFileSync(environmentPath, text, { mode: 0o600 }); chmodSync(environmentPath, 0o600)
  const proof = {
    createdNew: true, productionTouched: false, databaseHost: a.hostname, databaseRole: decodeURIComponent(a.username),
    pgPort: Number(a.port || 5432), applicationDatabase: appName, appDatabase: appName, testDatabase: testName,
    initialPublicTables: initiallyEmpty, databasesInitiallyEmpty: initiallyEmpty, initialTables: 0,
    environmentPath, environmentFile: environmentPath, environmentMode: '0o600',
    environmentSha256: createHash('sha256').update(text).digest('hex'),
    fixturePath: resolve('.verification/receipt-fixture.json'), browserFixturePath: resolve('.verification/receipt-fixture.json'),
    createdAt: new Date().toISOString(),
  }
  mkdirSync(resolve('.verification'), { recursive: true })
  for (const folder of ['', 'p3', 'p5', 'p6', 'payment-receipts-2026-10-14']) {
    const path = folder ? resolve(evidenceRoot, folder, 'isolation.json') : proofPath
    mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(proof, null, 2) + '\n')
  }
  console.log('Generated current, observed-empty CI isolation evidence and protected configuration.')
}
main().catch(() => { console.error('CI isolation setup failed. Check fresh loopback targets and permissions.'); process.exitCode = 1 })

/**
 * A signed-in session for the page pass, printed as a cookie value.
 *
 *   npx tsx scripts/mint-session.ts   (the REAL books, via ./dotenv)
 *
 * The page pass is how a screen gets looked at: the suites render components,
 * `next build` compiles them, and neither opens a page. This mints what a
 * browser would have after signing in, so `curl` can.
 */
import './dotenv'
import { createHash, randomBytes } from 'crypto'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'

async function main() {
  const [who] = await db.execute<{ id: string; email: string }>(raw`
    SELECT id::text, email FROM app_user ORDER BY kind = 'superadmin' DESC LIMIT 1`)
  if (!who) { console.error('No user to sign in as.'); process.exit(1) }
  const token = randomBytes(24).toString('hex')
  await db.execute(raw`
    INSERT INTO user_session (user_id, token_hash, expires_at, user_agent)
    VALUES (${who.id}::uuid, ${createHash('sha256').update(token).digest('hex')},
            now() + interval '1 hour', 'page pass')`)
  console.log(token)
  await conn.end()
}
main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

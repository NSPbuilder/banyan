/**
 * Set somebody's password from the shell.
 *
 *   npm run user:reset-password -- somebody@example.com
 *   npm run user:reset-password -- somebody@example.com --password 'a long ordinary sentence'
 *
 * This is the way back in when the superadmin's password is lost. There is
 * exactly one superadmin, nobody outranks it, and only it can change its own
 * password (docs/design/17-users-and-access.md) — so a forgotten one had no
 * door at all, only psql. Shell access to this machine already IS every
 * permission the database has; this makes the one thing it would be used for
 * a command with a name, a sentence, and an audit row that says a shell did it.
 *
 * Goes through `setPassword` like the screen does: the same length rule, the
 * same hash, every session that person had is signed out, the same trail —
 * with the actor `shell:<login>` so the row is never mistaken for a person
 * clicking. Without --password a random one is generated and printed ONCE.
 *
 * `./dotenv`, not `./env`: this acts on the books, not the test database.
 * (`US36` runs it against the test database by handing it DATABASE_URL in the
 * environment, which dotenv leaves alone.)
 */
import './dotenv'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { sql } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { UserError, setPassword } from '../src/lib/users'

const args = process.argv.slice(2)
const email = args.find((a) => !a.startsWith('--'))
const at = args.indexOf('--password')
const given = at >= 0 ? args[at + 1] : undefined

async function main() {
  if (!email) {
    console.error('usage: npm run user:reset-password -- <email> [--password <new password>]')
    process.exit(2)
  }
  const target = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)
  const [who] = await db.execute<{ id: string; email: string; kind: string; is_active: boolean }>(sql`
    SELECT id::text, email, kind, is_active FROM app_user WHERE email = lower(${email.trim()})`)
  if (!who) {
    console.error(`Nobody in ${target} has the address ${email}.`)
    process.exit(1)
  }
  const password = given ?? randomBytes(18).toString('base64url')
  try {
    await setPassword({ userId: who.id, password, actor: `shell:${userInfo().username}` })
  } catch (e) {
    console.error(e instanceof UserError ? e.message : String(e))
    process.exit(1)
  }
  console.log(`Password set for ${who.email} (${who.kind}) in ${target}. Every session they had is signed out.`)
  if (!given) console.log(`\n  ${password}\n\nThis is the only time it is shown. Sign in with it, then change it.`)
  if (!who.is_active) console.log('Note: that account is signed off. A password alone will not let them in.')
}

main().then(() => conn.end()).catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

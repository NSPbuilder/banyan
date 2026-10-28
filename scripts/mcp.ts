/** Local installation administration. No endpoint can mint tokens. */
import './dotenv'
import { userInfo } from 'node:os'
import { sql } from 'drizzle-orm'
import { db, sql as connection } from '../src/db/client'
import { issueMcpCredential, revokeMcpCredential } from '../src/lib/mcp-credentials'

const usage = 'npm run mcp -- list | create --user <email> --ledger <uuid> --name <label> [--days 90] [--tools balances,statement] | revoke --id <uuid>'
async function main() {
  const [command, ...args] = process.argv.slice(2)
  const allowed = command === 'create' ? ['--user', '--ledger', '--name', '--days', '--tools'] : command === 'revoke' ? ['--id'] : []
  const options = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || options.has(args[i])) throw Error(usage)
    options.set(args[i], args[i + 1])
  }
  const actor = `shell:${userInfo().username}`
  if (command === 'list') {
    const rows = await db.execute(sql`SELECT c.id::text,c.name,u.email,c.ledger_id::text,e.name AS company,
      c.tools,c.created_at::text,c.expires_at::text,c.last_used_at::text,c.revoked_at::text
      FROM mcp_credential c JOIN app_user u ON u.id=c.user_id JOIN ledger l ON l.id=c.ledger_id
      JOIN entity e ON e.id=l.entity_id ORDER BY c.created_at DESC`)
    console.log(JSON.stringify(rows, null, 2))
  } else if (command === 'create') {
    if (!options.get('--user') || !options.get('--ledger') || !options.get('--name')) throw Error(usage)
    const [user] = await db.execute<{ id: string }>(sql`SELECT id::text FROM app_user WHERE email=${options.get('--user')!.trim().toLowerCase()} AND is_active`)
    if (!user) throw Error('No active user with that email.')
    const issued = await issueMcpCredential({ userId: user.id, ledgerId: options.get('--ledger')!,
      name: options.get('--name')!, days: Number(options.get('--days') ?? 90),
      tools: options.get('--tools')?.split(',').map(t => t.trim()), actor })
    console.log('Save this bearer token securely. It is displayed once; do not paste it into a chat or commit it.')
    console.log(JSON.stringify(issued, null, 2))
  } else if (command === 'revoke') {
    if (!options.get('--id')) throw Error(usage)
    console.log(await revokeMcpCredential(options.get('--id')!, actor) ? 'Credential revoked.' : 'No active credential with that id.')
  } else throw Error(usage)
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'MCP administration failed.'); process.exitCode = 1 })
  .finally(() => connection.end())

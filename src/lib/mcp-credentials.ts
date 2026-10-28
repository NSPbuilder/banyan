import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditRow } from './audit-row'
import { userById } from './users'
import { isMcpTool, MCP_READ_TOOL_NAMES, MCP_TOOL_NAMES, mcpTools } from './mcp-tools'
import type { ToolContext } from './inquiry-tools'

export const MCP_RATE_LIMIT = 120
export class McpAccessError extends Error {
  constructor(message: string, public status = 403) { super(message) }
}
const hash = (secret: string) => createHash('sha256').update(secret).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export type McpPrincipal = { credentialId: string; tools: string[]; ctx: ToolContext }

async function context(userId: string, ledgerId: string): Promise<ToolContext> {
  const user = await userById(userId)
  const [ledger] = await db.execute<{ entity_id: string; name: string }>(sql`
    SELECT e.id::text AS entity_id,e.name FROM ledger l JOIN entity e ON e.id=l.entity_id
    WHERE l.id=${ledgerId}::uuid`)
  if (!user?.is_active || !ledger) throw new McpAccessError('Invalid or expired MCP credential.', 401)
  return { ledgerId, entityId: ledger.entity_id, entityName: ledger.name, user }
}

/** Shell administration only. A token has a fixed ledger and a fixed tool ceiling. */
export async function issueMcpCredential(input: {
  userId: string; ledgerId: string; name: string; days: number; tools?: string[]; actor: string
}) {
  if (!uuid.test(input.userId) || !uuid.test(input.ledgerId)) throw new McpAccessError('A user and ledger UUID are required.')
  const name = input.name.trim()
  if (!name || name.length > 80 || !Number.isInteger(input.days) || input.days < 1 || input.days > 365)
    throw new McpAccessError('Use a name of 1–80 characters and an expiry of 1–365 days.')
  const ctx = await context(input.userId, input.ledgerId)
  const available = (await mcpTools(ctx, MCP_TOOL_NAMES)).map(t => t.name)
  // Newly added capabilities never become the default grant.
  const tools = [...new Set(input.tools ?? available.filter(name => MCP_READ_TOOL_NAMES.includes(name as typeof MCP_READ_TOOL_NAMES[number])))]
  if (!tools.length || tools.every(t => t === 'ledger_context') || tools.some(t => !isMcpTool(t) || !available.includes(t)))
    throw new McpAccessError('Choose tools currently allowed for this user and company. Draft proposals require separate enablement and explicit scope.')
  const secret = `ft_mcp_${randomBytes(32).toString('base64url')}`
  const row = await db.transaction(async tx => {
    const [created] = await tx.execute<{ id: string; expires_at: string }>(sql`
      INSERT INTO mcp_credential(user_id,ledger_id,name,token_hash,tools,expires_at)
      VALUES (${input.userId}::uuid,${input.ledgerId}::uuid,${name},${hash(secret)},
        ARRAY[${sql.join(tools.map(t => sql`${t}`), sql`, `)}]::text[],
        clock_timestamp()+${input.days}*interval '1 day') RETURNING id::text,expires_at::text`)
    await auditRow(tx, { actor: input.actor, action: 'issue_mcp_credential', table: 'mcp_credential',
      recordId: created.id, entityId: ctx.entityId, ledgerId: ctx.ledgerId, scope: 'company', targetLabel: name,
      after: { userId: input.userId, tools, expiresAt: created.expires_at } })
    return created
  })
  return { ...row, secret }
}

export async function revokeMcpCredential(id: string, actor: string) {
  if (!uuid.test(id)) throw new McpAccessError('A credential UUID is required.')
  return db.transaction(async tx => {
    const [row] = await tx.execute<{ ledger_id: string; entity_id: string; name: string }>(sql`
      UPDATE mcp_credential c SET revoked_at=clock_timestamp() FROM ledger l
      WHERE c.id=${id}::uuid AND c.ledger_id=l.id AND c.revoked_at IS NULL
      RETURNING c.ledger_id::text,l.entity_id::text,c.name`)
    if (!row) return false
    await auditRow(tx, { actor, action: 'revoke_mcp_credential', table: 'mcp_credential', recordId: id,
      ledgerId: row.ledger_id, entityId: row.entity_id, scope: 'company', targetLabel: row.name, after: { active: false } })
    return true
  })
}

/** Reloads user, grants and revocation on each call, including before release. */
export async function liveMcpPrincipal(id: string): Promise<McpPrincipal> {
  const [row] = await db.execute<{ user_id: string; ledger_id: string; tools: string[] }>(sql`
    SELECT user_id::text,ledger_id::text,tools FROM mcp_credential
    WHERE id=${id}::uuid AND revoked_at IS NULL AND expires_at>clock_timestamp()`)
  if (!row) throw new McpAccessError('Invalid or expired MCP credential.', 401)
  return { credentialId: id, tools: row.tools, ctx: await context(row.user_id, row.ledger_id) }
}

/** A browser session is never an MCP credential. The plaintext is never stored. */
export async function authenticateMcp(authorization: string | null): Promise<McpPrincipal> {
  const match = /^Bearer (ft_mcp_[A-Za-z0-9_-]{43})$/i.exec(authorization ?? '')
  if (!match) throw new McpAccessError('A Banyan MCP bearer token is required.', 401)
  const [row] = await db.execute<{ id: string }>(sql`
    UPDATE mcp_credential c SET last_used_at=clock_timestamp(),
      request_count=CASE WHEN request_window<=clock_timestamp()-interval '1 minute' THEN 1 ELSE request_count+1 END,
      request_window=CASE WHEN request_window<=clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE request_window END
    FROM app_user u WHERE c.token_hash=${hash(match[1])} AND c.user_id=u.id AND u.is_active
      AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()
      AND (c.request_window<=clock_timestamp()-interval '1 minute' OR c.request_count<${MCP_RATE_LIMIT})
    RETURNING c.id::text`)
  if (!row) {
    const [live] = await db.execute(sql`SELECT c.id FROM mcp_credential c JOIN app_user u ON u.id=c.user_id
      WHERE c.token_hash=${hash(match[1])} AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND u.is_active`)
    throw new McpAccessError(live ? 'MCP request limit reached. Retry in one minute.' : 'Invalid or expired MCP credential.', live ? 429 : 401)
  }
  return liveMcpPrincipal(row.id)
}

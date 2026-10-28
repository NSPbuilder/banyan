import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Runner, Tx } from './acting'
import { refuseForLedger } from './access'
import { userById, type UserRecord } from './users'
import type { ToolContext } from './inquiry-tool-runtime'
import { isMcpProposal, McpProposalError, type McpOperationName, type McpProposalName } from './mcp-proposal-inputs'

export const mcpWritesEnabled = () => process.env.MCP_ENABLED === 'true' && process.env.MCP_WRITES_ENABLED === 'true'

export const mcpProposalSeat = (tool: McpProposalName) => ({
  propose_invoice_draft: '/invoices', propose_entry_draft: '/entries', propose_expense_draft: '/expenses',
})[tool]
const businessSeats = (tool: McpProposalName) => tool === 'propose_expense_draft'
  ? ['/expenses', '/entries'] : [mcpProposalSeat(tool)]

/** Array-valued access checks mean ANY seat; these two checks deliberately mean ALL. */
export async function assertMcpProposalSeats(user: UserRecord, ledgerId: string, tool: McpProposalName, on: Runner = db) {
  if (!user.is_active) throw new McpProposalError('ACCESS_CHANGED', 'Your access is no longer available.')
  for (const seat of ['/assistant', ...businessSeats(tool)]) {
    const refused = await refuseForLedger(user, ledgerId, seat, on)
    if (refused) throw new McpProposalError('ACCESS_CHANGED', refused.message)
  }
}

export async function mcpOperationAllowed(ctx: ToolContext, name: McpOperationName, on: Runner = db) {
  if (await refuseForLedger(ctx.user, ctx.ledgerId, '/assistant', on)) return false
  if (name === 'proposal_status') return true // The actual proposal's business seat is checked on lookup.
  if (name === 'draft_context') {
    for (const seat of ['/invoices', '/entries'])
      if (!(await refuseForLedger(ctx.user, ctx.ledgerId, seat, on))) return true
    return false
  }
  if (!isMcpProposal(name) || !mcpWritesEnabled()) return false
  for (const seat of businessSeats(name))
    if (await refuseForLedger(ctx.user, ctx.ledgerId, seat, on)) return false
  const [company] = await on.execute<{ archived_at: string | null }>(sql`SELECT archived_at::text FROM entity WHERE id=${ctx.entityId}::uuid`)
  return !!company && company.archived_at === null
}

/** Existing grant management locks app_user; company policy changes lock entity.
 * Taking compatible shared locks before reading seats keeps the final write and
 * those changes ordered, without holding a pool connection and querying another. */
export async function lockMcpActor(tx: Tx, ledgerId: string, userId: string): Promise<ToolContext> {
  const people = await tx.execute(sql`SELECT id FROM app_user WHERE id=${userId}::uuid AND is_active FOR SHARE`)
  const [company] = await tx.execute<{ entity_id: string; name: string; archived_at: string | null }>(sql`
    SELECT e.id::text AS entity_id,e.name,e.archived_at::text FROM ledger l JOIN entity e ON e.id=l.entity_id
    WHERE l.id=${ledgerId}::uuid FOR SHARE OF e,l`)
  const user = people.length ? await userById(userId, tx) : null
  if (!user || !company) throw new McpProposalError('ACCESS_CHANGED', 'The company or user is no longer available.')
  return { user, ledgerId, entityId: company.entity_id, entityName: company.name }
}

export async function lockMcpProposalScope(tx: Tx, input: {
  credentialId: string; ledgerId: string; userId: string; tool: McpProposalName
}): Promise<ToolContext> {
  const ctx = await lockMcpActor(tx, input.ledgerId, input.userId)
  const [credential] = await tx.execute<{ tools: string[] }>(sql`
    SELECT tools FROM mcp_credential WHERE id=${input.credentialId}::uuid AND user_id=${input.userId}::uuid
      AND ledger_id=${input.ledgerId}::uuid AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`)
  if (!credential?.tools.includes(input.tool)) throw new McpProposalError('CREDENTIAL_CHANGED', 'The originating MCP credential is unavailable or no longer permits this operation.')
  if (!mcpWritesEnabled()) throw new McpProposalError('WRITES_DISABLED', 'MCP draft proposals are disabled. An operator must enable them before a draft can be created.')
  await assertMcpProposalSeats(ctx.user, ctx.ledgerId, input.tool, tx)
  const [company] = await tx.execute<{ archived_at: string | null }>(sql`SELECT archived_at::text FROM entity WHERE id=${ctx.entityId}::uuid`)
  if (!company || company.archived_at !== null) throw new McpProposalError('ARCHIVED', 'Restore this company before creating a draft.')
  return ctx
}

/** Expiry can pass while a transaction is working; do not consume an expired grant. */
export async function assertMcpCredentialStillLive(tx: Tx, credentialId: string) {
  const live = await tx.execute(sql`SELECT 1 FROM mcp_credential WHERE id=${credentialId}::uuid
    AND revoked_at IS NULL AND expires_at>clock_timestamp()`)
  if (!live.length || !mcpWritesEnabled()) throw new McpProposalError('CREDENTIAL_CHANGED', 'MCP draft access expired or was disabled before this request finished.')
}

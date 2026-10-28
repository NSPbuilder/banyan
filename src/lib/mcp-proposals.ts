import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Runner, type Tx } from './acting'
import { auditRow } from './audit-row'
import type { UserRecord } from './users'
import type { ToolContext } from './inquiry-tool-runtime'
import {
  assertMcpCredentialStillLive, assertMcpProposalSeats, lockMcpActor,
  lockMcpProposalScope, mcpWritesEnabled,
} from './mcp-proposal-access'
import { mcpDraftEvidence, prepareMcpDraft, saveMcpDraft, type McpDraftPreview } from './mcp-drafts'
import {
  canonicalMcpJson, isMcpProposal, MCP_OPERATION_INPUTS, MCP_PROPOSAL_MINUTES,
  MCP_PROPOSAL_MODEL, MCP_PROPOSAL_SYSTEM, McpProposalError,
  type McpProposalInput, type McpProposalName,
} from './mcp-proposal-inputs'

type Principal = { credentialId: string; ctx: ToolContext }
type Envelope = {
  version: 1; credentialId: string; userId: string; entityId: string; ledgerId: string;
  tool: McpProposalName; payload: McpProposalInput; payloadDigest: string;
  prepared: Record<string, unknown>; preparedDigest: string; digest: string
}
type Row = {
  id: string; ledger_id: string; asked_by: string; question: string; asked_at: string; expires_at: string; expired: boolean;
  tool: string; args: Envelope; terminal: string | null; finished_at: string | null
}
type CreatedResult = { type: 'invoice' | 'entry'; id: string }
type Terminal = { status: 'created'; result: CreatedResult } | { status: 'rejected' }
export type McpProposalView = {
  proposalId: string; status: 'pending' | 'expired' | 'created' | 'rejected';
  createdAt: string; expiresAt: string; finishedAt: string | null; digest: string;
  credentialId: string; credentialName: string; requestedBy: string; reason: string;
  preview: McpDraftPreview; reviewUrl: string; canConfirm: boolean; canReject: boolean; blockedReason?: string;
  result?: CreatedResult & { href: string; currentStatus: string }
}

const digest = (value: unknown) => createHash('sha256').update(canonicalMcpJson(value)).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (code: string, message: string): never => { throw new McpProposalError(code, message) }
export function mcpProposalId(credentialId: string, requestId: string) {
  const bytes = createHash('sha256').update(`FigTree:MCP:proposal:v1:${credentialId}:${requestId}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 0x50
  bytes[8] = (bytes[8] & 63) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function rowOf(on: Runner, ledgerId: string, id: string, lock = false): Promise<Row | null> {
  if (!uuid.test(id) || !uuid.test(ledgerId)) return null
  // A joined SELECT can take its statement snapshot before waiting on q's
  // lock, missing a terminal step committed by the previous confirmer. Lock
  // first, then read the joined record in a fresh READ COMMITTED statement.
  if (lock) await on.execute(sql`SELECT id FROM ai_inquiry WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid FOR UPDATE`)
  const [row] = await on.execute<Row>(sql`SELECT q.id::text,q.ledger_id::text,q.asked_by,q.question,q.asked_at::text,
    (q.asked_at+${MCP_PROPOSAL_MINUTES}*interval '1 minute')::text AS expires_at,
    q.asked_at+${MCP_PROPOSAL_MINUTES}*interval '1 minute'<=clock_timestamp() AS expired,
    s.tool,s.args,t.result AS terminal,t.at::text AS finished_at
    FROM ai_inquiry q JOIN ai_inquiry_step s ON s.inquiry_id=q.id AND s.n=1
    LEFT JOIN ai_inquiry_step t ON t.inquiry_id=q.id AND t.n=2
    WHERE q.id=${id}::uuid AND q.ledger_id=${ledgerId}::uuid
      AND q.system=${MCP_PROPOSAL_SYSTEM} AND q.model=${MCP_PROPOSAL_MODEL}`)
  return row ?? null
}

function envelopeOf(row: Row, ctx: ToolContext, credentialId?: string): Envelope {
  const env = row.args
  if (!env || env.version !== 1 || !isMcpProposal(row.tool) || env.tool !== row.tool
    || env.userId !== ctx.user.id || env.entityId !== ctx.entityId || env.ledgerId !== ctx.ledgerId
    || row.ledger_id !== ctx.ledgerId || !uuid.test(env.credentialId)
    || (credentialId !== undefined && env.credentialId !== credentialId))
    return fail('NOT_FOUND', 'This MCP proposal is unavailable for this user, credential or ledger.')
  const parsed = MCP_OPERATION_INPUTS[env.tool].safeParse(env.payload)
  if (!parsed.success || env.payloadDigest !== digest({ tool: env.tool, payload: parsed.data })
    || env.preparedDigest !== digest(env.prepared)) return fail('INVALID_PROPOSAL', 'This recorded proposal is invalid; no draft was created.')
  const { digest: expected, ...body } = env
  if (expected !== digest(body)) return fail('INVALID_PROPOSAL', 'The proposal digest no longer matches its immutable contents.')
  return env
}

function terminalOf(row: Row): Terminal | null {
  if (row.terminal === null) return null
  let value: Record<string, unknown>
  try {
    const parsed = JSON.parse(row.terminal)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid terminal shape')
    value = parsed
  } catch { return fail('INVALID_PROPOSAL', 'The recorded proposal result is invalid.') }
  if (value.status === 'rejected') return { status: 'rejected' }
  const result = value.result as Partial<CreatedResult> | undefined
  if (value.status !== 'created' || !result || !['invoice', 'entry'].includes(result.type ?? '') || typeof result.id !== 'string' || !uuid.test(result.id))
    return fail('INVALID_PROPOSAL', 'The recorded proposal result is invalid.')
  return { status: 'created', result: { type: result.type as CreatedResult['type'], id: result.id } }
}

async function viewOf(on: Runner, row: Row, ctx: ToolContext, credentialId?: string): Promise<McpProposalView> {
  const env = envelopeOf(row, ctx, credentialId)
  await assertMcpProposalSeats(ctx.user, ctx.ledgerId, env.tool, on)
  const [credential] = await on.execute<{ name: string; live: boolean }>(sql`SELECT name,
    revoked_at IS NULL AND expires_at>clock_timestamp() AND ${env.tool}=ANY(tools)
      AND user_id=${env.userId}::uuid AND ledger_id=${env.ledgerId}::uuid AS live
    FROM mcp_credential WHERE id=${env.credentialId}::uuid`)
  const [company] = await on.execute<{ archived: boolean }>(sql`SELECT archived_at IS NOT NULL AS archived FROM entity WHERE id=${ctx.entityId}::uuid`)
  const terminal = terminalOf(row)
  const status = terminal?.status ?? (row.expired ? 'expired' : 'pending')
  const blockedReason = !mcpWritesEnabled() ? 'MCP draft proposals are disabled.'
    : !credential?.live ? 'The originating credential is expired, revoked or no longer permits this operation.'
      : company?.archived ? 'This company is archived.' : row.expired ? 'This proposal expired. Request a new proposal with a new request ID.' : undefined
  let result: McpProposalView['result']
  if (terminal?.status === 'created') {
    const table = terminal.result.type === 'invoice' ? sql`invoice` : sql`journal_entry`
    const [saved] = await on.execute<{ status: string }>(sql`SELECT status FROM ${table}
      WHERE id=${terminal.result.id}::uuid AND ledger_id=${ctx.ledgerId}::uuid`)
    if (saved) result = { ...terminal.result, currentStatus: saved.status,
      href: `/ledger/${ctx.ledgerId}/${terminal.result.type === 'invoice' ? 'invoices' : 'entries'}/${terminal.result.id}` }
  }
  return { proposalId: row.id, status, createdAt: row.asked_at, expiresAt: row.expires_at, finishedAt: row.finished_at,
    digest: env.digest, credentialId: env.credentialId, credentialName: credential?.name ?? 'Unavailable credential',
    requestedBy: row.asked_by, reason: row.question, preview: env.prepared.preview as McpDraftPreview,
    reviewUrl: `/ledger/${ctx.ledgerId}/assistant/mcp/${row.id}`, canConfirm: status === 'pending' && !blockedReason,
    canReject: terminal === null, blockedReason: terminal ? undefined : blockedReason, result }
}

/** The caller owns the transaction, so its completed-tool audit can commit with
 * the proposal, rather than reporting an error after an unaudited write. */
export async function proposeMcpDraft(tx: Tx, principal: Principal, tool: McpProposalName, raw: Record<string, unknown>) {
  const parsed = MCP_OPERATION_INPUTS[tool].safeParse(raw)
  if (!parsed.success) return fail('INVALID_ARGUMENTS', 'Use the exact proposal schema, decimal strings and valid dates.')
  const payload = parsed.data
  const ctx = await lockMcpProposalScope(tx, { credentialId: principal.credentialId, ledgerId: principal.ctx.ledgerId,
    userId: principal.ctx.user.id, tool })
  await acting(tx, ctx.user.email)
  const id = mcpProposalId(principal.credentialId, payload.request_id)
  // All equal request IDs map to the same row; the mutex also protects the
  // absent-row case before INSERT. It never depends on a client lock token.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('mcp_proposal:'||${id},0))`)
  const payloadDigest = digest({ tool, payload })
  const previous = await rowOf(tx, ctx.ledgerId, id)
  if (previous) {
    const old = envelopeOf(previous, ctx, principal.credentialId)
    if (old.payloadDigest !== payloadDigest) return fail('IDEMPOTENCY_CONFLICT', 'This request ID already names a different payload. Use a new request ID.')
    await assertMcpCredentialStillLive(tx, principal.credentialId)
    return viewOf(tx, previous, ctx, principal.credentialId)
  }
  const prepared = mcpDraftEvidence(await prepareMcpDraft(tx, ctx, tool, payload))
  const body: Omit<Envelope, 'digest'> = { version: 1, credentialId: principal.credentialId, userId: ctx.user.id,
    entityId: ctx.entityId, ledgerId: ctx.ledgerId, tool, payload, payloadDigest,
    prepared, preparedDigest: digest(prepared) }
  const env: Envelope = { ...body, digest: digest(body) }
  await tx.execute(sql`INSERT INTO ai_inquiry(id,ledger_id,asked_at,asked_by,question,system,model,service)
    VALUES (${id}::uuid,${ctx.ledgerId}::uuid,clock_timestamp(),${ctx.user.email},${payload.reason},${MCP_PROPOSAL_SYSTEM},${MCP_PROPOSAL_MODEL},'MCP')`)
  await tx.execute(sql`INSERT INTO ai_inquiry_step(inquiry_id,n,outcome,tool,args,result)
    VALUES (${id}::uuid,1,'call',${tool},${JSON.stringify(env)}::jsonb,'Proposal only; no accounting draft exists until the person confirms in Banyan.')`)
  await auditRow(tx, { actor: ctx.user.email, action: 'mcp_proposal_created', table: 'ai_inquiry', recordId: id,
    entityId: ctx.entityId, ledgerId: ctx.ledgerId, scope: 'company', targetLabel: tool,
    context: { source: 'mcp', credentialId: principal.credentialId, userId: ctx.user.id },
    after: { tool, payloadDigest, proposalDigest: env.digest } })
  await assertMcpCredentialStillLive(tx, principal.credentialId)
  return viewOf(tx, (await rowOf(tx, ctx.ledgerId, id))!, ctx, principal.credentialId)
}

export async function mcpProposalStatus(ctx: ToolContext, credentialId: string, id: string) {
  const row = await rowOf(db, ctx.ledgerId, id)
  if (!row) return fail('NOT_FOUND', 'There is no such MCP proposal for this credential and ledger.')
  return viewOf(db, row, ctx, credentialId)
}

export async function browserMcpProposal(ledgerId: string, id: string, user: UserRecord) {
  return db.transaction(async tx => {
    const ctx = await lockMcpActor(tx, ledgerId, user.id)
    const row = await rowOf(tx, ledgerId, id)
    if (!row) return null
    return viewOf(tx, row, ctx)
  })
}

export async function browserMcpProposals(ledgerId: string, user: UserRecord, limit = 30) {
  if (!uuid.test(ledgerId)) return []
  const rows = await db.execute<{ id: string }>(sql`SELECT q.id::text FROM ai_inquiry q
    JOIN ai_inquiry_step s ON s.inquiry_id=q.id AND s.n=1
    WHERE q.ledger_id=${ledgerId}::uuid AND q.system=${MCP_PROPOSAL_SYSTEM} AND q.model=${MCP_PROPOSAL_MODEL}
      AND s.args->>'userId'=${user.id} AND s.args->>'ledgerId'=${ledgerId}
    ORDER BY q.asked_at DESC,q.id DESC LIMIT ${Math.min(Math.max(limit, 1), 30)}`)
  const views: McpProposalView[] = []
  for (const row of rows) {
    try { const view = await browserMcpProposal(ledgerId, row.id, user); if (view) views.push(view) }
    catch (error) { if (!(error instanceof McpProposalError)) throw error }
  }
  return views
}

/** This service is reached only from an authenticated browser action. It takes
 * no replacement payload and is never registered as an MCP tool. */
export async function decideMcpProposal(input: {
  ledgerId: string; proposalId: string; expectedDigest: string; decision: 'confirm' | 'reject'; user: UserRecord
}) {
  if (!['confirm', 'reject'].includes(input.decision)) return fail('INVALID_DECISION', 'Choose confirm or reject in Banyan.')
  return db.transaction(async tx => {
    const ctx = await lockMcpActor(tx, input.ledgerId, input.user.id)
    await acting(tx, ctx.user.email)
    const row = await rowOf(tx, ctx.ledgerId, input.proposalId, true)
    if (!row) return fail('NOT_FOUND', 'There is no such MCP proposal in this ledger.')
    const env = envelopeOf(row, ctx)
    await assertMcpProposalSeats(ctx.user, ctx.ledgerId, env.tool, tx)
    if (input.expectedDigest !== env.digest) return fail('STALE_PREVIEW', 'Reload the immutable proposal before deciding. No draft was created.')
    if (terminalOf(row)) return viewOf(tx, row, ctx)
    let terminal: Terminal
    if (input.decision === 'reject') terminal = { status: 'rejected' }
    else {
      if (row.expired) return fail('EXPIRED', 'This proposal expired; request a new proposal with a new request ID.')
      await lockMcpProposalScope(tx, { credentialId: env.credentialId, ledgerId: ctx.ledgerId, userId: ctx.user.id, tool: env.tool })
      const prepared = await prepareMcpDraft(tx, ctx, env.tool, env.payload)
      if (digest(mcpDraftEvidence(prepared)) !== env.preparedDigest)
        return fail('DEPENDENCIES_CHANGED', 'Accounts, parties, tax configuration or rate evidence changed. Request and review a new proposal.')
      const result = await saveMcpDraft(tx, prepared)
      await assertMcpCredentialStillLive(tx, env.credentialId)
      const unexpired = await tx.execute(sql`SELECT 1 FROM ai_inquiry WHERE id=${row.id}::uuid
        AND asked_at+${MCP_PROPOSAL_MINUTES}*interval '1 minute'>clock_timestamp()`)
      if (!unexpired.length) return fail('EXPIRED', 'This proposal expired before the draft could be saved.')
      terminal = { status: 'created', result: { type: result.type, id: result.id } }
    }
    await tx.execute(sql`INSERT INTO ai_inquiry_step(inquiry_id,n,outcome,result)
      VALUES (${row.id}::uuid,2,${terminal.status === 'created' ? 'answer' : 'refusal'},${JSON.stringify(terminal)})`)
    await auditRow(tx, { actor: ctx.user.email, action: terminal.status === 'created' ? 'mcp_proposal_confirmed' : 'mcp_proposal_rejected',
      table: 'ai_inquiry', recordId: row.id, entityId: ctx.entityId, ledgerId: ctx.ledgerId, scope: 'company', targetLabel: env.tool,
      context: { source: 'browser', credentialId: env.credentialId, userId: ctx.user.id, proposalDigest: env.digest }, after: terminal })
    return viewOf(tx, (await rowOf(tx, ctx.ledgerId, row.id))!, ctx)
  })
}

import './env'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { db, sql as connection } from '../src/db/client'
import { guardMcp, handleMcp } from '../src/lib/mcp-http'
import { issueMcpCredential, revokeMcpCredential } from '../src/lib/mcp-credentials'
import { MCP_TOOL_NAMES, MCP_READ_TOOL_NAMES } from '../src/lib/mcp-tools'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv, setAccountActive } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { createFirstOwner, createUser, signIn } from '../src/lib/users'
import { setGrants } from '../src/lib/access'
import { bindFxBankAccount, setFxCurrency } from '../src/lib/fx'
import { browserMcpProposal, browserMcpProposals, decideMcpProposal, mcpProposalId, type McpProposalView } from '../src/lib/mcp-proposals'
import { inquiriesFor } from '../src/lib/inquiry'
import { exportCompany, restoreCompany } from '../src/lib/backup'
import { verifyAudit } from '../src/lib/audit-chain'
import { prepareMcpDraft } from '../src/lib/mcp-drafts'
import { MCP_OPERATION_INPUTS } from '../src/lib/mcp-proposal-inputs'

const actor = 'mcp-operations@example.test', clients: Client[] = []
let checks = 0
const pass = (label: string) => { checks++; console.log(`PASS  MCPO${checks} ${label}`) }
const http = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const request = new Request(`http://127.0.0.1:${(http.address() as AddressInfo).port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    })
    const who = await guardMcp(request)
    const response = who instanceof Response ? who : await handleMcp(request, who)
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
  } catch { res.writeHead(500); res.end('Test server failed.') }
})

async function main() {
  const co = await createCompanyWithYear({ code: 'MCPO', name: 'MCP operations fixture', province: 'BC' }, actor)
  const other = await createCompanyWithYear({ code: 'MCPX', name: 'Other company secret', province: 'BC' }, actor)
  const chart = `1000,CAD bank,asset,,cash_and_cash_equivalents
1010,USD bank,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
1300,GST recoverable,asset,,gst_hst_recoverable
2000,Payables,liability,,trade_payables
2100,GST payable,liability,,gst_hst_payable
2150,PST payable,liability,,qst_pst_payable
4000,Revenue,revenue,,revenue_from_contracts
5000,Supplies,expense,,other_operating_expenses`
  const accounts = await importAccounts(co.company.id, parseAccountsCsv(chart).map(a => ({ ...a, entityId: co.company.id })), actor)
  const foreignAccounts = await importAccounts(other.company.id, parseAccountsCsv(chart).map(a => ({ ...a, entityId: other.company.id })), actor)
  const at = (code: string) => accounts.find(a => a.code === code)!.id
  const customer = await createParty({ kind: 'organisation', name: 'MCP Customer', roles: [{ entityId: co.company.id, role: 'customer' }], actor })
  const supplier = await createParty({ kind: 'organisation', name: 'MCP Supplier', roles: [{ entityId: co.company.id, role: 'supplier' }], actor })
  const outsider = await createParty({ kind: 'organisation', name: 'Hidden other customer', roles: [{ entityId: other.company.id, role: 'customer' }], actor })
  const password = randomBytes(30).toString('base64url')
  const owner = await createFirstOwner({ email: actor, firstName: 'MCP', lastName: 'Owner', password })
  const clerk = await createUser({ email: 'mcp-operation-clerk@example.test', firstName: 'Clerk', password, kind: 'user', actor })
  const year = co.year.endDate.slice(0, 4), date = `${year}-03-10`, ledgerId = co.ledger.id
  process.env.MCP_ENABLED = 'true'; process.env.MCP_WRITES_ENABLED = 'true'
  const token = await issueMcpCredential({ userId: owner.id, ledgerId, name: 'Explicit operation tools', tools: [...MCP_TOOL_NAMES], days: 1, actor })
  const read = await issueMcpCredential({ userId: owner.id, ledgerId, name: 'Default read tools', days: 1, actor })
  const second = await issueMcpCredential({ userId: owner.id, ledgerId, name: 'Other credential', tools: [...MCP_TOOL_NAMES], days: 1, actor })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`; process.env.MCP_PUBLIC_ORIGIN = origin
  async function connect(secret: string) {
    const client = new Client({ name: 'mcp-operation-verifier', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }))
    clients.push(client); return client
  }
  const client = await connect(token.secret), reader = await connect(read.secret), another = await connect(second.secret)
  const call = (name: string, args: Record<string, unknown> = {}, on = client) => on.callTool({ name, arguments: args })
  async function proposal(name: string, args: Record<string, unknown>) {
    const result = await call(name, args)
    assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent as unknown as McpProposalView
  }
  const entry = (id: string) => ({ request_id: id, reason: 'Prepare the requested balanced journal', entry_date: date, description: 'MCP journal',
    lines: [{ account_id: at('5000'), amount: '100.00', description: 'Supplies' }, { account_id: at('1000'), amount: '-100.00', description: 'Actual payment' }] })
  const invoice = (id: string) => ({ request_id: id, reason: 'Prepare the requested customer invoice', direction: 'sales',
    party_id: customer.id, control_account_id: at('1200'), issued_on: date, due_on: `${year}-03-31`,
    lines: [{ account_id: at('4000'), description: 'Consulting', amount: '100.00', tax_code: 'GST_PST' }] })
  const decide = (p: McpProposalView, decision: 'confirm' | 'reject' = 'confirm') => decideMcpProposal({ ledgerId, proposalId: p.proposalId, expectedDigest: p.digest, decision, user: owner })
  const counts = async () => {
    const [r] = await db.execute<{ drafts: number; invoices: number; posted: number }>(sql`SELECT
      (SELECT count(*)::int FROM journal_entry WHERE ledger_id=${ledgerId}::uuid AND status='draft') AS drafts,
      (SELECT count(*)::int FROM invoice WHERE ledger_id=${ledgerId}::uuid) AS invoices,
      (SELECT count(*)::int FROM journal_line l JOIN journal_entry e ON e.id=l.entry_id WHERE e.ledger_id=${ledgerId}::uuid AND e.status='posted') AS posted`)
    return r
  }
  assert.deepEqual((await reader.listTools()).tools.map(t => t.name).sort(), [...MCP_READ_TOOL_NAMES].sort())
  assert.equal((await client.listTools()).tools.length, 16)
  assert.equal((await call('propose_entry_draft', entry('reader-denied'), reader)).isError, true)
  process.env.MCP_WRITES_ENABLED = 'false'
  assert.equal((await client.listTools()).tools.filter(t => t.name.startsWith('propose_')).length, 0)
  assert.equal((await call('propose_entry_draft', entry('disabled'))).isError, true)
  process.env.MCP_WRITES_ENABLED = 'true'
  await setGrants({ userId: clerk.id, entityIds: [co.company.id], modules: ['/entries'], actor })
  await assert.rejects(issueMcpCredential({ userId: clerk.id, ledgerId, name: 'Missing assistant seat', tools: ['propose_entry_draft'], days: 1, actor }))
  await setGrants({ userId: clerk.id, entityIds: [co.company.id], modules: ['/assistant', '/expenses'], actor })
  await assert.rejects(issueMcpCredential({ userId: clerk.id, ledgerId, name: 'Expense result needs entries seat', tools: ['propose_expense_draft'], days: 1, actor }))
  await setGrants({ userId: clerk.id, entityIds: [co.company.id], modules: ['/entries'], actor })
  pass('Existing/default credentials stay read-only; writes require both switches, explicit tools and both seats')

  const context = await call('draft_context', { operation: 'invoice' })
  assert.ok(!context.isError); assert.match(JSON.stringify(context), /MCP Customer/); assert.ok(!JSON.stringify(context).includes('Hidden other'))
  for (const [name, args] of [
    ['propose_entry_draft', { ...entry('unknown'), confirmed: true }], ['confirm_proposal', {}], ['execute_sql', { sql: 'DROP TABLE invoice' }],
    ['propose_entry_draft', { ...entry('precision'), lines: [{ account_id: at('5000'), amount: '1.001' }, { account_id: at('1000'), amount: '-1.001' }] }],
    ['propose_entry_draft', { ...entry('unbalanced'), lines: [{ account_id: at('5000'), amount: '1.00' }, { account_id: at('1000'), amount: '-2.00' }] }],
    ['propose_entry_draft', { ...entry('foreign-account'), lines: [{ account_id: foreignAccounts[0].id, amount: '100.00' }, { account_id: at('1000'), amount: '-100.00' }] }],
    ['propose_invoice_draft', { ...invoice('foreign-party'), party_id: outsider.id }],
    ['propose_invoice_draft', { ...invoice('wrong-role'), party_id: supplier.id }],
    ['propose_invoice_draft', { ...invoice('due'), due_on: `${year}-03-01` }],
    ['propose_entry_draft', { ...entry('fx-journal'), currency: 'USD' }],
    ['propose_invoice_draft', { ...invoice('zero-invoice'), lines: [...invoice('unused').lines, { account_id: at('4000'), description: 'Zero line', amount: '0' }] }],
    ['propose_expense_draft', { request_id: 'zero-expense', reason: 'Invalid zero line', entry_date: date, description: 'Zero expense line', payment_account_id: at('1000'),
      lines: [{ account_id: at('5000'), amount: '100', description: 'Supplies' }, { account_id: at('5000'), amount: '0', description: 'Zero line' }] }],
  ] as Array<[string, Record<string, unknown>]>) {
    const r = await call(name, args); assert.equal(r.isError, true, name); assert.ok(!JSON.stringify(r).includes('Hidden other'))
  }
  assert.deepEqual(await counts(), { drafts: 0, invoices: 0, posted: 0 })
  pass('Bounded context is company scoped; unknown/self-confirming tools, invalid precision, roles, dates and foreign IDs fail closed')

  const first = await proposal('propose_invoice_draft', invoice('first-invoice'))
  assert.equal(first.status, 'pending'); assert.equal(first.preview.totalMinor, '11200')
  assert.deepEqual(first.preview.lines.map(l => l.nativeMinor), ['-10000', '-500', '-700'])
  assert.deepEqual(await counts(), { drafts: 0, invoices: 0, posted: 0 })
  assert.ok(!(await inquiriesFor(ledgerId, owner)).some(q => q.id === first.proposalId))
  const retry = await proposal('propose_invoice_draft', invoice('first-invoice'))
  assert.equal(retry.proposalId, first.proposalId); assert.equal(retry.expiresAt, first.expiresAt); assert.equal(retry.digest, first.digest)
  assert.equal((await call('propose_invoice_draft', { ...invoice('first-invoice'), note: 'Different payload' })).isError, true)
  assert.equal((await call('proposal_status', { proposal_id: first.proposalId }, another)).isError, true)
  await assert.rejects(browserMcpProposal(ledgerId, first.proposalId, clerk))
  assert.equal(await browserMcpProposal(other.ledger.id, first.proposalId, owner), null)
  await assert.rejects(decideMcpProposal({ ledgerId, proposalId: first.proposalId, expectedDigest: 'forged', decision: 'confirm', user: owner }))
  pass('Proposal changes no accounting rows; immutable retry, digest, owner, credential and ledger boundaries enforced')

  const [a, b] = await Promise.all([decide(first), decide(first)])
  assert.equal(a.status, 'created'); assert.equal(a.result!.id, b.result!.id)
  assert.deepEqual(await counts(), { drafts: 0, invoices: 1, posted: 0 })
  const rows = await db.execute<{ amount: bigint }>(sql`SELECT amount FROM invoice_line WHERE invoice_id=${a.result!.id}::uuid ORDER BY line_no`)
  assert.deepEqual(rows.map(l => l.amount), [-10000n, -500n, -700n])
  assert.equal(((await call('proposal_status', { proposal_id: first.proposalId })).structuredContent as { status: string }).status, 'created')
  const simultaneous = await Promise.all([proposal('propose_entry_draft', entry('parallel')), proposal('propose_entry_draft', entry('parallel'))])
  assert.equal(simultaneous[0].proposalId, simultaneous[1].proposalId)
  const raced = await Promise.all([decide(simultaneous[0]), decide(simultaneous[0], 'reject')])
  assert.equal(raced[0].status, raced[1].status)
  const journal = await proposal('propose_entry_draft', entry('journal-ok')), savedJournal = await decide(journal)
  const [journalState] = await db.execute<{ status: string; total: bigint }>(sql`SELECT e.status,sum(l.amount) AS total FROM journal_entry e JOIN journal_line l ON l.entry_id=e.id
    WHERE e.id=${savedJournal.result!.id}::uuid GROUP BY e.id`)
  assert.equal(journalState.status, 'draft'); assert.equal(BigInt(journalState.total), 0n)
  pass('Concurrent proposals share one ID; concurrent confirm/reject consumes once; journal and taxed invoice save exact drafts only')

  for (const direction of ['sales', 'purchase']) for (const kind of ['invoice', 'credit_note']) {
    const p = await proposal('propose_invoice_draft', { ...invoice(`${direction}-${kind}`), direction, kind,
      party_id: direction === 'sales' ? customer.id : supplier.id, control_account_id: at(direction === 'sales' ? '1200' : '2000'),
      lines: [{ account_id: at(direction === 'sales' ? '4000' : '5000'), description: 'Inclusive GST', amount: '105.00', tax_code: 'GST' }], amounts: 'inclusive' })
    const sign = (direction === 'sales') === (kind === 'invoice') ? -1n : 1n
    assert.deepEqual(p.preview.lines.map(l => BigInt(l.nativeMinor)), [10000n * sign, 500n * sign]); await decide(p)
  }
  const expense = await proposal('propose_expense_draft', { request_id: 'expense', reason: 'Prepare supplier expense', entry_date: date,
    description: 'Purchased supplies', payment_account_id: at('1000'), party_id: supplier.id,
    lines: [{ account_id: at('5000'), description: 'Supplies', amount: '100.00', tax_code: 'GST_PST' }] })
  assert.deepEqual(expense.preview.lines.map(l => l.nativeMinor), ['10700', '500', '-11200']); await decide(expense)
  pass('Sales/purchase invoices and credit notes preserve signs; inclusive tax and actual-payment CAD expenses match ordinary commands')

  const future = await createParty({ kind: 'organisation', name: 'Future customer', roles: [{ entityId: co.company.id, role: 'customer', heldFrom: `${year}-12-01` }], actor })
  assert.equal((await call('propose_invoice_draft', { ...invoice('future-role'), party_id: future.id })).isError, true)
  const partyJournal = await proposal('propose_entry_draft', { ...entry('party-date-change'),
    lines: entry('unused').lines.map(line => ({ ...line, party_id: supplier.id })) })
  await db.execute(sql`UPDATE party_role SET held_from=${`${year}-03-01`}::date WHERE party_id=${supplier.id}::uuid AND entity_id=${co.company.id}::uuid`)
  await assert.rejects(decide(partyJournal), /changed/)
  pass('Role validity covers both dates and changes to held_from invalidate a pending prepared journal')

  // Child-row editors take their row lock before their mandatory parent-version
  // trigger. The parent share lock must serialize edits without child-lock inversion.
  let roleEdit: Promise<unknown> | undefined
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM party WHERE id=${supplier.id}::uuid FOR SHARE`)
    roleEdit = db.execute(sql`UPDATE party_role SET held_to=${`${year}-12-31`}::date WHERE party_id=${supplier.id}::uuid AND entity_id=${co.company.id}::uuid`).then(x => x, error => ({ error }))
    await new Promise(resolve => setTimeout(resolve, 50))
    await prepareMcpDraft(tx, { ledgerId, entityId: co.company.id, entityName: co.company.name, user: owner }, 'propose_entry_draft',
      MCP_OPERATION_INPUTS.propose_entry_draft.parse({ ...entry('role-edit-race'), lines: entry('unused').lines.map(l => ({ ...l, party_id: supplier.id })) }))
  })
  const roleResult = await roleEdit
  if (roleResult && typeof roleResult === 'object' && 'error' in roleResult) throw roleResult.error
  pass('Concurrent role correction serializes through parent version without a child-row lock inversion')

  await setFxCurrency(ledgerId, 'USD', true, actor); await setFxCurrency(ledgerId, 'JPY', true, actor)
  const fx = await proposal('propose_invoice_draft', { ...invoice('fx'), currency: 'USD', manual_rate: { rate: '1.35', observed_on: date, reference: 'Bank evidence' },
    lines: [{ account_id: at('4000'), description: 'Small line one', amount: '0.01' }, { account_id: at('4000'), description: 'Small line two', amount: '0.01' }] })
  assert.equal(fx.preview.totalMinor, '2'); assert.equal(fx.preview.functionalMinor, '2')
  const fxResult = await decide(fx)
  const fxLines = await db.execute<{ amount: bigint; original_amount: bigint }>(sql`SELECT amount,original_amount FROM invoice_line WHERE invoice_id=${fxResult.result!.id}::uuid ORDER BY line_no`)
  assert.deepEqual(fxLines.map(l => [l.amount, l.original_amount]), [[-1n, -1n], [-1n, -1n]])
  const jpy = await proposal('propose_invoice_draft', { ...invoice('jpy'), currency: 'JPY', manual_rate: { rate: '0.009', observed_on: date, reference: 'JPY bank evidence' },
    lines: [{ account_id: at('4000'), description: 'JPY', amount: '1000' }] }); await decide(jpy)
  assert.equal(jpy.preview.functionalMinor, '900')
  assert.equal((await call('propose_invoice_draft', { ...invoice('jpy-invalid'), currency: 'JPY', manual_rate: { rate: '0.009', observed_on: date, reference: 'Evidence' },
    lines: [{ account_id: at('4000'), description: 'Fractional yen', amount: '1.01' }] })).isError, true)
  await bindFxBankAccount(ledgerId, at('1010'), 'USD', actor)
  assert.equal((await call('propose_entry_draft', { ...entry('foreign-bank'), lines: [{ account_id: at('5000'), amount: '100' }, { account_id: at('1010'), amount: '-100' }] })).isError, true)
  pass('FX drafts preserve exact native amounts, manual evidence and per-line CAD rounding; JPY precision and foreign-bank restrictions enforced')

  await db.execute(sql`INSERT INTO fx_rate(currency,observed_on,rate,source,reference) VALUES ('USD',${date}::date,1.37,'BOC','BOC cached fixture')`)
  const bocArgs = { ...invoice('boc'), currency: 'USD' }
  const boc = await proposal('propose_invoice_draft', bocArgs); assert.equal(boc.preview.quote!.source, 'BOC')
  const bocSaved = await decide(boc)
  const [bocRow] = await db.execute<{ fx_snapshot: { rate: string; source: string } }>(sql`SELECT fx_snapshot FROM invoice WHERE id=${bocSaved.result!.id}::uuid`)
  assert.equal(bocRow.fx_snapshot.rate, boc.preview.quote!.rate); assert.equal(bocRow.fx_snapshot.source, 'BOC')
  const staleBoc = await proposal('propose_invoice_draft', { ...bocArgs, request_id: 'stale-boc' })
  await db.execute(sql`UPDATE fx_rate SET rate=1.38 WHERE currency='USD' AND observed_on=${date}::date`)
  await assert.rejects(decide(staleBoc), /changed/)
  const raceBoc = await proposal('propose_invoice_draft', { ...bocArgs, request_id: 'boc-refresh-race' })
  let releaseRefresh!: () => void, refreshLocked!: () => void
  const locked = new Promise<void>(r => { refreshLocked = r }), release = new Promise<void>(r => { releaseRefresh = r })
  const refresh = db.transaction(async tx => {
    await tx.execute(sql`SELECT code FROM fx_currency WHERE code='USD' FOR UPDATE`)
    refreshLocked(); await release
    await tx.execute(sql`UPDATE fx_rate SET fetched_at=clock_timestamp() WHERE currency='USD' AND observed_on=${date}::date`)
  })
  await locked
  const confirming = decide(raceBoc)
  const observed = confirming.then(value => ({ value }), error => ({ error }))
  await new Promise(resolve => setTimeout(resolve, 50)); releaseRefresh(); await refresh
  const completion = await observed
  if ('error' in completion) throw completion.error
  assert.equal(completion.value.status, 'created')
  pass('BOC quote is frozen through save, quote changes invalidate pending proposals, and concurrent cache refresh completes without deadlock')

  const changed = await proposal('propose_entry_draft', entry('dependency'))
  await db.execute(sql`UPDATE account SET name='Renamed supplies' WHERE id=${at('5000')}::uuid`)
  await assert.rejects(decide(changed), /changed/); assert.equal((await decide(changed, 'reject')).status, 'rejected')
  await setAccountActive(at('5000'), false, actor)
  assert.equal((await call('propose_entry_draft', entry('inactive'))).isError, true); await setAccountActive(at('5000'), true, actor)
  await db.execute(sql`CREATE FUNCTION mcpo_old_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.model='external-mcp-proposal' THEN NEW.asked_at=clock_timestamp()-interval '16 minutes'; END IF; RETURN NEW; END $$`)
  await db.execute(sql`CREATE TRIGGER mcpo_old_proposal BEFORE INSERT ON ai_inquiry FOR EACH ROW EXECUTE FUNCTION mcpo_old_proposal()`)
  const expired = await proposal('propose_entry_draft', entry('expired'))
  await db.execute(sql`DROP TRIGGER mcpo_old_proposal ON ai_inquiry`); await db.execute(sql`DROP FUNCTION mcpo_old_proposal()`)
  assert.equal(expired.status, 'expired'); await assert.rejects(decide(expired), /expired/)
  assert.equal((await proposal('propose_entry_draft', entry('expired'))).expiresAt, expired.expiresAt)
  pass('Changed dependencies and inactive accounts refuse creation; expired requests never refresh on retry')

  const disabled = await proposal('propose_entry_draft', entry('disabled-confirm'))
  process.env.MCP_WRITES_ENABLED = 'false'; await assert.rejects(decide(disabled)); process.env.MCP_WRITES_ENABLED = 'true'
  await db.execute(sql`UPDATE entity SET archived_at=now(),archived_by=${actor} WHERE id=${co.company.id}::uuid`); await assert.rejects(decide(disabled))
  await db.execute(sql`UPDATE entity SET archived_at=NULL,archived_by=NULL WHERE id=${co.company.id}::uuid`)
  await db.execute(sql`INSERT INTO company_module_access(entity_id,module,enabled,updated_by) VALUES (${co.company.id}::uuid,'/assistant',false,${actor})
    ON CONFLICT(entity_id,module) DO UPDATE SET enabled=false`)
  await assert.rejects(decide(disabled)); await db.execute(sql`UPDATE company_module_access SET enabled=true WHERE entity_id=${co.company.id}::uuid AND module='/assistant'`)
  const revoked = await proposal('propose_entry_draft', entry('revoked'))
  await revokeMcpCredential(token.id, actor); await assert.rejects(decide(revoked))
  assert.equal((await decide(revoked, 'reject')).status, 'rejected')
  pass('Browser confirmation rechecks both switches, archived company, live module policy and originating credential revocation')

  // Hold the mutation uncommitted, start confirmation against its old snapshot,
  // then commit the mutation. Lock waiters must re-read the live authorization.
  await setGrants({ userId: clerk.id, entityIds: [co.company.id], modules: ['/assistant', '/entries'], actor })
  const raceToken = await issueMcpCredential({ userId: clerk.id, ledgerId, name: 'Grant race', tools: ['propose_entry_draft', 'proposal_status'], days: 1, actor })
  const raceClient = await connect(raceToken.secret)
  const grantProposal = (await call('propose_entry_draft', entry('grant-race'), raceClient)).structuredContent as unknown as McpProposalView
  let confirmGrant: Promise<unknown> | undefined
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM app_user WHERE id=${clerk.id}::uuid FOR UPDATE`)
    await tx.execute(sql`DELETE FROM user_entity_module_access WHERE user_id=${clerk.id}::uuid AND entity_id=${co.company.id}::uuid AND module='/entries'`)
    confirmGrant = decideMcpProposal({ ledgerId, proposalId: grantProposal.proposalId, expectedDigest: grantProposal.digest, decision: 'confirm', user: clerk }).then(() => false, () => true)
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  assert.equal(await confirmGrant, true)
  const revokeToken = await issueMcpCredential({ userId: owner.id, ledgerId, name: 'Revoke race', tools: ['propose_entry_draft', 'proposal_status'], days: 1, actor })
  const revokeClient = await connect(revokeToken.secret)
  const revokeProposal = (await call('propose_entry_draft', entry('revoke-race'), revokeClient)).structuredContent as unknown as McpProposalView
  let confirmRevoked: Promise<unknown> | undefined
  await db.transaction(async tx => {
    await tx.execute(sql`UPDATE mcp_credential SET revoked_at=clock_timestamp() WHERE id=${revokeToken.id}::uuid`)
    confirmRevoked = decide(revokeProposal).then(() => false, () => true)
    await new Promise(resolve => setTimeout(resolve, 50))
  })
  assert.equal(await confirmRevoked, true)
  assert.equal((await db.execute(sql`SELECT 1 FROM ai_inquiry_step WHERE inquiry_id IN (${grantProposal.proposalId}::uuid,${revokeProposal.proposalId}::uuid) AND n=2`)).length, 0)
  pass('Confirmation waiting on a concurrent grant removal or credential revocation rechecks committed authorization and creates no draft')

  const third = await issueMcpCredential({ userId: owner.id, ledgerId, name: 'Audit fixture', tools: [...MCP_TOOL_NAMES], days: 1, actor })
  const auditClient = await connect(third.secret)
  await db.execute(sql`CREATE FUNCTION mcpo_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='mcp_tool_call' AND NEW.after->>'status'='completed' OR NEW.action='mcp_proposal_confirmed' THEN RAISE EXCEPTION 'MCPO_SENSITIVE_AUDIT'; END IF; RETURN NEW; END $$`)
  await db.execute(sql`CREATE TRIGGER mcpo_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION mcpo_audit_failure()`)
  const failed = await call('propose_entry_draft', entry('audit-write'), auditClient)
  assert.equal(failed.isError, true); assert.ok(!JSON.stringify(failed).includes('MCPO_SENSITIVE'))
  assert.equal((await db.execute(sql`SELECT 1 FROM ai_inquiry WHERE id=${mcpProposalId(third.id, 'audit-write')}::uuid`)).length, 0)
  await db.execute(sql`DROP TRIGGER mcpo_audit_failure ON audit_log`)
  const auditProposal = (await call('propose_entry_draft', entry('audit-confirm'), auditClient)).structuredContent as unknown as McpProposalView
  const beforeAudit = await counts()
  await db.execute(sql`CREATE TRIGGER mcpo_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION mcpo_audit_failure()`)
  await assert.rejects(decide(auditProposal)); assert.deepEqual(await counts(), beforeAudit)
  assert.equal((await browserMcpProposal(ledgerId, auditProposal.proposalId, owner))!.status, 'pending')
  await db.execute(sql`DROP TRIGGER mcpo_audit_failure ON audit_log`); await db.execute(sql`DROP FUNCTION mcpo_audit_failure()`)
  await decide(auditProposal)
  pass('Completed-tool audit failure rolls back proposal; confirmation audit failure rolls back both draft and consumption')

  const portable = await exportCompany(co.company.id), restored = await restoreCompany(portable, actor, { code: 'MCPR', name: 'Restored proposals' })
  const [restoredLedger] = await db.execute<{ id: string }>(sql`SELECT id::text FROM ledger WHERE entity_id=${restored.entityId}::uuid AND is_primary`)
  const copied = await db.execute<{ id: string }>(sql`SELECT id::text FROM ai_inquiry WHERE ledger_id=${restoredLedger.id}::uuid AND model='external-mcp-proposal' LIMIT 1`)
  if (copied.length) await assert.rejects(browserMcpProposal(restoredLedger.id, copied[0].id, owner))
  assert.equal((await browserMcpProposals(restoredLedger.id, owner)).length, 0)
  assert.equal((await counts()).posted, 0)
  const audit = await verifyAudit(); assert.equal(audit.ok, true)
  pass('Portable copy cannot replay source ledger/credential proposals; audit chain valid and all created accounting rows remain unposted')

  if (process.env.MCP_BROWSER_FIXTURE) {
    const pending = (await call('propose_entry_draft', { ...entry('browser-confirm'), lines: entry('unused').lines.map(l => ({ ...l, party_id: supplier.id })) }, auditClient)).structuredContent as unknown as McpProposalView
    const rejection = (await call('propose_invoice_draft', invoice('browser-reject'), auditClient)).structuredContent as unknown as McpProposalView
    const login = await signIn({ email: actor, password, clientIp: '192.0.2.62' })
    const clerkLogin = await signIn({ email: clerk.email, password, clientIp: '192.0.2.63' })
    writeFileSync(process.env.MCP_BROWSER_FIXTURE, JSON.stringify({ ledgerId, pending, rejection, expired, token: login.token, clerkToken: clerkLogin.token }), { mode: 0o600 })
  }
  console.log(`=== ${checks} MCP OPERATION GROUPS: ALL CHECKS PASSED ===`)
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(async () => {
  await Promise.allSettled(clients.map(c => c.close()))
  await new Promise<void>(resolve => http.close(() => resolve()))
  await connection.end()
})

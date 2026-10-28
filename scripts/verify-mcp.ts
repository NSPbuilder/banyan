import './env'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sql } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { db, sql as connection } from '../src/db/client'
import { guardMcp, handleMcp } from '../src/lib/mcp-http'
import { issueMcpCredential, authenticateMcp, revokeMcpCredential, MCP_RATE_LIMIT } from '../src/lib/mcp-credentials'
import { MCP_READ_TOOL_NAMES } from '../src/lib/mcp-tools'
import { createCompanyWithYear, createFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { postEntry } from '../src/lib/posting'
import { createParty } from '../src/lib/parties'
import { createFirstOwner, createUser, setPassword, setUserStatus, setUserKind } from '../src/lib/users'
import { setGrants } from '../src/lib/access'
import { registerTax } from '../src/lib/registrations'
import { saveGstAdjustment } from '../src/lib/gst-adjustments'
import { exportCompany, restoreCompany } from '../src/lib/backup'
import { pauseRestoredAutomation } from '../src/lib/automation-restore'
import { verifyAudit } from '../src/lib/audit-chain'

const actor = 'mcp-suite@example.test'
const pass = (label: string) => console.log(`PASS  ${label}`)
const clients: Client[] = []
const http = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const request = new Request(`http://127.0.0.1:${(http.address() as AddressInfo).port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>,
      body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
    })
    const who = await guardMcp(request)
    const response = who instanceof Response ? who : req.method === 'POST'
      ? await handleMcp(request, who) : new Response(null, { status: 405 })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  } catch { res.writeHead(500); res.end('Test server failed.') }
})

async function main() {
  const north = await createCompanyWithYear({ code: 'MCPN', name: 'MCP North marker', province: 'BC' }, actor)
  const south = await createCompanyWithYear({ code: 'MCPS', name: 'MCP South secret marker', province: 'BC' }, actor)
  const year = north.year.endDate.slice(0, 4), from = `${year}-01-01`, to = `${year}-12-31`
  for (const [c, cents] of [[north, 11111n], [south, 99999n]] as const) {
    const accounts = await importAccounts(c.company.id, parseAccountsCsv(`1000,Cash,asset,,cash_and_cash_equivalents\n1300,GST recoverable,asset,,gst_hst_recoverable\n2100,GST payable,liability,,gst_hst_payable\n4000,Revenue,revenue,,revenue_from_contracts`)
      .map(a => ({ ...a, entityId: c.company.id })), actor)
    const at = Object.fromEntries(accounts.map(a => [a.code, a.id]))
    await postEntry({ ledgerId: c.ledger.id, entryDate: `${year}-01-10`, description: `${c.company.name} sale`, actor,
      lines: [{ accountId: at['1000'], amount: cents }, { accountId: at['4000'], amount: -cents }] })
    if (c === north) {
      const [second] = await db.execute<{ id: string }>(sql`INSERT INTO ledger(entity_id,code,name,purpose,accounting_standard,is_primary)
        VALUES (${c.company.id}::uuid,'SECOND','Other ledger secret','statutory','IFRS',false) RETURNING id::text`)
      await createFiscalYear(second.id, c.year.endDate, actor)
      await postEntry({ ledgerId: second.id, entryDate: `${year}-01-10`, description: 'Other ledger secret', actor,
        lines: [{ accountId: at['1000'], amount: 88888n }, { accountId: at['4000'], amount: -88888n }] })
    }
  }
  const foreignParty = await createParty({ kind: 'organisation', name: 'Foreign customer secret', roles: [{ entityId: south.company.id, role: 'customer' }], actor })
  const owner = await createFirstOwner({ email: actor, firstName: 'MCP', lastName: 'Owner', password: 'a long MCP suite password' })
  const clerk = await createUser({ email: 'mcp-clerk@example.test', firstName: 'Clerk', lastName: null, password: 'a long MCP clerk password', kind: 'user', actor })
  await setGrants({ userId: clerk.id, entityIds: [north.company.id], modules: ['/reports', '/entries'], actor })
  const issued = await issueMcpCredential({ userId: owner.id, ledgerId: north.ledger.id, name: 'SDK client', days: 2, actor })
  const journalBefore = JSON.stringify(await db.execute(sql`SELECT id::text,amount::text FROM journal_line ORDER BY id`))
  const limited = await issueMcpCredential({ userId: clerk.id, ledgerId: north.ledger.id, name: 'Reports only', days: 1, tools: ['ledger_context', 'balances', 'statement'], actor })
  await assert.rejects(issueMcpCredential({ userId: clerk.id, ledgerId: south.ledger.id, name: 'Forbidden', days: 1, actor }))
  await assert.rejects(issueMcpCredential({ userId: clerk.id, ledgerId: north.ledger.id, name: 'Forbidden scope', days: 1, tools: ['tax_return'], actor }))
  const [stored] = await db.execute<{ token_hash: string }>(sql`SELECT token_hash FROM mcp_credential WHERE id=${issued.id}::uuid`)
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/); assert.ok(!stored.token_hash.includes(issued.secret))
  pass('Token is hashed, ledger-bound and cannot exceed live user grants')

  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`, url = `${origin}/mcp`
  process.env.MCP_ENABLED = 'true'; process.env.MCP_PUBLIC_ORIGIN = origin
  const raw = (body: unknown, extra: Record<string, string> = {}, secret = issued.secret) => fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${secret}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
  })
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }
  assert.equal((await fetch(url, { headers: { cookie: 'erp_session=forged' } })).status, 401)
  assert.equal((await raw(init, {}, 'bad-token')).status, 401)
  assert.equal((await raw(init, { origin: 'https://foreign.invalid' })).status, 403)
  assert.equal((await raw(init, { origin: 'null' })).status, 403)
  process.env.MCP_ENABLED = 'false'; assert.equal((await raw(init)).status, 404); process.env.MCP_ENABLED = 'true'
  delete process.env.MCP_PUBLIC_ORIGIN; assert.equal((await raw(init)).status, 503); process.env.MCP_PUBLIC_ORIGIN = origin
  assert.equal((await fetch(`${url}?token=not-accepted`, { headers: { authorization: `Bearer ${issued.secret}` } })).status, 400)
  const response = await raw(init, { origin }); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /no-store/)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${issued.secret}` } })).status, 405)
  assert.equal((await raw({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202)
  assert.equal((await raw({ ...init, padding: 'x'.repeat(33 * 1024) })).status, 413)
  assert.equal((await raw([init, init])).status, 400)
  pass('HTTP authentication, origin, opt-in, body limit, stateless lifecycle and no-store')

  async function connect(secret: string) {
    const client = new Client({ name: 'figtree-verifier', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }))
    clients.push(client); return client
  }
  const client = await connect(issued.secret), narrow = await connect(limited.secret)
  const listed = (await client.listTools()).tools
  assert.deepEqual(listed.map(t => t.name).sort(), [...MCP_READ_TOOL_NAMES].sort())
  assert.ok(listed.every(t => t.annotations?.readOnlyHint && t.annotations?.destructiveHint === false))
  assert.deepEqual((await narrow.listTools()).tools.map(t => t.name).sort(), ['balances', 'ledger_context', 'statement'])
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args })
  const context = JSON.stringify(await call('ledger_context')); assert.match(context, /MCP North marker/); assert.ok(!context.includes('South secret'))
  const trial = JSON.stringify(await call('balances', { from, to })); assert.match(trial, /111\.11/); assert.ok(!trial.includes('999.99'))
  for (const which of ['cash_flow', 'balance_sheet', 'profit_loss', 'equity_changes'])
    assert.equal((await call('statement', { which, from, to })).isError, false)
  assert.equal((await call('account_activity', { account: '1000', from, to })).isError, false)
  assert.equal((await call('journal', { from, to })).isError, false)
  assert.equal((await call('totals', { by: 'account', from, to })).isError, false)
  assert.equal((await call('open_documents')).isError, false)
  assert.equal((await call('parties')).isError, false)
  const chart = await call('accounts'); assert.equal(chart.isError, false)
  assert.match(JSON.stringify(chart), /111\.11/); assert.ok(!JSON.stringify(chart).includes('1,000.00'))
  await db.execute(sql`INSERT INTO company_module_access(entity_id,module,enabled,updated_by)
    VALUES (${north.company.id}::uuid,'/tax',false,${actor})
    ON CONFLICT(entity_id,module) DO UPDATE SET enabled=false`)
  assert.ok(!(await client.listTools()).tools.some(t => t.name === 'tax_return'))
  assert.equal((await call('tax_return', { tax: 'gst_hst', from, to })).isError, true)
  await db.execute(sql`UPDATE company_module_access SET enabled=true WHERE entity_id=${north.company.id}::uuid AND module='/tax'`)
  await registerTax({ entityId: north.company.id, tax: 'GST_HST', number: '123456789RT0001', registeredOn: from, actor })
  await saveGstAdjustment(north.ledger.id, actor, { from, to, version: 0, sales: '', collected: '23.45', itcs: '', reason: 'MCP adjusted GST fixture' })
  assert.match(JSON.stringify(await call('tax_return', { tax: 'gst_hst', from, to })), /23\.45/)
  pass('Official SDK discovers and calls all 11 read tools; statements and adjusted GST use current readers')

  for (const [name, args] of [
    ['balances', { from, to, ledgerId: south.ledger.id }], ['balances', { from: `${year}-02-31`, to }],
    ['balances', { from: to, to: from }], ['owed', { side: 'receivable', party: foreignParty.id }],
    ['execute_sql', { sql: 'SELECT * FROM app_user' }], ['crm_propose_note', {}],
  ] as Array<[string, Record<string, unknown>]>) {
    const result = await call(name, args); assert.equal(result.isError, true)
    assert.ok(!JSON.stringify(result).includes('Foreign customer secret')); assert.ok(!JSON.stringify(result).includes('South secret'))
  }
  assert.equal((await narrow.callTool({ name: 'journal', arguments: {} })).isError, true)
  await db.execute(sql`CREATE FUNCTION mcp_suite_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='mcp_tool_call' AND NEW.after->>'status'='completed' THEN RAISE EXCEPTION 'SENSITIVE_AUDIT_INTERNAL'; END IF; RETURN NEW; END $$`)
  await db.execute(sql`CREATE TRIGGER mcp_suite_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION mcp_suite_audit_failure()`)
  const auditFailure = await call('balances', { from, to })
  assert.equal(auditFailure.isError, true); assert.ok(!JSON.stringify(auditFailure).includes('111.11'))
  assert.ok(!JSON.stringify(auditFailure).includes('SENSITIVE_AUDIT_INTERNAL')); assert.ok(!JSON.stringify(auditFailure).includes('INSERT'))
  await db.execute(sql`DROP TRIGGER mcp_suite_audit_failure ON audit_log`)
  await db.execute(sql`DROP FUNCTION mcp_suite_audit_failure()`)
  await setGrants({ userId: clerk.id, entityIds: [north.company.id], modules: ['/entries'], actor })
  assert.deepEqual((await narrow.listTools()).tools, [])
  assert.equal((await narrow.callTool({ name: 'balances', arguments: { from, to } })).isError, true)
  assert.equal(JSON.stringify(await db.execute(sql`SELECT id::text,amount::text FROM journal_line ORDER BY id`)), journalBefore)
  pass('Foreign IDs, ledger substitution, invalid dates, writes, SQL and revoked grants release no data')

  const [audit] = await db.execute<{ count: string; payload: string }>(sql`SELECT count(*)::text,
    string_agg(coalesce(context::text,'')||coalesce(after::text,''),'') AS payload FROM audit_log WHERE action='mcp_tool_call'`)
  assert.ok(Number(audit.count) >= 40); assert.match(audit.payload, /completed/); assert.match(audit.payload, /denied/)
  assert.match(audit.payload, /invalid_arguments/); assert.ok(!audit.payload.includes(issued.secret)); assert.ok(!audit.payload.includes('111.11'))
  assert.equal((await verifyAudit(db)).ok, true)
  pass('Allowed and denied tool calls are in the verified audit chain, without bearer secrets or result bodies')

  await db.execute(sql`UPDATE mcp_credential SET request_count=${MCP_RATE_LIMIT},request_window=clock_timestamp() WHERE id=${limited.id}::uuid`)
  const throttled = await raw(init, {}, limited.secret); assert.equal(throttled.status, 429); assert.equal(throttled.headers.get('retry-after'), '60')
  await db.execute(sql`UPDATE mcp_credential SET request_window=clock_timestamp()-interval '2 minutes' WHERE id=${limited.id}::uuid`)
  assert.equal((await raw(init, {}, limited.secret)).status, 200)
  await db.execute(sql`UPDATE mcp_credential SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '2 days' WHERE id=${limited.id}::uuid`)
  assert.equal((await raw(init, {}, limited.secret)).status, 401)
  assert.equal(await revokeMcpCredential(issued.id, actor), true)
  assert.equal((await raw(init)).status, 401)
  pass('Rate window, expiry and explicit revocation apply to existing clients')

  const reset = await issueMcpCredential({ userId: owner.id, ledgerId: north.ledger.id, name: 'Reset fixture', days: 1, actor })
  await setPassword({ userId: owner.id, password: 'a new long MCP suite password', actor })
  await assert.rejects(authenticateMcp(`Bearer ${reset.secret}`))
  await setGrants({ userId: clerk.id, entityIds: [north.company.id], modules: ['/reports'], actor })
  const disabled = await issueMcpCredential({ userId: clerk.id, ledgerId: north.ledger.id, name: 'Disabled fixture', days: 1, actor })
  await setUserStatus({ userId: clerk.id, isActive: false, actor }); await setUserStatus({ userId: clerk.id, isActive: true, actor })
  await assert.rejects(authenticateMcp(`Bearer ${disabled.secret}`))
  const role = await issueMcpCredential({ userId: clerk.id, ledgerId: north.ledger.id, name: 'Role fixture', days: 1, actor })
  await setUserKind({ userId: clerk.id, kind: 'owner', actor: owner })
  await assert.rejects(authenticateMcp(`Bearer ${role.secret}`))
  const restore = await issueMcpCredential({ userId: owner.id, ledgerId: north.ledger.id, name: 'Restore fixture', days: 1, actor })
  const countBefore = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM mcp_credential`)
  const exported = await exportCompany(north.company.id), restored = await restoreCompany(exported, actor, { code: 'MCPREST', name: 'MCP restored marker' })
  const countAfter = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM mcp_credential`)
  assert.equal(countBefore[0].n, countAfter[0].n); assert.notEqual(restored.ledgerId, north.ledger.id)
  await db.transaction(tx => pauseRestoredAutomation(tx))
  await assert.rejects(authenticateMcp(`Bearer ${restore.secret}`))
  pass('Password reset, disable/re-enable and whole restore revoke tokens; portable backup copies none')
  console.log('\n=== ALL CHECKS PASSED ===')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  for (const client of clients) await client.close()
  http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()))
  await connection.end()
})

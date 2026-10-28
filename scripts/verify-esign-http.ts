/** Run only against a local server backed by the explicit TEST_DATABASE_URL.
 * This creates synthetic UI fixtures and tests real route authorization. */
import './env'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { db, sql as connection } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { createFirstOwner, createUser, signIn } from '../src/lib/users'
import { setGrantMatrix } from '../src/lib/access'
import { uploadSigningDocument, signingFiles, saveSigningConnection, setSigningDocumentArchived, renameSigningDocument } from '../src/lib/esign'
import { reporter, tinyPdf } from './suite'
import { actingAs } from '../src/lib/acting'

const r = reporter(65)
async function main() {
  const origin = process.env.ESIGN_TEST_ORIGIN
  if (!['http://localhost:3109','http://localhost:3110'].includes(origin ?? '') || !process.env.ATTACHMENTS_DIR?.startsWith('/tmp/') || !new URL(process.env.TEST_DATABASE_URL!).pathname.endsWith('_test')) throw Error('Explicit local signing UI test environment required.')
  const [identity] = await db.execute<{ name: string }>(sql`SELECT current_database() AS name`)
  assert.equal(identity.name, new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1))
  const suffix = randomUUID().slice(0,8), actor = 'esign-owner@example.test', password = 'synthetic signing password only'
  const [owner] = await db.execute(sql`SELECT id FROM app_user WHERE is_owner LIMIT 1`)
  if (!owner) await createFirstOwner({ email: actor, firstName: 'Signing tester', password })
  const A = await createCompanyWithYear({ code: `EHA${suffix}`, name: `Signing Preview ${suffix}` }, actor)
  const B = await createCompanyWithYear({ code: `EHB${suffix}`, name: `Signing Other ${suffix}` }, actor)
  const user = await createUser({ email: `esign-http-${suffix}@example.test`, firstName: 'Documents user', password, actor })
  const other = await createUser({ email: `esign-other-${suffix}@example.test`, firstName: 'Other company user', password, actor })
  const accounting = await createUser({ email: `esign-books-${suffix}@example.test`, firstName: 'Accounting only', password, actor })
  await setGrantMatrix({ userId: user.id, actor, grants: [{ entityId: A.company.id, module: '/documents' }] })
  await setGrantMatrix({ userId: other.id, actor, grants: [{ entityId: B.company.id, module: '/documents' }] })
  await setGrantMatrix({ userId: accounting.id, actor, grants: [{ entityId: A.company.id, module: '/entries' }] })
  const tokens = await Promise.all([actor,user.email,other.email,accounting.email].map(email => signIn({ email, password }).then(x => x.token)))
  const bytes = tinyPdf('Synthetic contract for local UI verification. No real personal data.')
  const documentId = await uploadSigningDocument({ entityId: A.company.id, title: 'Consulting agreement', kind: 'contract', submissionKey: randomUUID(), filename: 'consulting-agreement.pdf', bytes, actor })
  const fileId = (await signingFiles(A.company.id, documentId))[0].id
  const documentPath = `/ledger/${A.ledger.id}/documents/${documentId}`, filePath = `${documentPath}/files/${fileId}`
  const get = (p: string, token?: string, headers: Record<string,string> = {}) => fetch(origin + p, { redirect: 'manual', headers: { ...headers, ...(token ? { cookie: 'erp_session=' + token } : {}) } })
  r.check([302,307].includes((await get(filePath)).status), 'EH1 anonymous PDF request is sent to login')
  r.check((await get(filePath, 'forged-session')).status === 401, 'EH2 forged cookie cannot read a PDF')
  const permitted = await get(filePath,tokens[1]); r.check(permitted.status === 200 && Buffer.from(await permitted.arrayBuffer()).equals(bytes), 'EH3 granted document user receives exact source PDF bytes')
  r.check((await get(filePath,tokens[2])).status === 403 && (await get(filePath,tokens[3])).status === 403, 'EH4 other-company and accounting-only users cannot download')
  r.check((await get(filePath,tokens[2],{'x-erp-path':`/ledger/${B.ledger.id}/documents`})).status === 403, 'EH5 forged path header is replaced by the proxy')
  r.check((await get(`/ledger/${B.ledger.id}/documents/${documentId}/files/${fileId}`,tokens[2])).status === 404, 'EH6 borrowed document/file IDs fail inside an authorized company')
  const userPage = await (await get(`/ledger/${A.ledger.id}/documents`,tokens[1])).text()
  r.check(userPage.includes('Consulting agreement') && !userPage.includes('name="apiKey"'), 'EH7 document user sees documents but no credential form')
  const ownerDocuments = await (await get(`/ledger/${A.ledger.id}/documents`,tokens[0])).text()
  const ownerPage = await (await get(`/settings?ledger=${A.ledger.id}&section=documents`,tokens[0])).text()
  r.check(!ownerDocuments.includes('name="apiKey"') && ownerPage.includes('name="apiKey"') && ownerPage.includes(A.company.name) && ownerPage.includes('Connect Documenso'), 'EH8 owner connection lives in Settings with the selected company')
  const secret = 'synthetic-http-webhook-secret-32-characters-only'
  const hookId = await saveSigningConnection({ entityId: B.company.id, apiKey: 'api_synthetic_http_token_only', webhookSecret: secret, actor }, async () => Response.json({ data: [] }))
  const post = (id: string, body: string, value?: string) => fetch(`${origin}/api/documenso/${id}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...(value ? { 'x-documenso-secret': value } : {}) }, redirect: 'manual' })
  const event = JSON.stringify({ event: 'DOCUMENT_COMPLETED', payload: { envelopeId: 'envelope_synthetic_http' } })
  r.check((await post(hookId,event)).status === 401 && (await post(hookId,event,'wrong')).status === 401 && (await post(randomUUID(),event,secret)).status === 401, 'EH9 webhook refuses missing, wrong and unknown credentials')
  r.check((await post(hookId,event,secret)).status === 200 && (await post(hookId,event,secret)).status === 200, 'EH10 authenticated duplicate webhook is acknowledged without browser login')
  const [events] = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM esign_event WHERE connection_id=${hookId}::uuid`)
  r.check(events.n === '1', 'EH11 duplicate HTTP events persist once')
  r.check((await post(hookId,'broken-json',secret)).status === 400 && (await post(hookId,'x'.repeat(129*1024),secret)).status === 413, 'EH12 invalid and oversized webhook payloads are refused')
  const memberSettings = await (await get(`/settings?ledger=${B.ledger.id}`,tokens[1])).text()
  r.check(!memberSettings.includes('name="apiKey"') && !memberSettings.includes(B.company.name), 'EH13 a non-owner cannot see credentials or another company in Settings')
  await setSigningDocumentArchived({ entityId: A.company.id, documentId, archived: true, actor })
  const activePage = await (await get(`/ledger/${A.ledger.id}/documents`,tokens[1])).text()
  const archivedPage = await (await get(`/ledger/${A.ledger.id}/documents?view=archived`,tokens[1])).text()
  const archivedPdf = await get(filePath,tokens[1])
  r.check(!activePage.includes('Consulting agreement') && archivedPage.includes('Consulting agreement') && archivedPage.includes('Restore') && archivedPdf.status === 200 && Buffer.from(await archivedPdf.arrayBuffer()).equals(bytes), 'EH14 local archiving hides Active rows and retains authorized PDF access')
  await setSigningDocumentArchived({ entityId: A.company.id, documentId, archived: false, actor })
  await renameSigningDocument({ entityId: A.company.id, documentId, title: 'Renamed consulting agreement', actor })
  const renamedList = await (await get(`/ledger/${A.ledger.id}/documents`,tokens[1])).text()
  const renamedDetail = await (await get(documentPath,tokens[1])).text()
  const renamedPdf = await get(filePath,tokens[1])
  r.check(renamedList.includes('Renamed consulting agreement') && renamedDetail.includes('Renamed consulting agreement') && renamedList.includes('Rename document') && renamedDetail.includes('Save name') && !renamedDetail.includes('Open the draft in Documenso to add') && renamedPdf.status === 200 && Buffer.from(await renamedPdf.arrayBuffer()).equals(bytes), 'EH15 renamed list and detail keep the form entry and exact authorized PDF bytes')
  // Synthetic restored history exercises completed filing without a Cloud call.
  await actingAs(actor, tx => tx.execute(sql`INSERT INTO esign_request(entity_id,document_id,operation,remote_status,completed_at,created_by) VALUES(${A.company.id}::uuid,${documentId}::uuid,'DETACHED','COMPLETED','2026-10-04T12:00:00Z',${actor})`))
  const listPath = `/ledger/${A.ledger.id}/documents`, name = 'Renamed consulting agreement'
  const completedActive = await (await get(listPath,tokens[1])).text(), completedList = await (await get(listPath+'?view=completed',tokens[1])).text(), completedDetail = await (await get(documentPath,tokens[1])).text()
  r.check(!completedActive.includes(name) && completedList.includes(name) && completedList.includes('2026-10-04') && completedDetail.includes(`href="${listPath}?view=completed"`), 'EH16 completed documents move out of Active and their detail returns to Completed')
  await setSigningDocumentArchived({ entityId: A.company.id, documentId, archived: true, actor })
  const filedCompleted = await (await get(listPath+'?view=completed',tokens[1])).text(), filedList = await (await get(listPath+'?view=archived',tokens[1])).text(), filedDetail = await (await get(documentPath,tokens[1])).text()
  r.check(!filedCompleted.includes(name) && filedList.includes(name) && filedList.includes('Restore') && filedDetail.includes(`href="${listPath}?view=archived"`), 'EH17 archiving a completed document moves it to Archived and updates its back link')
  await setSigningDocumentArchived({ entityId: A.company.id, documentId, archived: false, actor })
  const restoredCompleted = await (await get(listPath+'?view=completed',tokens[1])).text(), restoredActive = await (await get(listPath,tokens[1])).text(), restoredPdf = await get(filePath,tokens[1])
  r.check(restoredCompleted.includes(name) && !restoredActive.includes(name) && restoredPdf.status === 200 && Buffer.from(await restoredPdf.arrayBuffer()).equals(bytes), 'EH18 Restore returns completed documents to Completed with unchanged PDF access')
  writeFileSync('/tmp/figtree-esign-ui-fixture.json', JSON.stringify({ ledgerId: A.ledger.id, documentId, fileId, documentPath }), { mode: 0o600 })
  console.log(r.summary())
  process.exitCode = r.failures ? 1 : 0
}
main().catch(e => { console.error('Signing HTTP verification failed:', e instanceof Error ? e.message : 'Unexpected error'); process.exitCode = 1 }).finally(() => connection.end())

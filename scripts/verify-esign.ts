/** Local, synthetic provider-contract fixtures. Never contacts Documenso, sends
 * invitations, resets a database, or writes into the application's file root. */
import './env'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import PDFDocument from 'pdfkit'
import { sql } from 'drizzle-orm'
import { db, sql as connection } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { createFirstOwner, createUser } from '../src/lib/users'
import { setGrantMatrix, refuseForLedger } from '../src/lib/access'
import { availableSkills, skillForNavPath } from '../src/lib/assistant-skills'
import { archiveCompany, deleteCompany } from '../src/lib/companies'
import { actingAs } from '../src/lib/acting'
import { exportCompany, packFigtree, readFigtree, restoreCompany, restorePaper } from '../src/lib/backup'
import { DOCUMENSO_HOST, documenso, DocumensoError, snapshotOf, editorUrl, type ProviderFetch } from '../src/lib/documenso'
import { connectionSummary, saveSigningConnection, webhookConnection, webhookSecretMatches, uploadSigningDocument, signingDocument, signingDocuments, signingFiles, signingRequest, prepareSigningRequest, synchronizeSigningRequest, receiveSigningEvent, reconcileSigningRequests, recipientsFromForm, setSigningDocumentArchived, renameSigningDocument, EsignError } from '../src/lib/esign'
import { keepSigningBytes, signingBytes, pdfHash } from '../src/lib/esign-storage'
import { reporter } from './suite'
import { documentView } from '../src/lib/esign-types'

const r = reporter(68)
let checks = 0
function verify(ok: unknown, label: string) { checks++; r.check(Boolean(ok), `ES${checks} ${label}`) }
async function refused(work: () => Promise<unknown>, code?: string) { try { await work(); return false } catch (e) { return code ? e instanceof EsignError && e.code === code : true } }
const json = (value: unknown, status = 200) => Response.json(value, { status })
const recipient = { name: 'Synthetic Signer', email: 'signer@example.test', role: 'SIGNER' as const, signingOrder: 1 }
async function pdf(text: string) {
  return new Promise<Buffer>(resolve => { const doc = new PDFDocument({ compress: false }), chunks: Buffer[] = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.text(text); doc.end() })
}
async function glSnapshot() {
  const rows = []
  for (const t of ['journal_entry','journal_line','invoice','invoice_line','bank_transaction','pay_run','pay_stub']) rows.push(await db.execute(sql`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${sql.raw(t)} t`))
  return JSON.stringify(rows)
}

async function main() {
  const test = process.env.TEST_DATABASE_URL, live = process.env.APP_DATABASE_URL
  if (!test || !live) throw Error('Explicit separate test and application database identities are required.')
  const t = new URL(test), a = new URL(live)
  if (!t.pathname.endsWith('_test') || !['localhost','127.0.0.1','[::1]'].includes(t.hostname) || t.host === a.host && t.pathname === a.pathname) throw Error('Signing tests refused: database isolation is not proven.')
  const [identity] = await db.execute<{ name: string }>(sql`SELECT current_database() AS name`)
  assert.equal(identity.name, t.pathname.slice(1))
  const originalRoot = process.env.ATTACHMENTS_DIR
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figtree-esign-'))
  process.env.ATTACHMENTS_DIR = root
  process.env.DOCUMENSO_KEY_SECRET = 'synthetic-test-encryption-key-32-characters-only'
  const token = 'api_synthetic_signing_token_only', secret = 'synthetic-webhook-secret-32-characters-only'
  const actor = 'esign-owner@example.test', suffix = randomUUID().slice(0,8)
  const [owner] = await db.execute(sql`SELECT id FROM app_user WHERE is_owner LIMIT 1`)
  if (!owner) await createFirstOwner({ email: actor, firstName: 'Signing tester', password: 'synthetic signing password only' })
  const user = await createUser({ email: `esign-${suffix}@example.test`, firstName: 'Signing only', password: 'synthetic seat password only', actor })
  const A = await createCompanyWithYear({ code: `ESA${suffix}`, name: `Signing Alpha Test ${suffix}` }, actor)
  const B = await createCompanyWithYear({ code: `ESB${suffix}`, name: `Signing Beta Test ${suffix}` }, actor)
  const entityId = A.company.id, ledgerId = A.ledger.id
  await setGrantMatrix({ userId: user.id, actor, grants: [{ entityId, module: '/documents' }] })
  verify(await refuseForLedger(user, ledgerId, '/documents') === null && (await refuseForLedger(user, ledgerId, '/entries'))?.code === 'NO_MODULE' && await refuseForLedger(user, B.ledger.id, '/documents') !== null, 'document seat has one-company scope and no GL access')
  verify(skillForNavPath('/documents')?.tools.join(',') === 'module_link' && (await availableSkills(ledgerId,user)).some(s => s.id === 'documents') && !(await availableSkills(B.ledger.id,user)).some(s => s.id === 'documents'), 'Assistant exposes a permission-scoped navigation skill only')
  const glBefore = await glSnapshot()
  const source = await pdf('Synthetic contract. Signer: __________________ Date: __________'), original = await pdf('Synthetic prepared PDF'), signed = await pdf('Synthetic signed PDF'), certificate = await pdf('Synthetic certificate'), audit = await pdf('Synthetic audit log')
  const envelopes = new Map<string, Record<string, unknown>>()
  const calls: { path: string; method: string }[] = []
  let createCount = 0, createMode: 'ok'|'timeout'|'refused' = 'ok', certificateFailure = false, observedPayload: Record<string, unknown> = {}
  const send: ProviderFetch = async (url, init) => {
    const u = new URL(String(url)); assert.equal(u.origin, DOCUMENSO_HOST)
    assert.equal(new Headers(init?.headers).get('authorization'), token)
    calls.push({ path: u.pathname + u.search, method: init?.method || 'GET' })
    if (u.pathname === '/api/v2/envelope/create') {
      createCount++
      if (createMode === 'refused') return json({ message: token + ' echoed private contents' }, 403)
      assert.ok(init?.body instanceof FormData)
      observedPayload = JSON.parse(String(init.body.get('payload')))
      const file = init.body.get('files'); assert.ok(file instanceof File); assert.ok(Buffer.from(await file.arrayBuffer()).equals(source))
      const id = 'envelope_' + randomUUID(), reference = String(observedPayload.externalId)
      envelopes.set(id, { id, type: 'DOCUMENT', status: 'DRAFT', title: 'Synthetic contract', externalId: reference, team: { id: 1, url: 'synthetic-team' }, completedAt: null,
        recipients: [{ ...recipient, id: 1, token: 'PRIVATE_SIGNING_CAPABILITY', signingStatus: 'NOT_SIGNED', signedAt: null }],
        envelopeItems: [{ id: 'envelope_item_' + id.slice(9), title: 'contract.pdf' }],
        fields: [{ id: 1, recipientId: 1, envelopeItemId: 'envelope_item_' + id.slice(9), type: 'SIGNATURE', page: 1, positionX: '10', positionY: '80', width: '30', height: '8', customText: 'PRIVATE_SIGNATURE_IMAGE' }] })
      if (createMode === 'timeout') throw Error('Simulated lost create response')
      return json({ id })
    }
    if (u.pathname === '/api/v2/envelope') return json({ data: [...envelopes.values()], totalPages: 1 })
    if (u.pathname.endsWith('/certificate/download')) return certificateFailure ? json({},503) : new Response(new Uint8Array(certificate))
    if (u.pathname.endsWith('/audit-log/download')) return new Response(new Uint8Array(audit))
    if (u.pathname.startsWith('/api/v2/envelope/item/')) return new Response(new Uint8Array(u.searchParams.get('version') === 'signed' ? signed : original))
    return json(envelopes.get(decodeURIComponent(u.pathname.split('/').at(-1)!)))
  }
  try {
    const connectionId = await saveSigningConnection({ entityId, apiKey: token, webhookSecret: secret, actor }, send)
    const summary = await connectionSummary(entityId), hook = await webhookConnection(connectionId)
    const [stored] = await db.execute<{ key_enc: Buffer; webhook_hash: string }>(sql`SELECT key_enc,webhook_hash FROM esign_connection WHERE id=${connectionId}::uuid`)
    verify(summary?.readable && !JSON.stringify(summary).includes(token) && !Buffer.from(stored.key_enc).toString().includes(token) && stored.webhook_hash === pdfHash(Buffer.from(secret)), 'token encrypted, webhook secret hashed, summary contains neither')
    verify(hook && webhookSecretMatches(secret, hook.webhook_hash) && !webhookSecretMatches('wrong', hook.webhook_hash) && !webhookSecretMatches(null, hook.webhook_hash) && await webhookConnection('------------------------------------') === null, 'webhook shared-secret comparison fails closed')
    const input = { entityId, title: 'Synthetic contract', kind: 'contract', note: 'Local verification only', submissionKey: randomUUID(), filename: '../contract.pdf', bytes: source, actor }
    const documentId = await uploadSigningDocument(input)
    verify(await uploadSigningDocument(input) === documentId && (await signingFiles(entityId, documentId))[0].filename === 'contract.pdf', 'upload retry is idempotent and filename cannot traverse directories')
    verify(await refused(() => uploadSigningDocument({ ...input, title: 'Changed title' }), 'REPLAY') && await refused(() => uploadSigningDocument({ ...input, submissionKey: randomUUID(), bytes: Buffer.from('Word file') }), 'FILE'), 'changed replay and non-PDF upload are refused')
    verify(await refused(() => signingDocument(B.company.id, documentId), 'DOCUMENT') && (await signingFiles(B.company.id, documentId)).length === 0 && (await signingDocuments(B.company.id)).length === 0, 'foreign company cannot read document metadata or files')
    verify(await refused(() => db.execute(sql`UPDATE esign_document SET title='Tampered' WHERE id=${documentId}::uuid`)) && await refused(() => db.execute(sql`DELETE FROM esign_file WHERE document_id=${documentId}::uuid`)), 'source documents and evidence rows reject direct mutation')
    const form = new FormData(); for (const [k,v] of Object.entries({ recipientName: recipient.name, recipientEmail: recipient.email, recipientRole: recipient.role })) form.append(k,v)
    verify(recipientsFromForm(form).length === 1, 'recipient form parses an explicit signing role')
    for (const [k,v] of Object.entries({ recipientName: recipient.name, recipientEmail: recipient.email, recipientRole: recipient.role })) form.append(k,v)
    let invalid = false; try { recipientsFromForm(form) } catch { invalid = true }; verify(invalid, 'duplicate recipient email is refused')
    const base = { entityId, documentId, recipients: [recipient], sequential: true, actor }
    const prepared = await Promise.allSettled([prepareSigningRequest(base, send), prepareSigningRequest(base, send)])
    let request = (await signingRequest(entityId, documentId))!
    verify(createCount === 1 && prepared[0].status === 'fulfilled' && prepared[1].status === 'fulfilled' && prepared[0].value === prepared[1].value && request.operation === 'LINKED', 'concurrent preparation creates exactly one remote draft')
    const meta = observedPayload.meta as Record<string, unknown>
    verify(observedPayload.externalId === request.id && meta.signingOrder === 'SEQUENTIAL' && meta.dateFormat === 'yyyy-MM-dd' && !calls.some(c => /distribute|send|sign$/.test(c.path)), 'draft creation sets reference/date format and never sends or signs')
    verify(!JSON.stringify(request.snapshot).includes('PRIVATE_') && request.snapshot?.fields[0].x === 10 && editorUrl(request)?.startsWith(DOCUMENSO_HOST + '/t/synthetic-team/documents/'), 'snapshot strips signing tokens/images and links only to Cloud')
    verify(await refused(() => db.execute(sql`DELETE FROM esign_request WHERE id=${request.id}::uuid`)), 'recorded provider request cannot be deleted and recreated')
    const remote = envelopes.get(request.remote_id!)!
    remote.status = 'PENDING'
    await receiveSigningEvent(hook!, Buffer.from(JSON.stringify({ event: 'DOCUMENT_COMPLETED', payload: { envelopeId: request.remote_id, status: 'COMPLETED' } })))
    verify((await signingRequest(entityId, documentId))?.remote_status === 'DRAFT', 'webhook body cannot assert completion')
    await synchronizeSigningRequest(entityId, documentId, actor, send)
    verify((await signingFiles(entityId, documentId)).some(f => f.kind === 'original') && (await signingRequest(entityId, documentId))?.remote_status === 'PENDING', 'authoritative pending state archives provider-prepared original')
    verify(await refused(() => uploadSigningDocument({ ...input, submissionKey: randomUUID(), supersedesId: documentId }), 'ACTIVE'), 'replacement is refused while signing is pending')
    remote.status = 'COMPLETED'; remote.completedAt = '2026-10-03T12:00:00Z'; certificateFailure = true
    const event = Buffer.from(JSON.stringify({ event: 'DOCUMENT_COMPLETED', payload: { envelopeId: request.remote_id } }))
    await receiveSigningEvent(hook!, event); await receiveSigningEvent(hook!, event)
    const [events] = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM esign_event WHERE connection_id=${connectionId}::uuid AND event_hash=${pdfHash(event)}`)
    verify(events.n === '1', 'duplicate webhook notifications are durably deduplicated')
    verify(await refused(() => synchronizeSigningRequest(entityId, documentId, actor, send)) && !(await signingRequest(entityId, documentId))?.archived_at && (await signingFiles(entityId, documentId)).some(f => f.kind === 'signed'), 'partial archive preserves signed bytes and remains visibly incomplete')
    const pendingEvidence = await signingDocument(entityId,documentId)
    verify(!(await signingDocuments(entityId)).some(d => d.id === documentId) && (await signingDocuments(entityId,'completed')).some(d => d.id === documentId) && pendingEvidence.completed_at?.startsWith('2026-10-03') && documentView(pendingEvidence) === 'completed' && (await signingDocuments(B.company.id,'completed')).length === 0, 'confirmed completion moves out of Active before evidence finishes and stays company scoped')
    const signedDownloads = calls.filter(c => c.path.includes('version=signed')).length
    certificateFailure = false; await archiveCompany(entityId, 'Synthetic archive test', actor)
    await synchronizeSigningRequest(entityId, documentId, actor, send)
    request = (await signingRequest(entityId, documentId))!
    verify(request.archived_at && (await signingFiles(entityId, documentId)).length === 5 && calls.filter(c => c.path.includes('version=signed')).length === signedDownloads, 'completion retries missing evidence only, even for archived company')
    const certificateFile = (await signingFiles(entityId, documentId)).find(f => f.kind === 'certificate')!
    const certificatePath = path.join(root,A.company.name,'blobs',certificateFile.sha256)
    const certificateBytes = await fs.readFile(certificatePath); await fs.writeFile(certificatePath,'%PDF-1.7\nCorrupted certificate.')
    verify(await refused(() => synchronizeSigningRequest(entityId,documentId,actor,send),'ARCHIVE') && !(await signingRequest(entityId,documentId))?.archived_at, 'damaged retained evidence revokes archive-complete status')
    await fs.writeFile(certificatePath,certificateBytes); await synchronizeSigningRequest(entityId,documentId,actor,send)
    verify((await signingRequest(entityId,documentId))?.archived_at, 'verified restored evidence permits archive completion again')
    verify(await refused(() => uploadSigningDocument({ ...input, submissionKey: randomUUID() }), 'ARCHIVED'), 'archived company refuses a new document')
    remote.status = 'PENDING'
    verify(await refused(() => synchronizeSigningRequest(entityId, documentId, actor, send), 'STATE') && await refused(() => actingAs(actor, tx => tx.execute(sql`SELECT set_config('app.esign_sync','on',true)`).then(() => tx.execute(sql`UPDATE esign_request SET remote_status='PENDING' WHERE id=${request.id}::uuid`)))), 'finished request cannot regress through API or direct SQL')
    remote.status = 'COMPLETED'
    const archive = readFigtree(await packFigtree(await exportCompany(entityId, { withFiles: true })))
    const serialized = JSON.stringify(archive)
    verify(archive.rows.esign_document.length === 1 && archive.rows.esign_file.length === 5 && archive.files.length >= 5 && !serialized.includes(token) && !serialized.includes(secret) && !archive.rows.esign_connection, 'company export carries evidence and omits live credentials')
    const restored = await restoreCompany(archive, actor, { code: `ESC${suffix}`, name: `Signing Restored Test ${suffix}` })
    await restorePaper(archive, restored.name, restored.ledgerId, restored)
    const restoredDoc = (await signingDocuments(restored.entityId,'completed'))[0], restoredRequest = (await signingRequest(restored.entityId, restoredDoc.id))!
    const beforeCalls = calls.length
    verify(restoredRequest.operation === 'DETACHED' && restoredRequest.connection_id === null && await refused(() => synchronizeSigningRequest(restored.entityId, restoredDoc.id, actor, send), 'DETACHED') && calls.length === beforeCalls, 'restored history cannot contact or reconnect to original request')
    verify(documentView(restoredDoc) === 'completed' && (await signingDocuments(restored.entityId)).length === 0 && restoredDoc.completed_at === (await signingDocument(entityId,documentId)).completed_at, 'restored completed history retains its completion date and Completed category')
    for (const file of await signingFiles(restored.entityId, restoredDoc.id)) verify(pdfHash(await signingBytes(`Signing Restored Test ${suffix}`, file.sha256)) === file.sha256, `restored ${file.kind} bytes match original digest`)
    verify(await refused(() => deleteCompany(restored.entityId, actor)), 'company containing signing history cannot be deleted')
    const doc2 = await uploadSigningDocument({ ...input, entityId: B.company.id, submissionKey: randomUUID() })
    await saveSigningConnection({ entityId: B.company.id, apiKey: token, webhookSecret: secret, actor }, send)
    createMode = 'timeout'
    verify(await refused(() => prepareSigningRequest({ ...base, entityId: B.company.id, documentId: doc2 }, send)) && (await signingRequest(B.company.id, doc2))?.operation === 'UNCERTAIN', 'lost create response persists an uncertain operation')
    const count = createCount
    await prepareSigningRequest({ ...base, entityId: B.company.id, documentId: doc2 }, send)
    verify(createCount === count, 'uncertain request retry never repeats provider creation')
    await synchronizeSigningRequest(B.company.id, doc2, actor, send)
    verify((await signingRequest(B.company.id, doc2))?.operation === 'LINKED', 'recovery matches exact external reference after a lost response')
    const doc3 = await uploadSigningDocument({ ...input, entityId: B.company.id, submissionKey: randomUUID() }); createMode = 'refused'
    verify(await refused(() => prepareSigningRequest({ ...base, entityId: B.company.id, documentId: doc3 }, send)) && (await signingRequest(B.company.id, doc3))?.operation === 'LOCAL' && !(await signingRequest(B.company.id, doc3))?.last_error?.includes(token), 'definitive rejection permits retry and redacts provider error body')
    createMode = 'ok'; await prepareSigningRequest({ ...base, entityId: B.company.id, documentId: doc3 }, send)
    const recovered = (await signingRequest(B.company.id, doc2))!, missingRemote = envelopes.get(recovered.remote_id!)!; envelopes.delete(recovered.remote_id!)
    const doc4 = await uploadSigningDocument({ ...input, entityId: B.company.id, submissionKey: randomUUID() }); createMode = 'timeout'
    await refused(() => prepareSigningRequest({ ...base, entityId: B.company.id, documentId: doc4 }, send))
    const unresolved = (await signingRequest(B.company.id, doc4))!, unresolvedRemote = [...envelopes.values()].find(v => v.externalId === unresolved.id)!
    envelopes.delete(String(unresolvedRemote.id)); const createsBeforeRecovery = createCount
    verify(await refused(() => synchronizeSigningRequest(B.company.id, doc4, actor, send), 'UNCERTAIN') && createCount === createsBeforeRecovery && (await signingRequest(B.company.id, doc4))?.operation === 'UNCERTAIN', 'missing recovery match remains uncertain without blind resend')
    envelopes.set(recovered.remote_id!, missingRemote); envelopes.set(String(unresolvedRemote.id), unresolvedRemote)
    await db.execute(sql`UPDATE esign_request SET next_sync_at=now() WHERE entity_id=${B.company.id}::uuid`)
    const sync = await reconcileSigningRequests(20, send)
    verify(sync.updated >= 3 && sync.failed === 0 && createCount === createsBeforeRecovery, 'scheduled reconciliation reads provider state without creating requests')
    const badProvider: ProviderFetch = async () => new Response('not a PDF')
    verify(await refused(() => documenso(token, badProvider).pdf('/envelope/test/certificate/download')), 'non-PDF provider evidence is refused')
    const paging: ProviderFetch = async url => { const page = new URL(String(url)).searchParams.get('page'); return json(page === '1' ? { data: Array.from({ length: 100 }, (_,i) => ({ id: 'envelope_dummy' + i, externalId: 'other' })), totalPages: 2 } : { data: [{ id: 'envelope_recovered', externalId: 'needle' }], totalPages: 2 }) }
    verify(await documenso(token, paging).recover('needle') === 'envelope_recovered', 'recovery searches subsequent team pages')
    const duplicate: ProviderFetch = async () => json({ data: [{ id: 'envelope_one', externalId: 'needle' }, { id: 'envelope_two', externalId: 'needle' }] })
    verify(await refused(() => documenso(token, duplicate).recover('needle')), 'duplicate external references require manual review')
    let badSnapshot = false; try { snapshotOf({ ...remote, fields: [{ id: 1, recipientId: 1, page: 'NaN' }] }) } catch (e) { badSnapshot = e instanceof DocumensoError }; verify(badSnapshot, 'invalid numeric field coordinates are refused')
    const sourceSha = pdfHash(source), filePath = path.join(root, A.company.name, 'blobs', sourceSha)
    const fileBytes = await fs.readFile(filePath); await fs.writeFile(filePath, '%PDF-1.7\nDamaged but still has a PDF header.')
    verify(await refused(() => signingBytes(A.company.name, sourceSha)) && await refused(() => keepSigningBytes(A.company.name, source)), 'damaged local bytes cannot be downloaded or silently overwritten')
    await fs.writeFile(filePath, fileBytes)
    verify(await glSnapshot() === glBefore, 'document lifecycle leaves accounting and payroll rows unchanged')
    verify(!JSON.stringify(await db.execute(sql`SELECT before,after FROM audit_log WHERE entity_id=${entityId}::uuid`)).includes(token), 'audit history never contains the Cloud API token')
    const filingInput = { ...input, entityId: B.company.id, submissionKey: randomUUID() }
    const filingId = await uploadSigningDocument(filingInput)
    const filing = { entityId: B.company.id, documentId: filingId, actor }, beforeFiling = await signingFiles(B.company.id, filingId)
    await setSigningDocumentArchived({ ...filing, archived: true })
    const archivedDocument = await signingDocument(B.company.id, filingId)
    verify(archivedDocument.document_archived_at && !(await signingDocuments(B.company.id)).some(d => d.id === filingId) && (await signingDocuments(B.company.id,'archived')).some(d => d.id === filingId) && JSON.stringify(await signingFiles(B.company.id,filingId)) === JSON.stringify(beforeFiling) && (await signingBytes(B.company.name,beforeFiling[0].sha256)).equals(source), 'local archive moves a document out of Active and keeps exact PDF bytes')
    await setSigningDocumentArchived({ ...filing, archived: true })
    const [filingAudit] = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM audit_log WHERE record_id::text=${filingId} AND action='archive_signing_document'`)
    verify(filingAudit.n === '1' && (await signingDocument(B.company.id,filingId)).document_archived_at === archivedDocument.document_archived_at, 'archive replay preserves its date and writes one audit event')
    verify(await refused(() => setSigningDocumentArchived({ ...filing, documentId, archived: true }), 'DOCUMENT') && await refused(() => actingAs(actor, tx => tx.execute(sql`UPDATE esign_document SET title='Changed content',document_archived_at=NULL WHERE id=${filingId}::uuid`))) && (await signingDocument(B.company.id,filingId)).title === input.title, 'local filing remains company scoped and cannot alter immutable content')
    const createsBeforeFiling = createCount
    verify(await refused(() => prepareSigningRequest({ ...base, ...filing }, send), 'DOCUMENT_ARCHIVED') && await refused(() => uploadSigningDocument({ ...input, entityId: B.company.id, submissionKey: randomUUID(), supersedesId: filingId }), 'DOCUMENT_ARCHIVED') && await refused(() => actingAs(actor, tx => tx.execute(sql`INSERT INTO esign_request(entity_id,document_id,created_by) VALUES(${B.company.id}::uuid,${filingId}::uuid,${actor})`))) && createCount === createsBeforeFiling && await signingRequest(B.company.id,filingId) === null, 'archived documents cannot create requests or versions through services or SQL')
    const portableFiling = readFigtree(await packFigtree(await exportCompany(B.company.id, { withFiles: true })))
    verify(portableFiling.rows.esign_document.some(d => String(d.id) === filingId && Boolean(d.document_archived_at)), 'company backup retains the local document filing state')
    await setSigningDocumentArchived({ ...filing, archived: false })
    verify((await signingDocument(B.company.id,filingId)).document_archived_at === null && (await signingDocuments(B.company.id)).some(d => d.id === filingId) && !(await signingDocuments(B.company.id,'archived')).some(d => d.id === filingId) && (await signingBytes(B.company.name,beforeFiling[0].sha256)).equals(source), 'Restore returns the same document and bytes to Active')
    const ongoing = { entityId: B.company.id, documentId: doc3, actor }, ongoingRequest = (await signingRequest(B.company.id,doc3))!
    await setSigningDocumentArchived({ ...ongoing, archived: true })
    envelopes.get(ongoingRequest.remote_id!)!.status = 'PENDING'
    await synchronizeSigningRequest(B.company.id,doc3,actor,send)
    verify((await signingRequest(B.company.id,doc3))?.remote_status === 'PENDING' && (await signingDocument(B.company.id,doc3)).document_archived_at && createCount === createsBeforeFiling, 'an archived document keeps synchronizing its existing signing request')
    verify(await refused(() => setSigningDocumentArchived({ entityId, documentId, archived: true, actor }), 'ARCHIVED') && await glSnapshot() === glBefore, 'archived-company filing is refused and document filing never changes accounting')
    const filedArchive = readFigtree(await packFigtree(await exportCompany(B.company.id, { withFiles: true })))
    const filedCopy = await restoreCompany(filedArchive, actor, { code: `ESD${suffix}`, name: `Signing Filed Copy ${suffix}` })
    await restorePaper(filedArchive, filedCopy.name, filedCopy.ledgerId, filedCopy)
    const filedDocument = (await signingDocuments(filedCopy.entityId,'archived'))[0], filedRequest = await signingRequest(filedCopy.entityId,filedDocument.id)
    const callsBeforeFiledCopy = calls.length
    verify(filedDocument.document_archived_at && filedRequest?.operation === 'DETACHED' && filedRequest.connection_id === null && (await signingBytes(filedCopy.name,sourceSha)).equals(source) && await refused(() => synchronizeSigningRequest(filedCopy.entityId,filedDocument.id,actor,send),'DETACHED') && calls.length === callsBeforeFiledCopy, 'a locally archived document restores with exact bytes and detached history')
    const renamedTitle = '批准备忘录 · July'
    await renameSigningDocument({ ...filing, title: '  ' + renamedTitle + '  ' })
    const renamedDocument = await signingDocument(B.company.id,filingId)
    const [uploadIdentity] = await db.execute<{ title: string; submission_key: string }>(sql`SELECT title,submission_key::text FROM esign_document WHERE id=${filingId}::uuid`)
    verify(renamedDocument.title === renamedTitle && (await signingDocuments(B.company.id)).find(d => d.id === filingId)?.title === renamedTitle && uploadIdentity.title === input.title && uploadIdentity.submission_key === filingInput.submissionKey && renamedDocument.revision === archivedDocument.revision && JSON.stringify(await signingFiles(B.company.id,filingId)) === JSON.stringify(beforeFiling) && (await signingBytes(B.company.name,sourceSha)).equals(source), 'renaming updates the displayed name and preserves upload identity and exact PDF bytes')
    await renameSigningDocument({ ...filing, title: renamedTitle })
    const renameAudit = await db.execute<{ before: { title: string }; after: { title: string } }>(sql`SELECT before,after FROM audit_log WHERE record_id::text=${filingId} AND action='rename_signing_document'`)
    verify(renameAudit.length === 1 && renameAudit[0].before.title === input.title && renameAudit[0].after.title === renamedTitle, 'rename replay writes one before-and-after audit event')
    verify(await refused(() => renameSigningDocument({ ...filing, title: '  ' }), 'TITLE') && await refused(() => renameSigningDocument({ ...filing, title: 'x'.repeat(181) }), 'TITLE') && await refused(() => renameSigningDocument({ ...filing, documentId, title: 'Foreign' }), 'DOCUMENT') && await refused(() => renameSigningDocument({ entityId, documentId, title: 'Read-only', actor }), 'ARCHIVED') && (await signingDocument(B.company.id,filingId)).title === renamedTitle, 'invalid names, foreign-company IDs and archived-company renames are refused')
    verify(await uploadSigningDocument(filingInput) === filingId && (await signingDocument(B.company.id,filingId)).title === renamedTitle && await refused(() => uploadSigningDocument({ ...filingInput, title: renamedTitle }), 'REPLAY'), 'renaming preserves original upload replay without accepting a changed submission')
    const beforeRenameRequest = JSON.stringify(await signingRequest(B.company.id,doc3)), beforeRenameCalls = calls.length
    const beforeRenameFiling = (await signingDocument(B.company.id,doc3)).document_archived_at
    await renameSigningDocument({ ...ongoing, title: 'Renamed pending contract' })
    verify((await signingDocuments(B.company.id,'archived')).find(d => d.id === doc3)?.title === 'Renamed pending contract' && (await signingDocument(B.company.id,doc3)).document_archived_at === beforeRenameFiling && JSON.stringify(await signingRequest(B.company.id,doc3)) === beforeRenameRequest && calls.length === beforeRenameCalls, 'an archived document can be renamed without changing or contacting its pending signing request')
    const renamedArchive = readFigtree(await packFigtree(await exportCompany(B.company.id, { withFiles: true })))
    const renamedCopy = await restoreCompany(renamedArchive, actor, { code: `ESE${suffix}`, name: `Signing Renamed Copy ${suffix}` })
    await restorePaper(renamedArchive, renamedCopy.name, renamedCopy.ledgerId, renamedCopy)
    const copiedName = (await signingDocuments(renamedCopy.entityId,'archived')).find(d => d.title === 'Renamed pending contract')
    verify(copiedName && (await signingRequest(renamedCopy.entityId,copiedName.id))?.operation === 'DETACHED' && (await signingBytes(renamedCopy.name,sourceSha)).equals(source) && calls.length === beforeRenameCalls && await glSnapshot() === glBefore, 'company backup restores renamed documents with exact bytes and detached history without changing accounting')
    await actingAs(actor, tx => tx.execute(sql`INSERT INTO esign_request(entity_id,document_id,operation,remote_status,completed_at,created_by) VALUES(${B.company.id}::uuid,${filingId}::uuid,'DETACHED','COMPLETED','2026-10-04T12:00:00Z',${actor})`))
    await setSigningDocumentArchived({ ...filing, archived: true })
    verify((await signingDocuments(B.company.id,'archived')).some(d => d.id === filingId) && !(await signingDocuments(B.company.id,'completed')).some(d => d.id === filingId) && !(await signingDocuments(B.company.id)).some(d => d.id === filingId) && documentView(await signingDocument(B.company.id,filingId)) === 'archived', 'local archive takes precedence over Completed without duplicating the document')
    await setSigningDocumentArchived({ ...filing, archived: false })
    verify((await signingDocuments(B.company.id,'completed')).some(d => d.id === filingId) && !(await signingDocuments(B.company.id)).some(d => d.id === filingId) && !(await signingDocuments(B.company.id,'archived')).some(d => d.id === filingId) && documentView(await signingDocument(B.company.id,filingId)) === 'completed' && (await signingBytes(B.company.name,sourceSha)).equals(source), 'restoring a completed document returns it to Completed and preserves exact bytes')
    const unsignedId = await uploadSigningDocument({ ...filingInput, submissionKey: randomUUID() })
    await actingAs(actor, tx => tx.execute(sql`UPDATE esign_request SET remote_status=CASE WHEN document_id=${doc2}::uuid THEN 'REJECTED' ELSE 'CANCELLED' END WHERE entity_id=${B.company.id}::uuid AND document_id IN (${doc2}::uuid,${doc4}::uuid)`))
    const active = await signingDocuments(B.company.id), completed = await signingDocuments(B.company.id,'completed')
    verify([unsignedId,doc2,doc4].every(id => active.some(d => d.id === id) && !completed.some(d => d.id === id)) && calls.length === beforeRenameCalls && await glSnapshot() === glBefore, 'unsigned, rejected and cancelled documents remain Active and classification contacts no provider')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
    if (originalRoot === undefined) delete process.env.ATTACHMENTS_DIR; else process.env.ATTACHMENTS_DIR = originalRoot
  }
}
main().then(() => { console.log(r.summary()); process.exitCode = r.failures ? 1 : 0 }).catch(e => { console.error('FAIL signing verification:', e instanceof Error ? e.message : 'Unexpected failure'); process.exitCode = 1 }).finally(() => connection.end())

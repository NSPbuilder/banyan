import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs, type Tx } from './acting'
import { auditRow } from './audit-row'
import { encryptKey, decryptKey } from './ai-service'
import { documenso, DocumensoError, envelopeId, type ProviderFetch } from './documenso'
import { DOCUMENT_KINDS, type ConnectionSummary, type DocumentKind, type DocumentView, type Recipient, type SigningDocument, type SigningFile, type SigningRequest, type SigningSnapshot } from './esign-types'
import { assertSigningPdf, keepSigningBytes, signingBytes, signingFilename, pdfHash } from './esign-storage'

export class EsignError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'EsignError' }
}
export const signingId = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new EsignError('ID', 'That document identifier is invalid.')
  return id
}
export function signingSentence(error: unknown) {
  if (error instanceof EsignError || error instanceof DocumensoError) return error.message
  return 'The document operation could not be completed. Refresh its status before trying again.'
}
function encryptionSecret() { return (process.env.DOCUMENSO_KEY_SECRET || process.env.AI_KEY_SECRET || '').trim() }
export function signingSecretReady() { return encryptionSecret().length >= 32 }
export type SigningCompany = { id: string; name: string; archived_at: string | null }
export async function signingCompany(ledgerId: string): Promise<SigningCompany> {
  const [company] = await db.execute<SigningCompany>(sql`SELECT e.id::text,e.name,e.archived_at::text FROM entity e JOIN ledger l ON l.entity_id=e.id WHERE l.id=${signingId(ledgerId)}::uuid`)
  if (!company) throw new EsignError('COMPANY', 'That company is not on file.')
  return company
}
async function companyFor(tx: Tx, entityId: string, write = false): Promise<SigningCompany> {
  const [company] = await tx.execute<SigningCompany>(sql`SELECT id::text,name,archived_at::text FROM entity WHERE id=${signingId(entityId)}::uuid FOR SHARE`)
  if (!company) throw new EsignError('COMPANY', 'That company is not on file.')
  if (write && company.archived_at) throw new EsignError('ARCHIVED', 'This company is archived. Its documents are read-only.')
  return company
}
type Connection = { id: string; entity_id: string; key_enc: Buffer; webhook_hash: string; enabled: boolean; updated_at: string }
async function connectionFor(entityId: string): Promise<Connection | null> {
  const [row] = await db.execute<Connection>(sql`SELECT id::text,entity_id::text,key_enc,webhook_hash,enabled,updated_at::text FROM esign_connection WHERE entity_id=${signingId(entityId)}::uuid`)
  return row ?? null
}
function keyOf(row: Connection | null) {
  if (!row?.enabled) throw new EsignError('CONNECTION', 'Ask the owner to connect this company to Documenso Cloud first.')
  const key = signingSecretReady() ? decryptKey(Buffer.from(row.key_enc), encryptionSecret()) : null
  if (!key) throw new EsignError('KEY', 'The saved Documenso token cannot be read. The owner must enter it again.')
  return key
}
export async function connectionSummary(entityId: string): Promise<ConnectionSummary> {
  const row = await connectionFor(entityId)
  return row ? { id: row.id, enabled: row.enabled, readable: signingSecretReady() && decryptKey(Buffer.from(row.key_enc), encryptionSecret()) !== null, updated_at: row.updated_at } : null
}
export async function saveSigningConnection(input: { entityId: string; apiKey: string; webhookSecret: string; actor: string }, send?: ProviderFetch) {
  if (!signingSecretReady()) throw new EsignError('SECRET', 'The administrator must set a random DOCUMENSO_KEY_SECRET (or the existing AI_KEY_SECRET) before saving a token.')
  const old = await connectionFor(input.entityId)
  const key = input.apiKey.trim() || (old ? keyOf(old) : '')
  if (!/^api_[A-Za-z0-9_-]{8,}$/.test(key)) throw new EsignError('KEY', 'Enter the full Documenso team API token, beginning with api_.')
  const secret = input.webhookSecret.trim()
  if (!old && secret.length < 32 || secret && secret.length < 32) throw new EsignError('SECRET', 'Use a webhook secret with at least 32 characters.')
  await documenso(key, send).check()
  // Replacing credentials must not silently move existing requests to another team.
  const [active] = await db.execute<{ remote_id: string; id: string }>(sql`SELECT id::text,remote_id FROM esign_request WHERE entity_id=${input.entityId}::uuid AND operation='LINKED' AND remote_status IN ('DRAFT','PENDING') LIMIT 1`)
  if (active && (await documenso(key, send).get(active.remote_id)).externalId !== active.id) throw new EsignError('TEAM', 'This token does not belong to the team managing this company’s active signing requests.')
  return actingAs(input.actor, async tx => {
    await companyFor(tx, input.entityId, true)
    const [row] = await tx.execute<{ id: string }>(sql`INSERT INTO esign_connection(entity_id,key_enc,webhook_hash)
      VALUES(${input.entityId}::uuid,${encryptKey(key, encryptionSecret())},${secret ? pdfHash(Buffer.from(secret)) : old!.webhook_hash})
      ON CONFLICT(entity_id) DO UPDATE SET key_enc=EXCLUDED.key_enc,webhook_hash=EXCLUDED.webhook_hash,enabled=true,updated_at=now() RETURNING id::text`)
    await auditRow(tx, { actor: input.actor, action: 'connect_documenso', table: 'esign_connection', recordId: row.id, entityId: input.entityId, scope: 'company', after: { provider: 'Documenso Cloud', webhookSecretChanged: Boolean(secret) } })
    return row.id
  })
}
export { webhookSecretMatches } from './esign-auth'
export async function webhookConnection(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
  const [row] = await db.execute<{ id: string; entity_id: string; webhook_hash: string }>(sql`SELECT id::text,entity_id::text,webhook_hash FROM esign_connection WHERE id=${id}::uuid AND enabled`)
  return row ?? null
}
const DOCUMENT_SELECT = sql`SELECT d.*,coalesce(d.display_title,d.title) AS title,d.id::text,d.entity_id::text,d.supersedes_id::text,d.created_at::text,d.document_archived_at::text,
  r.id::text AS request_id,r.remote_status,r.operation,r.archived_at::text,r.completed_at::text FROM esign_document d LEFT JOIN esign_request r ON r.document_id=d.id`
export async function signingDocuments(entityId: string, view: DocumentView | 'all' = 'active'): Promise<SigningDocument[]> {
  const filing = view === 'all' ? sql`true` : view === 'archived' ? sql`d.document_archived_at IS NOT NULL`
    : sql`d.document_archived_at IS NULL AND ${view === 'completed' ? sql`r.remote_status = 'COMPLETED'` : sql`r.remote_status IS DISTINCT FROM 'COMPLETED'`}`
  const order = view === 'completed' ? sql`r.completed_at DESC NULLS LAST,d.created_at DESC` : sql`d.created_at DESC`
  return Array.from(await db.execute<SigningDocument>(sql`${DOCUMENT_SELECT} WHERE d.entity_id=${signingId(entityId)}::uuid AND ${filing} ORDER BY ${order}`))
}
export async function signingDocument(entityId: string, id: string): Promise<SigningDocument> {
  const [row] = await db.execute<SigningDocument>(sql`${DOCUMENT_SELECT} WHERE d.entity_id=${signingId(entityId)}::uuid AND d.id=${signingId(id)}::uuid`)
  if (!row) throw new EsignError('DOCUMENT', 'That document is not in this company.')
  return row
}
export async function signingRequest(entityId: string, documentId: string): Promise<SigningRequest | null> {
  const [row] = await db.execute<SigningRequest>(sql`SELECT *,provider_state AS snapshot,id::text,entity_id::text,document_id::text,connection_id::text,synced_at::text,completed_at::text,archived_at::text FROM esign_request WHERE entity_id=${signingId(entityId)}::uuid AND document_id=${signingId(documentId)}::uuid`)
  return row ?? null
}
export async function signingFiles(entityId: string, documentId: string): Promise<SigningFile[]> {
  return Array.from(await db.execute<SigningFile>(sql`SELECT f.id::text,f.document_id::text,f.kind,f.filename,f.sha256,b.byte_size::text FROM esign_file f JOIN attachment_blob b USING(sha256) WHERE f.entity_id=${signingId(entityId)}::uuid AND f.document_id=${signingId(documentId)}::uuid ORDER BY f.created_at,f.id`))
}
export async function setSigningDocumentArchived(input: { entityId: string; documentId: string; archived: boolean; actor: string }) {
  return actingAs(input.actor, async tx => {
    await companyFor(tx, input.entityId, true)
    const [doc] = await tx.execute<{ document_archived_at: string | null }>(sql`SELECT document_archived_at::text FROM esign_document WHERE entity_id=${signingId(input.entityId)}::uuid AND id=${signingId(input.documentId)}::uuid FOR UPDATE`)
    if (!doc) throw new EsignError('DOCUMENT', 'That document is not in this company.')
    if (Boolean(doc.document_archived_at) === input.archived) return
    await tx.execute(sql`UPDATE esign_document SET document_archived_at=${input.archived ? sql`now()` : sql`NULL`} WHERE id=${input.documentId}::uuid AND entity_id=${input.entityId}::uuid`)
    await auditRow(tx, { actor: input.actor, action: input.archived ? 'archive_signing_document' : 'restore_signing_document', table: 'esign_document', recordId: input.documentId, entityId: input.entityId, scope: 'company', before: { archived: Boolean(doc.document_archived_at) }, after: { archived: input.archived } })
  })
}
export async function renameSigningDocument(input: { entityId: string; documentId: string; title: string; actor: string }) {
  const title = input.title.trim()
  if (!title || title.length > 180) throw new EsignError('TITLE', 'Enter a name up to 180 characters.')
  return actingAs(input.actor, async tx => {
    await companyFor(tx, input.entityId, true)
    const [doc] = await tx.execute<{ title: string }>(sql`SELECT coalesce(display_title,title) AS title FROM esign_document WHERE entity_id=${signingId(input.entityId)}::uuid AND id=${signingId(input.documentId)}::uuid FOR UPDATE`)
    if (!doc) throw new EsignError('DOCUMENT', 'That document is not in this company.')
    if (doc.title === title) return
    await tx.execute(sql`UPDATE esign_document SET display_title=nullif(${title},title) WHERE entity_id=${input.entityId}::uuid AND id=${input.documentId}::uuid`)
    await auditRow(tx, { actor: input.actor, action: 'rename_signing_document', table: 'esign_document', recordId: input.documentId, entityId: input.entityId, scope: 'company', before: { title: doc.title }, after: { title } })
  })
}
async function keepFile(tx: Tx, company: SigningCompany, input: { documentId: string; requestId?: string; artifact: string; kind: string; filename: string; bytes: Buffer; actor: string }) {
  const [existing] = await tx.execute<{ id: string }>(sql`SELECT id::text FROM esign_file WHERE document_id=${input.documentId}::uuid AND artifact_key=${input.artifact}`)
  if (existing) return existing.id
  let sha: string
  try { sha = await keepSigningBytes(company.name, input.bytes) } catch (error) { throw new EsignError('FILE', error instanceof Error ? error.message : 'The PDF could not be archived.') }
  await tx.execute(sql`INSERT INTO attachment_blob(sha256,byte_size,mime,created_by) VALUES(${sha},${input.bytes.length},'application/pdf',${input.actor}) ON CONFLICT DO NOTHING`)
  const [file] = await tx.execute<{ id: string }>(sql`INSERT INTO esign_file(entity_id,document_id,request_id,artifact_key,kind,sha256,filename,created_by)
    VALUES(${company.id}::uuid,${input.documentId}::uuid,${input.requestId ?? null}::uuid,${input.artifact},${input.kind},${sha},${signingFilename(input.filename)},${input.actor}) ON CONFLICT(document_id,artifact_key) DO NOTHING RETURNING id::text`)
  if (file) await auditRow(tx, { actor: input.actor, action: 'archive_signing_file', table: 'esign_file', recordId: file.id, entityId: company.id, scope: 'company', after: { documentId: input.documentId, kind: input.kind, sha256: sha, filename: signingFilename(input.filename) } })
  return file?.id
}
export async function uploadSigningDocument(input: { entityId: string; title: string; kind: string; note?: string; supersedesId?: string; submissionKey: string; filename: string; bytes: Buffer; actor: string }) {
  const title = input.title.trim(), note = input.note?.trim() || null
  if (!title || title.length > 180) throw new EsignError('TITLE', 'Enter a name up to 180 characters.')
  if (!DOCUMENT_KINDS.includes(input.kind as DocumentKind)) throw new EsignError('KIND', 'Choose Memo, Contract, or Other.')
  if (note && note.length > 5000) throw new EsignError('NOTE', 'Keep the note within 5,000 characters.')
  try { assertSigningPdf(input.bytes) } catch (error) { throw new EsignError('FILE', (error as Error).message) }
  signingId(input.submissionKey)
  return actingAs(input.actor, async tx => {
    const company = await companyFor(tx, input.entityId, true)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('esign-upload:' || ${input.entityId + input.submissionKey},0))`)
    const [existing] = await tx.execute<{ id: string; title: string; kind: string; note: string | null; supersedes_id: string | null; sha256: string }>(sql`SELECT d.id::text,d.title,d.kind,d.note,d.supersedes_id::text,f.sha256 FROM esign_document d JOIN esign_file f ON f.document_id=d.id AND f.kind='source' WHERE d.entity_id=${input.entityId}::uuid AND d.submission_key=${input.submissionKey}::uuid`)
    if (existing) {
      if (existing.sha256 !== pdfHash(input.bytes) || existing.title !== title || existing.kind !== input.kind || existing.note !== note || existing.supersedes_id !== (input.supersedesId || null)) throw new EsignError('REPLAY', 'That upload reference was already used for different content. Start a new upload.')
      return existing.id
    }
    let revision = 1
    if (input.supersedesId) {
      const [previous] = await tx.execute<{ revision: number; operation: string | null; remote_status: string | null; document_archived_at: string | null }>(sql`SELECT d.revision,r.operation,r.remote_status,d.document_archived_at::text FROM esign_document d LEFT JOIN esign_request r ON r.document_id=d.id WHERE d.id=${signingId(input.supersedesId)}::uuid AND d.entity_id=${input.entityId}::uuid FOR UPDATE OF d`)
      if (!previous) throw new EsignError('DOCUMENT', 'The previous version is not in this company.')
      if (previous.document_archived_at) throw new EsignError('DOCUMENT_ARCHIVED', 'Restore this document before uploading a new version.')
      if (['CREATING','UNCERTAIN'].includes(previous.operation ?? '') || previous.remote_status === 'PENDING') throw new EsignError('ACTIVE', 'Reconcile or cancel the active request in Documenso before uploading a replacement version.')
      revision = previous.revision + 1
    }
    const [doc] = await tx.execute<{ id: string }>(sql`INSERT INTO esign_document(entity_id,title,kind,note,revision,supersedes_id,submission_key,created_by)
      VALUES(${input.entityId}::uuid,${title},${input.kind},${note},${revision},${input.supersedesId || null}::uuid,${input.submissionKey}::uuid,${input.actor}) RETURNING id::text`)
    await keepFile(tx, company, { documentId: doc.id, artifact: 'source', kind: 'source', filename: input.filename, bytes: input.bytes, actor: input.actor })
    await auditRow(tx, { actor: input.actor, action: 'upload_signing_document', table: 'esign_document', recordId: doc.id, entityId: input.entityId, scope: 'company', after: { title, kind: input.kind, revision, supersedesId: input.supersedesId || null } })
    return doc.id
  })
}
export function recipientsFromForm(f: FormData): Recipient[] {
  const names = f.getAll('recipientName'), emails = f.getAll('recipientEmail'), roles = f.getAll('recipientRole'), recipients: Recipient[] = []
  if (names.length > 20 || names.length !== emails.length || names.length !== roles.length) throw new EsignError('RECIPIENTS', 'Use up to 20 recipients with a name, email, and role for each.')
  names.forEach((name, i) => {
    const n = String(name).trim(), email = String(emails[i]).trim().toLowerCase(), role = String(roles[i])
    if (!n && !email) return
    if (!n || n.length > 255 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['SIGNER','APPROVER','CC'].includes(role)) throw new EsignError('RECIPIENTS', 'Give each recipient a name, valid email, and role.')
    if (recipients.some(r => r.email === email)) throw new EsignError('RECIPIENTS', 'Each recipient email should appear once.')
    recipients.push({ name: n, email, role: role as Recipient['role'], signingOrder: recipients.length + 1 })
  })
  return recipients
}
export async function prepareSigningRequest(input: { entityId: string; documentId: string; recipients: Recipient[]; sequential: boolean; actor: string }, send?: ProviderFetch) {
  const doc = await signingDocument(input.entityId, input.documentId)
  if (doc.document_archived_at) throw new EsignError('DOCUMENT_ARCHIVED', 'Restore this document before creating a signing request.')
  const connection = await connectionFor(input.entityId), key = keyOf(connection)
  const source = (await signingFiles(input.entityId, input.documentId)).find(f => f.kind === 'source')
  if (!source) throw new EsignError('FILE', 'The source PDF is not on file.')
  const claim = await actingAs(input.actor, async tx => {
    await companyFor(tx, input.entityId, true)
    const [locked] = await tx.execute<{ document_archived_at: string | null }>(sql`SELECT document_archived_at::text FROM esign_document WHERE id=${input.documentId}::uuid AND entity_id=${input.entityId}::uuid FOR UPDATE`)
    if (!locked || locked.document_archived_at) throw new EsignError('DOCUMENT_ARCHIVED', 'Restore this document before creating a signing request.')
    let [r] = await tx.execute<SigningRequest>(sql`SELECT *,id::text FROM esign_request WHERE document_id=${input.documentId}::uuid FOR UPDATE`)
    if (!r) {
      [r] = await tx.execute<SigningRequest>(sql`INSERT INTO esign_request(entity_id,document_id,connection_id,recipients,created_by) VALUES(${input.entityId}::uuid,${input.documentId}::uuid,${connection!.id}::uuid,${JSON.stringify(input.recipients)}::jsonb,${input.actor}) RETURNING *,id::text`)
    }
    if (r.operation === 'DETACHED') throw new EsignError('DETACHED', 'This is restored signing history. Upload a new document version to create a new request.')
    if (r.operation !== 'LOCAL') return { id: r.id, create: false }
    await tx.execute(sql`UPDATE esign_request SET operation='CREATING',recipients=${JSON.stringify(input.recipients)}::jsonb,last_error=NULL,next_sync_at=now()+interval '2 minutes' WHERE id=${r.id}::uuid`)
    await auditRow(tx, { actor: input.actor, action: 'prepare_signing_request', table: 'esign_request', recordId: r.id, entityId: input.entityId, scope: 'company', after: { documentId: input.documentId, recipients: input.recipients } })
    return { id: r.id, create: true }
  })
  if (!claim.create) return claim.id
  try {
    const company = await signingCompanyByEntity(input.entityId)
    const bytes = await signingBytes(company.name, source.sha256)
    const remote = await documenso(key, send).create({ title: `${doc.title.slice(0,180)} [FigTree ${claim.id}]`, reference: claim.id, filename: source.filename, bytes, recipients: input.recipients, sequential: input.sequential })
    await actingAs(input.actor, async tx => { await tx.execute(sql`UPDATE esign_request SET remote_id=${remote},operation='LINKED',remote_status='DRAFT',next_sync_at=now(),last_error=NULL WHERE id=${claim.id}::uuid AND operation='CREATING'`) })
    await synchronizeSigningRequest(input.entityId, input.documentId, input.actor, send)
    return claim.id
  } catch (error) {
    await actingAs(input.actor, async tx => {
      const operation = error instanceof DocumensoError && !error.ambiguous ? 'LOCAL' : 'UNCERTAIN'
      await tx.execute(sql`UPDATE esign_request SET operation=${operation},last_error=${signingSentence(error)},next_sync_at=now()+interval '2 minutes' WHERE id=${claim.id}::uuid AND operation='CREATING'`)
    })
    throw error
  }
}
async function signingCompanyByEntity(entityId: string): Promise<SigningCompany> {
  const [c] = await db.execute<SigningCompany>(sql`SELECT id::text,name,archived_at::text FROM entity WHERE id=${signingId(entityId)}::uuid`)
  if (!c) throw new EsignError('COMPANY', 'That company is not on file.')
  return c
}
async function integrationTx<T>(actor: string, work: (tx: Tx) => Promise<T>) {
  return actingAs(actor, async tx => { await tx.execute(sql`SELECT set_config('app.esign_sync','on',true)`); return work(tx) })
}
async function applySnapshot(entityId: string, request: SigningRequest, snapshot: SigningSnapshot, actor: string) {
  if (snapshot.externalId !== request.id || snapshot.id !== request.remote_id && request.remote_id !== null) throw new EsignError('REFERENCE', 'This Documenso document does not match the ERP signing request.')
  await integrationTx(actor, async tx => {
    const [old] = await tx.execute<SigningRequest>(sql`SELECT *,provider_state AS snapshot FROM esign_request WHERE id=${request.id}::uuid AND entity_id=${entityId}::uuid FOR UPDATE`)
    if (!old || old.operation === 'DETACHED') throw new EsignError('DETACHED', 'This request is detached from Documenso.')
    if (old.remote_status && ['COMPLETED','REJECTED','CANCELLED'].includes(old.remote_status) && old.remote_status !== snapshot.status) throw new EsignError('STATE', 'Documenso reported a conflicting state for a finished signing request.')
    const changed = JSON.stringify(old.snapshot) !== JSON.stringify(snapshot)
    await tx.execute(sql`UPDATE esign_request SET operation='LINKED',remote_id=${snapshot.id},team_url=${snapshot.teamUrl},remote_status=${snapshot.status},provider_state=${JSON.stringify(snapshot)}::jsonb,completed_at=${snapshot.completedAt}::timestamptz,synced_at=now(),last_error=NULL,attempts=0,next_sync_at=now()+interval '5 minutes' WHERE id=${request.id}::uuid`)
    if (changed) await auditRow(tx, { actor, action: 'sync_signing_request', table: 'esign_request', recordId: request.id, entityId, scope: 'company', before: { status: old.remote_status }, after: { status: snapshot.status, recipients: snapshot.recipients, remoteId: snapshot.id } })
  })
}
export async function synchronizeSigningRequest(entityId: string, documentId: string, actor: string, send?: ProviderFetch) {
  await signingDocument(entityId, documentId)
  const request = await signingRequest(entityId, documentId)
  if (!request) throw new EsignError('REQUEST', 'Create a Documenso draft first.')
  if (request.operation === 'DETACHED') throw new EsignError('DETACHED', 'Restored requests are history only and cannot contact Documenso.')
  const connection = await connectionFor(entityId)
  if (!connection || connection.id !== request.connection_id) throw new EsignError('CONNECTION', 'This request’s Documenso connection is unavailable.')
  const provider = documenso(keyOf(connection), send)
  try {
    const remote = request.remote_id || await provider.recover(request.id)
    if (!remote) throw new EsignError('UNCERTAIN', 'No matching Documenso draft was found. A previous upload may still be processing. Check Documenso and refresh later; another draft will not be created automatically.')
    const snapshot = await provider.get(remote)
    await applySnapshot(entityId, request, snapshot, actor)
    if (snapshot.status === 'PENDING' || snapshot.status === 'COMPLETED') {
      if (!snapshot.items.length) throw new EsignError('ARCHIVE', 'Documenso returned no PDF items. The evidence archive is incomplete.')
      const company = await signingCompanyByEntity(entityId)
      async function artifact(kind: string, key: string, name: string, path: string) {
        const [exists] = await db.execute(sql`SELECT id FROM esign_file WHERE document_id=${documentId}::uuid AND artifact_key=${key}`)
        if (exists) return
        const bytes = await provider.pdf(path)
        await integrationTx(actor, tx => keepFile(tx, company, { documentId, requestId: request!.id, artifact: key, kind, filename: name, bytes, actor }))
      }
      for (const item of snapshot.items) {
        if (!/^envelope_item_[a-zA-Z0-9_-]{1,150}$/.test(item.id)) throw new EsignError('ARCHIVE', 'Documenso returned an invalid PDF item reference.')
        await artifact('original', 'original:' + item.id, 'Prepared ' + item.title, `/envelope/item/${encodeURIComponent(item.id)}/download?version=original`)
        if (snapshot.status === 'COMPLETED') await artifact('signed', 'signed:' + item.id, 'Signed ' + item.title, `/envelope/item/${encodeURIComponent(item.id)}/download?version=signed`)
      }
      if (snapshot.status === 'COMPLETED') {
        await artifact('certificate', 'certificate', 'Completion certificate.pdf', `/envelope/${encodeURIComponent(remote)}/certificate/download`)
        await artifact('audit', 'audit', 'Signing audit log.pdf', `/envelope/${encodeURIComponent(remote)}/audit-log/download`)
        // Metadata alone is not an evidence archive. Recheck every retained
        // source and provider file before declaring the archive complete.
        try { for (const file of await signingFiles(entityId, documentId)) await signingBytes(company.name, file.sha256) }
        catch { throw new EsignError('ARCHIVE', 'A stored signing PDF is missing or damaged. Restore its verified bytes before the evidence archive can be marked complete.') }
        await integrationTx(actor, async tx => { await tx.execute(sql`UPDATE esign_request SET archived_at=coalesce(archived_at,now()),last_error=NULL WHERE id=${request.id}::uuid`) })
      }
    }
    await integrationTx(actor, async tx => { await tx.execute(sql`UPDATE esign_event SET processed_at=now() WHERE connection_id=${connection.id}::uuid AND remote_id=${remote} AND processed_at IS NULL`) })
  } catch (error) {
    await integrationTx(actor, async tx => { await tx.execute(sql`UPDATE esign_request SET archived_at=CASE WHEN ${error instanceof EsignError && error.code === 'ARCHIVE'} THEN NULL ELSE archived_at END,last_error=${signingSentence(error)},attempts=least(attempts+1,10),next_sync_at=now()+least(interval '1 hour',interval '1 minute'*power(2,least(attempts,6))) WHERE id=${request.id}::uuid`) })
    throw error
  }
}
export async function receiveSigningEvent(connection: { id: string; entity_id: string }, bytes: Buffer) {
  if (!bytes.length || bytes.length > 128 * 1024) throw new EsignError('EVENT', 'Invalid webhook payload size.')
  let remote: string
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    remote = envelopeId(String(value?.payload?.envelopeId ?? ''))
    if (typeof value.event !== 'string' || !value.event.startsWith('DOCUMENT_')) return
  } catch { throw new EsignError('EVENT', 'Invalid Documenso event.') }
  await integrationTx('documenso-webhook', async tx => {
    const created = await tx.execute(sql`INSERT INTO esign_event(entity_id,connection_id,remote_id,event_hash) VALUES(${connection.entity_id}::uuid,${connection.id}::uuid,${remote},${pdfHash(bytes)}) ON CONFLICT DO NOTHING RETURNING id`)
    if (created.length) await tx.execute(sql`UPDATE esign_request SET next_sync_at=now() WHERE connection_id=${connection.id}::uuid AND remote_id=${remote} AND operation<>'DETACHED' AND archived_at IS NULL`)
  })
}
export async function reconcileSigningRequests(limit = 20, send?: ProviderFetch) {
  const rows = await integrationTx('documenso-sync', tx => tx.execute<{ entity_id: string; document_id: string }>(sql`
    UPDATE esign_request SET next_sync_at=now()+interval '10 minutes' WHERE id IN (
      SELECT id FROM esign_request WHERE operation IN ('CREATING','UNCERTAIN','LINKED') AND next_sync_at<=now() AND archived_at IS NULL
      AND (remote_status IS NULL OR remote_status IN ('DRAFT','PENDING','COMPLETED'))
      ORDER BY next_sync_at LIMIT ${Math.max(1, Math.min(limit, 100))} FOR UPDATE SKIP LOCKED
    ) RETURNING entity_id::text,document_id::text`))
  let updated = 0, failed = 0
  for (const row of rows) { try { await synchronizeSigningRequest(row.entity_id, row.document_id, 'documenso-sync', send); updated++ } catch { failed++ } }
  return { updated, failed }
}

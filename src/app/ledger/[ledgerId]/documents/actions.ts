'use server'

import { revalidatePath } from 'next/cache'
import type { FormState } from '@/app/actions'
import { requireLedger, actorOf } from '@/lib/gate'
import { signingCompany, signingRequest, uploadSigningDocument, setSigningDocumentArchived, renameSigningDocument, prepareSigningRequest, synchronizeSigningRequest, recipientsFromForm, signingSentence, EsignError } from '@/lib/esign'

const field = (f: FormData, name: string) => String(f.get(name) ?? '')
async function run(f: FormData, work: (base: { entityId: string; actor: string }) => Promise<FormState>) {
  const ledgerId = field(f, 'ledgerId'), user = await requireLedger(ledgerId, '/documents')
  try {
    const company = await signingCompany(ledgerId)
    const result = await work({ entityId: company.id, actor: actorOf(user) })
    revalidatePath(`/ledger/${ledgerId}/documents`, 'layout')
    if (field(f, 'documentId')) revalidatePath(`/ledger/${ledgerId}/documents/${field(f, 'documentId')}`)
    return result
  } catch (error) { return { error: signingSentence(error) } }
}
export async function uploadDocumentAction(_previous: FormState, f: FormData): Promise<FormState> {
  return run(f, async base => {
    const file = f.get('file')
    if (!(file instanceof File) || !file.size || file.size > 25 * 1024 * 1024) throw new EsignError('FILE', 'Choose a non-empty PDF up to 25 MB.')
    const id = await uploadSigningDocument({ ...base, title: field(f, 'title'), kind: field(f, 'kind'), note: field(f, 'note'), supersedesId: field(f, 'supersedesId'), submissionKey: field(f, 'submissionKey'), filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) })
    return { ok: 'Document saved.', madeId: id }
  })
}
export async function archiveDocumentAction(_previous: FormState, f: FormData): Promise<FormState> {
  return run(f, async base => {
    const intent = field(f, 'intent')
    if (!['archive', 'restore'].includes(intent)) throw new EsignError('INTENT', 'Choose Archive or Restore.')
    await setSigningDocumentArchived({ ...base, documentId: field(f, 'documentId'), archived: intent === 'archive' })
    return { ok: intent === 'archive' ? 'Document archived.' : 'Document restored.' }
  })
}
export async function renameDocumentAction(_previous: FormState, f: FormData): Promise<FormState> {
  return run(f, async base => {
    await renameSigningDocument({ ...base, documentId: field(f, 'documentId'), title: field(f, 'title') })
    return { ok: 'Document renamed.' }
  })
}
export async function prepareDocumentAction(_previous: FormState, f: FormData): Promise<FormState> {
  return run(f, async base => {
    await prepareSigningRequest({ ...base, documentId: field(f, 'documentId'), recipients: recipientsFromForm(f), sequential: field(f, 'sequential') === 'on' })
    const request = await signingRequest(base.entityId, field(f, 'documentId'))
    return { ok: request?.operation === 'LINKED' && request.team_url ? 'Draft ready. Open Documenso to set fields.' : 'Draft in progress. Refresh signing status.' }
  })
}
export async function refreshDocumentAction(_previous: FormState, f: FormData): Promise<FormState> {
  return run(f, async base => {
    await synchronizeSigningRequest(base.entityId, field(f, 'documentId'), base.actor)
    return { ok: 'Signing status refreshed.' }
  })
}


import { PageHeading } from '@/components/DialogHeading'
import { formatNumber } from '@/lib/numbers'
import Link from 'next/link'
import {personalSettingsPath} from '@/lib/settings-context'
import { randomUUID } from 'node:crypto'
import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { signingCompany, signingDocument, signingFiles, signingRequest, connectionSummary, EsignError } from '@/lib/esign'
import { documentStatus, documentView } from '@/lib/esign-types'
import { editorUrl } from '@/lib/documenso'
import { PAGE_HEADER, BUTTON, QUIET, REFUSAL, TOOL_BUTTON } from '@/lib/ui'
import { ActionForm } from '@/components/ActionForm'
import { ToolAction } from '@/components/ToolAction'
import { PrepareDocument, UploadDocument, RenameDocument } from '../DocumentForms'
import { prepareDocumentAction, refreshDocumentAction, uploadDocumentAction, archiveDocumentAction, renameDocumentAction } from '../actions'

export default async function DocumentPage({ params }: { params: Promise<{ ledgerId: string; documentId: string }> }) {
  const { ledgerId, documentId } = await params
  const user = await requireLedger(ledgerId, '/documents')
  const company = await signingCompany(ledgerId)
  let doc
  try { doc = await signingDocument(company.id, documentId) } catch (error) { if (error instanceof EsignError) notFound(); throw error }
  const [files, request, connection] = await Promise.all([signingFiles(company.id, documentId), signingRequest(company.id, documentId), connectionSummary(company.id)])
  const base = `/ledger/${ledgerId}/documents`, here = `${base}/${documentId}`, url = request?.operation === 'LINKED' ? editorUrl(request) : null
  const preview = files.find(f => f.kind === 'signed') || files.find(f => f.kind === 'source')
  const canReplace = !company.archived_at && !doc.document_archived_at && !['CREATING','UNCERTAIN'].includes(request?.operation ?? '') && request?.remote_status !== 'PENDING'
  const view = documentView(doc)
  return <main className="w-full min-w-0 space-y-5 px-8 py-8 font-sans">
    <Link className={TOOL_BUTTON} title="Back" href={view === 'active' ? base : `${base}?view=${view}`}><ToolAction kind="back">Back to Documents</ToolAction></Link>
    <header className={PAGE_HEADER}><div><PageHeading title={<>{doc.title}</>} /><p className="mt-1 text-sm text-neutral-500">{company.name} · Version {doc.revision} · {documentStatus(doc)}</p></div><div className="flex flex-wrap items-center gap-2">{!company.archived_at && <RenameDocument key={doc.title} ledgerId={ledgerId} documentId={doc.id} title={doc.title} action={renameDocumentAction}/>}{canReplace && <UploadDocument ledgerId={ledgerId} previous={doc} submissionKey={randomUUID()} action={uploadDocumentAction}/>}{!company.archived_at && <ActionForm action={archiveDocumentAction} submit={doc.document_archived_at ? 'Restore' : 'Archive'} working={doc.document_archived_at ? 'Restoring…' : 'Archiving…'} buttonClassName={QUIET}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="documentId" value={documentId}/><input type="hidden" name="intent" value={doc.document_archived_at ? 'restore' : 'archive'}/></ActionForm>}</div></header>
    {doc.document_archived_at && <p role="status" className="text-sm text-neutral-500">Archived {doc.document_archived_at.slice(0, 10)}.</p>}
    {doc.supersedes_id && <Link className="text-sm underline" href={`${base}/${doc.supersedes_id}`}>Previous version</Link>}
    {doc.note && <p className="max-w-3xl whitespace-pre-wrap text-sm">{doc.note}</p>}
    {request?.last_error && <p role="alert" className={REFUSAL}>{request.last_error}</p>}
    {request?.operation === 'DETACHED' && <p className="text-sm text-neutral-500">Restored copy. Upload a new version to request signatures.</p>}
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
      <section className="min-w-0 space-y-3"><h2 className="text-lg font-semibold">{preview?.kind === 'signed' ? 'Signed PDF' : 'Source PDF'}</h2>
        {preview && <><iframe className="h-[38rem] w-full rounded-lg border border-neutral-200 bg-white dark:border-neutral-800" title={`${doc.title} PDF`} src={`${here}/files/${preview.id}`}/><a className="text-sm underline print:hidden" href={`${here}/files/${preview.id}?download=yes`}>Download PDF</a></>}
      </section>
      <section className="min-w-0 space-y-5"><h2 className="text-lg font-semibold">Signatures</h2>
        {(!request || request.operation === 'LOCAL') && !company.archived_at && !doc.document_archived_at && (connection?.enabled && connection.readable ? <PrepareDocument ledgerId={ledgerId} documentId={documentId} action={prepareDocumentAction}/> : <p className="text-sm text-neutral-500">{user.is_owner ? <><Link className="underline underline-offset-4" href={personalSettingsPath(ledgerId,'documents')+'#documenso'}>Connect Documenso in Settings</Link> to request signatures.</> : 'Ask the owner to connect Documenso for signatures.'}</p>)}
        {url && <div className="space-y-3"><a href={url} target="_blank" rel="noopener noreferrer" className={BUTTON}>Set fields in Documenso</a><p className="text-sm text-neutral-500">Review fields and send in Documenso. Use AI detection if enabled.</p></div>}
        {request && request.operation !== 'DETACHED' && <ActionForm action={refreshDocumentAction} submit="Refresh signing status" working="Refreshing…" buttonClassName={QUIET}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="documentId" value={documentId}/></ActionForm>}
        {request?.snapshot && <div className="space-y-3"><h3 className="font-medium">Recipients</h3><ul className="divide-y divide-neutral-200 dark:divide-neutral-800">{request.snapshot.recipients.map(r => <li key={r.id} className="py-2 text-sm"><p>{r.name || r.email}<span className="ml-2 text-xs text-neutral-500">{r.role.toLowerCase()}</span></p><p className="break-all text-xs text-neutral-500">{r.email}</p><p className="mt-1 text-xs">{r.signingStatus === 'SIGNED' ? 'Signed' : r.signingStatus === 'REJECTED' ? 'Rejected' : 'Awaiting action'}{r.signedAt ? ' · ' + r.signedAt.slice(0, 10) : ''}</p></li>)}</ul><p className="text-xs text-neutral-500">{formatNumber(request.snapshot.fields.length)} fields · Last checked {request.synced_at?.slice(0, 19).replace('T', ' ')}</p></div>}
        <div className="space-y-2 print:hidden"><h3 className="font-medium">Files</h3><ul className="space-y-2 text-sm">{files.map(file => <li key={file.id}><a className="underline" href={`${here}/files/${file.id}?download=yes`}>{file.filename}</a><span className="ml-2 text-xs text-neutral-500">{file.kind === 'original' ? 'prepared PDF' : file.kind}</span></li>)}</ul>
          {request?.remote_status === 'COMPLETED' && !request.archived_at && <p className="text-sm text-amber-700 dark:text-amber-300">Evidence pending. Refresh to retry.</p>}
        </div>
      </section>
    </div>
  </main>
}

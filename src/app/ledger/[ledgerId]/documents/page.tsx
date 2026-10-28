import { PageHeader } from '@/components/PageHeader'
import { ModuleTabs } from '@/components/ModuleTabs'
import { DataTable, TableViewport } from '@/components/Table'
import Link from 'next/link'
import {personalSettingsPath} from '@/lib/settings-context'
import { randomUUID } from 'node:crypto'
import { requireLedger } from '@/lib/gate'
import { signingCompany, signingDocuments, connectionSummary } from '@/lib/esign'
import { documentStatus, type DocumentView } from '@/lib/esign-types'
import { QUIET } from '@/lib/ui'
import { ActionForm } from '@/components/ActionForm'
import { UploadDocument, RenameDocument } from './DocumentForms'
import { uploadDocumentAction, archiveDocumentAction, renameDocumentAction } from './actions'

export default async function DocumentsPage({ params, searchParams }: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ view?: string }> }) {
  const { ledgerId } = await params, user = await requireLedger(ledgerId, '/documents'), company = await signingCompany(ledgerId)
  const requestedView = (await searchParams).view
  const view: DocumentView = requestedView === 'archived' || requestedView === 'completed' ? requestedView : 'active'
  const archived = view === 'archived'
  const [documents, connection] = await Promise.all([signingDocuments(company.id, view), connectionSummary(company.id)])
  const base = `/ledger/${ledgerId}/documents`
  return <main className="w-full min-w-0 space-y-5 px-8 py-8 font-sans">
    <PageHeader title="Documents">{!company.archived_at && <UploadDocument ledgerId={ledgerId} submissionKey={randomUUID()} action={uploadDocumentAction}/>}</PageHeader>
    {(!connection?.enabled || !connection.readable) && <p className="text-sm text-neutral-500">{user.is_owner ? <>For signatures, <Link className="underline underline-offset-4" href={personalSettingsPath(ledgerId,'documents')+'#documenso'}>connect Documenso in Settings</Link>.</> : 'Ask the owner to connect Documenso for signatures.'}</p>}
    <ModuleTabs label="Document filing" items={([['active', 'Active'], ['completed', 'Completed'], ['archived', 'Archived']] as const).map(([tab, label]) => ({
      href: tab === 'active' ? base : `${base}?view=${tab}`, label, selected: view === tab,
    }))} />
    <TableViewport label="Documents"><DataTable className="min-w-[44rem]"><thead><tr className="text-left text-xs text-neutral-500"><th className="px-3 py-3">Document</th><th className="px-3 py-3">Type</th><th className="px-3 py-3">Signing status</th><th className="px-3 py-3">{archived ? 'Archived' : view === 'completed' ? 'Completed' : 'Uploaded'}</th>{!company.archived_at && <th className="relative px-3 py-3"><span className="sr-only">Manage document</span></th>}</tr></thead>
      <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">{documents.map(doc => <tr key={doc.id}><td className="px-3 py-3"><Link className="font-medium underline decoration-neutral-300 underline-offset-4" href={`${base}/${doc.id}`}>{doc.title}</Link>{doc.revision > 1 && <span className="ml-2 text-xs text-neutral-500">Version {doc.revision}</span>}</td><td className="px-3 py-3 capitalize">{doc.kind}</td><td className="px-3 py-3">{documentStatus(doc)}</td><td className="px-3 py-3 whitespace-nowrap">{(archived ? doc.document_archived_at : view === 'completed' ? doc.completed_at : doc.created_at)?.slice(0, 10) ?? '—'}</td>{!company.archived_at && <td className="px-3 py-3"><div className="flex items-start gap-2"><RenameDocument key={doc.title} ledgerId={ledgerId} documentId={doc.id} title={doc.title} action={renameDocumentAction}/><ActionForm action={archiveDocumentAction} submit={archived ? 'Restore' : 'Archive'} working={archived ? 'Restoring…' : 'Archiving…'} buttonClassName={QUIET}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="documentId" value={doc.id}/><input type="hidden" name="intent" value={archived ? 'restore' : 'archive'}/></ActionForm></div></td>}</tr>)}</tbody></DataTable>
      {!documents.length && <p className="px-3 py-8 text-sm text-neutral-500">{{ active: 'No active documents.', completed: 'No completed documents.', archived: 'No archived documents.' }[view]}</p>}
    </TableViewport>
  </main>
}

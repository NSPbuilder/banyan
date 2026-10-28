'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { Floating } from '@/components/Floating'
import { BUTTON, FIELD, LABEL, QUIET } from '@/lib/ui'
import type { DocumentKind } from '@/lib/esign-types'

const input = FIELD + ' mt-1 block w-full'
export function UploadDocument({ ledgerId, submissionKey, action, previous }: {
  ledgerId: string; submissionKey: string; action: FormAction;
  previous?: { id: string; title: string; kind: DocumentKind; revision: number }
}) {
  const router = useRouter()
  return <Floating label={previous ? 'Upload new version' : 'Upload PDF'} title={previous ? 'New document version' : 'Upload document'} buttonClassName={previous ? QUIET : BUTTON}>
    <ActionForm action={action} submit="Save document" working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-4"
      onSucceeded={state => { if (state.madeId) router.push(`/ledger/${ledgerId}/documents/${state.madeId}`) }}>
      <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="submissionKey" value={submissionKey}/>
      {previous && <input type="hidden" name="supersedesId" value={previous.id}/>}
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <label className={LABEL}>Name<input className={input} name="title" required maxLength={180} defaultValue={previous?.title}/></label>
        <label className={LABEL}>Type<select className={input} name="kind" defaultValue={previous?.kind ?? 'contract'}><option value="contract">Contract</option><option value="memo">Memo</option><option value="other">Other</option></select></label>
      </div>
      <label className={LABEL}>PDF<input className={input} type="file" name="file" accept="application/pdf,.pdf" required/></label>
      <p className="text-xs text-neutral-500">PDF only · Up to 25 MB</p>
      <label className={LABEL}>Note<textarea className={input} name="note" maxLength={5000} rows={3}/></label>
    </ActionForm>
  </Floating>
}
export function RenameDocument({ ledgerId, documentId, title, action }: { ledgerId: string; documentId: string; title: string; action: FormAction }) {
  return <Floating label="Rename" title="Rename document" ariaLabel={`Rename ${title}`} buttonClassName={QUIET}>
    <ActionForm action={action} submit="Save name" working="Saving…" buttonClassName={BUTTON} className="mt-5 max-w-xl space-y-4">
      <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="documentId" value={documentId}/>
      <label className={LABEL}>Name<input className={input} name="title" required maxLength={180} defaultValue={title}/></label>
    </ActionForm>
  </Floating>
}
export function PrepareDocument({ ledgerId, documentId, action }: { ledgerId: string; documentId: string; action: FormAction }) {
  const [rows, setRows] = useState(2)
  return <ActionForm action={action} submit="Create Documenso draft" working="Creating draft…" buttonClassName={BUTTON} className="space-y-4">
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="documentId" value={documentId}/>
    <p className="text-sm text-neutral-500">Recipients are optional. Invitations are sent from Documenso.</p>
    <div className="space-y-3">{Array.from({ length: rows }, (_, i) => <fieldset key={i} className="grid gap-2 sm:grid-cols-[1fr_1.5fr_8rem]">
      <legend className="sr-only">Recipient {i + 1}</legend>
      <label className={LABEL}>Name<input name="recipientName" maxLength={255} className={input}/></label>
      <label className={LABEL}>Email<input name="recipientEmail" type="email" maxLength={254} className={input}/></label>
      <label className={LABEL}>Role<select name="recipientRole" className={input}><option value="SIGNER">Signer</option><option value="APPROVER">Approver</option><option value="CC">Copy</option></select></label>
    </fieldset>)}</div>
    {rows < 20 && <button type="button" className={QUIET} onClick={() => setRows(n => n + 1)}>Add recipient</button>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="sequential"/>Sign in recipient order</label>
  </ActionForm>
}

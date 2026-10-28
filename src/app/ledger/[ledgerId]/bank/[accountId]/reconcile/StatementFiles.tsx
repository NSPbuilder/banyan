'use client'

import { formatNumber } from '@/lib/numbers'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { Floating } from '@/components/Floating'
import { MATCH_FIELDS as F, STATEMENT_FILE_FIELDS as S, STATEMENT_FILE_ACCEPT } from '@/lib/forms'
import type { StatementFileRecord } from '@/lib/attachments'
import { BUTTON, FIELD, QUIET } from '@/lib/ui'

export function StatementFiles({ ledgerId, accountId, statementId, statementDate, finished, files, uploadAction, removeAction }: {
  ledgerId: string; accountId: string; statementId: string; statementDate: string; finished: boolean
  files: StatementFileRecord[]; uploadAction: FormAction; removeAction: FormAction
}) {
  const scope = <>
    <input type="hidden" name={F.ledgerId} value={ledgerId} />
    <input type="hidden" name={F.accountId} value={accountId} />
    <input type="hidden" name={F.statementId} value={statementId} />
  </>
  return (
    <section className="mt-4 rounded border border-neutral-200 p-4 dark:border-neutral-800" aria-label="Statement files">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Statement files</h2>
          <p className="mt-1 font-mono text-xs text-neutral-500">{statementDate}</p>
        </div>
        <Floating label="Upload statement" title={`Upload statement · ${statementDate}`} buttonClassName={BUTTON}>
          <ActionForm action={uploadAction} submit="Upload" working="Uploading…" className="mt-3 space-y-3" buttonClassName={BUTTON}>
            {scope}
            <label className="block text-xs text-neutral-500">Statement file
              <input type="file" name={S.file} required accept={STATEMENT_FILE_ACCEPT} className={`mt-1 block w-full ${FIELD}`} />
            </label>
            <p className="text-xs text-neutral-500">PDF or image · up to 25 MB</p>
          </ActionForm>
        </Floating>
      </div>
      {files.length ? <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-900">
        {files.map(file => {
          const href = `/ledger/${ledgerId}/bank/${accountId}/files/${file.id}`
          const bytes = Number(file.byte_size)
          const size = bytes < 1024 * 1024 ? `${formatNumber(Math.max(1, Math.round(bytes / 1024)))} KB` : `${formatNumber((bytes / 1024 / 1024).toFixed(1))} MB`
          return <li key={file.id} className="flex flex-col items-stretch gap-x-4 gap-y-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <a href={href} target="_blank" rel="noopener noreferrer" className="block break-words text-sm hover:underline">{file.filename}</a>
              <p className="mt-1 text-xs text-neutral-500">{size}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs">
              <a href={`${href}?download=1`} className={QUIET}>Download</a>
              {!finished && <Floating label="Remove" title="Remove statement file" buttonClassName={QUIET}>
                <p className="break-all text-sm">{file.filename}</p>
                <ActionForm action={removeAction} submit="Remove file" working="Removing…" className="mt-3 space-y-3" buttonClassName={BUTTON}>
                  {scope}
                  <input type="hidden" name={S.attachmentId} value={file.id} />
                  <label className="block text-xs text-neutral-500">Reason
                    <input name="reason" required className={`mt-1 block w-full ${FIELD}`} />
                  </label>
                </ActionForm>
              </Floating>}
            </div>
          </li>
        })}
      </ul> : <p className="mt-3 text-sm text-neutral-500">No statement file uploaded.</p>}
    </section>
  )
}

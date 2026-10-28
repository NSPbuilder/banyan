import { formatNumber } from '@/lib/numbers'
import { ActionForm } from '@/components/ActionForm'
import { deleteAttachmentAction, waiveReceiptAction } from '@/app/actions'
import { attachmentsOf, receiptWaiver } from '@/lib/attachments'
import { AttachmentUpload } from './AttachmentUpload'

/**
 * The paper behind the entry. Uploads are never required — receipts arrive
 * late, and the standing reminder chases what is missing — and a CLOSED month
 * still accepts them: filing paper changes no figure.
 *
 * One file, one blob: the store dedupes by content, and the account/month
 * folders hold hardlinks, so the expense account and the bank account "both
 * have" the receipt without a second copy existing anywhere.
 */
export async function Attachments({ ledgerId, entryId }: { ledgerId: string; entryId: string }) {
  const [files, waiver] = await Promise.all([attachmentsOf(entryId), receiptWaiver(entryId)])
  const size = (bytes: string) => {
    const n = Number(bytes)
    return n >= 1024 * 1024 ? `${formatNumber((n / 1024 / 1024).toFixed(1))} MB` : `${formatNumber(Math.max(1, Math.round(n / 1024)))} KB`
  }

  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
        Attachments
      </h2>
      {waiver && (
        <div className="mt-2 flex flex-wrap items-baseline gap-2 text-sm text-neutral-500">
          <span>
            Marked as needing no supporting document ({waiver.created_at.slice(0, 10)})
          </span>
          <ActionForm action={waiveReceiptAction} submit="Chase it again" working="…"
                      buttonClassName="text-xs underline decoration-dotted text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200">
            <input type="hidden" name="ledgerId" value={ledgerId} />
            <input type="hidden" name="entryId" value={entryId} />
            <input type="hidden" name="lift" value="yes" />
          </ActionForm>
        </div>
      )}
      {files.length === 0 ? (
        !waiver && (
        <div className="mt-2 flex flex-wrap items-baseline gap-2 text-sm text-neutral-500">
          <span>No supporting document filed yet. It can come later — a closed month still accepts paper.</span>
          <ActionForm action={waiveReceiptAction} submit="No supporting needed" working="…"
                      buttonClassName="text-xs underline decoration-dotted text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200">
            <input type="hidden" name="ledgerId" value={ledgerId} />
            <input type="hidden" name="entryId" value={entryId} />
          </ActionForm>
        </div>
        )
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3">
              <a href={`/ledger/${ledgerId}/attachments/${f.id}`} target="_blank"
                 className="underline underline-offset-2 hover:text-neutral-600 dark:hover:text-neutral-300">
                {f.filename}
              </a>
              <span className="text-xs text-neutral-500">
                {size(f.byte_size)} · {f.created_at.slice(0, 10)}
                {f.uploaded !== f.filename && <> · was {f.uploaded}</>}
              </span>
              <ActionForm action={deleteAttachmentAction} submit="Unfile" working="…"
                          className="flex items-center gap-2"
                          buttonClassName="text-xs text-neutral-400 underline hover:text-red-700">
                <input type="hidden" name="ledgerId" value={ledgerId} />
                <input type="hidden" name="attachmentId" value={f.id} />
                <input name="reason" required maxLength={500} aria-label={`Reason for unfiling ${f.filename}`} className="h-[34px] w-40 rounded border border-neutral-300 bg-transparent px-2 text-xs dark:border-neutral-700" />
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <AttachmentUpload ledgerId={ledgerId} entryId={entryId} />
      </div>

    </section>
  )
}

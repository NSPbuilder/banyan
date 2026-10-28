'use client'

import { invoiceHref } from '@/lib/invoice-routes'

import { EditLease } from '@/components/EditLease'
import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { INVOICE_FIELDS as F } from '@/lib/forms'
import { formatMoney } from '@/lib/money'
import { BUTTON, QUIET } from '@/lib/ui'

export type DetailLine = {
  line_no: number
  code: string
  name: string
  description: string | null
  /** Signed, as the ledger holds it. Shown as what it adds to the invoice. */
  amount: bigint
}


/**
 * One invoice, and the two things that can be done to it.
 *
 * Line amounts are shown as what they ADD to the invoice, which is the sign the
 * person typed — the ledger's own sign is the opposite for a sale, and showing
 * that here would mean the screen disagreed with itself between entering and
 * reading. `docs/design/09-invoices.md` section 3 has the two conventions.
 */
export function InvoiceDetail({
  ledgerId, invoiceId, version, direction, kind, status, entryNo, entryId, lines, total, actions, managed, sourceHref, sourceLabel = 'source',
}: {
  ledgerId: string
  invoiceId: string
  version?:string
  direction: 'sales' | 'purchase'
  kind: 'invoice' | 'credit_note'
  status: 'draft' | 'posted' | 'void'
  entryNo: string | null
  /** For the jump to the entry itself; absent on a render check's fixture. */
  entryId?: string | null
  lines: DetailLine[]
  total: bigint
  actions: { post: FormAction; delete: FormAction }
  managed?:boolean
  sourceLabel?:string
  sourceHref?:string
}) {
  // Same (direction, kind) rule as the paper and `totalOf` — direction alone
  // printed a credit note's lines as the negation of its total here too.
  const debitsControl = (direction === 'sales') === (kind === 'invoice')
  const asEntered = (amount: bigint) => (debitsControl ? -amount : amount)

  return (
    <>
      <table className="mt-6 w-full text-sm">
        <tbody>
          <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
            <td className="py-1 w-8">#</td>
            <td className="py-1">Account</td>
            <td className="py-1">Description</td>
            <td className="py-1 text-right">Amount</td>
          </tr>
          {lines.map((l) => (
            <tr key={l.line_no} className="border-b border-neutral-200 last:border-0 dark:border-neutral-800">
              <td className="py-2 font-mono text-xs text-neutral-400">{l.line_no}</td>
              <td className="py-2"><span className="font-mono text-xs">{l.code}</span> {l.name}</td>
              <td className="py-2 text-neutral-600 dark:text-neutral-400">{l.description}</td>
              <td className="py-2 text-right font-mono tabular-nums">
                {formatMoney(asEntered(l.amount))}
              </td>
            </tr>
          ))}
          <tr>
            <td />
            <td />
            <td className="py-2 text-right text-xs uppercase tracking-wide text-neutral-500">Total</td>
            <td className="py-2 text-right font-mono text-base tabular-nums">{formatMoney(total)}</td>
          </tr>
        </tbody>
      </table>

      {status === 'draft' && (
        <div className="mt-6 flex flex-wrap items-end gap-4">
          <ActionForm action={actions.post} submit="Post it" working="Posting…"
                      buttonClassName={BUTTON}>
            <input type="hidden" name={F.ledgerId} value={ledgerId} />
            <input type="hidden" name={F.invoiceId} value={invoiceId} />
            <EditLease passive resource={{ledgerId,type:'invoice',id:invoiceId}} version={version ?? ''} />
          </ActionForm>

          {managed ? sourceHref&&<Link href={sourceHref} className={QUIET}>Edit in {sourceLabel}</Link> : <Link href={`${invoiceHref(ledgerId, direction, invoiceId)}/edit`} className={QUIET}>Edit draft</Link>}

          {!managed&&<ActionForm action={actions.delete} submit="Delete it" working="…"
                      buttonClassName={QUIET}>
            <input type="hidden" name={F.ledgerId} value={ledgerId} />
            <input type="hidden" name={F.invoiceId} value={invoiceId} />
            <EditLease passive resource={{ledgerId,type:'invoice',id:invoiceId}} version={version ?? ''} />
            {/* Which list to go back to once this page is gone: the invoice
                list became two pages, and only the document says which. */}
            <input type="hidden" name={F.direction} value={direction} />
          </ActionForm>}
        </div>
      )}

      {status === 'posted' && managed && <p className="mt-6 text-metadata text-ink-muted">Posted as {entryNo}. {sourceHref?<Link href={sourceHref} className="underline">Edit or cancel in {sourceLabel}</Link>:`Managed by ${sourceLabel}.`}</p>}
      {status === 'posted' && !managed && (
        <div className="mt-6">
          <p className="text-sm text-neutral-500">
            Posted as{' '}
            {entryId ? (
              <Link href={`/ledger/${ledgerId}/entries/${entryId}`}
                    className="font-mono underline hover:text-neutral-800 dark:hover:text-neutral-200">
                {entryNo}
              </Link>
            ) : (
              <span className="font-mono">{entryNo}</span>
            )}. While its month is open it can be edited or deleted here, and the
            entry moves with it in the same transaction; once the month is closed,
            only a correcting document can touch it.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Link href={`${invoiceHref(ledgerId, direction, invoiceId)}/edit`}
                  className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
              Edit
            </Link>
            <ActionForm action={actions.delete} submit="Delete it" working="…"
                        buttonClassName="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50">
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
              <input type="hidden" name={F.invoiceId} value={invoiceId} />
            <EditLease passive resource={{ledgerId,type:'invoice',id:invoiceId}} version={version ?? ''} />
              <input type="hidden" name={F.direction} value={direction} />
            </ActionForm>
            <span className="text-xs text-neutral-500">
              Anything applied against it is released back to on-account, and the audit log
              keeps the document. A closed month refuses both.
            </span>
          </div>
        </div>
      )}

      {status === 'void' && (
        <p className="mt-6 text-sm text-neutral-500">
          Voided. If it had been posted, the entry it produced was reversed at the same time —
          there is nothing of it left in the ledger.
        </p>
      )}
    </>
  )
}

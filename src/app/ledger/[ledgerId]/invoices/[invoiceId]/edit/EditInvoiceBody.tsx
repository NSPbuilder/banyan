import { FxInvoiceDetail } from '../../../fx/FxDetail'

import { PageHeading } from '@/components/DialogHeading'
import { notFound } from 'next/navigation'
import { updateInvoiceAction } from '@/app/actions'
import { invoiceDetail, type DocumentKind } from '@/lib/invoices'
import { invoiceEditorState } from '@/lib/invoice-editor'
import { NewInvoiceForm } from '../../new/NewInvoiceForm'
import { invoiceFormData } from '../../new/NewInvoiceBody'
import { moduleFinanceView } from '@/lib/module-extensions'
import { requireLedger, requireUser } from '@/lib/gate'
import { redirect } from 'next/navigation'
import { invoiceHref, type InvoiceDirection } from '@/lib/invoice-routes'

/**
 * Editing a live invoice, body only — the same form that created it, opened
 * with the document's own values. The direction and kind are identity and
 * shown, not editable; the line amounts open AS ENTERED (asEnteredAmount, the
 * same helper the detail screen reads with), so what the person sees is what
 * they typed when they issued it.
 */
export async function EditInvoiceBody({
  ledgerId, invoiceId, direction = 'sales',
}: { ledgerId: string; invoiceId: string; direction?: InvoiceDirection }) {
  const detail = await invoiceDetail(invoiceId)
  if (!detail || detail.invoice.ledger_id !== ledgerId) notFound()
  if (detail.invoice.direction !== direction) redirect(`${invoiceHref(ledgerId, detail.invoice.direction, invoiceId)}/edit`)
  if (detail.invoice.fx_currency) return <FxInvoiceDetail detail={detail} />
  const origin=(await moduleFinanceView({type:'invoice',id:invoiceId,ledgerId,entityId:detail.invoice.entity_id,user:await requireUser()})).editTarget
  if(origin) {
    await requireLedger(ledgerId,origin.seat)
    redirect(origin.href)
  }
  const { invoice } = detail
  if (invoice.status === 'void') notFound()

  const data = await invoiceFormData(ledgerId)
  if (!data) notFound()

  const kind = invoice.document_kind as DocumentKind
  const openWith = invoiceEditorState(detail)

  return (
    <>
      <PageHeading className="mt-2" title={<>
        Edit {invoice.number ?? invoice.their_ref ?? 'this document'}
      </>} />
      {invoice.status==='draft'&&<p className="mt-1 text-metadata text-ink-muted">Draft · not posted</p>}

      <NewInvoiceForm
        ledgerId={ledgerId}
        parties={data.parties}
        controlAccounts={data.controlAccounts}
        lineAccounts={data.lineAccounts}
        today={data.today}
        templateData={data.templateData}
        action={updateInvoiceAction}
        openWith={openWith}
        edit={{
          invoiceId, version: invoice.version ?? '',
          direction: invoice.direction,
          kind,
          templateSelection: invoice.print_template_selection,
          templateSnapshot: invoice.print_template_snapshot,
          templateLocked: invoice.status !== 'draft',
          isDraft: invoice.status === 'draft',
          kindLabel: `${invoice.direction === 'sales' ? 'Sales' : 'Purchase'} ${kind === 'credit_note' ? 'credit note' : invoice.direction === 'sales' ? 'invoice' : 'bill'}`,
          header: {
            partyId: invoice.party_id,
            controlAccountId: invoice.control_account_id,
            issuedOn: invoice.issued_on,
            dueOn: invoice.due_on,
            number: invoice.number ?? '',
            theirRef: invoice.their_ref ?? '',
            note: invoice.note ?? '',
          },
        }}
      />
    </>
  )
}

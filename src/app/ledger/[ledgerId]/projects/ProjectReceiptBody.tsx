import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { DocumentError } from '@/lib/customer-docs'
import { renderProjectPaymentReceipt } from '@/lib/receipts'
import { InvoiceDocView } from '../invoices/[invoiceId]/print/InvoiceDocView'

/** Both the routed overlay and its deep link show the same read-only receipt. */
export async function ProjectReceiptBody({ ledgerId, projectId, paymentId, crumb = false }: {
  ledgerId: string; projectId: string; paymentId: string; crumb?: boolean
}) {
  const doc = await renderProjectPaymentReceipt(ledgerId, projectId, paymentId).catch(error => {
    if (error instanceof DocumentError) notFound()
    throw error
  })
  const project = `/ledger/${ledgerId}/projects/${projectId}`
  return <div className="min-w-0 space-y-5 p-6" data-project-receipt>
    <PageHeader title={<>Receipt <span className="break-all">{doc.receipt!.number}</span></>} context={doc.billTo.name}
      backTo={crumb ? project : undefined} backLabel="Back to project" />
    <InvoiceDocView doc={doc} pdfHref={`${project}/payments/${paymentId}/receipt?download=1`} printPdfHref={`${project}/payments/${paymentId}/receipt`} />
  </div>
}

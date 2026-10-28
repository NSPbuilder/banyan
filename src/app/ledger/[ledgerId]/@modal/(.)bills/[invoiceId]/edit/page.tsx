import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { EditInvoiceBody } from '../../../../invoices/[invoiceId]/edit/EditInvoiceBody'

export const dynamic = 'force-dynamic'

export default async function EditBillOverlay({ params }: { params: Promise<{ ledgerId: string; invoiceId: string }> }) {
  await requireUser()
  const { ledgerId, invoiceId } = await params
  return <OverlayPanel returnTo={`/ledger/${ledgerId}/bills/${invoiceId}`}>
    <EditInvoiceBody ledgerId={ledgerId} invoiceId={invoiceId} direction="purchase" />
  </OverlayPanel>
}

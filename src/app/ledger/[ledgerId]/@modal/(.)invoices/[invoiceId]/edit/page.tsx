import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { EditInvoiceBody } from '../../../../invoices/[invoiceId]/edit/EditInvoiceBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page. */
export default async function EditInvoiceOverlay({
  params,
}: { params: Promise<{ ledgerId: string; invoiceId: string }> }) {
  await requireUser()

  const { ledgerId, invoiceId } = await params
  return (
    <OverlayPanel>
      <EditInvoiceBody ledgerId={ledgerId} invoiceId={invoiceId} />
    </OverlayPanel>
  )
}

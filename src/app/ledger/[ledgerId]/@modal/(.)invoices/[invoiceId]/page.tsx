import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { DetailBody } from '../../../invoices/[invoiceId]/DetailBody'

export const dynamic = 'force-dynamic'

/**
 * The overlay: clicking an invoice on the list floats THIS over it — the list
 * stays open behind. It renders the SAME `DetailBody` the full page renders;
 * this file adds the floating frame and nothing else. A hard load of the same
 * URL skips interception and gets the full page.
 */
export default async function InvoiceOverlay({
  params,
}: { params: Promise<{ ledgerId: string; invoiceId: string }> }) {
  await requireUser()

  const { ledgerId, invoiceId } = await params
  return (
    <OverlayPanel size="wide">
      <DetailBody ledgerId={ledgerId} invoiceId={invoiceId} />
    </OverlayPanel>
  )
}

import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { DetailBody } from '../../../invoices/[invoiceId]/DetailBody'

export const dynamic = 'force-dynamic'

export default async function BillOverlay({ params }: { params: Promise<{ ledgerId: string; invoiceId: string }> }) {
  await requireUser()
  const { ledgerId, invoiceId } = await params
  return <OverlayPanel size="wide" returnTo={`/ledger/${ledgerId}/bills`}>
    <DetailBody ledgerId={ledgerId} invoiceId={invoiceId} direction="purchase" />
  </OverlayPanel>
}

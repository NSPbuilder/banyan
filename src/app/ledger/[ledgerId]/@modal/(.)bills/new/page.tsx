import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { NewInvoiceBody } from '../../../invoices/new/NewInvoiceBody'

export const dynamic = 'force-dynamic'

export default async function NewBillOverlay({ params, searchParams }: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ reading?: string; copy?: string }>
}) {
  await requireUser()
  const { ledgerId } = await params
  const { reading, copy } = await searchParams
  return <OverlayPanel size="wide" returnTo={`/ledger/${ledgerId}/bills`}>
    <NewInvoiceBody ledgerId={ledgerId} readingId={reading} copyId={copy} direction="purchase" />
  </OverlayPanel>
}

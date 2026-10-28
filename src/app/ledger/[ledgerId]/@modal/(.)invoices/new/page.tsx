import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { NewInvoiceBody } from '../../../invoices/new/NewInvoiceBody'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * The overlay exit. This static segment must exist alongside the dynamic
 * `(.)invoices/[invoiceId]` intercept, or a client navigation to
 * /invoices/new would be caught there with "new" as the id.
 */
export default async function NewInvoiceOverlay({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ reading?: string; direction?: string; copy?: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  // `?reading=<id>` reaches the deep link and must reach the overlay too:
  // pressing the card's button opens THIS route, and it opened blank
  // (owner, 2026-09-07).
  const { reading, direction, copy } = await searchParams
  if (direction === 'purchase' || reading && direction !== 'sales') {
    const query = new URLSearchParams()
    if (reading) query.set('reading', reading)
    if (copy) query.set('copy', copy)
    redirect(`/ledger/${ledgerId}/bills/new${query.size ? '?' + query.toString() : ''}`)
  }
  return (
    <OverlayPanel size="wide" returnTo={`/ledger/${ledgerId}/invoices`}>
      <NewInvoiceBody ledgerId={ledgerId} readingId={reading} direction="sales" copyId={copy} />
    </OverlayPanel>
  )
}

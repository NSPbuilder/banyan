import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { NewPartyBody } from '../../../parties/new/NewPartyBody'

export const dynamic = 'force-dynamic'

/**
 * The overlay exit. This static segment must exist alongside the dynamic
 * `(.)parties/[partyId]` intercept, or a client navigation to /parties/new
 * would be caught there with "new" as the id.
 */
export default async function NewPartyOverlay({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <OverlayPanel>
      <NewPartyBody ledgerId={ledgerId} copyId={copy} />
    </OverlayPanel>
  )
}

import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { PartyBody } from '../../../parties/[partyId]/PartyBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over the list. */
export default async function PartyOverlay({
  params,
}: { params: Promise<{ ledgerId: string; partyId: string }> }) {
  await requireUser()

  const { ledgerId, partyId } = await params
  return (
    <OverlayPanel>
      <PartyBody ledgerId={ledgerId} partyId={partyId} />
    </OverlayPanel>
  )
}

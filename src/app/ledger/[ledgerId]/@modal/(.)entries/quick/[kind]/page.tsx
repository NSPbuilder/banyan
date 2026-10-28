import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { QuickBody } from '../../../../entries/quick/[kind]/QuickBody'

export const dynamic = 'force-dynamic'

/**
 * The overlay exit: same body as the full page, floated over the journal.
 *
 * SAME BODY IS NOT ENOUGH — it must be handed the same things. This route
 * ignored `searchParams`, so `?reading=<id>` reached the deep link and never
 * the overlay, and pressing "Enter as an expense paid now" on a bill the
 * assistant had read opened a blank form (owner, 2026-09-07). The one-renderer
 * rule keeps the two screens from drifting in what they DRAW; nothing was
 * keeping them from drifting in what they are GIVEN.
 */
export default async function QuickEntryOverlay({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string; kind: string }>
  searchParams: Promise<{ reading?: string; copy?: string }>
}) {
  await requireUser()

  const { ledgerId, kind } = await params
  const { reading, copy } = await searchParams
  return (
    <OverlayPanel size="wide">
      <QuickBody ledgerId={ledgerId} kind={kind} readingId={reading} copyId={copy} />
    </OverlayPanel>
  )
}

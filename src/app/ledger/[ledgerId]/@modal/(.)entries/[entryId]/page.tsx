import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { EntryBody } from '../../../entries/[entryId]/EntryBody'

export const dynamic = 'force-dynamic'

/**
 * The overlay exit: the journal entry floated over whatever screen linked to
 * it — the invoice that produced it, the quick form that just posted it, the
 * journal list itself.
 */
export default async function EntryOverlay({
  params,
}: { params: Promise<{ ledgerId: string; entryId: string }> }) {
  await requireUser()

  const { ledgerId, entryId } = await params
  return (
    <OverlayPanel size="wide">
      <EntryBody ledgerId={ledgerId} entryId={entryId} />
    </OverlayPanel>
  )
}

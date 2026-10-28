import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { NewEntryBody } from '../../../entries/new/NewEntryBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over the journal. */
export default async function NewEntryOverlay({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <OverlayPanel size="wide">
      <NewEntryBody ledgerId={ledgerId} copyId={copy} />
    </OverlayPanel>
  )
}

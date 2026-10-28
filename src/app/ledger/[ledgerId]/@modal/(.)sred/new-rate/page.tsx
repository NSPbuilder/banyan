import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { NewRateBody } from '../../../sred/new-rate/NewRateBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over the SR&ED list. */
export default async function NewSredRateOverlay({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <OverlayPanel>
      <NewRateBody ledgerId={ledgerId} copyId={copy} />
    </OverlayPanel>
  )
}

import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { NewProjectBody } from '../../../sred/new/NewProjectBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over the project list. */
export default async function NewSredProjectOverlay({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <OverlayPanel>
      <NewProjectBody ledgerId={ledgerId} copyId={copy} />
    </OverlayPanel>
  )
}

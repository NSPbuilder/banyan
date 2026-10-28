import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { AddTimeBody } from '../../../../../sred/[projectId]/time/new/AddTimeBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over the project. */
export default async function AddSredTimeOverlay({
  params, searchParams,
}: { params: Promise<{ ledgerId: string; projectId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId, projectId } = await params
  const { copy } = await searchParams
  return (
    <OverlayPanel>
      <AddTimeBody ledgerId={ledgerId} projectId={projectId} copyId={copy} />
    </OverlayPanel>
  )
}

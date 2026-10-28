import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { RunBody } from '../../../payroll/new/RunBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over whatever page the Add menu was opened on. */
export default async function NewPayRunOverlay({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <OverlayPanel>
      <RunBody ledgerId={ledgerId} copyId={copy} />
    </OverlayPanel>
  )
}

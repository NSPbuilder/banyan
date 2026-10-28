import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { NewAccountBody } from '../../../accounts/new/NewAccountBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over the chart. */
export default async function NewAccountOverlay({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <OverlayPanel>
      <NewAccountBody ledgerId={ledgerId} copyId={copy} />
    </OverlayPanel>
  )
}

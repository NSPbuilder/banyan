import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { BreakdownBody } from '../../breakdown/BreakdownBody'

export const dynamic = 'force-dynamic'

/**
 * The overlay exit: what makes a figure up, floated over the report the
 * figure was clicked on. Escape or the backdrop goes back to the report.
 */
export default async function BreakdownOverlay({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  await requireUser()

  const { ledgerId } = await params
  const query = await searchParams
  return (
    <OverlayPanel>
      <BreakdownBody ledgerId={ledgerId} query={query} />
    </OverlayPanel>
  )
}

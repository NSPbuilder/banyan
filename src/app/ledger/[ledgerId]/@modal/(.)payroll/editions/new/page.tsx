import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { NewEditionBody } from '../../../../payroll/editions/new/NewEditionBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over Pay runs. */
export default async function NewEditionOverlay({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <OverlayPanel>
      <NewEditionBody ledgerId={ledgerId} copyId={copy} />
    </OverlayPanel>
  )
}

import { requireUser } from '@/lib/gate'
import { OverlayPanel } from '@/components/OverlayPanel'
import { RecordRowsBody } from '../../../../records/add/[table]/RecordRowsBody'

export const dynamic = 'force-dynamic'

/** The overlay exit: same body as the full page, floated over the register. */
export default async function AddRecordRowsOverlay({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string; table: string }>
  searchParams: Promise<{ reading?: string; copy?: string }>
}) {
  await requireUser()

  const { ledgerId, table } = await params
  const { reading, copy } = await searchParams
  return (
    <OverlayPanel>
      <RecordRowsBody ledgerId={ledgerId} table={table} readingId={reading ?? null} copyId={copy} />
    </OverlayPanel>
  )
}

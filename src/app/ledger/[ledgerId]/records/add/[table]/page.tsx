
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { TABLE_WORDS, isRecordTable } from '@/lib/record-rows'
import { RecordRowsBody } from './RecordRowsBody'

export const dynamic = 'force-dynamic'

/**
 * The deep link: the same body the overlay floats over a register, framed as a
 * full page. `RecordRowsBody` holds everything; this file may add furniture only.
 */
export default async function AddRecordRows({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string; table: string }>
  searchParams: Promise<{ reading?: string; copy?: string }>
}) {
  await requireUser()

  const { ledgerId, table } = await params
  const { reading, copy } = await searchParams
  const back = isRecordTable(table) ? TABLE_WORDS[table] : null
  return (
    <main className="mx-auto w-full max-w-6xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}${back?.list ?? '/records'}`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to {back?.title ?? 'Corporate records'}</ToolAction></Link>
      <RecordRowsBody ledgerId={ledgerId} table={table} readingId={reading ?? null} copyId={copy} />
    </main>
  )
}


import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { NewAccountBody } from './NewAccountBody'

export const dynamic = 'force-dynamic'

/**
 * The deep link: the same body the overlay floats over the chart, framed as a
 * full page. `NewAccountBody` holds everything; this file may add furniture only.
 */
export default async function NewAccount({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/accounts`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Chart of accounts</ToolAction></Link>
      <NewAccountBody ledgerId={ledgerId} copyId={copy} />
    </main>
  )
}

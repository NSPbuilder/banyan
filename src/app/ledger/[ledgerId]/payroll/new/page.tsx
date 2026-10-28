
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { RunBody } from './RunBody'

export const dynamic = 'force-dynamic'

/**
 * The deep link: the same body the overlay floats. `RunBody` holds everything;
 * this file may add furniture only. A LITERAL page (N7), so `/payroll/new` is
 * never read as a run id.
 */
export default async function NewPayRun({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <main className="mx-auto w-full max-w-5xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/payroll`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Pay runs</ToolAction></Link>
      <RunBody ledgerId={ledgerId} copyId={copy} />
    </main>
  )
}

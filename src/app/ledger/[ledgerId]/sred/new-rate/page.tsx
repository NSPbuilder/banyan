
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { NewRateBody } from './NewRateBody'

export const dynamic = 'force-dynamic'

/** The deep link: the same body the overlay floats over the SR&ED list. */
export default async function NewSredRate({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <main className="mx-auto w-full max-w-5xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/sred`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to SR&amp;ED</ToolAction></Link>
      <NewRateBody ledgerId={ledgerId} copyId={copy} />
    </main>
  )
}


import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { NewEditionBody } from './NewEditionBody'

export const dynamic = 'force-dynamic'

/** The deep link: the same body the overlay floats over Pay runs. */
export default async function NewEdition({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const { copy } = await searchParams
  return (
    <main className="mx-auto w-full max-w-4xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/payroll`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Pay runs</ToolAction></Link>
      <NewEditionBody ledgerId={ledgerId} copyId={copy} />
    </main>
  )
}

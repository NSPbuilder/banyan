
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { AddTimeBody } from './AddTimeBody'

export const dynamic = 'force-dynamic'

/** The deep link: the same body the overlay floats over the project. */
export default async function AddSredTime({
  params, searchParams,
}: { params: Promise<{ ledgerId: string; projectId: string }>; searchParams: Promise<{ copy?: string }> }) {
  await requireUser()

  const { ledgerId, projectId } = await params
  const { copy } = await searchParams
  return (
    <main className="mx-auto w-full max-w-4xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/sred/${projectId}`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to The project</ToolAction></Link>
      <AddTimeBody ledgerId={ledgerId} projectId={projectId} copyId={copy} />
    </main>
  )
}

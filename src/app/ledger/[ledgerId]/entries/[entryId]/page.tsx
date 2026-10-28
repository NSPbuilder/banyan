
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { EntryBody } from './EntryBody'

export const dynamic = 'force-dynamic'

/** The deep link: same body as the overlay, framed as a full page. */
export default async function EditEntry({
  params,
}: { params: Promise<{ ledgerId: string; entryId: string }> }) {
  await requireUser()

  const { ledgerId, entryId } = await params

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/entries`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Journal</ToolAction></Link>
      <EntryBody ledgerId={ledgerId} entryId={entryId} />
    </main>
  )
}

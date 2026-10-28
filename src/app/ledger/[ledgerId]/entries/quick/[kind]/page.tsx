
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { QuickBody } from './QuickBody'

export const dynamic = 'force-dynamic'

/**
 * The deep link: the same body the overlay floats over the journal, framed as
 * a full page. `QuickBody` holds everything; this file may add furniture only.
 */
export default async function QuickEntryPage({
  params, searchParams,
}: { params: Promise<{ ledgerId: string; kind: string }>; searchParams: Promise<{ reading?: string; copy?: string }> }) {
  await requireUser()

  const { ledgerId, kind } = await params
  // `?reading=<id>`: open filled in from a reading (0064, 0077).
  const { reading, copy } = await searchParams

  return (
    <main className="mx-auto max-w-5xl p-10 font-sans">
      <Link href={reading ? `/ledger/${ledgerId}/readings` : `/ledger/${ledgerId}/entries`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">{reading ? 'Back to AI' : 'Back to Journal'}</ToolAction></Link>
      <QuickBody ledgerId={ledgerId} kind={kind} readingId={reading} copyId={copy} />
    </main>
  )
}

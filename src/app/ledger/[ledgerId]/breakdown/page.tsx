
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { BreakdownBody } from './BreakdownBody'

export const dynamic = 'force-dynamic'

/**
 * The full-page exit: a refreshed overlay, a shared link, a bookmark. Same
 * body as the overlay, so the two cannot drift.
 */
export default async function BreakdownPage({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  await requireUser()

  const { ledgerId } = await params
  const query = await searchParams
  return (
    <main className="mx-auto w-full max-w-none px-8 py-10">
      <Link href={`/ledger/${ledgerId}`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to the books</ToolAction></Link>
      <div className="mt-4">
        <BreakdownBody ledgerId={ledgerId} query={query} />
      </div>
    </main>
  )
}

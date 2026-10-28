
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { PartyBody } from './PartyBody'

export const dynamic = 'force-dynamic'

/**
 * The deep link: the same body the overlay floats over the list, framed as a
 * full page. `PartyBody` holds everything; this file may add furniture only.
 */
export default async function OneParty({
  params,
}: { params: Promise<{ ledgerId: string; partyId: string }> }) {
  await requireUser()

  const { ledgerId, partyId } = await params

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/parties`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Customers and suppliers</ToolAction></Link>
      <PartyBody ledgerId={ledgerId} partyId={partyId} />
    </main>
  )
}

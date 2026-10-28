import { PageHeader } from '@/components/PageHeader'

import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { accountStandings } from '@/lib/bank'
import { BUTTON } from '@/lib/ui'
import { ledgerHead } from '@/lib/ledger-head'

export const dynamic = 'force-dynamic'

/**
 * Banking — the way in, and nothing else.
 *
 * This used to be a screen: a list of the accounts with rows on file, how many
 * waited on each, and a link into one of them. Bank transactions grew a card
 * per account across its own top on 2026-09-10, which is that list — so this
 * became a page whose only content was a worse copy of the next page's header
 * (owner, 2026-09-10: 「现在的banking界面不需要了」).
 *
 * It sends you to an account instead. Which one: the first with something
 * waiting, because that is what somebody opening Banking came to do; failing
 * that, the first there is.
 *
 * IT STILL RENDERS FOR ONE CASE — books with no bank rows at all. There is
 * nowhere to send those, and "nothing here" with no way forward is how a
 * person concludes the module is broken.
 */
export default async function Banking({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const standings = await accountStandings(head.entity_id)
  const land = standings.find((s) => s.review > 0) ?? standings[0]
  if (land) redirect(`/ledger/${ledgerId}/bank/${land.id}`)

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Banking</>} backTo={`/ledger/${ledgerId}`} backLabel={`Back to ${head.entity}`} />

      <p className="mt-4">
        <Link href={`/ledger/${ledgerId}/bank/import`} className={BUTTON}>Read a bank file</Link>
      </p>
    </main>
  )
}

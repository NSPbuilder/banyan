import { PageHeader } from '@/components/PageHeader'

import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { accountStandings } from '@/lib/bank'
import { Standings } from '../Standings'
import { ledgerHead } from '@/lib/ledger-head'

export const dynamic = 'force-dynamic'

/**
 * Reconcile — the second door (19). The same accounts, read for the other
 * question: which statement is newest, and how far each account is signed off.
 */
export default async function ReconcileLanding({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const standings = await accountStandings(head.entity_id)

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Reconcile</>} backTo={`/ledger/${ledgerId}`} backLabel={`Back to ${head.entity}`} />

      <p className="mt-2 max-w-2xl text-xs text-neutral-500">
        When the difference is zero, finish it, and everything up to that date is frozen until the
        reconciliation is undone.
      </p>

      <Standings ledgerId={ledgerId} standings={standings} door="reconcile" />
    </main>
  )
}

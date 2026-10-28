import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/gate'

/** The file directory returns to the statement list; individual files have their own scoped door. */
export default async function StatementFileIndex({ params }: {
  params: Promise<{ ledgerId: string; accountId: string }>
}) {
  await requireUser()
  const { ledgerId, accountId } = await params
  redirect(`/ledger/${ledgerId}/bank/${accountId}/reconcile`)
}

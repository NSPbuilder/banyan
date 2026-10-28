import { requireUser } from '@/lib/gate'

/** Clear the modal slot when navigating to the ledger root itself. */
export default async function DismissModalAtLedgerRoot() {
  await requireUser()
  return null
}

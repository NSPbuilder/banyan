import { requireUser } from '@/lib/gate'
import { PartyLedgerPage } from '../PartyLedgerPage'

export const dynamic = 'force-dynamic'

/**
 * MONEY OUT, by party — everything about a supplier in one place (owner,
 * 2026-09-03). Bills, immediate expenses, payments, journals and the
 * documents that never reached the books, each row saying which it is.
 *
 * A browse view, not a form: creation lives behind + Add. The Expense column
 * still ties to the trial balance's own expense movement (X32 holds the two
 * readers together) because only the rows that touched an expense account
 * carry a figure there; the Unpaid column answers the other question.
 */
export default async function ExpensesPage(props: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ from?: string; to?: string; party?: string }>
}) {
  await requireUser()
  return <PartyLedgerPage direction="out" {...props} />
}

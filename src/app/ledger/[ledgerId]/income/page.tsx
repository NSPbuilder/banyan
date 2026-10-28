import { requireUser } from '@/lib/gate'
import { PartyLedgerPage } from '../PartyLedgerPage'

export const dynamic = 'force-dynamic'

/** MONEY IN, by party — /expenses with the other sign and the other paper. */
export default async function IncomePage(props: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ from?: string; to?: string; party?: string }>
}) {
  await requireUser()
  return <PartyLedgerPage direction="in" {...props} />
}

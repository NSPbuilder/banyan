import { PageHeader } from '@/components/PageHeader'

import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  acceptMatchesAction, createAccountAction, createPartyAction, ignoreRowAction, matchAction,
  deleteBankRowAction, postFromRowAction, unignoreRowAction, unmatchAction,
} from '@/app/actions'
import { accountStandings, feed, importableAccounts } from '@/lib/bank'
import { transactingPartyRoles } from '@/lib/parties'
import { tagsAvailable } from '@/lib/tagged-line'
import { FEED_TABS, type FeedTab } from '@/lib/bank-feed'
import { FeedScreen } from './FeedScreen'

export const dynamic = 'force-dynamic'

/**
 * The bank feed for one account — QuickBooks' Banking page (19).
 *
 * This page used to be the whole module: the feed, the reconciliation summary
 * and the statement panel on one screen. The reconcile half is its own page
 * now (`./reconcile`); this one asks a single question per row — what is this,
 * in the books?
 */
export default async function BankFeed(
  { params, searchParams }: {
    params: Promise<{ ledgerId: string; accountId: string }>
    searchParams: Promise<{ tab?: string }>
  },
) {
  await requireUser()

  const { ledgerId, accountId } = await params
  const asked = (await searchParams).tab
  const tab: FeedTab = (FEED_TABS as readonly string[]).includes(asked ?? '') ? asked as FeedTab : 'pending'

  const [head] = await db.execute<{ entity: string; entity_id: string; code: string; name: string;currency:string }>(sql`
    SELECT e.name AS entity, e.id::text AS entity_id, a.code, a.name,COALESCE(a.foreign_currency,l.currency) AS currency
      FROM ledger l
      JOIN entity e ON e.id = l.entity_id
      JOIN account a ON a.entity_id = e.id
     WHERE l.id = ${ledgerId}::uuid AND a.id = ${accountId}::uuid`)
  if (!head) notFound()

  const f = await feed(accountId)
  // Every account with rows, for the cards across the top — the same list the
  // bank landing reads, so a figure cannot differ between the two screens.
  const standings = await accountStandings(head.entity_id)
  // The other side of an Add. An account that has bank rows of its own is a
  // bank account, and adding to one of those is a transfer.
  const contraAccounts = (await importableAccounts(head.entity_id))
    .filter((a) => a.id !== accountId)
    .map((a) => ({ id: a.id, code: a.code, name: a.name, bank: a.landed !== '0' }))

  // Who it was with, and which tax tags this company can actually honour — an
  // Add used to be the one door that could name neither (owner, 2026-09-07).
  // A tag with no account to land on is not offered rather than refused after
  // the fact; `tagsAvailable` asks the chart the same way the arithmetic will.
  const [parties, tags] = await Promise.all([
    transactingPartyRoles(head.entity_id),
    tagsAvailable(ledgerId),
  ])

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Bank transactions</>} backTo={`/ledger/${ledgerId}/bank`} backLabel={`Back to Banking`} />

      <FeedScreen
        ledgerId={ledgerId}
        accountId={accountId}
        accountLabel={`${head.code} — ${head.name}${head.currency==='CAD'?'':` (${head.currency})`}`}
        standings={standings}
        tab={tab}
        counts={{ pending: f.pending.length, posted: f.posted.length, excluded: f.excluded.length }}
        rows={f[tab]}
        contraAccounts={contraAccounts}
        parties={parties}
        tags={{ recoverable: tags.recoverable !== null, payable: tags.payable !== null, pstPayable: tags.pstPayable !== null }}
        makers={{ account: createAccountAction, party: createPartyAction }}
        actions={{
          match: matchAction,
          unmatch: unmatchAction,
          ignore: ignoreRowAction,
          unignore: unignoreRowAction,
          remove: deleteBankRowAction,
          post: postFromRowAction,
          accept: acceptMatchesAction,
        }}
      />

    </main>
  )
}

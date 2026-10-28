'use client'

import { useSearchParams } from 'next/navigation'
import { ContextDirectory } from '@/components/ContextDirectory'
import { partyLedgerHref, type PartyDirectoryItem } from '@/lib/party-ledger-navigation'

export function PartyDirectory({ ledgerId, direction, items, selected, total }: {
  ledgerId: string; direction: 'in' | 'out' | 'invoices' | 'bills'; items: PartyDirectoryItem[]; selected: string; total: number
}) {
  const search = useSearchParams()
  const title = direction === 'in' || direction === 'invoices' ? 'Customers' : 'Suppliers'
  const path = direction === 'in' ? 'income' : direction === 'out' ? 'expenses' : direction
  return <aside className="party-directory print:hidden" aria-label={title}>
    <ContextDirectory label={title} items={items} selected={selected} total={total}
      href={id => partyLedgerHref(`/ledger/${ledgerId}/${path}`, search.toString(), id)} />
  </aside>
}

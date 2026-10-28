import type { LedgerRow } from './browse'

export const NO_PARTY = 'none'
export type PartyDirectoryItem = { id: string; name: string; count: number }

/** Include known roles with no activity and historical counterparties still named by rows. */
export function partyDirectory(rows: LedgerRow[], known: Array<{ id: string; name: string }>, direction: 'in' | 'out'): PartyDirectoryItem[] {
  const items = new Map(known.map(p => [p.id, { ...p, count: 0 }]))
  for (const row of rows) {
    const id = row.party_id ?? NO_PARTY
    const item = items.get(id) ?? { id, name: row.party_name ?? (direction === 'in' ? 'No customer' : 'No supplier'), count: 0 }
    item.count++
    items.set(id, item)
  }
  return [...items.values()].sort((a, b) => a.id === NO_PARTY ? 1 : b.id === NO_PARTY ? -1 : a.name.localeCompare(b.name))
}

/** Unknown/stale selection falls back to All; it never exposes another company's rows. */
export function selectedParty(items: PartyDirectoryItem[], wanted?: string): PartyDirectoryItem | null {
  return items.find(p => p.id === wanted) ?? null
}

export function rowsForParty(rows: LedgerRow[], selected: PartyDirectoryItem | null): LedgerRow[] {
  return selected ? rows.filter(r => (r.party_id ?? NO_PARTY) === selected.id) : rows
}

export function partyLedgerHref(base: string, search: string, party: string): string {
  const params = new URLSearchParams(search)
  if (party) params.set('party', party)
  else params.delete('party')
  const query = params.toString()
  return base + (query ? `?${query}` : '')
}

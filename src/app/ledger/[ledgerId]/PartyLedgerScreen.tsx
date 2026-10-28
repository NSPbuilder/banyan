'use client'

import { invoiceHref } from '@/lib/invoice-routes'
import { useState, type ReactNode } from 'react'
import { PartyGroups, type Cell } from '@/components/PartyGroups'
import type { Direction, LedgerRow, RowKind } from '@/lib/browse'
import {invoiceEmailLink} from '@/lib/workflow-links'

/**
 * One party, everything about them, in one place (owner, 2026-09-03).
 *
 * Income and Expenses share this register. Each party occupies its own
 * column, while invoice/bill details open from the record. Every row says
 * what it IS — Bill, Payment,
 * Expense, Credit note, Journal — and carries two figures that answer two
 * different questions:
 *
 *   the first is what the row put into the profit and loss, and it is empty
 *   for a payment and for a document that never reached the books. That
 *   column is the one that still adds up to the trial balance's movement.
 *
 *   the second is what is still owed on the document, tax included, because
 *   tax is what gets paid. It is a POSITION — owed today or not — so it does
 *   not move when the date range does.
 *
 * Adding the two together would be a bill and its own payment counted twice,
 * which is exactly why they are two columns and two subtotals.
 */

const STATE_TONE: Record<LedgerRow['state'], 'ok' | 'muted' | 'struck'> = {
  posted: 'ok',
  reversed: 'muted',
  draft: 'muted',
  void: 'struck',
}

const ALL = 'Everything'

export function PartyLedgerScreen({ ledgerId, direction, rows, mayJournal, hidePartySearch = false, filters,mailContacts=null }: {
  ledgerId: string
  filters?: ReactNode
  direction: Direction
  rows: LedgerRow[]
  mayJournal: boolean
  hidePartySearch?: boolean
  mailContacts?:Record<string,string|null>|null
}) {
  const [kind, setKind] = useState<string>(ALL)
  // Offered from what is actually there: a filter listing kinds this ledger
  // has never seen would be a menu of empty pages.
  const kinds = [ALL, ...[...new Set(rows.map((r) => r.kind))].sort()]
  const visible = kind === ALL ? rows : rows.filter((r) => r.kind === kind)

  return (
    <PartyGroups
      partyColumn
      sortableAmounts
      filters={filters}
      searchLabel={hidePartySearch ? undefined : 'Find a party'}
      filter={{ label: 'Type', value: kind, options: kinds, onChange: setKind }}
      flipSign={direction === 'in'}
      moneyLabel="Total"
      moneyTitle={direction === 'in' ? 'Posted income excluding tax; payments are not counted again.' : 'Posted expense excluding tax; payments are not counted again.'}
      secondLabel="Unpaid"
      columns={[
        { label: 'Description', width: 'min-w-40' },
        { label: 'Type', width: 'w-24', nowrap: true, sortable: true },
        { label: 'Entry', width: 'w-28', mono: true, nowrap: true, sortable: true },
        { label: direction === 'in' ? 'Invoice #' : 'Their invoice #', width: 'w-36', mono: true },
        { label: 'Date', width: 'w-28', faint: true, nowrap: true, sortable: true },
        ...(mailContacts?[{label:'Email',width:'w-36',nowrap:true}]:[]),
      ]}
      sections={[{
        title: 'Total',
        rows: visible.map((r) => ({
          partyId: r.party_id,
          partyName: r.party_name,
          row: {
            key: r.key,
            href: r.href.kind === 'invoice'
              ? invoiceHref(ledgerId, direction === 'in' ? 'sales' : 'purchase', r.href.id)
              : `/ledger/${ledgerId}/entries/${r.href.id}`,
            amount: r.pl_amount,
            second: r.unpaid,
            cells: [
              // A row with no p&l figure says where the money went instead.
              r.note ? `${r.description} (${r.note})` : r.description,
              r.kind,
              r.entry_id && r.entry_no
                ? mayJournal ? { text: r.entry_no, href: `/ledger/${ledgerId}/entries/${r.entry_id}` } : r.entry_no
                : '—',
              r.doc_ref ?? '—',
              r.on_date,
              ...(mailContacts?[r.href.kind==='invoice'&&r.party_id?invoiceEmailLink(ledgerId,r.href.id,r.party_id,mailContacts[r.party_id],r.state):'']:[]),
            ],
            metadata: r.state !== 'posted' ? [
              // A plain posted row says nothing: the absence of a badge is
              // the ordinary case, and a page of green "posted" chips is a
              // page nobody reads.
              { text: r.state, tone: STATE_TONE[r.state] } as Cell,
            ] : undefined,
          },
        })),
      }]}
    />
  )
}

export type { RowKind }

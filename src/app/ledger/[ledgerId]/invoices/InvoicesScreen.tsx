'use client'

import { PageState } from '@/components/PageState'
import { PartyGroups, type Cell } from '@/components/PartyGroups'
import { documentNumber } from '@/lib/doc-number'
import Form from 'next/form'
import { useRef } from 'react'
import { useRouter } from 'next/navigation'
import { DateInput } from '@/components/DateInput'
import { FilterBar } from '@/components/FormLayout'
import { FIELD, GHOST, LABEL, QUIET } from '@/lib/ui'
import { formatNumber } from '@/lib/numbers'
import type { InvoiceFilters } from '@/lib/invoice-filters'
import { invoiceHref, type InvoiceDirection } from '@/lib/invoice-routes'
import {invoiceEmailLink} from '@/lib/workflow-links'

export type InvoiceRow = {
  id: string
  direction: 'sales' | 'purchase'
  party_id: string
  number: string | null
  their_ref: string | null
  party_name: string
  issued_on: string
  due_on: string
  status: 'draft' | 'posted' | 'void'
  document_kind?: 'invoice' | 'credit_note'
  total: bigint
}

export type Choice = { id: string; label: string }

/** A document's state, in the browse renderer's own closed vocabulary. */
const TONE: Record<InvoiceRow['status'], 'ok' | 'muted' | 'struck'> = {
  draft: 'muted',
  posted: 'ok',
  void: 'struck',
}

/**
 * The invoice list keeps its shared party groups and subtotals. Combined
 * filters query the ledger on the server and persist in the URL. The form
 * that makes a new one lives at `invoices/new`
 * (`NewInvoiceForm`), floated over this list by the intercepting route — the
 * create-buttons-are-overlays rule.
 *
 * It renders `PartyGroups`, the same by-party browse the expenses and income
 * pages render. It used to carry a near-identical grouping renderer of its
 * own — two answers to "what does a party's paper look like", and the columns
 * of one never lined up with the columns of the other.
 */
export function InvoicesScreen({ ledgerId, direction = 'sales', rows, filters, error,mailContacts=null }: {
  ledgerId: string; direction?: InvoiceDirection; rows: InvoiceRow[]; filters: InvoiceFilters; error: string | null;mailContacts?:Record<string,string|null>|null
}) {
  const router = useRouter()
  const filterForm = useRef<HTMLFormElement>(null)
  const base = invoiceHref(ledgerId, direction)
  const purchase = direction === 'purchase'
  const active = Boolean(filters.q || filters.from || filters.to || filters.partyId)
  const partyCount = new Set(rows.map(r => r.party_id)).size
  const section = (title: string, direction: InvoiceRow['direction']) => ({
    title,
    rows: rows.filter((r) => r.direction === direction).map((r) => ({
      partyId: r.party_id,
      partyName: r.party_name,
      row: {
        key: r.id,
        href: invoiceHref(ledgerId, r.direction, r.id),
        amount: String(r.total),
        metadata: r.document_kind === 'credit_note' ? ['Credit note'] : undefined,
        // Voided paper is history, not money — it shows and does not count.
        excludeFromTotal: r.status === 'void',
        cells: [
          // The same rule the expenses browse prints by: whoever raised the
          // document gave it its number. This list used to prefer OURS on
          // both directions, so one bill appeared here under our filing
          // number and on /expenses under the supplier's.
          documentNumber(r) ?? 'unnumbered',
          r.issued_on,
          r.due_on,
          { text: r.status, tone: TONE[r.status] } as Cell,
          ...(mailContacts?[invoiceEmailLink(ledgerId,r.id,r.party_id,mailContacts[r.party_id],r.status)]:[]),
        ],
      },
    })),
  })

  return (
    <PartyGroups
      toolbar={<>
        <Form ref={filterForm} action={base} scroll={false} aria-label={purchase ? 'Bill filters' : 'Invoice filters'}>
          <input type="hidden" name="party" value={filters.partyId} />
          <FilterBar actions={<>
            <button type="submit" className={QUIET}>Apply</button>
            <button type="button" className={GHOST} onClick={() => {
              filterForm.current?.reset()
              router.push(base, { scroll: false })
            }}>Clear</button>
          </>}>
            <label className={`${LABEL} min-w-48 max-w-sm flex-1`}>
              Search
              <input name="q" type="search" defaultValue={filters.q} placeholder="Number, party or description"
                className={`mt-1 w-full ${FIELD}`} />
            </label>
            <label className={`${LABEL} w-36 shrink-0`}>
              Issued from
              <DateInput name="from" defaultValue={filters.from} className={`mt-1 w-full ${FIELD}`} />
            </label>
            <label className={`${LABEL} w-36 shrink-0`}>
              Issued to
              <DateInput name="to" defaultValue={filters.to} className={`mt-1 w-full ${FIELD}`} />
            </label>
          </FilterBar>
        </Form>
        {!error && <p className="mb-3 text-metadata text-ink-muted" role="status">
          {formatNumber(rows.length)} {rows.length === 1 ? 'document' : 'documents'}, {formatNumber(partyCount)} {partyCount === 1 ? 'party' : 'parties'}
        </p>}
      </>}
      emptyState={<PageState role={error ? 'alert' : 'status'}
        title={error ? 'Check the filters' : active ? `No ${purchase ? 'bills' : 'invoices'} match these filters.` : `No ${purchase ? 'bills' : 'invoices'} yet.`}
        action={(active || error) && <button type="button" className={GHOST} onClick={() => {
          filterForm.current?.reset(); router.push(base, { scroll: false })
        }}>Clear filters</button>}>
        {error || (!active ? `Use New ${purchase ? 'bill' : 'invoice'} to create the first document.` : undefined)}
      </PageState>}
      sortableAmounts
      columns={[
        { label: 'Number', width: 'w-40', mono: true, sortable: true },
        { label: 'Issued', width: 'w-28', mono: true, faint: true, nowrap: true, sortable: true },
        { label: 'Due', width: 'w-28', mono: true, faint: true, nowrap: true, sortable: true },
        { label: 'Status', width: 'w-24', sortable: true },
        ...(mailContacts?[{label:'Email',width:'w-36',nowrap:true}]:[]),
      ]}
      sections={[section(purchase ? 'Supplier bills' : 'Invoices', direction)]}
    />
  )
}

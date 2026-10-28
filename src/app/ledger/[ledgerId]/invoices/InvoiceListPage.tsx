import Link from 'next/link'
import { notFound } from 'next/navigation'
import { invoicePartiesFor, invoicesFor } from '@/lib/invoices'
import { readInvoiceFilters, type InvoiceFilterParams } from '@/lib/invoice-filters'
import { invoiceHref, type InvoiceDirection } from '@/lib/invoice-routes'
import { InvoicesScreen } from './InvoicesScreen'
import { BUTTON } from '@/lib/ui'
import { PageHeader } from '@/components/PageHeader'
import { ledgerHead } from '@/lib/ledger-head'
import { PartyDirectory } from '../PartyDirectory'
import {invoiceMailContacts} from '@/lib/invoice-mail-links'

export type InvoiceListProps = {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<InvoiceFilterParams>
}

/** One list renderer, with the document direction fixed by its workspace. */
export async function InvoiceListPage({ direction, params, searchParams }: InvoiceListProps & { direction: InvoiceDirection }) {
  const { ledgerId } = await params
  if (!(await ledgerHead(ledgerId))) notFound()
  const { filters, error } = readInvoiceFilters({ ...await searchParams, direction })
  const [rows, parties] = await Promise.all([
    error ? Promise.resolve([]) : invoicesFor(ledgerId, { ...filters, partyId: '' }),
    invoicePartiesFor(ledgerId, direction),
  ])
  const items = parties.map(p => ({ id: p.id, name: p.label, count: rows.filter(r => r.party_id === p.id).length }))
  const selected = items.find(p => p.id === filters.partyId)
  const visible = filters.partyId ? rows.filter(r => r.party_id === filters.partyId) : rows
  const purchase = direction === 'purchase'
  const mailContacts=purchase?null:await invoiceMailContacts(ledgerId)
  return <div className="party-ledger-workspace">
    <PartyDirectory ledgerId={ledgerId} direction={purchase ? 'bills' : 'invoices'} items={items}
      selected={filters.partyId} total={rows.length} />
    <main className="party-ledger-content mx-auto w-full max-w-none px-8 py-7 font-sans">
      <PageHeader title={purchase ? 'Supplier bills' : 'Invoices'} context={selected?.name ?? (purchase ? 'All suppliers' : 'All customers')}>
        <Link href={invoiceHref(ledgerId, direction, 'new')} className={BUTTON}>{purchase ? 'New bill' : 'New invoice'}</Link>
      </PageHeader>
      <InvoicesScreen key={JSON.stringify(filters)} ledgerId={ledgerId} direction={direction} rows={visible} filters={filters} error={error} mailContacts={mailContacts}/>
    </main>
  </div>
}

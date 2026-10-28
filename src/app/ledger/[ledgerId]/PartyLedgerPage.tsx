import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ledgerHead } from '@/lib/ledger-head'
import { partyLedger } from '@/lib/browse'
import { partiesAsAt } from '@/lib/parties'
import { partyDirectory, selectedParty, rowsForParty } from '@/lib/party-ledger-navigation'
import { firstBookDay, resolvePeriodSpan } from '@/lib/balances'
import { rangePresets, spanLabel } from '@/lib/date-range'
import { localToday } from '@/lib/today'
import { RangePicker } from '@/components/RangePicker'
import { PartyLedgerScreen } from './PartyLedgerScreen'
import { PartyDirectory } from './PartyDirectory'
import { BUTTON, QUIET } from '@/lib/ui'
import { PageHeader } from '@/components/PageHeader'
import { requireUser } from '@/lib/gate'
import { refuseForLedger } from '@/lib/access'
import { invoiceHref } from '@/lib/invoice-routes'
import {invoiceMailContacts} from '@/lib/invoice-mail-links'

const WORDS = {
  in: { title: 'Income' },
  out: { title: 'Expenses' },
} as const

/**
 * Money in or money out, by party — one page wearing two titles. /income and
 * /expenses were the same sixty lines with the sign and the words changed;
 * each keeps its own file for the route, its own sentence for why, and its
 * own `requireUser()` — the gate stays in the page file, where `N14` reads it.
 */
export async function PartyLedgerPage({ direction, params, searchParams }: {
  direction: 'in' | 'out'
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ from?: string; to?: string; party?: string }>
}) {
  const { ledgerId } = await params
  const wanted = await searchParams

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()
  const allFrom = await firstBookDay(ledgerId)

  const today = localToday()
  const from = wanted.from ?? allFrom ?? rangePresets(today)[0].from
  const to = wanted.to ?? today
  const span = await resolvePeriodSpan(ledgerId, from, to)

  const rows = await partyLedger(ledgerId, direction, from, to)
  const known = await partiesAsAt(head.entity_id, to, direction === 'in' ? 'customer' : 'supplier')
  const directory = partyDirectory(rows, known, direction)
  const selected = selectedParty(directory, wanted.party)
  const visible = rowsForParty(rows, selected)
  const w = WORDS[direction]
  const documents = invoiceHref(ledgerId, direction === 'in' ? 'sales' : 'purchase')
  const user = await requireUser()
  const [documentRefusal, journalRefusal] = await Promise.all([
    refuseForLedger(user, ledgerId, '/invoices'),
    refuseForLedger(user, ledgerId, '/entries'),
  ])
  const mayDocuments = !documentRefusal
  const mailContacts=direction==='in'?await invoiceMailContacts(ledgerId):null

  return (
    <div className="party-ledger-workspace">
    <PartyDirectory ledgerId={ledgerId} direction={direction} items={directory} selected={selected?.id ?? ''} total={rows.length} />
    <main className="party-ledger-content mx-auto w-full max-w-none px-8 py-7 font-sans">
      <PageHeader title={w.title} context={<>
        {selected?.name ?? (direction === 'in' ? 'All customers' : 'All suppliers')}
        {span ? ` · ${spanLabel(span.fromPeriod.name, span.toPeriod.name)}` : ''}
        <span> · Unpaid as of today</span>
      </>}>
        {direction === 'out' && <Link href={`/ledger/${ledgerId}/cheques`} className={QUIET}>Cheques</Link>}
        {mayDocuments && <>
          <Link href={documents} className={QUIET}>{direction === 'in' ? 'Invoices' : 'Supplier bills'}</Link>
          <Link href={`${documents}/new`} className={direction === 'in' ? BUTTON : QUIET}>{direction === 'in' ? 'New invoice' : 'New bill'}</Link>
        </>}
        {direction === 'out' && <Link href={`/ledger/${ledgerId}/entries/quick/expense`} className={BUTTON}>New expense</Link>}
      </PageHeader>

      <PartyLedgerScreen key={selected?.id ?? 'all'} ledgerId={ledgerId} direction={direction} rows={visible}
                         mayJournal={!journalRefusal} hidePartySearch mailContacts={mailContacts}
                         filters={<RangePicker from={from} to={to} today={today} allFrom={allFrom ?? undefined} />} />
    </main>
    </div>
  )
}

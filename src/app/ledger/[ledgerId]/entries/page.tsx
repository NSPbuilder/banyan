
import { formatNumber } from '@/lib/numbers'
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { journalEntries } from '@/lib/reports'
import { readQuery } from '@/lib/query'
import { firstBookDay } from '@/lib/balances'
import { localToday } from '@/lib/today'
import { formatMoney } from '@/lib/money'
import { RangePicker } from '@/components/RangePicker'
import { SearchBox } from '@/components/SearchBox'
import { BUTTON, QUIET } from '@/lib/ui'
import { PageState } from '@/components/PageState'
import { PageHeader } from '@/components/PageHeader'
import { FilterBar } from '@/components/FormLayout'
import { DataTable, TableViewport } from '@/components/Table'
import { DateText, Money } from '@/components/AccountingData'
import { Pagination } from '@/components/Pagination'
import { EntryLines } from './EntryLines'
import { deletedEntrySentence } from '@/lib/forms'

export const dynamic = 'force-dynamic'

type Entry = Awaited<ReturnType<typeof journalEntries>>[number]

/**
 * The journal, with its own search box and date range (owner, 2026-09-03).
 *
 * Neither is this page's own idea of matching: the query is parsed by
 * `readQuery`, which the search page uses too, and the filtering happens
 * inside `journalEntries`, which is the reader BOTH pages render. The range
 * matters more here than anywhere else — the posted list is capped, so
 * before this an entry from two years ago simply fell off the end with
 * nothing saying so.
 */
export default async function Entries({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{
    q?: string; from?: string; to?: string; page?: string
    /** What a delete that had to leave the entry's own page carried here. */
    gone?: string; apps?: string; matches?: string
  }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const wanted = await searchParams
  const query = readQuery(wanted.q ?? '')

  const [head] = await db.execute<{ entity: string; accounts: string }>(sql`
    SELECT e.name AS entity,
           (SELECT count(*) FROM account a WHERE a.entity_id = e.id AND a.is_postable)::text AS accounts
      FROM ledger l JOIN entity e ON e.id = l.entity_id WHERE l.id = ${ledgerId}::uuid`)
  if (!head) notFound()

  const today = localToday()
  const allFrom = await firstBookDay(ledgerId)
  // No range asked for means the whole journal: this page is a list of what
  // happened, not a report about a period, so the honest default is
  // everything and the picker narrows it.
  const from = wanted.from
  const to = wanted.to

  const page = /^\d+$/.test(wanted.page ?? '') ? Math.max(1, Math.min(10000, Number(wanted.page))) : 1
  const [drafts, postedRead, stale] = await Promise.all([
    journalEntries(ledgerId, { status: 'draft', q: query, from, to }),
    journalEntries(ledgerId, { status: 'posted', limit: 101, offset: (page - 1) * 100, q: query, from, to }),
    db.execute<{ id: string; reason: string }>(sql`
      SELECT id, reason FROM check_stale_drafts(${ledgerId}::uuid)`),
  ])
  const posted = postedRead.slice(0, 100)
  const pageLink = (n: number) => {
    const q = new URLSearchParams()
    if (query.text) q.set('q', query.text)
    if (from) q.set('from', from)
    if (to) q.set('to', to)
    q.set('page', String(n))
    return `/ledger/${ledgerId}/entries?${q}`
  }
  const reasonById = new Map(stale.map((s) => [s.id, s.reason]))

  const row = (e: Entry, isDraft: boolean) => (
    <tr data-row key={e.id} className="border-b border-neutral-200 align-top dark:border-neutral-800">
      <td className="w-28 py-2 font-mono text-xs text-neutral-500"><DateText value={e.entry_date} /></td>
      <td className="w-28 py-2 font-mono text-xs">{e.entry_no ?? '—'}</td>
      <td className="py-2">
        <Link href={`/ledger/${ledgerId}/entries/${e.id}`} className="hover:underline">
          {e.description}
        </Link>
        {e.status === 'reversed' && e.reversed_by && (
          <span className="ml-2 text-xs text-neutral-500">reversed by {e.reversed_by}</span>
        )}
        {e.reverses && (
          <span className="ml-2 text-xs text-neutral-500">reverses {e.reverses}</span>
        )}
        {isDraft && reasonById.has(e.id) && (
          <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">{reasonById.get(e.id)}</span>
        )}
        {e.line_count === '0' ? (
          <div className="mt-0.5 font-mono text-xs text-neutral-500">no lines yet</div>
        ) : (
          <EntryLines accounts={e.accounts} names={e.names}
                      debits={e.debits} credits={e.credits} />
        )}
      </td>
      <td className="w-28 py-2 text-right tabular-nums"><Money cents={e.total} sign="minus" /></td>
    </tr>
  )

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title="Journal" backTo={`/ledger/${ledgerId}`} backLabel={`Back to ${head.entity}`}>
        {head.accounts !== '0' && <>
          <Link href={`/ledger/${ledgerId}/entries/quick/expense`} className={QUIET}>New expense</Link>
          <Link href={`/ledger/${ledgerId}/entries/new`} className={BUTTON}>New entry</Link>
        </>}
      </PageHeader>

      {head.accounts === '0' && (
        <p className="mt-6 rounded border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          This company has no postable accounts yet.{' '}
          <Link href={`/ledger/${ledgerId}/accounts`} className="underline">Add a chart of accounts</Link> first.
        </p>
      )}

      <FilterBar actions={<a href={`/ledger/${ledgerId}/export?what=journal&format=xlsx`}
        className={TOOL_BUTTON} title="Download Excel"><ToolAction kind="xlsx">Download Excel — the whole journal</ToolAction></a>}>
        <div className="w-full sm:w-56">
          <SearchBox label="Find an entry" value={query.text} />
        </div>
        <RangePicker from={from ?? ''} to={to ?? ''} today={today} allFrom={allFrom ?? undefined} clearable />
      </FilterBar>

      {/*
        * WHAT A DELETE SAID ON ITS WAY OUT.
        *
        * Deleting an entry used to answer on the entry's own page and stay
        * there — which was a 404 from that moment on (2026-09-15). It comes
        * here instead, and the consequences have to arrive with it: a released
        * application means a debt is owed again, a released match means a
        * reconciliation must be done over. Counts travel in the address and
        * `deletedEntrySentence` words them, so nothing a person could put in a
        * link becomes text on this page.
        */}
      {wanted.gone && (
        <p role="status" className="mt-4 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {deletedEntrySentence(wanted.gone, Number(wanted.apps) || 0, Number(wanted.matches) || 0)}
        </p>
      )}

      {(query.text || from || to) && (
        <p className="mt-3 text-xs text-neutral-500">
          {formatNumber(drafts.length + posted.length)} of the journal shown
          {query.text && <> · matching “{query.text}”</>}
          {(from || to) && <> · {from || 'the beginning'} to {to || 'today'}</>}
          {query.cents.length > 0 && (
            <> · read as an amount: {query.cents.map((c) => formatMoney(c)).join(' or ')}</>
          )}
        </p>
      )}

      {drafts.length > 0 && (
        <section className="mt-5">
          <h2 className="mb-2 text-section-title font-semibold">
            Drafts
          </h2>
          <p className="mb-2 text-metadata text-ink-muted">Excluded from balances and statements.</p>
          <TableViewport label="Draft entries"><DataTable>
            <thead><tr><th className="w-28 text-left">Date</th><th className="w-28 text-left">Entry</th><th className="text-left">Description / accounts</th><th className="w-28 text-right">Total debit</th></tr></thead>
            <tbody>{drafts.map((d) => row(d, true))}</tbody>
          </DataTable></TableViewport>
        </section>
      )}

      <section className="mt-5">
        <h2 className="mb-2 text-section-title font-semibold">Posted</h2>
        {posted.length === 0 ? (
          <PageState role="status" title={query.text || from || to ? 'Nothing posted matches.' : 'Nothing posted yet.'}
            action={(query.text || from || to) && <Link href={`/ledger/${ledgerId}/entries`} className={QUIET}>Clear filters</Link>}>
            {!query.text && !from && !to && 'Drafts remain outside balances and statements until posted.'}
          </PageState>
        ) : (
          <TableViewport label="Posted entries"><DataTable>
            <thead><tr><th className="w-28 text-left" aria-sort="descending">Date ↓</th><th className="w-28 text-left">Entry</th><th className="text-left">Description / accounts</th><th className="w-28 text-right">Total debit</th></tr></thead>
            <tbody>{posted.map((p) => row(p, false))}</tbody>
          </DataTable></TableViewport>
        )}
        <Pagination page={page} count={posted.length} previous={page > 1 ? pageLink(page - 1) : undefined}
          next={postedRead.length > 100 ? pageLink(page + 1) : undefined} />
      </section>
    </main>
  )
}

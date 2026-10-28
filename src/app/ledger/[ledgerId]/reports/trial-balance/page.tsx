import { DataTable, TableViewport } from '@/components/Table'
import { FilterBar } from '@/components/FormLayout'
import { PageHeader } from '@/components/PageHeader'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { firstBookDay, resolvePeriodSpan, trialBalanceSpan } from '@/lib/balances'
import { rangePresets, spanLabel } from '@/lib/date-range'
import { localToday } from '@/lib/today'
import { formatMoney } from '@/lib/money'
import { RangePicker } from '@/components/RangePicker'
import { ZeroFilter } from '@/components/ZeroFilter'
import { HIDE_ZEROS, hidesZeros, isEmptyRow } from '@/lib/reporting-view'
import { ledgerHead } from '@/lib/ledger-head'

export const dynamic = 'force-dynamic'

/**
 * The trial balance as a report of its own — the same `trialBalanceSpan` the
 * ledger home shows, with the PDF and CSV exits beside it. The home keeps its
 * copy as the working view; this page is the one you hand to someone.
 */
export default async function TrialBalance({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ from?: string; to?: string; nonzero?: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const wanted = await searchParams

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()
  const allFrom = await firstBookDay(ledgerId)

  const today = localToday()
  const preset = rangePresets(today)[0]
  const from = wanted.from ?? preset.from
  const to = wanted.to ?? preset.to

  const span = await resolvePeriodSpan(ledgerId, from, to)
  const rows = span ? await trialBalanceSpan(ledgerId, span.fromPeriod.id, span.toPeriod.id) : []
  // A chart holds accounts nobody has posted to this year, and each takes a
  // line (owner, 2026-09-07). Hiding them is a reading choice, so it is in the
  // URL and travels to the PDF and the spreadsheet with everything else.
  const hideZeros = hidesZeros(wanted)
  const shown = hideZeros ? rows.filter((r) => !isEmptyRow(r)) : rows
  // TOTALS ARE OF EVERYTHING. A trial balance whose columns stopped adding up
  // to the books when a box was ticked would be a different report.
  const zeroParam = hideZeros ? `&${HIDE_ZEROS}=1` : ''
  const totals = rows.reduce(
    (t, r) => ({
      debit: t.debit + BigInt(r.debit),
      credit: t.credit + BigInt(r.credit),
      closing: t.closing + BigInt(r.balance),
    }),
    { debit: 0n, credit: 0n, closing: 0n })

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Trial balance</>} backTo={`/ledger/${ledgerId}/reports`} backLabel={`Back to Reports`} />
      <p className="mt-1 text-sm text-neutral-500">
        {head.entity} · {span ? spanLabel(span.fromPeriod.name, span.toPeriod.name) : 'no periods cover that range'}
      </p>

      <FilterBar>
        <RangePicker from={from} to={to} today={today} allFrom={allFrom ?? undefined} />

      {span && (
        <div className="flex flex-wrap items-center gap-3 text-sm print:hidden">
          <ZeroFilter />
          <span className="flex flex-wrap gap-4">
            <a href={`/ledger/${ledgerId}/reports/trial-balance/pdf?from=${from}&to=${to}${zeroParam}`}
               target="_blank" className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">Download PDF</ToolAction></a>
            <a href={`/ledger/${ledgerId}/reports/trial-balance/pdf?from=${from}&to=${to}&format=xlsx${zeroParam}`}
               className={TOOL_BUTTON} title="Download Excel"><ToolAction kind="xlsx">Download Excel</ToolAction></a>
          </span>
        </div>
      )}

      </FilterBar>

      <TableViewport label="Trial balance" className="mt-4"><DataTable className="min-w-[36rem]">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-3 font-medium">Code</th>
            <th className="py-2 pr-3 font-medium">Account</th>
            <th className="py-2 pr-3 text-right font-medium">Debits</th>
            <th className="py-2 pr-3 text-right font-medium">Credits</th>
            <th className="py-2 text-right font-medium">Closing</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            // Two doors per row. Debits/credits are MOVEMENT — their story is
            // the range's own rows. Closing is a POSITION — cumulative, so its
            // drill omits `from` and opens since the start of the books,
            // opening at zero, every line that built the figure on the page.
            const drillRange = `/ledger/${ledgerId}/breakdown?kind=account&account=${r.id}&from=${from}&to=${to}`
            const drillPosition = `/ledger/${ledgerId}/breakdown?kind=account&account=${r.id}&to=${to}`
            return (
            <tr key={r.code} className="border-b border-neutral-100 dark:border-neutral-900">
              <td className="py-1.5 pr-3 font-mono text-xs">{r.code}</td>
              <td className="py-1.5 pr-3">{r.name}</td>
              <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{BigInt(r.debit) === 0n ? '' : <Link href={drillRange} className="hover:underline">{formatMoney(BigInt(r.debit))}</Link>}</td>
              <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{BigInt(r.credit) === 0n ? '' : <Link href={drillRange} className="hover:underline">{formatMoney(BigInt(r.credit))}</Link>}</td>
              <td className="py-1.5 text-right font-mono tabular-nums"><Link href={drillPosition} className="hover:underline">{formatMoney(BigInt(r.balance))}</Link></td>
            </tr>
            )
          })}
          <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
            <td className="py-2 pr-3" />
            <td className="py-2 pr-3">Total</td>
            <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatMoney(totals.debit)}</td>
            <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatMoney(totals.credit)}</td>
            <td className="py-2 text-right font-mono tabular-nums">{formatMoney(totals.closing)}</td>
          </tr>
        </tbody>
      </DataTable></TableViewport>

    </main>
  )
}

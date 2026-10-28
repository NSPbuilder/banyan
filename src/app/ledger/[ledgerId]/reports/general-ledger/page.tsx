import { DataTable, TableViewport } from '@/components/Table'
import { FilterBar } from '@/components/FormLayout'
import { PageHeader } from '@/components/PageHeader'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { generalLedger } from '@/lib/reports'
import { spanFor } from '@/lib/pdf-reports'
import { firstBookDay } from '@/lib/balances'
import { rangePresets } from '@/lib/date-range'
import { localToday } from '@/lib/today'
import { formatMoney } from '@/lib/money'
import { RangePicker } from '@/components/RangePicker'
import { ledgerHead } from '@/lib/ledger-head'

export const dynamic = 'force-dynamic'

/**
 * The general ledger: every account's activity for the span, with opening and
 * running balances. The summary line per account is the trial balance's own
 * (`generalLedger` derives opening from it); the detail rows are the
 * account register's. The suite holds the two to each other.
 */
export default async function GeneralLedger({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ from?: string; to?: string }>
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

  const span = await spanFor(ledgerId, from, to)
  const accounts = span ? await generalLedger(ledgerId, span) : []

  const cellR = 'py-1 pr-3 text-right font-mono tabular-nums'
  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>General ledger</>} backTo={`/ledger/${ledgerId}/reports`} backLabel={`Back to Reports`} />
      <p className="mt-1 text-sm text-neutral-500">
        {head.entity} · {span ? span.label : 'no periods cover that range'}
      </p>

      <FilterBar>
        <RangePicker from={from} to={to} today={today} allFrom={allFrom ?? undefined} />

      {span && (
        <div className="ml-auto flex flex-wrap gap-2 text-sm print:hidden">
          <a href={`/ledger/${ledgerId}/reports/general-ledger/pdf?from=${from}&to=${to}`}
             target="_blank" className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">Download PDF</ToolAction></a>
          <a href={`/ledger/${ledgerId}/reports/general-ledger/pdf?from=${from}&to=${to}&format=xlsx`}
             className={TOOL_BUTTON} title="Download Excel"><ToolAction kind="xlsx">Download Excel</ToolAction></a>
        </div>
      )}

      </FilterBar>

      {accounts.length === 0 && (
        <p className="mt-8 text-sm text-neutral-500">
          Nothing moved and nothing stood at a balance in this span.
        </p>
      )}

      {accounts.map((a) => (
        <section key={a.account.id} className="mt-5">
          <h2 className="text-section-title font-semibold">
            <Link href={`/ledger/${ledgerId}/accounts/${a.account.id}`} className="hover:underline">
              {a.account.code} — {a.account.name}
            </Link>
          </h2>
          <TableViewport label={`${a.account.code} general ledger`} className="mt-2"><DataTable className="min-w-[48rem]">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-1.5 pr-3 font-medium">Date</th>
                <th className="py-1.5 pr-3 font-medium">No</th>
                <th className="py-1.5 pr-3 font-medium">Description</th>
                <th className="py-1.5 pr-3 font-medium">Against</th>
                <th className="py-1.5 pr-3 text-right font-medium">Debit</th>
                <th className="py-1.5 pr-3 text-right font-medium">Credit</th>
                <th className="py-1.5 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-neutral-100 font-medium dark:border-neutral-900">
                <td className="py-1 pr-3" colSpan={4}>Opening balance</td>
                <td className={cellR} /><td className={cellR} />
                <td className="py-1 text-right font-mono tabular-nums">{formatMoney(a.opening)}</td>
              </tr>
              {a.rows.map((r, i) => (
                <tr key={`${r.entry_id}-${i}`} className="border-b border-neutral-100 dark:border-neutral-900">
                  <td className="whitespace-nowrap py-1 pr-3 font-mono text-xs">{r.entry_date}</td>
                  <td className="whitespace-nowrap py-1 pr-3 font-mono text-xs">
                    <Link href={`/ledger/${ledgerId}/entries/${r.entry_id}`} className="hover:underline">
                      {r.entry_no}
                    </Link>
                  </td>
                  <td className="py-1 pr-3">{r.line_description || r.description}</td>
                  <td className="py-1 pr-3 font-mono text-xs text-neutral-500">{r.contra_codes.join(' ')}</td>
                  <td className={cellR}>{BigInt(r.debit) === 0n ? '' : formatMoney(BigInt(r.debit))}</td>
                  <td className={cellR}>{BigInt(r.credit) === 0n ? '' : formatMoney(BigInt(r.credit))}</td>
                  <td className="py-1 text-right font-mono tabular-nums">{formatMoney(BigInt(r.running))}</td>
                </tr>
              ))}
              <tr className="border-t border-neutral-300 font-medium dark:border-neutral-700">
                <td className="py-1.5 pr-3" colSpan={4}>Closing balance</td>
                <td className={cellR}>{a.debit === 0n ? '' : formatMoney(a.debit)}</td>
                <td className={cellR}>{a.credit === 0n ? '' : formatMoney(a.credit)}</td>
                <td className="py-1.5 text-right font-mono tabular-nums">{formatMoney(a.closing)}</td>
              </tr>
            </tbody>
          </DataTable></TableViewport>
        </section>
      ))}
    </main>
  )
}

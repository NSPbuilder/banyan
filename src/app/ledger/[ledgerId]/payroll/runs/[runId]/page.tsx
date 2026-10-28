
import { PageHeader } from '@/components/PageHeader'

import { DataTable } from '@/components/Table'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { payRunDetail, remittanceOf } from '@/lib/payroll/runs'
import { FREQUENCY_LABEL, formatHours } from '@/lib/payroll/labels'
import type { Frequency } from '@/lib/payroll/engine'
import { formatMoney } from '@/lib/money'

export const dynamic = 'force-dynamic'

/**
 * One payday, employee by employee — the pay stubs.
 *
 * This is where the T4 will be read from. The ledger's own lines carry the
 * run's totals and cannot be split back apart; these rows carry every figure
 * per person, under the CRA edition that produced them, and they are frozen
 * once the run is in the books.
 */
export default async function PayRunPage({
  params,
}: { params: Promise<{ ledgerId: string; runId: string }> }) {
  await requireUser()

  const { ledgerId, runId } = await params

  const found = await payRunDetail(ledgerId, runId)
  if (!found) notFound()
  const { run, stubs } = found

  const sum = (f: (s: (typeof stubs)[number]) => string) =>
    stubs.reduce((t, s) => t + BigInt(f(s)), 0n)
  const gross = sum((s) => s.gross)
  const netPay = sum((s) => s.net_pay)
  // Added up by the same function the run list and the computation use — this
  // page used to spell the sum out a third time (critic).
  const remittance = remittanceOf({
    cpp: sum((s) => s.cpp), cpp2: sum((s) => s.cpp2), ei: sum((s) => s.ei),
    incomeTax: sum((s) => s.income_tax), employerCpp: sum((s) => s.employer_cpp),
    employerCpp2: sum((s) => s.employer_cpp2), employerEi: sum((s) => s.employer_ei),
  })
  const reversed = run.status !== 'posted'

  const money = (v: string) => formatMoney(BigInt(v))

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/payroll`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Pay runs</ToolAction></Link>
      <PageHeader title={`Payroll paid ${run.pay_date}`}>
        <Link href={`/ledger/${ledgerId}/payroll/new?copy=${runId}`}
              className={TOOL_BUTTON}>Copy</Link>
      </PageHeader>
      <p className="mt-1 max-w-3xl text-sm text-neutral-500">
        {run.period_start && run.period_end
          ? `For ${run.period_start} to ${run.period_end}. `
          : ''}
        Net pay out of {run.bank_code} — {run.bank_name}.{' '}
        {run.entry_id ? (
          <>
            Posted as{' '}
            <Link href={`/ledger/${ledgerId}/entries/${run.entry_id}`} className="underline">
              {run.entry_no}
            </Link>
            {reversed && <> — since reversed, so it counts for nothing in the books
                          or in anybody&rsquo;s year to date.</>}
          </>
        ) : 'Not in the books.'}
      </p>

      <div className="mt-6 flex flex-wrap gap-8 text-sm">
        <div>
          <span className="block text-xs uppercase tracking-wide text-neutral-500">Gross</span>
          <span className="tabular-nums">{formatMoney(gross)}</span>
        </div>
        <div>
          <span className="block text-xs uppercase tracking-wide text-neutral-500">Net paid</span>
          <span className="tabular-nums">{formatMoney(netPay)}</span>
        </div>
        <div>
          <span className="block text-xs uppercase tracking-wide text-neutral-500">To CRA</span>
          <span className="tabular-nums">{formatMoney(remittance)}</span>
        </div>
        <div>
          <span className="block text-xs uppercase tracking-wide text-neutral-500">CRA table</span>
          <span>{[...new Set(stubs.map((s) => s.edition))].join(', ')}</span>
        </div>
      </div>

      <DataTable density="reading" className="mt-8 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-4 font-medium">Employee</th>
            <th className="py-2 pr-3 text-right font-medium">Gross</th>
            <th className="py-2 pr-3 text-right font-medium">CPP</th>
            <th className="py-2 pr-3 text-right font-medium">CPP2</th>
            <th className="py-2 pr-3 text-right font-medium">EI</th>
            <th className="py-2 pr-3 text-right font-medium">Federal tax</th>
            <th className="py-2 pr-3 text-right font-medium">BC tax</th>
            <th className="py-2 pr-3 text-right font-medium">Extra tax</th>
            <th className="py-2 pr-3 text-right font-medium">Net pay</th>
            <th className="py-2 pr-3 text-right font-medium">Er CPP</th>
            <th className="py-2 pr-3 text-right font-medium">Er EI</th>
            <th className="py-2 pr-3 font-medium">Pay stub PDF / cheque</th>
          </tr>
        </thead>
        <tbody>
          {stubs.map((s) => (
            <tr key={s.id} className="border-b border-neutral-200 dark:border-neutral-800">
              <td className="py-2 pr-4">
                {s.name}
                <span className="mt-0.5 block text-xs text-neutral-500">
                  {FREQUENCY_LABEL[s.frequency as Frequency]}
                  {BigInt(s.hours) > 0n && ` · ${formatHours(BigInt(s.hours))} hours`}
                  {s.pensionable !== s.gross && ` · pensionable ${money(s.pensionable)}`}
                  {s.insurable !== s.gross && ` · insurable ${money(s.insurable)}`}
                </span>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(s.gross)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(s.cpp)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(s.cpp2)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(s.ei)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(s.federal_tax)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(s.provincial_tax)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(s.additional_tax)}</td>
              <td className="py-2 pr-3 text-right font-medium tabular-nums">{money(s.net_pay)}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">
                {money(String(BigInt(s.employer_cpp) + BigInt(s.employer_cpp2)))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">
                {money(s.employer_ei)}
              </td>
              <td className="py-2 pr-3">
                {/* A new tab, the way every other PDF in this application
                    opens — the first version navigated the page away from the
                    run somebody was reading (owner, 2026-09-04). */}
                <a href={`/ledger/${ledgerId}/payroll/runs/${runId}/${s.employee_id}/pdf`}
                   target="_blank" rel="noreferrer"
                   className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">Pay stub PDF</ToolAction></a>
                {!reversed && BigInt(s.net_pay) > 0n && <Link
                  href={`/ledger/${ledgerId}/cheques/new?stub=${s.id}`}
                  className="ml-3 underline decoration-neutral-300 underline-offset-2">Make cheque</Link>}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>

    </main>
  )
}

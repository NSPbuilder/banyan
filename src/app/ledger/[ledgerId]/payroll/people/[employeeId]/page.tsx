
import { PageHeader } from '@/components/PageHeader'

import { DataTable } from '@/components/Table'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { listEmployees, stubsFor, yearToDate } from '@/lib/payroll/employees'
import { FREQUENCY_LABEL } from '@/lib/payroll/labels'
import { formatMoney } from '@/lib/money'
import { localToday } from '@/lib/today'

export const dynamic = 'force-dynamic'

/**
 * One employee's year: the stubs, and what they add up to.
 *
 * The totals here are not a stored figure being displayed — they are the same
 * `yearToDate` the engine is handed before every pay period, summed from the
 * same stubs. That is the whole reason there is no cached running total: this
 * page and the next pay run cannot disagree, because there is only one answer
 * and both ask for it.
 *
 * A reversed run's stub is shown, struck, and is NOT in the totals. It is
 * still the record of what was computed that day.
 */
export default async function EmployeeYear({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string; employeeId: string }>
  searchParams: Promise<{ year?: string }>
}) {
  await requireUser()

  const { ledgerId, employeeId } = await params
  const { year: asked } = await searchParams

  const staff = await listEmployees(ledgerId)
  const person = staff.find((e) => e.id === employeeId)
  if (!person) notFound()

  // A whole CALENDAR YEAR — which is the span CPP, EI and the T4 are all
  // reckoned over, and the span the table below covers. `yearToDate` is
  // exclusive of its date because a pay run asks what the year did BEFORE this
  // period; 1 January next is how this page asks for the whole of it. Bounding
  // the totals to today and the table to nothing put rows on the page that
  // were not in the figures above them (critic).
  const year = /^\d{4}$/.test(asked ?? '') ? Number(asked) : Number(localToday().slice(0, 4))
  const [ytd, stubs] = await Promise.all([
    yearToDate(ledgerId, [employeeId], `${year + 1}-01-01`, year),
    stubsFor(ledgerId, employeeId, year),
  ])
  const total = ytd.get(employeeId)!
  const money = (v: string | bigint) => formatMoney(typeof v === 'bigint' ? v : BigInt(v))

  // Pensionable and insurable are their own figures, not the gross: they are
  // T4 boxes 26 and 24, and this is the page a T4 will be read off.
  const figures: Array<[string, bigint]> = [
    ['Gross', total.gross],
    ['Pensionable', total.pensionable],
    ['Insurable', total.insurable],
    ['CPP', total.cpp],
    ['CPP2', total.cpp2],
    ['EI', total.ei],
    ['Federal tax', total.federalTax],
    ['BC tax', total.provincialTax],
    // Extra tax the employee asked for on their TD1 is its own component of
    // what was withheld, not part of either figure above it. Without this
    // column the two tax figures do not reconcile to the net pay beside them.
    ['Tax withheld', total.incomeTax],
    ['Net paid', total.netPay],
    ["Employer's CPP", total.employerCpp + total.employerCpp2],
    ["Employer's EI", total.employerEi],
  ]

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/payroll/people`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Employees</ToolAction></Link>
      <PageHeader title={person.party_name}>
        <Link href={`/ledger/${ledgerId}/payroll/people/new?copy=${person.id}`}
              className={TOOL_BUTTON}>Copy</Link>
      </PageHeader>
      <p className="mt-1 max-w-3xl text-sm text-neutral-500">
        {FREQUENCY_LABEL[person.frequency]}
        {person.hired_on && ` · on payroll since ${person.hired_on}`}
        {person.sin && ` · SIN ${person.sin}`}
        {!person.is_active && ' · off the active payroll'}
        {' · '}
        <Link href={`/ledger/${ledgerId}/payroll/people/${person.id}/edit`} className="underline">
          edit the record
        </Link>
        {' · '}
        <Link href={`/ledger/${ledgerId}/payroll/roe/${person.id}`} className="underline">
          Record of Employment
        </Link>
        {' · '}
        <Link href={`/ledger/${ledgerId}/payroll/t4?year=${year}`} className="underline">
          T4 figures
        </Link>
      </p>

      <h2 className="mt-8 text-sm font-medium uppercase tracking-wide text-neutral-500">
        {year} · {total.periods} pay {total.periods === 1 ? 'period' : 'periods'}
      </h2>
      <div className="mt-3 flex flex-wrap gap-x-10 gap-y-4 text-sm">
        {figures.map(([name, value]) => (
          <div key={name}>
            <span className="block text-xs uppercase tracking-wide text-neutral-500">{name}</span>
            <span className="tabular-nums">{money(value)}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 max-w-3xl text-xs text-neutral-500">
        Calendar-year totals · Excludes reversed runs ·{' '}
        <Link href={`/ledger/${ledgerId}/payroll/people/${employeeId}?year=${year - 1}`}
              className="underline">{year - 1}</Link>
      </p>

      {stubs.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">No pay stubs in {year}.</p>
      ) : (
        <DataTable density="reading" className="mt-8 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Pay date</th>
              <th className="py-2 pr-3 text-right font-medium">Gross</th>
              <th className="py-2 pr-3 text-right font-medium">CPP</th>
              <th className="py-2 pr-3 text-right font-medium">CPP2</th>
              <th className="py-2 pr-3 text-right font-medium">EI</th>
              <th className="py-2 pr-3 text-right font-medium">Federal tax</th>
              <th className="py-2 pr-3 text-right font-medium">BC tax</th>
              <th className="py-2 pr-3 text-right font-medium">Extra tax</th>
              <th className="py-2 pr-3 text-right font-medium">Net pay</th>
              <th className="py-2 pr-4 font-medium">Table</th>
              <th className="py-2 pr-4 font-medium">Entry</th>
              <th className="py-2 pr-4 font-medium">Pay stub PDF</th>
            </tr>
          </thead>
          <tbody>
            {stubs.map((s) => {
              const gone = s.status !== 'posted'
              return (
                <tr key={s.id}
                    className={`border-b border-neutral-200 dark:border-neutral-800 ${gone ? 'text-neutral-400 line-through' : ''}`}>
                  <td className="py-2 pr-4">{s.pay_date}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(s.gross)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(s.cpp)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(s.cpp2)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(s.ei)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(s.federal_tax)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(s.provincial_tax)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(s.additional_tax)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(s.net_pay)}</td>
                  <td className="py-2 pr-4 text-neutral-500">{s.edition}</td>
                  <td className="py-2 pr-4 no-underline">
                    {s.entry_id ? (
                      <Link href={`/ledger/${ledgerId}/entries/${s.entry_id}`} className="underline">
                        {s.entry_no}
                      </Link>
                    ) : '—'}
                  </td>
                  {/* Somebody asked for a copy of one payday: this is the page
                      they are on, so the paper is here too (owner, 2026-09-04). */}
                  <td className="py-2 pr-4 no-underline">
                    <a href={`/ledger/${ledgerId}/payroll/runs/${s.pay_run_id}/${employeeId}/pdf`}
                       target="_blank" rel="noreferrer" className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">Pay stub PDF</ToolAction></a>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </DataTable>
      )}
    </main>
  )
}

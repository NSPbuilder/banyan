
import { DataTable } from '@/components/Table'
import { PageHeader } from '@/components/PageHeader'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { payrollOwed, remittanceMonths } from '@/lib/payroll/runs'
import { formatMoney } from '@/lib/money'
import { localToday } from '@/lib/today'

export const dynamic = 'force-dynamic'

const TH = 'py-2 pr-3 font-medium'
const R = 'whitespace-nowrap py-2 pr-3 text-right font-mono tabular-nums'

/**
 * The PD7A worksheet: for each month of paydays, the figures the remittance
 * form asks for, and what the books say is still owed.
 *
 * Like the T4 page, a worksheet and not a filing (owner, 2026-09-04): the
 * remittance itself is a payment to CRA, made and recorded like any other.
 */
export default async function Remittances({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ year?: string }>
}) {
  await requireUser()
  const { ledgerId } = await params
  const { year: asked } = await searchParams
  const year = /^\d{4}$/.test(asked ?? '') ? Number(asked) : Number(localToday().slice(0, 4))

  const months = await remittanceMonths(ledgerId, year)
  const owed = await payrollOwed(ledgerId)
  const sum = (k: 'gross' | 'cpp' | 'ei' | 'incomeTax' | 'total') => months.reduce((a, m) => a + m[k], 0n)

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>PD7A remittances for {year}</>} backTo={`/ledger/${ledgerId}/payroll`} backLabel={`Back to Pay runs`} />

      <p className="mt-2 text-sm text-neutral-500">
        <Link href={`/ledger/${ledgerId}/payroll/remittances?year=${year - 1}`} className="underline">{year - 1}</Link>
        {' · '}
        <Link href={`/ledger/${ledgerId}/payroll/remittances?year=${year + 1}`} className="underline">{year + 1}</Link>
      </p>

      {months.length > 0 && (
        <p className="mt-4 text-sm print:hidden">
          <a href={`/ledger/${ledgerId}/export?what=pd7a&year=${year}&format=xlsx`}
             className={TOOL_BUTTON} title="Download Excel"><ToolAction kind="xlsx">Download Excel</ToolAction></a>
        </p>
      )}

      {months.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">No pay runs dated in {year}.</p>
      ) : (
        <DataTable density="reading" className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className={TH}>Month</th>
              <th className={TH}>Remit by</th>
              <th className={`${TH} text-right`}>Runs</th>
              <th className={`${TH} text-right`}>Employees</th>
              <th className={`${TH} text-right`}>Gross payroll</th>
              <th className={`${TH} text-right`}>CPP</th>
              <th className={`${TH} text-right`}>EI</th>
              <th className={`${TH} text-right`}>Tax</th>
              <th className={`${TH} text-right`}>Current payment</th>
            </tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month} className="border-b border-neutral-100 dark:border-neutral-900" data-month={m.month}>
                <td className="py-2 pr-3 font-mono text-xs">{m.month}</td>
                <td className="py-2 pr-3 font-mono text-xs text-neutral-500">{m.dueOn}</td>
                <td className={R}>{m.runs}</td>
                <td className={R}>{m.employees}</td>
                <td className={R}>{formatMoney(m.gross)}</td>
                <td className={R}>{formatMoney(m.cpp)}</td>
                <td className={R}>{formatMoney(m.ei)}</td>
                <td className={R}>{formatMoney(m.incomeTax)}</td>
                <td className={`${R} font-medium`}>{formatMoney(m.total)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-neutral-700 font-medium dark:border-neutral-300">
              <td className="py-2 pr-3" colSpan={4}>{year}</td>
              <td className={R}>{formatMoney(sum('gross'))}</td>
              <td className={R}>{formatMoney(sum('cpp'))}</td>
              <td className={R}>{formatMoney(sum('ei'))}</td>
              <td className={R}>{formatMoney(sum('incomeTax'))}</td>
              <td className={R}>{formatMoney(sum('total'))}</td>
            </tr>
          </tbody>
        </DataTable>
      )}

      <section className="mt-8 max-w-3xl rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Still owed to CRA</p>
        <p className="mt-1 font-mono text-lg tabular-nums">{formatMoney(owed.balance)}</p>
        <p className="mt-1 text-xs text-neutral-500">
          {owed.account
            ? `The balance of ${owed.account} — every payday adds to it, every remittance paid takes from it. Zero means everything withheld has been sent.`
            : 'No account carries the payroll-liabilities role, so nothing here can say what is owed.'}
        </p>
      </section>

    </main>
  )
}

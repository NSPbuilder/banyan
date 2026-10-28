
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { t4Year } from '@/lib/payroll/t4'
import { PayrollError } from '@/lib/payroll/rates'
import { formatMoney } from '@/lib/money'
import { localToday } from '@/lib/today'

export const dynamic = 'force-dynamic'

/**
 * The T4 worksheet: every employee's figures beside the box they go in.
 *
 * Deliberately NOT a slip and NOT a filing (owner, 2026-09-03). What it owes
 * the person typing is that every figure is right, and that every box it
 * cannot produce says why instead of showing a confident zero — a blank you
 * were warned about is recoverable; a wrong number that looks fine is not.
 */
export default async function T4Worksheet({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ year?: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const { year: asked } = await searchParams
  const year = /^\d{4}$/.test(asked ?? '') ? Number(asked) : Number(localToday().slice(0, 4))

  let t4
  try {
    t4 = await t4Year(ledgerId, year)
  } catch (e) {
    // A year outside the tables, or a ledger that is not there. Both are the
    // reader refusing by name; the page has nothing to show for either.
    if (e instanceof PayrollError) {
      return (
        <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
          <Link href={`/ledger/${ledgerId}/payroll`}
                className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Pay runs</ToolAction></Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">T4 figures</h1>
          <p role="alert" className="mt-4 max-w-2xl rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {e.message}
          </p>
        </main>
      )
    }
    throw e
  }
  const paid = t4.employees.filter((e) => !e.empty)

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/payroll`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Pay runs</ToolAction></Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">T4 figures for {year}</h1>
      <p className="mt-1 max-w-3xl text-sm text-neutral-500">
        {t4.employer.legalName ?? t4.employer.name}
        {t4.employer.businessNumber && ` · business number ${t4.employer.businessNumber}`}
        {t4.employer.province && ` · box 10 province of employment ${t4.employer.province}`}
      </p>
      <p className="mt-2 text-xs text-neutral-500">Working figures · Not filed</p>
      <p className="mt-2 text-sm text-neutral-500">
        Previous year:{' '}
        <Link href={`/ledger/${ledgerId}/payroll/t4?year=${year - 1}`} className="underline">
          {year - 1}
        </Link>
      </p>

      {paid.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">
          Nobody was paid in {year}, so no T4 is due.
        </p>
      ) : (
        paid.map((e) => (
          <section key={e.employeeId} className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">{e.name}</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Box 12 social insurance number:{' '}
              {e.sin
                ? <span className="tabular-nums">{e.sin}</span>
                : <span className="text-red-700 dark:text-red-400">
                    not recorded — CRA will reject a slip without one
                  </span>}
              {' · '}
              <Link href={`/ledger/${ledgerId}/payroll/people/${e.employeeId}?year=${year}`}
                    className="underline">their year</Link>
            </p>
            <table className="mt-3 w-full max-w-3xl border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                  <th className="w-16 py-2 pr-4 font-medium">Box</th>
                  <th className="py-2 pr-4 font-medium">What CRA calls it</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {e.boxes.map((b) => (
                  <tr key={b.box} className="border-b border-neutral-200 align-top dark:border-neutral-800">
                    <td className="py-2 pr-4 font-medium tabular-nums">{b.box}</td>
                    <td className="py-2 pr-4">
                      {b.label}
                      {b.absent && (
                        <span className="mt-0.5 block text-xs text-neutral-500">{b.absent}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {b.amount !== null ? formatMoney(b.amount)
                        : b.text ? <span className="font-medium">{b.text}</span>
                        : <span className="text-neutral-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}

      {paid.length > 0 && (
        <>
          <h2 className="mt-12 text-lg font-semibold tracking-tight">
            What the T4 Summary should total
          </h2>

          <table className="mt-3 w-full max-w-xl border-collapse text-sm">
            <tbody>
              {([
                ['14', 'Employment income', t4.totals.box14],
                ['16', "Employees' CPP", t4.totals.box16],
                ['16A', "Employees' second CPP", t4.totals.box16a],
                ['18', "Employees' EI", t4.totals.box18],
                ['22', 'Income tax deducted', t4.totals.box22],
              ] as const).map(([box, label, amount]) => (
                <tr key={box} className="border-b border-neutral-200 dark:border-neutral-800">
                  <td className="w-16 py-2 pr-4 font-medium tabular-nums">{box}</td>
                  <td className="py-2 pr-4">{label}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatMoney(amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <ul className="mt-10 max-w-3xl list-disc space-y-1 pl-5 text-xs text-neutral-500">
        {t4.caveats.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </main>
  )
}

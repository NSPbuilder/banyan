
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { roeSummary } from '@/lib/payroll/roe'
import { PayrollError } from '@/lib/payroll/rates'
import { formatMoney } from '@/lib/money'
import { formatHours } from '@/lib/payroll/labels'

export const dynamic = 'force-dynamic'

/**
 * A Record of Employment, block by block.
 *
 * Not a filed ROE — Service Canada's own form is filled on ROE Web. This is the
 * sheet somebody works from, and its whole value is that the blocks a ledger
 * CANNOT answer are listed as loudly as the ones it can.
 */
export default async function RoePage({
  params,
}: { params: Promise<{ ledgerId: string; employeeId: string }> }) {
  await requireUser()

  const { ledgerId, employeeId } = await params

  let roe
  try {
    roe = await roeSummary(ledgerId, employeeId)
  } catch (e) {
    if (e instanceof PayrollError) notFound()
    throw e
  }

  const known: Array<[string, string, React.ReactNode]> = [
    ['6', 'Pay period type', roe.payPeriodType ?? (
      <span className="text-red-700 dark:text-red-400">
        Service Canada&rsquo;s form has no pay-period type for{' '}
        {roe.frequency.replace('_', '-')}. Blocks 15A, 15B and 15C are therefore
        left unstated below — every one of them is defined as a count of pay
        periods, and there is no count to take.
      </span>
    )],
    ['8', 'Social insurance number', roe.sin ?? <span className="text-neutral-400">not recorded</span>],
    ['9', 'Employee name and address', <>{roe.name}{roe.address ? ` · ${roe.address}` : ''}</>],
    ['10', 'First day worked', roe.firstDayWorked ?? <span className="text-neutral-400">unknown</span>],
    ['11', 'Last day for which paid', roe.lastDayPaid ?? (
      <span className="text-neutral-400">
        no end date on the employee role, and no pay run to take one from
      </span>
    )],
    ['12', 'Final pay period ending date', roe.finalPeriodEnd
      ? <>{roe.finalPeriodEnd}{roe.finalPeriodEndIsPayDate && (
          <span className="mt-0.5 block text-xs text-neutral-500">
            No period end was entered on that run, so this is the pay date. Check it
            against the period the pay actually covered.
          </span>)}</>
      : <span className="text-neutral-400">—</span>],
    ['13', 'Occupation', roe.occupation ?? <span className="text-neutral-400">not recorded</span>],
  ]

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/payroll/people/${employeeId}`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to {roe.name}</ToolAction></Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Record of Employment — {roe.name}
      </h1>
      <p className="mt-2 text-xs text-neutral-500">Working figures · Not filed</p>

      <table className="mt-8 w-full max-w-4xl border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="w-16 py-2 pr-4 font-medium">Block</th>
            <th className="py-2 pr-4 font-medium">What it asks</th>
            <th className="py-2 pr-4 font-medium">From the books</th>
          </tr>
        </thead>
        <tbody>
          {known.map(([block, label, value]) => (
            <tr key={block} className="border-b border-neutral-200 align-top dark:border-neutral-800">
              <td className="py-2 pr-4 font-medium tabular-nums">{block}</td>
              <td className="py-2 pr-4">{label}</td>
              <td className="py-2 pr-4">{value}</td>
            </tr>
          ))}
          <tr className="border-b border-neutral-200 align-top dark:border-neutral-800">
            <td className="py-2 pr-4 font-medium tabular-nums">15A</td>
            <td className="py-2 pr-4">
              Total insurable hours
              <span className="mt-0.5 block text-xs text-neutral-500">
                over the last {roe.span ? roe.span.hours15A : 'available'} pay periods
                {roe.span && roe.covered.hours < roe.span.hours15A
                  && ` — only ${roe.covered.hours} exist`}
                {roe.span && roe.covered.hoursRecorded > 0 && roe.covered.hoursRecorded < roe.covered.hours && (
                  <span className="block text-amber-700 dark:text-amber-400">
                    Hours were entered on {roe.covered.hoursRecorded} of those {roe.covered.hours} periods;
                    the total counts only what was entered.
                  </span>
                )}
              </span>
            </td>
            <td className="py-2 pr-4 tabular-nums">
              {roe.span === null
                ? <span className="text-red-700 dark:text-red-400">
                    Not stated: there is no pay-period type on the form for this
                    frequency, so there is no number of periods to look back over.
                  </span>
                : roe.insurableHours === null
                ? <span className="text-red-700 dark:text-red-400">
                    No hours were recorded on any pay run. This is the number the ROE
                    exists to establish, and Service Canada will not accept the form
                    without it — enter hours on future runs, or work them out from
                    your own records.
                  </span>
                : formatHours(roe.insurableHours)}
            </td>
          </tr>
          <tr className="border-b border-neutral-200 align-top dark:border-neutral-800">
            <td className="py-2 pr-4 font-medium tabular-nums">15B</td>
            <td className="py-2 pr-4">
              Total insurable earnings
              <span className="mt-0.5 block text-xs text-neutral-500">
                over the last {roe.span ? roe.span.earnings15B : 'available'} pay periods
                {roe.span && roe.covered.earnings < roe.span.earnings15B
                  && ` — only ${roe.covered.earnings} exist`}
              </span>
            </td>
            <td className="py-2 pr-4 tabular-nums">
              {roe.insurableEarnings === null
                ? <span className="text-red-700 dark:text-red-400">
                    Not stated, for the same reason: no pay-period type means no span,
                    and every period there has ever been is not what Block 15B asks for.
                  </span>
                : formatMoney(roe.insurableEarnings)}
            </td>
          </tr>
        </tbody>
      </table>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">
        Block 15C — insurable earnings by pay period
      </h2>

      {roe.span && (
        <p className="mt-1 max-w-3xl text-sm text-neutral-500">
          A paper ROE has room for {roe.span.paper15C}; ROE Web takes {roe.span.web15C}
          {' '}and Service Canada asks for the longer list.
        </p>
      )}
      {roe.periods.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          {roe.span === null
            ? 'Not listed: Service Canada\'s form has no pay-period type for this '
              + 'frequency, so there is no defined number of periods to report.'
            : 'No pay periods on the books.'}
        </p>
      ) : (
        <table className="mt-4 w-full max-w-3xl border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">P.P.</th>
              <th className="py-2 pr-4 font-medium">Period ending</th>
              <th className="py-2 pr-4 font-medium">Paid</th>
              <th className="py-2 pr-4 text-right font-medium">Insurable earnings</th>
              <th className="py-2 pr-4 text-right font-medium">Hours</th>
            </tr>
          </thead>
          <tbody>
            {roe.periods.map((p, i) => (
              <tr key={`${p.payDate}-${i}`} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-2 pr-4 tabular-nums text-neutral-500">{i + 1}</td>
                <td className="py-2 pr-4">{p.periodEnd ?? <span className="text-neutral-400">not stated</span>}</td>
                <td className="py-2 pr-4 text-neutral-500">{p.payDate}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatMoney(p.insurable)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">
                  {p.hours > 0n ? formatHours(p.hours) : <span className="text-neutral-400">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-10 text-lg font-semibold tracking-tight">You supply these</h2>

      <table className="mt-3 w-full max-w-4xl border-collapse text-sm">
        <tbody>
          {roe.toSupply.map((b) => (
            <tr key={b.block} className="border-b border-neutral-200 align-top dark:border-neutral-800">
              <td className="w-16 py-2 pr-4 font-medium tabular-nums">{b.block}</td>
              <td className="py-2 pr-4">{b.label}</td>
              <td className="py-2 pr-4 text-xs text-neutral-500">{b.why}</td>
            </tr>
          ))}
        </tbody>
      </table>

    </main>
  )
}


import { PageHeading } from '@/components/DialogHeading'
import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { listEmployees } from '@/lib/payroll/employees'
import { payRunDetail, payrollBankAccounts } from '@/lib/payroll/runs'
import { FREQUENCY_LABEL } from '@/lib/payroll/labels'
import { localToday } from '@/lib/today'
import { RunForm } from './RunForm'
import { ledgerHead } from '@/lib/ledger-head'
import { moneyInput } from '@/lib/money'

/**
 * Run the payroll — body only. The Add menu's Pay run floats it over whatever
 * page it was opened from (owner, 2026-09-16: 「工资运行也要悬浮」), and a deep
 * link renders it as a page.
 *
 * The form is deliberately thin: it collects a date, an account and a gross
 * for each person, and everything else is CRA's. There is no preview button —
 * the figures depend on the year to date, which the server knows and the
 * browser does not, so a browser-side preview would be a second arithmetic
 * that could disagree with the one that posts.
 */
export async function RunBody({ ledgerId, copyId }: { ledgerId: string; copyId?: string }) {
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const [staff, banks] = await Promise.all([
    listEmployees(ledgerId),
    payrollBankAccounts(ledgerId),
  ])
  const source = copyId ? await payRunDetail(ledgerId, copyId) : null
  if (copyId && !source) notFound()
  const active = staff.filter((e) => e.is_active).map((e) => ({
    id: e.id,
    name: e.party_name,
    frequency: FREQUENCY_LABEL[e.frequency],
  }))

  return (
    <>
      <PageHeading className="mt-2" title={<>{source ? 'Copy pay run' : 'Run payroll'}</>} />
      <p className="mt-1 text-sm text-neutral-500">{head.entity}</p>

      {active.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">
          Nobody is on the active payroll.{' '}
          <Link href={`/ledger/${ledgerId}/payroll/people/new`} className="underline">
            Add somebody
          </Link>{' '}first.
        </p>
      ) : banks.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">
          No active account carries the cash-and-cash-equivalents role, so there is
          nothing to pay out of. Tag one in the{' '}
          <Link href={`/ledger/${ledgerId}/accounts`} className="underline">chart of accounts</Link>.
        </p>
      ) : (
        <RunForm key={copyId ?? 'new'} ledgerId={ledgerId} today={localToday()} formKey={randomUUID()}
                 initial={source ? {
                   payDate: source.run.pay_date,
                   periodStart: source.run.period_start ?? '',
                   periodEnd: source.run.period_end ?? '',
                   bankAccountId: source.run.bank_account_id,
                   rows: source.stubs.filter((stub) => active.some((e) => e.id === stub.employee_id))
                     .map((stub) => ({
                       employeeId: stub.employee_id,
                       gross: moneyInput(BigInt(stub.gross)),
                       hours: moneyInput(BigInt(stub.hours)),
                       pensionable: moneyInput(BigInt(stub.pensionable)),
                       insurable: moneyInput(BigInt(stub.insurable)),
                       bonus: moneyInput(BigInt(stub.bonus)),
                     })),
                 } : undefined}
                 employees={active} banks={banks} />
      )}
    </>
  )
}


import { PageHeading } from '@/components/DialogHeading'

import { DataTable } from '@/components/Table'
import { formatNumber } from '@/lib/numbers'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { payRuns } from '@/lib/payroll/runs'
import { formatMoney } from '@/lib/money'
import { coveredYears, lastCoveredDate } from '@/lib/payroll/rates'
import { editionRecords, type EditionRecord } from '@/lib/payroll/editions'
import { removeEditionAction } from '@/app/ledger/[ledgerId]/payroll/actions'
import { ActionForm } from '@/components/ActionForm'
import { EditionFigures } from './EditionFigures'
import { EditionCopy } from './EditionCopy'
import { localToday } from '@/lib/today'
import { problemsWith } from '@/lib/payroll/rates-check'
import { BUTTON, BUTTON_WIDE, CARD, PAGE_HEADER, QUIET } from '@/lib/ui'
import { ledgerHead } from '@/lib/ledger-head'

export const dynamic = 'force-dynamic'

/**
 * Every payday this company has had.
 *
 * A pay run's own row says what it cost and what is owed to CRA; the entry
 * number is the link into the books, and a run whose entry has been reversed
 * says so rather than sitting in the list looking like money that moved.
 */
export default async function PayrollRuns({
  params,
}: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()

  const { ledgerId } = await params

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  // The editions added in the app first (0082): the heading, the countdown and
  // the list below all read the one list, built-in and added together.
  const editions = await editionRecords()
  const runs = await payRuns(ledgerId)
  // What these runs PUT ON the payroll liability, not what it holds now: a
  // remittance to CRA is an ordinary payment and debits that account, and this
  // sum never comes down. Saying it was the account's balance made this page a
  // second, wrong answer to a question the trial balance already answers
  // (critic).
  const raised = runs
    .filter((r) => r.status === 'posted')
    .reduce((t, r) => t + BigInt(r.remittance), 0n)

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <div className={PAGE_HEADER}>
        <div>
          <PageHeading className="mt-2" title={<>Pay runs</>} />
          <p className="mt-1 max-w-2xl text-sm text-neutral-500">
            {head.entity} · CRA&rsquo;s T4127 tables for {coveredYears().join(', ')}, federal and BC.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link href={`/ledger/${ledgerId}/payroll/people`}
                className="rounded border border-neutral-300 px-3 py-2 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
            Employees
          </Link>
          <Link href={`/ledger/${ledgerId}/payroll/new`}
                className={BUTTON_WIDE}>
            Run payroll
          </Link>
        </div>
      </div>

      {runs.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">
          No payroll has been run yet. Put somebody on the{' '}
          <Link href={`/ledger/${ledgerId}/payroll/people`} className="underline">employee list</Link>{' '}
          first — payroll pays parties who hold the employee role.
        </p>
      ) : (
        <>
          <p className="mt-6 text-sm text-neutral-500">
            Owed to CRA by these runs:{' '}
            <span className="font-medium text-neutral-900 dark:text-neutral-100">
              {formatMoney(raised)}
            </span>{' '}
            — both shares of CPP and EI plus the tax withheld, from every run
            still standing. What is <em>still</em> owed after remittances is the
            payroll liabilities account&rsquo;s balance, on the{' '}
            <Link href={`/ledger/${ledgerId}/reports/trial-balance`} className="underline">
              trial balance
            </Link>.
          </p>

          <DataTable density="reading" className="mt-4 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-2 pr-4 font-medium">Pay date</th>
                <th className="py-2 pr-4 font-medium">Period</th>
                <th className="py-2 pr-4 font-medium">People</th>
                <th className="py-2 pr-4 text-right font-medium">Gross</th>
                <th className="py-2 pr-4 text-right font-medium">Net paid</th>
                <th className="py-2 pr-4 text-right font-medium">To CRA</th>
                <th className="py-2 pr-4 font-medium">Entry</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const reversed = r.status !== 'posted'
                return (
                  <tr key={r.id}
                      className={`border-b border-neutral-200 dark:border-neutral-800 ${reversed ? 'text-neutral-400' : ''}`}>
                    <td className="py-2 pr-4">
                      <Link href={`/ledger/${ledgerId}/payroll/runs/${r.id}`}
                            className="underline decoration-neutral-300 underline-offset-2">
                        {r.pay_date}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-neutral-500">
                      {r.period_start && r.period_end ? `${r.period_start} → ${r.period_end}` : '—'}
                    </td>
                    <td className="py-2 pr-4">{r.people}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatMoney(BigInt(r.gross))}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatMoney(BigInt(r.net_pay))}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatMoney(BigInt(r.remittance))}</td>
                    <td className="py-2 pr-4">
                      {r.entry_id ? (
                        <Link href={`/ledger/${ledgerId}/entries/${r.entry_id}`}
                              className="underline decoration-neutral-300 underline-offset-2">
                          {r.entry_no}
                        </Link>
                      ) : '—'}
                      {reversed && <span className="ml-2 text-xs uppercase">reversed</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>

        </>
      )}

      <CraNumbers ledgerId={ledgerId} editions={editions} />
    </main>
  )
}

/**
 * Which CRA tables are on file, and until when.
 *
 * THE REFUSAL EXISTED AND WAS INVISIBLE. Payroll has always declined a year it
 * has no tables for, but the declining happened at the moment somebody pressed
 * Run — in January, with people waiting to be paid. Here it is a date on a
 * screen months earlier (owner, 2026-09-12).
 */
function CraNumbers({ ledgerId, editions }: { ledgerId: string; editions: EditionRecord[] }) {
  const until = lastCoveredDate()
  // `localToday`, not the UTC day. Half of every evening in BC is already
  // tomorrow in UTC, and a countdown that jumps a day at 5pm is the bug `R47`
  // exists to keep out — it caught this one.
  const daysLeft = Math.round(
    (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${localToday()}T00:00:00Z`)) / 86400000)
  const confirm = editions.flatMap((r) => problemsWith(r.edition).confirm)
  return (
    <section className={`mt-10 ${CARD}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg font-semibold">The CRA numbers</h2>
        {/* A new T4127 is added here, in a floating form, and proved against a
            PDOC example before it is saved (0082, owner 2026-09-16). */}
        <Link href={`/ledger/${ledgerId}/payroll/editions/new`} className={BUTTON}>Add an edition</Link>
      </div>

      <p className={`mt-3 text-sm ${daysLeft <= 90
        ? 'font-medium text-amber-800 dark:text-amber-300' : 'text-neutral-600 dark:text-neutral-300'}`}>
        {daysLeft < 0
          ? `No tables since ${until} — payroll cannot run until the next edition is added.`
          : `Payroll can run up to ${until}, ${daysLeft} day${daysLeft === 1 ? '' : 's'} from today.`}
      </p>

      <div className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-900">
        {editions.map(({ edition: e, added, copy }, i) => {
          const next = editions[i + 1]?.edition
          const to = next ? next.startsOn : `${e.startsOn.slice(0, 4)}-12-31`
          return (
            <details key={e.id} className="py-2" data-edition={e.id}>
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                <span className="w-16 font-mono">{e.id}</span>
                <span className="w-56 font-mono text-neutral-500">{e.startsOn} → {next ? `before ${to}` : to}</span>
                <span className="flex-1 text-neutral-600 dark:text-neutral-300">{e.authority}</span>
                <span className="text-neutral-400">
                  {added ? `added ${added.at.slice(0, 10)} by ${added.by}` : 'built in'}
                </span>
              </summary>
              <EditionFigures edition={e} />
              <Link href={`/ledger/${ledgerId}/payroll/editions/new?copy=${encodeURIComponent(e.id)}`}
                    className="mt-2 inline-block text-xs text-neutral-500 underline">Copy</Link>
              {copy && <EditionCopy ledgerId={ledgerId} editionId={e.id} copy={copy} remove={removeEditionAction} />}
              {added && (
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
                  <span>
                    Proved against PDOC: {added.pdoc.frequency.replace('_', '-')} pay of{' '}
                    {formatMoney(BigInt(added.pdoc.gross))} on {added.pdoc.payDate}.
                  </span>
                  <ActionForm action={removeEditionAction} submit="Remove this edition" working="…"
                              className="inline" buttonClassName={QUIET}>
                    <input type="hidden" name="ledgerId" value={ledgerId} />
                    <input type="hidden" name="editionId" value={e.id} />
                  </ActionForm>
                </div>
              )}
            </details>
          )
        })}
      </div>

      {confirm.length > 0 && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">
            {formatNumber(confirm.length)} figure{confirm.length === 1 ? '' : 's'} to check against the PDF.
          </p>
          {confirm.map((c) => <p key={c} className="mt-1">{c}</p>)}
        </div>
      )}
    </section>
  )
}

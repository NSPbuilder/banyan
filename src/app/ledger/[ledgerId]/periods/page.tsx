
import { DataTable } from '@/components/Table'
import { PageHeader } from '@/components/PageHeader'

import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { periodHistory, periodOverview, periodReadiness } from '@/lib/periods'
import { formatMoney } from '@/lib/money'
import { closePeriodAction, deleteFiscalYearAction, reopenPeriodAction, reopenYearAction } from '@/app/actions'
import { ActionForm } from '@/components/ActionForm'
import { QUIET } from '@/lib/ui'
import { CloseControls, ReopenControls, ReopenYearControls } from './PeriodActions'
import { ledgerHead } from '@/lib/ledger-head'
import { Floating } from '@/components/Floating'
import { FiscalYearForm } from '../FiscalYearForm'

export const dynamic = 'force-dynamic'

const STATUS: Record<string, { label: string; className: string }> = {
  open:   { label: 'open',   className: 'text-neutral-500' },
  closed: { label: 'closed', className: 'text-amber-700 dark:text-amber-400' },
  locked: { label: 'locked', className: 'text-red-700 dark:text-red-400' },
}

export default async function Periods({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ period?: string; year?: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const { period: openedId, year: openedYearId } = await searchParams

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const periods = await periodOverview(ledgerId)
  const opened = periods.find((p) => p.id === openedId)

  // Only for the period being looked at: these checks read the whole ledger,
  // and running them for every row would be twelve times the work for nothing.
  const [readiness, history] = opened
    ? await Promise.all([periodReadiness(ledgerId, opened.id), periodHistory(opened.id)])
    : [[], []]

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Periods</>} backTo={`/ledger/${ledgerId}`} backLabel={`Back to ${head.entity}`} />

      {[...new Set(periods.map((p) => p.year_name))].map((year, i, years) => {
        // The year's own status and id ride on every one of its periods.
        const fy = periods.find((p) => p.year_name === year)!
        const reopening = fy.year_status === 'closed' && openedYearId === fy.year_id
        // A year made by mistake, offered for deletion only while it holds
        // nothing and sits at either end — `deleteFiscalYear` refuses the rest
        // and says why (0084).
        const empty = fy.year_status === 'open' && periods.filter((p) => p.year_name === year)
          .every((p) => p.status === 'open' && p.entries === '0' && p.drafts === '0' && p.outside === '0')
        const deletable = empty && (i === 0 || i === years.length - 1) && years.length > 1
        const lastEnd = periods.filter((p) => p.year_name === year).at(-1)?.end_date
        const copiedEnd = lastEnd
          ? new Date(Date.UTC(Number(lastEnd.slice(0, 4)) + 1,
              Number(lastEnd.slice(5, 7)) - 1, Number(lastEnd.slice(8, 10)))).toISOString().slice(0, 10)
          : ''
        return (
        <section key={year} className="mt-8">
          {/* The year is named here and nowhere else on this screen, so this
              is where a closed year is reopened: four refusals said "reopen
              the year" while no screen could (2026-09-13). */}
          <h2 className="mb-2 flex items-baseline gap-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            <span>{year}</span>
            <span className={`normal-case tracking-normal ${STATUS[fy.year_status]?.className ?? ''}`}>
              {STATUS[fy.year_status]?.label ?? fy.year_status}
            </span>
            {fy.year_status === 'closed' && !reopening && (
              <Link href={`/ledger/${ledgerId}/periods?year=${fy.year_id}`}
                    className="normal-case tracking-normal hover:underline">
                Reopen the year…
              </Link>
            )}
            {deletable && (
              <ActionForm action={deleteFiscalYearAction} submit="Delete this empty year" working="…"
                          className="inline normal-case tracking-normal" buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
                <input type="hidden" name="ledgerId" value={ledgerId} />
                <input type="hidden" name="fiscalYearId" value={fy.year_id} />
              </ActionForm>
            )}
          </h2>
          {i === years.length - 1 && copiedEnd && (
            <div className="mb-2">
              <Floating label="Copy to next year" title={`Add a year after ${year}`} buttonClassName={QUIET}>
                <FiscalYearForm ledgerId={ledgerId} defaultEnd={copiedEnd} />
              </Floating>
            </div>
          )}
          {reopening && (
            <ReopenYearControls ledgerId={ledgerId} fiscalYearId={fy.year_id} yearName={year}
                                action={reopenYearAction} />
          )}
          <DataTable density="reading" className="w-full text-sm">
            <tbody>
              {periods.filter((p) => p.year_name === year).map((p) => {
                const isOpen = p.id === opened?.id
                return (
                  <tr key={p.id} className="border-b border-neutral-200 align-top dark:border-neutral-800">
                    <td className="w-24 py-2 font-mono text-xs">
                      <Link href={`/ledger/${ledgerId}/periods?period=${p.id}`}
                            className="hover:underline">
                        {p.name}
                      </Link>
                    </td>
                    <td className="w-40 py-2 font-mono text-xs text-neutral-500">
                      {p.start_date} – {p.end_date}
                    </td>
                    <td className={`w-20 py-2 text-xs ${STATUS[p.status]?.className}`}>
                      {STATUS[p.status]?.label ?? p.status}
                    </td>
                    <td className="w-32 py-2 text-right text-xs text-neutral-500">
                      {p.entries === '0' ? '—' : `${p.entries} entries`}
                      {p.outside !== '0' && (
                        <span className="ml-2 text-neutral-400"
                              title="Reversed entries, and reversals (of entries here or in an earlier period): counted here, left out of the total">
                          {p.outside} reversed or reversing
                        </span>
                      )}
                      {p.drafts !== '0' && (
                        <span className="ml-2 text-amber-700 dark:text-amber-400">
                          {p.drafts} draft{p.drafts === '1' ? '' : 's'}
                        </span>
                      )}
                    </td>
                    <td className="w-28 py-2 text-right tabular-nums">
                      {p.total === '0' ? '' : formatMoney(BigInt(p.total))}
                    </td>
                    <td className="py-2 pl-4">
                      {isOpen ? (
                        p.status === 'open'
                          ? <CloseControls ledgerId={ledgerId} periodId={p.id}
                                           periodName={p.name} readiness={readiness}
                                           action={closePeriodAction} />
                          : <ReopenControls ledgerId={ledgerId} periodId={p.id}
                                            periodName={p.name} status={p.status}
                                            action={reopenPeriodAction} />
                      ) : (
                        <Link href={`/ledger/${ledgerId}/periods?period=${p.id}`}
                              className="text-xs text-neutral-500 hover:underline">
                          {p.status === 'open' ? 'Close…' : 'Reopen…'}
                        </Link>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>
        </section>
        )
      })}

      {opened && history.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            {opened.name} — what has been done to it
          </h2>
          <DataTable density="reading" className="w-full text-sm">
            <tbody>
              {history.map((h, i) => (
                <tr key={i} className="border-b border-neutral-100 dark:border-neutral-900">
                  <td className="w-44 py-1.5 font-mono text-xs text-neutral-500">
                    {h.occurred_at.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="w-24 py-1.5 text-xs">{h.actor}</td>
                  <td className="py-1.5 text-xs">
                    {h.action === 'close_period' && `closed (${h.before_status} → ${h.after_status})`}
                    {h.action === 'reopen_period' && `reopened (${h.before_status} → ${h.after_status})`}
                    {h.action === 'reopen_period_reason' && (
                      <span className="text-neutral-600 dark:text-neutral-400">“{h.reason}”</span>
                    )}
                    {h.action === 'redefine_period' && 'dates changed'}
                    {h.action === 'close_period_override' && (
                      <span className="text-red-700 dark:text-red-400">
                        closed despite a blocking problem — “{h.reason}”
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </section>
      )}
    </main>
  )
}

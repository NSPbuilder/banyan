'use client'

import { DataTable } from '@/components/Table'

import { formatNumber } from '@/lib/numbers'
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { MATCH_FIELDS as F } from '@/lib/forms'
import { nativeMoney } from '@/lib/fx-money'
import type { ReconcileView } from '@/lib/bank'
import { STATE_LABEL } from '@/lib/bank-feed'
import { reconcileFigures } from '@/lib/recon-display'
import { BUTTON, QUIET } from '@/lib/ui'

const TH = 'py-2 pr-3 font-medium'

function Figure({ label, amount, note, tone,currency='CAD' }: {
  currency?:string
  label: string; amount: bigint; note?: string; tone?: 'good' | 'bad'
}) {
  const formatMoney=nativeMoney(currency)
  const color = tone === 'good' ? 'text-emerald-700 dark:text-emerald-300'
    : tone === 'bad' ? 'text-amber-700 dark:text-amber-300' : ''
  return (
    <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</p>
      <p className={`mt-1 font-mono text-lg tabular-nums ${color}`}>{formatMoney(amount)}</p>
      {note && <p className="mt-0.5 text-xs text-neutral-500">{note}</p>}
    </div>
  )
}

/**
 * One statement's reconciliation, the QuickBooks way: four figures, the
 * cleared list, what is still pending, and Finish when the difference is
 * zero. It computes nothing — `reconcileView()` decided every figure, and the
 * difference it shows is the number the database's own guard computes when
 * Finish is asked for, so the button and the figure cannot disagree.
 */
export function ReconcilePanel({
  ledgerId, accountId, view, actions,
}: {
  ledgerId: string
  accountId: string
  view: ReconcileView
  actions: { finish: FormAction; undo: FormAction }
}) {
  const formatMoney=nativeMoney(view.currency??'CAD')
  const balanced = view.difference === 0n
  const canFinish = balanced && !view.finished && !view.earlierOpen
  const feed = `/ledger/${ledgerId}/bank/${accountId}`
  const payments = view.clearedRows.filter((r) => r.amount < 0n)
  const deposits = view.clearedRows.filter((r) => r.amount > 0n)

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Statement of {view.statementDate}</h2>
        <span className="flex gap-3 text-xs">
          <a href={`${feed}/statement/${view.statementDate}/pdf`} target="_blank"
             className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">PDF</ToolAction></a>
          <a href={`${feed}/statement/${view.statementDate}/pdf?format=xlsx`}
             className="text-neutral-500 hover:underline">Excel</a>
          <Link href={`${feed}/statement/${view.statementDate}/print`}
                className={TOOL_BUTTON} title="Print"><ToolAction kind="print">Print</ToolAction></Link>
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {reconcileFigures(view).map(([label, amount, note]) => (
          <Figure currency={view.currency} key={label} label={label} amount={amount} note={note}
                  tone={label === 'Difference' ? (balanced ? 'good' : 'bad') : undefined} />
        ))}
      </div>

      {view.importGap !== 0n && (
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <strong>Import gap: {formatMoney(view.importGap)}.</strong> Check missing or duplicate rows
          and statement balances; matching cannot fix this gap.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        {view.finished ? (
          <>
            <span className="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
              Finished {view.finished.at.slice(0, 10)} by {view.finished.by}
            </span>
            {view.isNewestFinished ? (
              <ActionForm action={actions.undo} submit="Undo reconciliation" working="…"
                          className="flex flex-wrap items-center gap-2" buttonClassName={QUIET}>
                <input type="hidden" name={F.ledgerId} value={ledgerId} />
                <input type="hidden" name={F.accountId} value={accountId} />
                <input type="hidden" name={F.statementId} value={view.statementId} />
                <input name={F.reason} required maxLength={500} aria-label="Reason for undoing reconciliation" className="h-[34px] w-64 rounded border border-neutral-300 bg-transparent px-2 text-sm dark:border-neutral-700" />
              </ActionForm>
            ) : (
              <span className="text-xs text-neutral-500">
                A later reconciliation rests on this one; undo that one first.
              </span>
            )}
          </>
        ) : (
          <>
            <ActionForm action={actions.finish} submit="Finish now" working="Finishing…" buttonClassName={BUTTON}>
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
              <input type="hidden" name={F.accountId} value={accountId} />
              <input type="hidden" name={F.statementId} value={view.statementId} />
            </ActionForm>
            {!canFinish && (
              <span className="text-xs text-neutral-500">
                {view.earlierOpen
                  ? `The statement of ${view.earlierOpen} is not finished; reconciliations are finished in order.`
                  : 'Finishing is refused until the difference is zero.'}
              </span>
            )}
          </>
        )}
      </div>

      {/* Three lists, ONE column layout: the same colgroup, the same headers,
          the same money columns — so a payment in one table sits over a
          payment in the next. The first version gave each list its own
          columns and nothing lined up (owner, 2026-09-04). */}
      <Rows currency={view.currency} title={`Not yet cleared (${formatNumber(view.pendingRows.length)})`} last="Status"
            rows={view.pendingRows.map((r) => ({
              id: r.id, tick: false, date: r.txn_date, description: r.description,
              amount: r.unmatched_amount,
              last: `${STATE_LABEL[r.state]}${r.state === 'ignored' && r.ignored_reason ? ` — ${r.ignored_reason}` : ''}`,
            }))}
            empty="Every row on this statement is cleared."
            note={view.pendingRows.length > 0 ? (
              <>Match or add these on the <Link href={`${feed}?tab=review`} className="underline">feed</Link>.
              A row set aside still moved the bank&apos;s balance, so it counts against the difference
              until the books account for it — two set-aside rows that cancel out are fine, one on its
              own is not.</>
            ) : undefined} />
      <Rows currency={view.currency} title={`Cleared payments (${formatNumber(payments.length)})`} last="Booked as"
            rows={payments.map((r) => ({
              id: r.id, tick: true, date: r.txn_date, description: r.description, amount: r.amount,
              last: r.entries.map((e) => `${e.entry_no ?? 'entry'} · ${e.description}`).join('; '),
            }))} empty="No payments cleared on this statement." />
      <Rows currency={view.currency} title={`Cleared deposits (${formatNumber(deposits.length)})`} last="Booked as"
            rows={deposits.map((r) => ({
              id: r.id, tick: true, date: r.txn_date, description: r.description, amount: r.amount,
              last: r.entries.map((e) => `${e.entry_no ?? 'entry'} · ${e.description}`).join('; '),
            }))} empty="No deposits cleared on this statement." />
    </section>
  )
}

type Line = { id: string; tick: boolean; date: string; description: string; amount: bigint; last: string }

/**
 * One list of the three. Payment and Deposit are two columns, the way a bank
 * prints them, and the Total line foots each.
 */
function Rows({ title, rows, last, empty, note,currency='CAD' }: {
  currency?:string
  title: string; rows: Line[]; last: string; empty: string; note?: React.ReactNode
}) {
  const formatMoney=nativeMoney(currency)
  const paid = rows.filter((r) => r.amount < 0n).reduce((a, r) => a + r.amount, 0n)
  const got = rows.filter((r) => r.amount > 0n).reduce((a, r) => a + r.amount, 0n)
  return (
    <div className="mt-6">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-neutral-400">{empty}</p>
      ) : (
        <DataTable density="reading" className="mt-1 w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-7" /><col className="w-24" /><col />
            <col className="w-28" /><col className="w-28" /><col className="w-[22rem]" />
          </colgroup>
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2 font-medium" />
              <th className={TH}>Date</th><th className={TH}>Description</th>
              <th className={`${TH} text-right`}>Payment</th><th className={`${TH} text-right`}>Deposit</th>
              <th className="py-2 font-medium">{last}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-neutral-100 align-top dark:border-neutral-900" data-line={r.id}>
                <td className="py-1.5 pr-2 text-emerald-700 dark:text-emerald-300" aria-label={r.tick ? 'cleared' : undefined}>
                  {r.tick ? '✓' : ''}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs text-neutral-500">{r.date}</td>
                <td className="truncate py-1.5 pr-3">{r.description || <span className="italic text-neutral-400">no description</span>}</td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">{r.amount < 0n ? formatMoney(-r.amount) : ''}</td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">{r.amount > 0n ? formatMoney(r.amount) : ''}</td>
                <td className="truncate py-1.5 text-xs text-neutral-600 dark:text-neutral-400">{r.last}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-neutral-700 dark:border-neutral-300">
              <td /><td />
              <td className="py-1.5 pr-3 text-xs font-medium">Total</td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono font-medium tabular-nums">{paid < 0n ? formatMoney(-paid) : ''}</td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono font-medium tabular-nums">{got > 0n ? formatMoney(got) : ''}</td>
              <td />
            </tr>
          </tbody>
        </DataTable>
      )}
      {note && <p className="mt-2 text-xs text-neutral-500">{note}</p>}
    </div>
  )
}

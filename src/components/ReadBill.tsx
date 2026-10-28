'use client'

import { DataTable } from '@/components/Table'

import { formatNumber } from '@/lib/numbers'
import { Fragment } from 'react'
import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { BILL_FIELDS as F } from '@/lib/forms'
import type { ReadingCard } from '@/lib/bill-reading'
import { MONEY_KEYS, destinationHref, destinationOf } from '@/lib/destinations'
import { STRUCTURED_TABLE_WORDS as TABLE_WORDS, structuredRowCounts as rowCounts } from '@/lib/structured-readings'
import { BUTTON, FIELD, QUIET, REFUSAL } from '@/lib/ui'

/**
 * Read & add: a sentence, a document or both, and the readings that came back —
 * each with the ways it can be entered and a way to throw it away.
 *
 * It started on the Assistant page, moved onto Expenses and Invoices (owner,
 * 2026-09-07: 「ai 读文件应该放到 expenses 和 invoices 界面里」) and then to a
 * door of its own in the Add flyout. ONE component, one place. Since
 * 2026-09-15 a reading can be a sentence alone (「我告诉他一句话和附件，就可以
 * 做账了」), and money coming in is read as well as money going out.
 *
 * Nothing here posts. The buttons are LINKS to the ordinary forms with
 * `?reading=<id>`; those forms open filled in from the proposal and post
 * through the doors they always posted through. A line the model could not
 * put an account to is shown in amber, and the form it opens in will refuse
 * to post until a person picks one — the review is enforced by the door.
 *
 * The actions arrive as props so a check can render this (BR12, BR27) without
 * a server runtime, the ActionForm rule. What arrives in `readings` is what the
 * browser gets — built by `readingCards` in the lib, from the rows, and
 * watched there: never the bytes, which have their own guarded route.
 */

/** What a reading can become, and the words for it. */
type Door = { key: 'expense' | 'cheque' | 'bill' | 'income' | 'sale'; href: string; label: string; short: string }
const doorsFor = (ledgerId: string, id: string): Record<Door['key'], Door> => ({
  expense: { key: 'expense', href: `/ledger/${ledgerId}/entries/quick/expense?reading=${id}`,
             label: 'Enter as an expense paid now', short: 'an expense paid now' },
  cheque: { key: 'cheque', href: `/ledger/${ledgerId}/cheques/new?reading=${id}`,
            label: 'Review as a cheque', short: 'a cheque to issue' },
  bill: { key: 'bill', href: `/ledger/${ledgerId}/bills/new?reading=${id}`,
          label: 'Enter as a bill to pay (AP)', short: 'a bill to pay' },
  income: { key: 'income', href: `/ledger/${ledgerId}/entries/quick/income?reading=${id}`,
            label: 'Enter as income received now', short: 'income received now' },
  sale: { key: 'sale', href: `/ledger/${ledgerId}/invoices/new?direction=sales&reading=${id}`,
          label: 'Enter as a sales invoice (AR)', short: 'a sales invoice' },
})

/**
 * How a card says what the model took the reading for.
 *
 * Keyed on the PROPOSAL's kinds, not the doors': `other` is a thing the model
 * can say and not a door anybody can walk through, which is the whole point of
 * it existing (2026-09-16).
 */
const LOOKS: Record<ReadingCard['proposal'] extends { suggests: infer K } | null ? K & string : never, string> = {
  other: 'not a transaction',
  expense: 'looks paid',
  cheque: 'looks like a cheque to issue',
  bill: 'looks like a bill to pay',
  income: 'looks received',
  sale: 'looks like an invoice to a customer',
}

export function ReadBill({
  ledgerId, canRead, readAction, discardAction, chart, readings, sentenceMax,
}: {
  ledgerId: string
  /** Whether the person has a service to read with; the list shows either way. */
  canRead: boolean
  readAction: FormAction
  discardAction: FormAction
  /** Account code → its label, for naming what the model proposed. */
  chart: Record<string, string>
  readings: ReadingCard[]
  /** The longest sentence a reading takes (`SENTENCE_MAX`, which lives server-side). */
  sentenceMax: number
}) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">Say it or show it</h2>
      {canRead ? (
        <ActionForm action={readAction} submit="Read it" working="Reading…" className="max-w-2xl"
                    buttonClassName={`mt-3 ${BUTTON}`}>
          <input type="hidden" name={F.ledgerId} value={ledgerId} />
          <textarea name={F.sentence} aria-label="Description" rows={3} maxLength={sentenceMax}
                    className={`block w-full ${FIELD}`} />
          <input type="file" name={F.file} accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,application/pdf,image/png,image/jpeg,image/webp,image/gif"
                 className="mt-3 block text-xs text-neutral-600 file:mr-3 file:rounded file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-xs dark:text-neutral-400 dark:file:border-neutral-700" />

          <p className="mt-2 max-w-xl text-xs text-neutral-500" data-ai-privacy-boundary>
            Your service receives the sentence or file and this company&apos;s accounting context. It returns only a
            proposal; nothing is entered until you choose a form and review it.
          </p>

        </ActionForm>
      ) : (
        <p className="text-sm text-neutral-500">
          Save your AI service in Settings → AI to use Read &amp; add.
        </p>
      )}

      {readings.length > 0 && (
        <ol className="mt-6 space-y-4">
          {readings.map((r) => <Card key={r.id} ledgerId={ledgerId} r={r} chart={chart} discardAction={discardAction} />)}
        </ol>
      )}
    </section>
  )
}

function Card({ ledgerId, r, chart, discardAction }: {
  ledgerId: string; r: ReadingCard; chart: Record<string, string>; discardAction: FormAction
}) {
  const p = r.proposal
  const doors = doorsFor(ledgerId, r.id)
  /**
   * The model said this is not a transaction (2026-09-16).
   *
   * Until then four money movements were the only answers it was allowed,
   * and anything else became `expense` in silence — which is how a company
   * registration document was filed as money spent. Now it can say so, and
   * this screen's job changes: it still offers the four doors, because the
   * person may disagree and knows their own books, but it stops RANKING them
   * as though one had been suggested. A suggestion nobody made should not be
   * dressed as one.
   */
  const chosen = destinationOf(p?.suggests)
  /**
   * Where the model said this belongs, when that is not one of the money
   * doors — a registration certificate, a director's consent, a statement.
   * The card leads with THAT door instead of ranking the transaction ones.
   */
  const elsewhere = chosen && !MONEY_KEYS.includes(chosen.key) ? chosen : null
  /**
   * EVERY TABLE THIS READING READ ROWS FOR (2026-09-16), whichever one the
   * model named. A minute book fills several — the minute book, the directors,
   * the shares — and each has its own add form; a card offering only the one
   * the model led with would leave the rest of what it read with no door.
   */
  const tables = p ? rowCounts(p.rows) : []
  /** Rows of this reading are in the corporate record somewhere: 0080 keeps it. */
  const kept = Object.keys(r.recordsEntered).length > 0
  const notATransaction = p?.suggests === 'other'
  const moneyIn = p?.suggests === 'income' || p?.suggests === 'sale'
  const [first, second] = moneyIn ? [doors.income, doors.sale] : [doors.expense, doors.bill]
  // The one the model suggested is the main button, the other of its pair beside it.
  const pair = p?.suggests === second.key ? [second, first] : [first, second]
  const likelier = moneyIn ? pair : p?.suggests === 'cheque' ? [doors.cheque, ...pair] : [...pair, doors.cheque]
  // And the other direction, quietly, for a reading the model took the wrong way round.
  const others = moneyIn ? [doors.expense, doors.bill] : [doors.income, doors.sale]
  return (
    <li className="rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800" data-reading={r.id}>
      <p className="text-xs text-neutral-500">
        {r.when} · {r.by} ·{' '}
        {r.filename !== null ? (
          <a href={`/ledger/${ledgerId}/readings/${r.id}/file`} target="_blank"
             className="underline underline-offset-2">{r.filename}</a>
        ) : 'from a sentence'}
      </p>
      {r.sentence && <p className="mt-2 whitespace-pre-wrap text-neutral-600 dark:text-neutral-400">“{r.sentence}”</p>}
      {r.error !== null && (
        <p className={`mt-2 ${REFUSAL}`}>
          Could not be read: {r.error}
        </p>
      )}
      {p && (
        <>
          <p className="mt-2 font-medium">
            {p.party || (moneyIn ? 'Customer not read' : 'Supplier not read')}
            {p.documentRef && <> · {p.documentRef}</>}
            {p.issuedOn && <> · {p.issuedOn}</>}
            {p.dueOn && <> · due {p.dueOn}</>}
            {' · '}{LOOKS[p.suggests]}
            {p.currency !== 'CAD' && <span className="ml-2 text-amber-700 dark:text-amber-400">in {p.currency} — the books are in CAD</span>}
          </p>
          {elsewhere && (
            <div className="mt-3 rounded border border-clay-300 bg-clay-50 p-3 text-sm dark:border-clay-800 dark:bg-neutral-900">
              <p className="font-medium">
                This is not a transaction — it belongs in {elsewhere.label.replace(/^Open (the )?/, '')}.
              </p>
              <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                {p.suggestedKind ? <>Read as <strong>{p.suggestedKind}</strong>.</> : null}
                {p.belongs && <> {p.belongs}</>}
              </p>
              {Object.keys(p.facts).length > 0 && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {Object.entries(p.facts).map(([k, v]) => (
                    <Fragment key={k}>
                      <dt className="text-neutral-500">{k}</dt>
                      <dd className="font-mono">{v}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
              {!tables.some(([t]) => t === elsewhere.key) && (
                <a href={destinationHref(ledgerId, r.id, elsewhere)}
                   className={`mt-3 inline-block ${BUTTON}`}>
                  {elsewhere.label}
                </a>
              )}
              <p className="mt-2 text-xs text-neutral-500">
                {elsewhere.prefills
                  ? 'The form opens with what was read already in it, for you to check before saving.'
                  : 'That screen does not read a document yet, so it opens as it is — what was read is above, to copy across.'}
              </p>
            </div>
          )}
          {tables.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2" data-record-tables>
              {tables.map(([table, count]) => {
                const d = destinationOf(table)
                const words = TABLE_WORDS[table]
                const lead = elsewhere?.key === table
                return (
                  <li key={table} data-table={table}>
                    {r.recordsEntered[table] !== undefined ? (
                      <Link href={`/ledger/${ledgerId}${words.list}`}
                            className="inline-block rounded border border-emerald-300 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:text-emerald-300">
                        Entered: {r.recordsEntered[table]} {r.recordsEntered[table] === 1 ? words.one : words.many} — view
                      </Link>
                    ) : d && (
                      <Link href={destinationHref(ledgerId, r.id, d)} className={lead ? BUTTON : QUIET}>
                        {d.label} — {formatNumber(count)} {count === 1 ? 'row' : 'rows'}
                      </Link>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {notATransaction && (
            <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
              <p className="font-medium text-amber-900 dark:text-amber-200">
                This does not look like a transaction.
              </p>
              <p className="mt-1 text-amber-800 dark:text-amber-300">
                {p.suggestedKind
                  ? <>It was read as <strong>{p.suggestedKind}</strong>.</>
                  : <>It was read, but not as money moving.</>}
                {p.belongs && <> It belongs with {p.belongs}.</>}
              </p>
              <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                Nothing here enters it: these doors post money, and this document moves none. The
                reading and the file are kept. If you disagree, the doors below still open.
              </p>
            </div>
          )}
          {p.lines.length === 0 ? (
            !notATransaction && <p className="mt-2 text-neutral-500">No lines were read. The form will open blank.</p>
          ) : (
            <DataTable density="reading" className="mt-2 text-xs">
              <tbody>
                {p.lines.map((l, i) => (
                  <tr key={i} data-line={i}>
                    <td className="pr-4 py-0.5">{l.description || '—'}</td>
                    <td className="pr-4 py-0.5">
                      {l.accountCode && chart[l.accountCode]
                        ? <span className="font-mono">{chart[l.accountCode]}</span>
                        : (
                          <span className="text-amber-700 dark:text-amber-400" data-no-account>
                            {l.suggestedCode
                              // The model had an opinion this chart cannot honour. Saying
                              // so beats a blank: it tells the person what to add, or what
                              // the model was reaching for (2026-09-07).
                              ? <>it suggested {l.suggestedCode}, which this chart has not — choose an account</>
                              : <>choose an account</>}
                          </span>
                        )}
                    </td>
                    <td className="pr-4 py-0.5 text-right tabular-nums">{formatNumber(l.amount)}</td>
                    <td className="py-0.5 text-neutral-500">{l.taxCode || 'no tax'}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
          <p className="mt-2 text-xs text-neutral-500">
            On the document:
            {p.subtotal !== null && <> subtotal {p.subtotal} ·</>}
            {p.gst !== null && <> GST {p.gst} ·</>}
            {p.pst !== null && <> PST {p.pst} ·</>}
            {p.total !== null ? <> total {p.total}</> : <> no total read</>}
            {p.notes && <> · the model notes: “{p.notes}”</>}
          </p>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {r.usedEntryId !== null ? (
          <Link href={`/ledger/${ledgerId}/entries/${r.usedEntryId}`} className="text-xs underline underline-offset-2">
            Entered — view the entry
          </Link>
        ) : (
          <>
            {p && likelier.map((d, i) => (
              <Link key={d.key} href={d.href} className={i === 0 ? BUTTON : QUIET} data-enter={d.key}>{d.label}</Link>
            ))}
            {/* A reading whose rows are in the corporate record is kept (0080): the
                database refuses the discard, so the card does not offer it. */}
            {!kept && (
              <ActionForm action={discardAction} submit="Discard" working="…"
                          buttonClassName="text-xs text-neutral-500 underline hover:text-red-700">
                <input type="hidden" name={F.ledgerId} value={ledgerId} />
                <input type="hidden" name={F.readingId} value={r.id} />
              </ActionForm>
            )}
          </>
        )}
      </div>
      {r.usedEntryId === null && p && (
        <p className="mt-2 text-xs text-neutral-500">
          {moneyIn ? 'Money out, not in?' : 'Money in, not out?'} Enter it as{' '}
          <Link href={others[0].href} className="underline underline-offset-2" data-enter={others[0].key}>{others[0].short}</Link>
          {' or '}
          <Link href={others[1].href} className="underline underline-offset-2" data-enter={others[1].key}>{others[1].short}</Link>.
        </p>
      )}
    </li>
  )
}

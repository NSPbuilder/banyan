'use client'
import { DateInput } from '@/components/DateInput'

import { formatNumber } from '@/lib/numbers'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ActionForm, useActionForm, type FormAction } from '@/components/ActionForm'
import { ATTACH_FIELD, MATCH_FIELDS as F, bankPartyOptions, type TransactingPartyRoleChoice } from '@/lib/forms'
import { nativeMoney } from '@/lib/fx-money'
import type { AccountStanding, FeedRow } from '@/lib/bank'
import { FEED_TABS, STATE_LABEL, TAB_LABEL, type FeedTab } from '@/lib/bank-feed'
import { TAX_CODES } from '@/lib/tax-rates'
import { BankSplitFields } from './BankSplitFields'
import { Picker } from '@/components/Picker'
import { ModuleTabs } from '@/components/ModuleTabs'
import { FilterBar } from '@/components/FormLayout'
import { DataTable, TableViewport } from '@/components/Table'
import { IconButton } from '@/components/IconButton'
import { BUTTON, FIELD, QUIET, REFUSAL_QUIET } from '@/lib/ui'

/**
 * The two doors an Add row can open on its own behalf (owner, 2026-09-07):
 * the account this money should go to, and the party it was with, when
 * neither exists yet. Props, because this screen takes every action as one.
 */
export type FeedMakers = {
  account: FormAction
  party: FormAction
}

export type FeedActions = {
  match: FormAction
  unmatch: FormAction
  ignore: FormAction
  unignore: FormAction
  /** A row imported by mistake, deleted (0084). */
  remove: FormAction
  post: FormAction
  accept: FormAction
}

export type ContraAccount = { id: string; code: string; name: string; bank: boolean }
/** Which tax tags this company has an account for; a tag with nowhere to land is not offered. */
export type TagsOnOffer = { recoverable: boolean; payable: boolean; pstPayable: boolean }

/**
 * The tags an Add can carry for a row of this sign. Money out is something
 * bought, so its GST needs the recoverable account and its PST is cost, which
 * needs no account at all; money in is something sold, and both taxes need
 * their payable accounts. Asked here rather than refused afterwards.
 */
export function tagsFor(amount: bigint, tags: TagsOnOffer) {
  const bought = amount < 0n
  return TAX_CODES.filter((t) => {
    const wantsGst = t.code === 'GST' || t.code === 'GST_PST'
    const wantsPst = t.code === 'PST' || t.code === 'GST_PST'
    if (wantsGst && !(bought ? tags.recoverable : tags.payable)) return false
    if (wantsPst && !bought && !tags.pstPayable) return false
    return true
  })
}

const TH = 'py-2 pr-3 font-medium'
const ACCEPT_FORM = 'accept-matches'

/**
 * The account types an Add offers, likeliest first. Money out of the bank is
 * usually something bought and money in usually something sold, but either can
 * be a transfer, a loan, or the purchase of something owned — so the guess is
 * an ORDER, never a restriction.
 */
export function accountTypesFor(amount: bigint) {
  const TYPES = [
    { value: 'expense', label: 'Expense' },
    { value: 'revenue', label: 'Revenue' },
    { value: 'asset', label: 'Asset' },
    { value: 'liability', label: 'Liability' },
    { value: 'equity', label: 'Equity' },
  ]
  const first = amount < 0n ? 'expense' : 'revenue'
  return [...TYPES.filter((t) => t.value === first), ...TYPES.filter((t) => t.value !== first)]
}

/** Every form on a row carries the row it is about. */
function Hidden({ ledgerId, accountId, rowId, form }: {
  ledgerId: string; accountId: string; rowId?: string; form?: string
}) {
  return (
    <>
      <input type="hidden" name={F.ledgerId} value={ledgerId} form={form} />
      <input type="hidden" name={F.accountId} value={accountId} form={form} />
      {rowId !== undefined && <input type="hidden" name={F.rowId} value={rowId} form={form} />}
    </>
  )
}


/**
 * ONE ACCOUNT'S CARD, across the top.
 *
 * QuickBooks shows what the bank says beside what the books say. This system
 * reads a CSV — no bank connection, frozen decision — so the pair is what the
 * BOOKS hold beside what the last STATEMENT ended at. The gap between them is
 * what has not been reconciled, which is the question the other pair answers.
 * A card with no statement yet says so rather than showing a zero.
 */
function AccountCard({ ledgerId, standing, selected }: {
  ledgerId: string; standing: AccountStanding; selected: boolean
}) {
  const formatMoney=nativeMoney(standing.currency??'CAD'),money=(n:bigint)=>formatMoney(n,{sign:'accounting'})
  return (
    <Link href={`/ledger/${ledgerId}/bank/${standing.id}`}
          data-card={standing.id}
          aria-current={selected ? 'page' : undefined}
          className={`block min-w-56 rounded-control border-b-2 p-3 transition-colors ${
            selected
              ? 'border-action bg-surface-selected'
              : 'border-transparent bg-surface hover:bg-surface-hover'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-neutral-500">{standing.code} {standing.name}</span>
        {standing.review > 0 && (
          <span className="text-metadata font-medium text-ink-secondary">
            {formatNumber(standing.review)}
          </span>
        )}
      </div>
      <div className="mt-1 text-section-title font-semibold tabular-nums">
        {money(standing.books)}
      </div>
      <div className="mt-0.5 text-xs text-neutral-500">
        {standing.statement === null
          ? 'no statement on file'
          : <>Statement {money(standing.statement)}
              {standing.newestStatement && <> · {standing.newestStatement}</>}</>}
      </div>
    </Link>
  )
}

/**
 * ONE PENDING ROW, and everything it can be told — on the row itself.
 *
 * The old screen put the tax, the party and the account behind a "More…"
 * expander, so categorising three rows meant three expands (owner, 2026-09-10,
 * with a QuickBooks screenshot). Every box is in its own column now.
 *
 * A TABLE CANNOT HOLD A FORM THAT SPANS ITS CELLS, so the form lives in the
 * last cell and the boxes point at it by id — the HTML answer, and the one the
 * batch checkbox has used since it was written.
 */
function PendingRow({
  ledgerId, accountId, view, contraAccounts, parties, tags, actions, makers,
}: {
  ledgerId: string; accountId: string; view: FeedRow
  contraAccounts: ContraAccount[]; parties: TransactingPartyRoleChoice[]; tags: TagsOnOffer
  actions: FeedActions; makers?: FeedMakers
}) {
  const formatMoney=nativeMoney(view.currency??'CAD'),money=(n:bigint)=>formatMoney(n,{sign:'accounting'})
  const { row, candidates, suggestion } = view
  const postId = `post-${row.id}`
  const { state, pending, formProps } = useActionForm(actions.post)
  const [paperName, setPaperName] = useState('')
  const [splitMode, setSplitMode] = useState(false)
  const [splitAccount, setSplitAccount] = useState(suggestion.kind === 'add' ? suggestion.contraAccountId : '')
  const spent = row.amount < 0n
  const suggestedMatch = suggestion.kind === 'match' ? suggestion.entry : null

  return (
    <>
      <tr className="border-b border-neutral-100 align-middle hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900/50"
          data-row={row.id} data-state={row.state}>
        <td className="py-2 pr-2">
          {/* Only a row with a suggested match can be accepted in a batch;
              anything else needs a decision that is not a tick. */}
          {suggestedMatch && (
            <input type="checkbox" form={ACCEPT_FORM} name={F.rowIds} value={row.id}
                   aria-label={`Accept the match for ${row.description}`} />
          )}
        </td>
        <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-neutral-500">{row.txn_date}</td>
        <td className="max-w-0 truncate py-2 pr-3" title={row.description}>
          {row.description || <span className="italic text-neutral-400">no description</span>}
        </td>
        <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">
          {spent ? money(-row.amount) : ''}
        </td>
        <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">
          {spent ? '' : money(row.amount)}
        </td>

        <td className="py-2 pr-2">
          <select name={F.taxCode} form={postId} defaultValue="" aria-label="Tax"
                  className={`h-[34px] w-full ${FIELD}`}>
            {tagsFor(row.amount, tags).map((t) => (
              <option key={t.code} value={t.code === 'OUT_OF_SCOPE' ? '' : t.code}>
                {t.code === 'OUT_OF_SCOPE' ? 'No tax' : t.label}
              </option>
            ))}
          </select>
        </td>

        <td className="py-2 pr-2">
          <Picker name={F.partyId} form={postId} className="w-full"
                  ariaLabel="Party"
                  options={bankPartyOptions(parties, row.txn_date, spent)}
                  create={makers && {
                    presentation: 'party',
                    title: 'New party',
                    action: makers.party,
                    hidden: { ledgerId },
                    fields: [
                      { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
                      { name: 'kind', label: 'Kind', options: [
                        { value: 'organisation', label: 'Organisation' },
                        { value: 'person', label: 'Person' },
                      ] },
                      { name: 'role', label: 'Role', options: (spent
                        ? ['supplier', 'customer', 'employee', 'director', 'shareholder']
                        : ['customer', 'supplier', 'employee', 'director', 'shareholder']
                      ).map((role) => ({ value: role, label: role[0].toUpperCase() + role.slice(1) })) },
                    ],

                  }} />
        </td>

        <td className="py-2 pr-2">
          <label className="relative block min-w-0 cursor-pointer rounded border border-dashed border-neutral-300 px-2 py-1.5 text-xs text-neutral-600 hover:border-clay-500 focus-within:outline-2 focus-within:outline-clay-400 dark:border-neutral-700 dark:text-neutral-400">
            <span className="block truncate">{paperName || 'Attach file…'}</span>
            <input type="file" name={ATTACH_FIELD} form={postId}
                   aria-label={`Paper for ${row.description || row.txn_date}`}
                   accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.gif,.tiff,application/pdf,image/*"
                   onChange={(e) => setPaperName(e.target.files?.[0]?.name ?? '')}
                   className="sr-only" />
          </label>
        </td>

        {/* Both resolutions stay inline; compact paths stack within one cell. */}
        <td className="bank-resolve-cell py-2" colSpan={2}>
          <div className="bank-resolve grid gap-1.5"
               data-resolve={row.id}>
            {suggestedMatch && (
              <div className="grid h-[34px] grid-cols-[minmax(0,1fr)_auto] items-center gap-1"
                   data-resolution="match">
                <span className="flex h-[34px] min-w-0 items-center truncate rounded-md border border-clay-200 bg-clay-50 px-2 text-xs text-neutral-700 dark:border-clay-800 dark:bg-clay-900/20 dark:text-neutral-200"
                      data-suggestion
                      title={`${suggestedMatch.entry_date} · ${suggestedMatch.description}`}>
                  Suggested · {suggestedMatch.entry_no ?? suggestedMatch.description}
                </span>
                <ActionForm action={actions.match} submit="Match" working="…" buttonClassName={QUIET}>
                  <Hidden ledgerId={ledgerId} accountId={accountId} rowId={row.id} />
                  <input type="hidden" name={F.entryId} value={suggestedMatch.entry_id} />
                </ActionForm>
              </div>
            )}
            <div className="grid h-[34px] grid-cols-[minmax(0,1fr)_auto] items-center gap-1"
                 data-resolution="post">
              <div className="min-w-0">
                {splitMode ? <span className="text-xs text-neutral-500">Split between accounts</span> : <Picker name={F.contraAccountId} form={postId} required className="w-full"
                        ariaLabel="Category for the new entry"
                        defaultValue={suggestion.kind === 'add' ? suggestion.contraAccountId : ''}
                        options={contraAccounts.map((a) => ({
                          id: a.id,
                          label: `${a.code} — ${a.name}`,
                          hint: a.bank ? '(transfer)' : undefined,
                        }))}
                        create={makers && {
                          title: spent ? 'New expense account' : 'New income account',
                          action: makers.account,
                          hidden: { ledgerId },
                          fields: [
                            { name: 'code', label: 'Code', width: '6rem' },
                            { name: 'name', label: 'Name', width: '13rem', takesTyped: true },
                            { name: 'accountType', label: 'Type', width: '8rem',
                              options: accountTypesFor(row.amount) },
                          ],
                      }} />}
              </div>
              {/* The form lives beside the choice it commits; Tax and From/To
                  above still point at it by id because a form cannot span
                  table cells. */}
              <form {...formProps} id={postId} className="inline-flex items-center">
                <Hidden ledgerId={ledgerId} accountId={accountId} rowId={row.id} form={postId} />
                <button type="submit" disabled={pending}
                        className={suggestedMatch ? QUIET : BUTTON}>
                  {pending ? '…' : 'Post new'}
                </button>
              </form>
            </div>
          </div>
        </td>
      </tr>

      {/* Everything else this row can be told, one line under it and folded:
          the other candidates, and setting it aside. A row that needs neither
          costs a line of nothing. */}
      {(
        <tr className="border-b border-neutral-100 dark:border-neutral-900" data-strip={row.id}>
          <td />
          <td colSpan={9} className="pb-2 pt-0">
            {state.error && (
              <p role="alert" className={`mb-1 ${REFUSAL_QUIET}`}>
                {state.error}
              </p>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-neutral-500 hover:underline">More…</summary>
              <div className="mt-2 flex flex-wrap items-end gap-4 rounded bg-neutral-100 p-3 dark:bg-neutral-900/50">
                {view.currency&&view.currency!=='CAD'&&<fieldset className="flex max-w-full flex-wrap items-end gap-3"><legend className="mb-1">Actual exchange rate (optional with a saved BOC quote)</legend>
                  <label>CAD per 1 {view.currency}<input name="fxRate" form={postId} inputMode="decimal" disabled={pending} className={`${FIELD} mt-1 block w-28 max-w-full`}/></label>
                  <label>Rate date<DateInput name="fxRateDate"  form={postId} defaultValue={row.txn_date} disabled={pending} className={`${FIELD} mt-1 block max-w-full`}/></label>
                  <label>Rate evidence<input name="fxRateEvidence" form={postId} disabled={pending} className={`${FIELD} mt-1 block w-72 max-w-full`}/></label>
                </fieldset>}
                <BankSplitFields currency={view.currency} form={postId} enabled={splitMode} pending={pending}
                  remainder={row.unmatched_amount} accounts={contraAccounts} initialAccount={splitAccount}
                  onToggle={(enabled) => {
                    if (enabled && formProps.ref.current) setSplitAccount(String(new FormData(formProps.ref.current).get(F.contraAccountId) ?? ''))
                    setSplitMode(enabled)
                  }} />
                <label className="text-xs text-neutral-500">
                  <span className="block">Description</span>
                  <input type="text" name={F.description} form={postId}
                         aria-label="Item description" placeholder="Item or purpose"
                         disabled={pending}
                         className={`mt-1 w-72 max-w-full ${FIELD} py-1 text-xs`} />
                </label>
                {candidates.length > 0 && (
                  <ActionForm action={actions.match} submit="Match" working="…"
                              className="flex flex-wrap items-end gap-2" buttonClassName={QUIET}>
                    <Hidden ledgerId={ledgerId} accountId={accountId} rowId={row.id} />
                    <label className="text-xs text-neutral-500">
                      <span className="block">Find another match</span>
                      <select name={F.entryId} required defaultValue={candidates[0].entry_id}
                              className={`mt-1 w-[28rem] max-w-full ${FIELD} py-1 text-xs`}>
                        {candidates.map((c) => (
                          <option key={c.entry_id} value={c.entry_id}>
                            {c.entry_date} · {c.entry_no ?? 'entry'} · {c.description} · {formatMoney(c.room)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </ActionForm>
                )}
                <ActionForm action={actions.ignore} submit="Exclude" working="…"
                            className="flex flex-wrap items-end gap-2" buttonClassName={QUIET}>
                  <Hidden ledgerId={ledgerId} accountId={accountId} rowId={row.id} />
                  <label className="text-xs text-neutral-500">
                    <span className="block">Set aside, because</span>
                    <input name={F.reason} required
                           className={`mt-1 w-72 ${FIELD} py-1 text-xs`} />
                  </label>
                </ActionForm>
                {/* Imported into the wrong account, or the same file twice
                    (owner, 2026-09-16: 「所有的紀錄儘量都可以編輯刪除」). Exclude
                    keeps a row the bank really sent; this removes one that
                    should never have come in. */}
                <ActionForm action={actions.remove} submit="Delete this row" working="…"
                            className="flex flex-wrap items-end gap-2" buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
                  <Hidden ledgerId={ledgerId} accountId={accountId} rowId={row.id} />
                  <span className="text-xs text-neutral-500">imported by mistake</span>
                </ActionForm>
              </div>
            </details>
          </td>
        </tr>
      )}
    </>
  )
}

/** A row that has been dealt with: what it became, and the way back. */
function PostedRow({ ledgerId, accountId, view, actions }: {
  ledgerId: string; accountId: string; view: FeedRow; actions: FeedActions
}) {
  const formatMoney=nativeMoney(view.currency??'CAD'),money=(n:bigint)=>formatMoney(n,{sign:'accounting'})
  const { row, matches } = view
  const spent = row.amount < 0n
  return (
    <tr className="border-b border-neutral-100 align-middle dark:border-neutral-900"
        data-row={row.id} data-state={row.state}>
      <td className="py-2 pr-2" />
      <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-neutral-500">{row.txn_date}</td>
      <td className="max-w-0 truncate py-2 pr-3" title={row.description}>{row.description}</td>
      <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{spent ? money(-row.amount) : ''}</td>
      <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{spent ? '' : money(row.amount)}</td>
      <td className="py-2 pr-3 text-xs text-neutral-500" colSpan={4}>
        {matches.map((m) => (
          <span key={m.id} className="mr-3 inline-block">
            <Link href={`/ledger/${ledgerId}/entries/${m.entry_id}`} className="hover:underline">
              {m.entry_no ?? 'entry'} · {formatMoney(m.amount)}
            </Link>
          </span>
        ))}
        {matches.length === 0 && <span className="text-neutral-400">{STATE_LABEL[row.state]}</span>}
      </td>
      <td className="py-2 text-right">
        {matches.map((m) => (
          <ActionForm key={m.id} action={actions.unmatch} submit="Undo" working="…" buttonClassName={QUIET}>
            <Hidden ledgerId={ledgerId} accountId={accountId} rowId={row.id} />
            <input type="hidden" name={F.matchId} value={m.id} />
          </ActionForm>
        ))}
      </td>
    </tr>
  )
}

/** A row set aside, and the way back. */
function ExcludedRow({ ledgerId, accountId, view, actions }: {
  ledgerId: string; accountId: string; view: FeedRow; actions: FeedActions
}) {
  const formatMoney=nativeMoney(view.currency??'CAD'),money=(n:bigint)=>formatMoney(n,{sign:'accounting'})
  const { row } = view
  const spent = row.amount < 0n
  return (
    <tr className="border-b border-neutral-100 align-middle dark:border-neutral-900"
        data-row={row.id} data-state={row.state}>
      <td className="py-2 pr-2" />
      <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-neutral-500">{row.txn_date}</td>
      <td className="max-w-0 truncate py-2 pr-3" title={row.description}>{row.description}</td>
      <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{spent ? money(-row.amount) : ''}</td>
      <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{spent ? '' : money(row.amount)}</td>
      <td className="py-2 pr-3 text-xs text-neutral-500" colSpan={4}>{row.ignored_reason}</td>
      <td className="py-2 text-right">
        <ActionForm action={actions.unignore} submit="Put it back" working="…" buttonClassName={QUIET}>
          <Hidden ledgerId={ledgerId} accountId={accountId} rowId={row.id} />
        </ActionForm>
      </td>
    </tr>
  )
}

const PER_PAGE = 50

/**
 * Bank transactions — the shape QuickBooks Online uses (owner, 2026-09-10,
 * with a screenshot).
 *
 * A card per account across the top, three tabs, a toolbar, and a table whose
 * every pending row carries its own tax, party and category with a Post at the
 * end. It computes nothing about the money: `feed()` decided every state and
 * every suggestion, and this arranges them (06 §5).
 *
 * The search and the type filter are CLIENT state, not the URL: they are how
 * you are looking through a list right now, they change on every keystroke,
 * and a round trip per letter would make the box feel broken. The account and
 * the tab are in the URL, because those are where you are.
 */
export function FeedScreen({
  ledgerId, accountId, accountLabel, standings, tab, counts, rows,
  contraAccounts, parties, tags, actions, makers,
}: {
  ledgerId: string
  accountId: string
  accountLabel: string
  /** Every account with bank rows, for the cards. */
  standings?: AccountStanding[]
  tab: FeedTab
  counts: Record<FeedTab, number>
  rows: FeedRow[]
  contraAccounts: ContraAccount[]
  parties: TransactingPartyRoleChoice[]
  tags: TagsOnOffer
  actions: FeedActions
  makers?: FeedMakers
}) {
  const base = `/ledger/${ledgerId}/bank/${accountId}`
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'all' | 'spent' | 'received'>('all')
  const [page, setPage] = useState(0)

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return rows.filter((v) => {
      if (kind === 'spent' && v.row.amount >= 0n) return false
      if (kind === 'received' && v.row.amount < 0n) return false
      if (words.length === 0) return true
      const hay = `${v.row.description} ${v.row.txn_date}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [rows, q, kind])

  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE))
  const at = Math.min(page, pages - 1)
  const slice = shown.slice(at * PER_PAGE, at * PER_PAGE + PER_PAGE)
  const suggested = rows.filter((v) => v.suggestion.kind === 'match').length

  return (
    <>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-sm text-neutral-500">{accountLabel}</p>
        <p className="flex gap-4 text-sm">
          <Link href={`/ledger/${ledgerId}/bank/import`} className={BUTTON}>
            Read a file
          </Link>
          <Link href={`${base}/reconcile`} className={QUIET}>Reconcile</Link>
        </p>
      </div>

      {standings && standings.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3" aria-label="accounts">
          {standings.map((s) => (
            <AccountCard key={s.id} ledgerId={ledgerId} standing={s} selected={s.id === accountId} />
          ))}
        </div>
      )}

      <ModuleTabs label="feed tabs" className="mt-4" items={FEED_TABS.map((t) => ({
        href: `${base}?tab=${t}`, selected: t === tab,
        label: <>{TAB_LABEL[t]}{counts[t] > 0 && <span className="ml-1 text-metadata text-ink-muted">({formatNumber(counts[t])})</span>}</>,
      }))} />

      <FilterBar>
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} aria-label="Search these rows"
               className={`w-64 max-w-full ${FIELD}`} />
        <select value={kind} aria-label="Which transactions"
                onChange={(e) => { setKind(e.target.value as typeof kind); setPage(0) }}
                className={FIELD}>
          <option value="all">All transactions ({formatNumber(rows.length)})</option>
          <option value="spent">Money out</option>
          <option value="received">Money in</option>
        </select>
        <span className="ml-auto flex items-center gap-2 text-xs text-neutral-500">
          {shown.length === 0 ? 'nothing' : `${formatNumber(at * PER_PAGE + 1)}–${formatNumber(at * PER_PAGE + slice.length)} of ${formatNumber(shown.length)}`}
          {pages > 1 && (
            <>
              <IconButton icon="back" label="Previous page" disabled={at === 0} onClick={() => setPage(at - 1)} />
              <span>{formatNumber(at + 1)} / {formatNumber(pages)}</span>
              <IconButton icon="chevron-right" label="Next page" disabled={at + 1 >= pages} onClick={() => setPage(at + 1)} />
            </>
          )}
        </span>
      </FilterBar>

      {tab === 'pending' && suggested > 0 && (
        <ActionForm action={actions.accept} id={ACCEPT_FORM}
                    submit={`Accept ${formatNumber(suggested)} match${suggested === 1 ? '' : 'es'}`}
                    working="Accepting…" className="mt-4 flex flex-wrap items-center gap-3" buttonClassName={QUIET}>
          <Hidden ledgerId={ledgerId} accountId={accountId} />

        </ActionForm>
      )}

      {slice.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          {rows.length === 0
            ? 'Nothing here. Read a file to bring rows in.'
            : 'Nothing matches what you typed.'}
        </p>
      ) : (
        <TableViewport label="Bank transactions" className="mt-4">
        <DataTable className="bank-feed-table table-fixed" data-feed-tab={tab}>
          <colgroup>
            <col className="w-8" /><col className="w-[5.25rem]" /><col />
            <col className="w-[5.5rem]" /><col className="w-[5.5rem]" />
            <col className={tab === 'pending' ? 'w-[5.5rem]' : undefined} />
            <col className={tab === 'pending' ? 'w-36' : undefined} />
            <col className={tab === 'pending' ? 'w-[6.25rem]' : undefined} />
            <col className={tab === 'pending' ? 'w-[10.5rem]' : undefined} /><col className="w-[5.75rem]" />
          </colgroup>
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-2" />
              <th className={TH}>Date</th>
              <th className={TH}>Bank description</th>
              <th className={`${TH} text-right`}>Spent</th>
              <th className={`${TH} text-right`}>Received</th>
              <th className={TH}>{tab === 'pending' ? 'Tax' : ''}</th>
              <th className={TH}>{tab === 'pending' ? 'From/To' : ''}</th>
              {tab === 'pending' ? (
                <>
                  <th className={TH}>Paper</th>
                  <th className="bank-resolve-cell py-2 font-medium" colSpan={2}>Resolve</th>
                </>
              ) : (
                <>
                  <th className={TH} colSpan={2}>{tab === 'posted' ? 'In the books' : 'Why'}</th>
                  <th className="py-2 text-right font-medium">Action</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {slice.map((v) => (
              tab === 'pending' ? (
                <PendingRow key={v.row.id} ledgerId={ledgerId} accountId={accountId} view={v}
                            contraAccounts={contraAccounts} parties={parties} tags={tags}
                            actions={actions} makers={makers} />
              ) : tab === 'posted' ? (
                <PostedRow key={v.row.id} ledgerId={ledgerId} accountId={accountId} view={v} actions={actions} />
              ) : (
                <ExcludedRow key={v.row.id} ledgerId={ledgerId} accountId={accountId} view={v} actions={actions} />
              )
            ))}
          </tbody>
        </DataTable>
        </TableViewport>
      )}
    </>
  )
}

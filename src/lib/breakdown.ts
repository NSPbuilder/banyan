import 'server-only'
import { sql } from 'drizzle-orm'
import { invoiceHref } from '@/lib/invoice-routes'
import { db } from '@/db/client'
import { firstBookDay, resolvePeriodSpan } from './balances'
import { spanLabel } from './date-range'
import { generalLedger } from './reports'
import { formulaTerms, renderStatement } from './statements'
import { renderCashFlow } from './cash-flow'
import { renderEquityChanges } from './equity-changes'
import { BUCKETS, ageOf, bucketOf, openControlEntries } from './aging'
import { gstHstReturn, pstReturn, type PstReturn } from './tax'
import { ledgerHead } from './ledger-head'

/**
 * What makes a report figure up.
 *
 * Every number on a report can be clicked, and this is the one function behind
 * the click: the screen overlay, the full page, the CSV and the PDF all render
 * the SAME Breakdown. It computes nothing of its own — each kind calls the
 * derivation its report already calls (`generalLedger`, `renderStatement`,
 * `openControlEntries`, `gstHstReturn`), so the rows here are the rows the
 * report added, not a second opinion that can drift.
 *
 * The one rule of presentation: the money column must visibly add up to the
 * figure that was clicked, in the direction the report showed it. A trace whose
 * column does not sum to its total is not a trace.
 */

export type BreakdownCell = { text: string; mono?: boolean } | { money: bigint }

export type BreakdownRow = {
  cells: BreakdownCell[]
  /** Where clicking this row leads — an entry, an invoice, a deeper breakdown. */
  href?: string
  bold?: boolean
  rule?: boolean
}

export type Breakdown = {
  entity: string
  title: string
  subtitle: string
  /** What a reader must know to read the rows: the basis, the sign, the cut. */
  note?: string
  columns: Array<{ label: string; align?: 'right'; weight?: number }>
  rows: BreakdownRow[]
  /** The figure that was clicked. The rows above must account for it. */
  total: { label: string; amount: bigint }
  /** Filename parts for the exports. */
  slug: string[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const t = (text: string, mono = false): BreakdownCell => (mono ? { text, mono } : { text })
const m = (money: bigint): BreakdownCell => ({ money })
const blankIfZero = (cents: bigint): BreakdownCell => (cents === 0n ? { text: '' } : { money: cents })

const entityName = async (ledgerId: string): Promise<string | null> =>
  (await ledgerHead(ledgerId))?.entity ?? null

/** The address of a breakdown, for links that drill one level deeper. */
export function breakdownHref(ledgerId: string, params: Record<string, string>): string {
  return `/ledger/${ledgerId}/breakdown?${new URLSearchParams(params)}`
}

export async function breakdown(
  ledgerId: string, q: Record<string, string | undefined>,
): Promise<Breakdown | null> {
  const entity = await entityName(ledgerId)
  if (!entity) return null

  switch (q.kind) {
    case 'account': return accountBreakdown(ledgerId, entity, q)
    case 'statement-line': return statementLineBreakdown(ledgerId, entity, q)
    case 'cash-flow-line': return cashFlowLineBreakdown(ledgerId, entity, q)
    case 'equity-cell': return equityCellBreakdown(ledgerId, entity, q)
    case 'aging': return agingBreakdown(ledgerId, entity, q)
    case 'tax': return taxBreakdown(ledgerId, entity, q)
    default: return null
  }
}

// ------------------------------------------------ a trial balance figure --

/**
 * One account over the range: opening, every posted line, closing. The same
 * `generalLedger` the GL report prints, filtered to the account — so this
 * breakdown and that report cannot use different arithmetic, and X16's
 * "opening + rows = closing" identity holds here for free.
 */
async function accountBreakdown(
  ledgerId: string, entity: string, q: Record<string, string | undefined>,
): Promise<Breakdown | null> {
  const { account: accountId, from, to } = q
  if (!accountId || !UUID.test(accountId) || !to || !DATE.test(to)) return null
  if (from !== undefined && !DATE.test(from)) return null

  // A POSITION'S explanation starts where the books start. A closing balance
  // is cumulative; opening it over a quiet month shows "opening 20,000,
  // closing 20,000" and explains nothing. No `from` means the books' first
  // day — the opening row is then zero, and every posted line that built
  // the figure is on the page. Movement figures pass their own `from`.
  const fromDate = from ?? await firstBookDay(ledgerId) ?? undefined
  if (!fromDate) return null

  const span = await resolvePeriodSpan(ledgerId, fromDate, to)
  if (!span) return null

  const [one] = await generalLedger(ledgerId, {
    fromPeriodId: span.fromPeriod.id, toPeriodId: span.toPeriod.id,
    fromDate: span.fromPeriod.start_date, toDate: span.toPeriod.end_date,
  }, { accountId })

  // An account the span's balances never touched still deserves an answer.
  const [acct] = one
    ? [one.account]
    : await db.execute<{ id: string; code: string; name: string }>(sql`
        SELECT a.id::text, a.code, a.name
          FROM account a JOIN ledger l ON l.entity_id = a.entity_id
         WHERE a.id = ${accountId}::uuid AND l.id = ${ledgerId}::uuid`)
  if (!acct) return null

  const opening = one?.opening ?? 0n
  const closing = one?.closing ?? 0n

  const rows: BreakdownRow[] = [
    { cells: [t(''), t(''), t('Opening balance'), t(''), t(''), t(''), m(opening)] },
    ...(one?.rows ?? []).map((r) => ({
      cells: [
        t(r.entry_date, true), t(r.entry_no, true),
        t(r.line_description || r.description),
        t(r.contra_codes.join(' '), true),
        blankIfZero(BigInt(r.debit)), blankIfZero(BigInt(r.credit)),
        m(BigInt(r.running)),
      ],
      href: `/ledger/${ledgerId}/entries/${r.entry_id}`,
    })),
    { cells: [t(''), t(''), t('Closing balance'), t(''), t(''), t(''), m(closing)],
      bold: true, rule: true },
  ]

  return {
    entity,
    title: `${acct.code} — ${acct.name}`,
    subtitle: spanLabel(span.fromPeriod.name, span.toPeriod.name),
    note: 'Opening is the position where the range begins; every posted line in the range '
        + 'follows; the running balance ends at the closing figure the report shows.',
    columns: [
      { label: 'Date', weight: 1.4 }, { label: 'Entry', weight: 1.4 },
      { label: 'Description', weight: 3.4 }, { label: 'Against', weight: 1.2 },
      { label: 'Debit', align: 'right', weight: 1.4 },
      { label: 'Credit', align: 'right', weight: 1.4 },
      { label: 'Balance', align: 'right', weight: 1.6 },
    ],
    rows,
    total: { label: 'Closing balance', amount: closing },
    slug: ['breakdown', acct.code, from ?? 'since-start', to],
  }
}

// ------------------------------------------------- a statement line figure --

/**
 * One line of a financial statement.
 *
 *   detail            the accounts that fed it (renderStatement already
 *                     carries them for exactly this purpose)
 *   total             the lines its formula added and subtracted — the same
 *                     terms, from the same tokenizer, the total itself used
 *   current_earnings  the year-to-date movement of every revenue and expense
 *                     account, which is what that line is
 *
 * Amounts are in the direction the STATEMENT shows the clicked line, so the
 * column sums to the figure on the screen — not to its raw ledger sign.
 */
async function statementLineBreakdown(
  ledgerId: string, entity: string, q: Record<string, string | undefined>,
): Promise<Breakdown | null> {
  const { template, line, from, to } = q
  if (!template || !from || !DATE.test(from) || !to || !DATE.test(to)) return null
  if (!line || !/^\d+$/.test(line)) return null

  const span = await resolvePeriodSpan(ledgerId, from, to)
  if (!span) return null

  const st = await renderStatement(ledgerId, template, span.toPeriod.id, span.fromPeriod.id)
  if (!st) return null

  const index = Number(line)
  const l = st.lines[index]
  if (!l || (l.lineType !== 'detail' && l.lineType !== 'total' && l.lineType !== 'current_earnings')) {
    return null
  }

  const flip = l.signFlip ? -1n : 1n
  const subtitle = `${st.template.name} · ${spanLabel(span.fromPeriod.name, span.toPeriod.name)}`
  const slug = ['breakdown', st.template.code, l.code ?? `line-${index}`, from, to]
  const shownNote = l.signFlip
    ? 'Amounts are shown as the statement shows this line — flipped from their raw ledger sign — '
    : 'Amounts are shown as the statement shows this line — '

  if (l.lineType === 'detail') {
    const basis = l.valueBasis === 'period_movement'
      ? `each account's movement over the range`
      : `each account's balance at ${span.toPeriod.end_date}`
    return {
      entity, title: l.label, subtitle,
      note: `${shownNote}so the column adds to the figure on the statement. The figure is ${basis}.`,
      columns: [
        { label: 'Code', weight: 1 }, { label: 'Account', weight: 4 },
        { label: 'Amount', align: 'right', weight: 1.6 },
      ],
      rows: [
        ...(l.accounts ?? []).map((a) => ({
          cells: [t(a.code, true), t(a.name), m(flip * a.amount)],
          // A movement line's account opens over the same range; a POSITION
          // line's account opens with no `from` — since the start of the
          // books, opening at zero, so the whole figure is explained.
          href: breakdownHref(ledgerId, {
            kind: 'account', account: a.id,
            ...(l.valueBasis === 'period_movement' ? { from } : {}),
            to,
          }),
        })),
        { cells: [t(''), t(l.label), m(l.shown)], bold: true, rule: true },
      ],
      total: { label: l.label, amount: l.shown },
      slug,
    }
  }

  if (l.lineType === 'total') {
    const parsed = formulaTerms(l.formula ?? '')
    if ('error' in parsed) return null
    const rows: BreakdownRow[] = []
    for (const term of parsed.terms) {
      const siblingIndex = st.lines.findIndex((x) => x.code === term.code)
      const sibling = st.lines[siblingIndex]
      if (!sibling) return null
      rows.push({
        cells: [t(sibling.label), m(flip * term.sign * sibling.raw)],
        href: sibling.lineType === 'header' ? undefined
          : breakdownHref(ledgerId, {
              kind: 'statement-line', template: st.template.code,
              line: String(siblingIndex), from, to,
            }),
      })
    }
    rows.push({ cells: [t(l.label), m(l.shown)], bold: true, rule: true })
    return {
      entity, title: l.label, subtitle,
      note: `${shownNote}so the column adds to the figure on the statement. `
          + 'The rows are the statement lines this total adds and subtracts.',
      columns: [{ label: 'Line', weight: 4 }, { label: 'Amount', align: 'right', weight: 1.6 }],
      rows,
      total: { label: l.label, amount: l.shown },
      slug,
    }
  }

  // current_earnings: the year so far, account by account.
  //
  // This is the ONE query in this file that cannot reuse its report's reader:
  // the renderer keeps a single SUM (statements.ts, `earnings`), and grouping
  // it by account is necessarily a second statement of the same predicates —
  // ledger, posted, revenue+expense, the fiscal year up to the end period.
  // What holds the two spellings together is X25 (the grouped rows must re-add
  // to the renderer's own line) and mutation block 245 on the predicate below.
  const [year] = await db.execute<{ start_date: string }>(sql`
    SELECT fy.start_date::text
      FROM fiscal_period fp JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
     WHERE fp.id = ${span.toPeriod.id}::uuid`)
  if (!year) return null

  const perAccount = await db.execute<{ id: string; code: string; name: string; amount: string }>(sql`
    SELECT a.id::text, a.code, a.name, COALESCE(SUM(jl.amount), 0)::text AS amount
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
      JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted','reversed')
       AND a.account_type IN ('revenue','expense')
       AND fp.start_date >= ${year.start_date}::date
       AND fp.end_date   <= ${span.toPeriod.end_date}::date
     GROUP BY a.id, a.code, a.name
    HAVING COALESCE(SUM(jl.amount), 0) <> 0
     ORDER BY a.code`)

  return {
    entity, title: l.label, subtitle,
    note: `${shownNote}so the column adds to the figure on the statement. `
        + `Every revenue and expense account's movement from ${year.start_date} `
        + `to ${span.toPeriod.end_date} — the year so far, which is what this line is.`,
    columns: [
      { label: 'Code', weight: 1 }, { label: 'Account', weight: 4 },
      { label: 'Amount', align: 'right', weight: 1.6 },
    ],
    rows: [
      ...perAccount.map((a) => ({
        cells: [t(a.code, true), t(a.name), m(flip * BigInt(a.amount))],
        href: breakdownHref(ledgerId, {
          kind: 'account', account: a.id, from: year.start_date, to: span.toPeriod.end_date,
        }),
      })),
      { cells: [t(''), t(l.label), m(l.shown)], bold: true, rule: true },
    ],
    total: { label: l.label, amount: l.shown },
    slug,
  }
}

// ---------------------------------------------- a cash flow statement figure --

/**
 * One line of the Statement of Cash Flows.
 *
 * The cash flow statement is derived, not templated (src/lib/cash-flow.ts), so
 * there is no `formula` to re-tokenise the way a template total's breakdown
 * does. Each total instead records the indices of the lines it added AS IT WAS
 * BUILT (`sums`), and this reads that — the render's own arithmetic, not a
 * second statement of it.
 *
 * Signs need no flipping here: a cash flow line's `raw` IS its cash effect, an
 * inflow positive, which is exactly how the statement shows it.
 */
async function cashFlowLineBreakdown(
  ledgerId: string, entity: string, q: Record<string, string | undefined>,
): Promise<Breakdown | null> {
  const { line, from, to } = q
  if (!from || !DATE.test(from) || !to || !DATE.test(to)) return null
  if (!line || !/^\d+$/.test(line)) return null

  const span = await resolvePeriodSpan(ledgerId, from, to)
  if (!span) return null

  const cf = await renderCashFlow(ledgerId, span.toPeriod.id, span.fromPeriod.id)
  if (!cf) return null

  const index = Number(line)
  const l = cf.lines[index]
  if (!l || (l.lineType !== 'detail' && l.lineType !== 'total')) return null

  const subtitle = `Statement of Cash Flows · ${spanLabel(span.fromPeriod.name, span.toPeriod.name)}`
  const slug = ['breakdown', 'cash-flow', l.code ?? `line-${index}`, from, to]

  if (l.entries) return {
    entity,title:l.label,subtitle,
    note:'The exact journal contributions used by this statement, after the separately disclosed non-cash exclusions. The column adds to the reported figure.',
    columns:[{label:'Date',weight:1.4},{label:'Entry',weight:1.4},{label:'Description',weight:4},{label:'Amount',align:'right',weight:1.6}],
    rows:[...l.entries.map(e=>({cells:[t(e.date,true),t(e.entryNo,true),t(e.description),m(e.amount)],href:`/ledger/${ledgerId}/entries/${e.id}`})),
      {cells:[t(''),t(''),t(l.label),m(l.raw)],bold:true,rule:true}],
    total:{label:l.label,amount:l.raw},slug,
  }

  // A total: the lines it added, each opening one level deeper.
  if (l.lineType === 'total' && l.sums && l.sums.length > 0) {
    return {
      entity, title: l.label, subtitle,
      note: 'The lines of this statement that this total adds. Amounts are cash effects — an '
          + 'inflow positive — so the column adds to the figure on the statement.',
      columns: [{ label: 'Line', weight: 4 }, { label: 'Amount', align: 'right', weight: 1.6 }],
      rows: [
        ...l.sums.map((at) => ({
          cells: [t(cf.lines[at].label), m(cf.lines[at].raw)],
          href: breakdownHref(ledgerId, { kind: 'cash-flow-line', line: String(at), from, to }),
        })),
        { cells: [t(l.label), m(l.raw)], bold: true, rule: true },
      ],
      total: { label: l.label, amount: l.raw },
      slug,
    }
  }

  // A detail line, or a total with nothing recorded behind it (cash at end):
  // the accounts the renderer already carries.
  const accounts = l.accounts ?? []
  // WHICH FIGURE each account contributed decides where its own link goes.
  // Beginning and ending cash are POSITIONS — opened since the books began, so
  // the whole figure is explained; everything else is a movement over the span.
  const position = l.code === 'CF_BEGIN' || l.code === 'CF_END'
  // Beginning cash is the position BEFORE the span, so its accounts open to the
  // day the span starts rather than the day it ends.
  const asAt = l.code === 'CF_BEGIN' ? span.fromPeriod.start_date : to
  return {
    entity, title: l.label, subtitle,
    note: position
      ? `Each cash account's balance at ${asAt}. The column adds to the figure on the statement.`
      : 'Each account\u2019s movement over the range with its sign turned round — the indirect '
        + 'method — so the column adds to the figure on the statement.',
    columns: [
      { label: 'Code', weight: 1 }, { label: 'Account', weight: 4 },
      { label: 'Amount', align: 'right', weight: 1.6 },
    ],
    rows: [
      ...accounts.map((a) => ({
        cells: [t(a.code, true), t(a.name), m(a.amount)],
        href: breakdownHref(ledgerId, {
          kind: 'account', account: a.id, ...(position ? {} : { from }), to: asAt,
        }),
      })),
      { cells: [t(''), t(l.label), m(l.raw)], bold: true, rule: true },
    ],
    total: { label: l.label, amount: l.raw },
    slug,
  }
}

// ------------------------------------------ a statement of changes in equity --

/**
 * One CELL of the equity matrix: a row (why equity moved) and a column (which
 * component it moved in).
 *
 * Addressed by the row's own `code` rather than by its index, because rows
 * worth nothing are left out of the render — so an index would name a
 * different row for a different span, and a bookmarked breakdown would quietly
 * answer about something else.
 *
 * Figures are shown the way equity is read, a credit positive, which is the
 * `shown` side of both the cell and its accounts.
 */
async function equityCellBreakdown(
  ledgerId: string, entity: string, q: Record<string, string | undefined>,
): Promise<Breakdown | null> {
  const { row: rowCode, col, from, to } = q
  if (!from || !DATE.test(from) || !to || !DATE.test(to)) return null
  if (!rowCode || !col || !/^\d+$/.test(col)) return null

  const span = await resolvePeriodSpan(ledgerId, from, to)
  if (!span) return null

  const eq = await renderEquityChanges(ledgerId, span.toPeriod.id, span.fromPeriod.id)
  if (!eq) return null

  const r = eq.rows.find((x) => x.code === rowCode)
  if (!r) return null
  const c = Number(col)
  if (c < 0 || c >= r.shown.length) return null

  // The last column is the Total, which has no EquityColumn of its own.
  const columnLabel = c < eq.columns.length ? eq.columns[c].label : 'Total'
  const accounts = r.accounts[c] ?? []

  // Opening is a position BEFORE the span; closing a position at its end;
  // everything between is a movement over it. That decides both the sentence
  // and where each account's own link goes.
  const position = r.lineType !== 'movement'
  const asAt = r.lineType === 'opening' ? span.fromPeriod.start_date : to

  return {
    entity,
    title: `${r.label} · ${columnLabel}`,
    subtitle: `Statement of Changes in Equity · ${spanLabel(span.fromPeriod.name, span.toPeriod.name)}`,
    note: (position
      ? `Each account's balance at ${asAt}. `
      : 'Each account\u2019s movement over the range. ')
      + 'Shown the way equity is read — a credit positive — so the column adds to the figure on '
      + 'the statement.',
    columns: [
      { label: 'Code', weight: 1 }, { label: 'Account', weight: 4 },
      { label: 'Amount', align: 'right', weight: 1.6 },
    ],
    rows: [
      ...accounts.map((a) => ({
        cells: [t(a.code, true), t(a.name), m(-a.amount)],
        href: breakdownHref(ledgerId, {
          kind: 'account', account: a.id, ...(position ? {} : { from }), to: asAt,
        }),
      })),
      { cells: [t(''), t(`${r.label} · ${columnLabel}`), m(r.shown[c])], bold: true, rule: true },
    ],
    total: { label: `${r.label} · ${columnLabel}`, amount: r.shown[c] },
    slug: ['breakdown', 'equity', rowCode.toLowerCase(), String(c), from, to],
  }
}

// ------------------------------------------------------- an aging figure --

/**
 * The open items behind one aging cell: a party and a bucket, a party's total
 * (no bucket), a bucket's column (no party), the whole side (neither) — or
 * `party=none`, the figure owed by nobody, which the matrix cannot show at all.
 *
 * Rows come from `openControlEntries`, the same CTEs the matrix sums; the
 * bucket is assigned here by `bucketOf(ageOf(...))`, the list the screen's
 * headings come from, while the matrix buckets in SQL. Agreeing is therefore a
 * real cross-check of the boundaries, and the export suite asserts it cell by
 * cell.
 */
async function agingBreakdown(
  ledgerId: string, entity: string, q: Record<string, string | undefined>,
): Promise<Breakdown | null> {
  const { role, asOf, party, bucket } = q
  if (role !== 'trade_receivables' && role !== 'trade_payables') return null
  if (!asOf || !DATE.test(asOf)) return null
  if (bucket !== undefined && !(Number(bucket) >= 0 && Number(bucket) < BUCKETS.length)) return null

  const side = role === 'trade_receivables' ? 'Owed to us' : 'Owed by us'

  if (party === 'none') {
    // Movement on the control accounts with no party named — the join the
    // matrix is built on discards these, which is why they get their own door.
    const rows = await db.execute<{
      entry_id: string; entry_no: string; entry_date: string
      description: string; amount: string
    }>(sql`
      SELECT je.id::text AS entry_id, je.entry_no, je.entry_date::text, je.description,
             SUM(jl.amount)::text AS amount
        FROM journal_line jl
        JOIN journal_entry je ON je.id = jl.entry_id
        JOIN account a ON a.id = jl.account_id
        JOIN account_role ar ON ar.account_id = a.id AND ar.role = ${role}
       WHERE je.ledger_id = ${ledgerId}::uuid
         AND je.status IN ('posted','reversed')
         AND je.entry_date <= ${asOf}::date
         AND jl.party_id IS NULL
       GROUP BY je.id
      HAVING SUM(jl.amount) <> 0
       ORDER BY je.entry_date, je.entry_no`)

    const total = rows.reduce((s, r) => s + BigInt(r.amount), 0n)
    return {
      entity, title: 'Owed by nobody', subtitle: `${side} · as at ${asOf}`,
      note: 'Movement on the control accounts with no party named on the line. It is in no '
          + 'row of the aging table, because the table is grouped by party — put a party on '
          + 'these entries and it will be.',
      columns: [
        { label: 'Date', weight: 1.4 }, { label: 'Entry', weight: 1.4 },
        { label: 'Description', weight: 4 }, { label: 'Amount', align: 'right', weight: 1.6 },
      ],
      rows: [
        ...rows.map((r) => ({
          cells: [t(r.entry_date, true), t(r.entry_no, true), t(r.description), m(BigInt(r.amount))],
          href: `/ledger/${ledgerId}/entries/${r.entry_id}`,
        })),
        { cells: [t(''), t(''), t('Total'), m(total)], bold: true, rule: true },
      ],
      total: { label: 'Owed by nobody', amount: total },
      slug: ['breakdown', 'aging', role, 'unattributed', asOf],
    }
  }

  if (party !== undefined && !UUID.test(party)) return null

  const [who] = party
    ? await db.execute<{ name: string }>(sql`SELECT name FROM party WHERE id = ${party}::uuid`)
    : [{ name: 'All parties' }]
  if (!who) return null

  const bucketIndex = bucket === undefined ? null : Number(bucket)
  const all = await openControlEntries(ledgerId, role, asOf)
  const wanted = all.filter((e) =>
    (party === undefined || e.party_id === party) &&
    (bucketIndex === null || bucketOf(ageOf(e.entry_date, asOf)) === bucketIndex))

  const total = wanted.reduce((s, e) => s + BigInt(e.open_amount), 0n)
  return {
    entity,
    title: bucketIndex === null ? who.name : `${who.name} · ${BUCKETS[bucketIndex].label}`,
    subtitle: `${side} · as at ${asOf}`,
    note: 'Open items: each document’s movement on the control account, less what has been '
        + 'applied against it by that date, aged from the original entry date.',
    columns: [
      { label: 'Date', weight: 1.4 }, { label: 'Document', weight: 1.6 },
      { label: 'Description', weight: 3.4 }, { label: 'Due', weight: 1.4 },
      { label: 'Age', align: 'right', weight: 0.8 },
      { label: 'Open', align: 'right', weight: 1.6 },
    ],
    rows: [
      ...wanted.map((e) => ({
        cells: [
          t(e.entry_date, true), t(e.number ?? e.entry_no, true),
          t(e.description ?? ''), t(e.due_on ?? '', true),
          t(`${ageOf(e.entry_date, asOf)}d`, true),
          m(BigInt(e.open_amount)),
        ],
        href: e.invoice_id
          ? invoiceHref(ledgerId, role === 'trade_payables' ? 'purchase' : 'sales', e.invoice_id)
          : `/ledger/${ledgerId}/entries/${e.entry_id}`,
      })),
      { cells: [t(''), t(''), t('Total'), t(''), t(''), m(total)], bold: true, rule: true },
    ],
    total: { label: 'Total', amount: total },
    slug: ['breakdown', 'aging', role, party ?? 'all',
           bucketIndex === null ? 'all' : BUCKETS[bucketIndex].label, asOf],
  }
}

// -------------------------------------------------- a GST/HST line figure --

/** The entries behind one line of the return — the trace the screen already
 *  shows inline, as its own addressable, exportable page. */
async function taxBreakdown(
  ledgerId: string, entity: string, q: Record<string, string | undefined>,
): Promise<Breakdown | null> {
  const { line, from, to } = q
  if (!from || !DATE.test(from) || !to || !DATE.test(to)) return null

  // Which return: the PST worksheet links here too (2026-09-04), and its
  // boxes are letters. The first version answered "nothing to break down" to
  // every figure on that page.
  const isPst = q.tax === 'pst'
  const ret = isPst ? await pstReturn(ledgerId, from, to) : await gstHstReturn(ledgerId, from, to)
  if (!ret) return null

  // By line, entries or none: a line that is zero this quarter still opens
  // into an explained zero (X28). Only the DERIVED lines have no breakdown —
  // net, and PST's commission — because there are no entries behind them.
  const derived = new Set([ret.lines.net, ...(isPst ? [(ret as PstReturn).lines.commission] : [])])
  const tax = Object.values(ret.lines).find((l) => l.line === line && !derived.has(l)) ?? null
  if (!tax) return null

  return {
    entity,
    title: `${isPst ? 'Box' : 'Line'} ${tax.line} — ${tax.label}`,
    subtitle: `${isPst ? 'PST' : 'GST/HST'} return · ${from} to ${to}`,
    note: 'Each entry’s contribution in the direction the return reads: a reversal on a '
        + 'tax account reduces the line, so the column adds to the figure on the return.',
    columns: [
      { label: 'Date', weight: 1.4 }, { label: 'Entry', weight: 1.4 },
      { label: 'Description', weight: 3.6 }, { label: 'Account', weight: 1.2 },
      { label: 'Amount', align: 'right', weight: 1.6 },
    ],
    rows: [
      ...tax.entries.map((e) => ({
        cells: [t(e.entryDate, true), t(e.entryNo, true), t(e.description),
                t(e.accountCode, true), m(e.contribution)],
        href: e.entryId ? `/ledger/${ledgerId}/entries/${e.entryId}` : undefined,
      })),
      ...(tax.adjustment === undefined ? [] : [{
        cells: [t(''), t(''), t(`Manual adjustment — ${tax.adjustmentReason}`), t(''), m(tax.adjustment)],
      }]),
      { cells: [t(''), t(''), t(tax.label), t(''), m(tax.amount)], bold: true, rule: true },
    ],
    total: { label: tax.label, amount: tax.amount },
    slug: ['breakdown', isPst ? 'pst' : 'gst-hst', `line-${tax.line}`, from, to],
  }
}

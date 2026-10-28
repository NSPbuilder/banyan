'use client'


import { formatNumber } from '@/lib/numbers'
import { useState, type ReactNode } from 'react'
import { DataTable, TableViewport } from './Table'
import { FilterBar } from './FormLayout'
import { Icon } from './Icon'
import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { FIELD, LABEL, GHOST } from '@/lib/ui'

/**
 * The ONE by-party browse renderer (owner-picked shape, 2026-09-03): a party
 * search box, then a section per party with a subtotal and its rows. Rows
 * whose entry names nobody gather under "(no party)", last — money with no
 * counterparty is still money.
 *
 * Grouping and the search live HERE, on data the server derived: the search
 * narrows parties, never re-queries, so what you see is always a subset of
 * one consistent read.
 *
 * ONE TABLE for the whole page, not one per party. The first version gave
 * every party its own <DataTable density="reading">, so every party's columns were measured against
 * that party's own text and no two lines of dates or entry numbers stood in
 * the same place (owner, 2026-09-03: "不同的parties的日期/journal#没对齐").
 * Column widths are a property of the COLUMN — declared once in `columns`,
 * carried by the header cells, and therefore identical in every group by
 * construction rather than by luck. A per-cell width would be the same bug
 * with more places to forget it.
 *
 * The invoice list eats this too, which is the other half of the fix: it used
 * to carry a second, near-identical grouping renderer of its own, and the two
 * drifted exactly as far apart as their two authors' afternoons.
 */

/** A column: what it is called and how wide it stands, everywhere. */
export type GroupColumn = {
  label: string
  /** Tailwind width for the header cell; the column inherits it. */
  width?: string
  mono?: boolean
  faint?: boolean
  sortable?: boolean
  nowrap?: boolean
}

/**
 * A cell is text, or text with a STATE. The tone vocabulary is closed and
 * rendered here — a caller says "this row is void", not "this row is grey and
 * struck through", so the look of a state is decided in one place.
 */
export type Cell = string | { text: string; tone: 'ok' | 'muted' | 'struck' } | { text: string; href: string }

const TONE: Record<'ok' | 'muted' | 'struck', string> = {
  ok: 'text-success-ink',
  muted: 'text-ink-secondary',
  struck: 'text-ink-muted line-through',
}

export type GroupRow = {
  key: string
  href: string
  /** Used when parties occupy a column instead of separate group headings. */
  partyName?: string | null
  /** One per column, in the column order. The first is the link. */
  cells: Cell[]
  /** Compact reference, kind, state and secondary actions below the description. */
  metadata?: Cell[]
  /**
   * Signed cents, or null for a row that is not about this figure at all —
   * a payment is money moving, not money earned or spent, and putting it in
   * the same column as the expense it settles is how a $1,000 bill and its
   * $1,000 payment become $2,000 of nothing (owner, 2026-09-03).
   */
  amount: string | null
  /** Show the amount on historical paper without counting it as money. */
  excludeFromTotal?: boolean
  /**
   * The SECOND money column, when the page has one: what is still owed on
   * this row. A different question from the first, so it gets its own column
   * and its own subtotal rather than being folded into one number that
   * answers neither.
   */
  second?: string | null
}

export type PartyRow = { partyId: string | null; partyName: string | null; row: GroupRow }

/** A titled block of rows: one for a browse page, two for the invoice list. */
export type GroupSection = { title: string; rows: PartyRow[] }

export function PartyGroups({
  sections, columns, searchLabel, flipSign, moneyLabel = 'Amount', moneyTitle, secondLabel,
  filter, filters, sortableAmounts = false, toolbar, emptyState, partyColumn = false,
}: {
  sections: GroupSection[]
  /** A compact register with a party cell on every row and no group headings. */
  partyColumn?: boolean
  filters?: ReactNode
  /** A caller that queries on the server supplies its complete filter form. */
  toolbar?: ReactNode
  emptyState?: ReactNode
  sortableAmounts?: boolean
  columns: GroupColumn[]
  searchLabel?: string
  /** Show credits positive (income reads better that way). */
  flipSign?: boolean
  /** What the first money column is called. */
  moneyLabel?: string
  /** Clarifies the accounting basis without lengthening the column heading. */
  moneyTitle?: string
  /** When given, rows carry a second money column under this heading. */
  secondLabel?: string
  /** An extra narrowing, offered beside the search box. */
  filter?: { label: string; value: string; options: string[]; onChange: (v: string) => void }
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: number | 'amount' | 'second'; direction: 'ascending' | 'descending' } | null>(null)
  const toggleSort = (key: number | 'amount' | 'second') => setSort((prev) => ({ key, direction: prev?.key === key && prev.direction === 'descending' ? 'ascending' : 'descending' }))
  const sortControl = (key: number | 'amount' | 'second', label: string) => <button type="button" aria-label={`Sort by ${label}`} title={`Sort by ${label}`}
    className="inline-flex items-center gap-1 rounded-control hover:text-ink" onClick={() => toggleSort(key)}>{label}{sort?.key === key && <Icon name="chevron-down" className={sort.direction === 'ascending' ? 'rotate-180' : ''} />}</button>
  const sortedRows = (rows: GroupRow[]) => !sort ? rows : [...rows].sort((a, b) => {
    let compared = 0
    if (typeof sort.key === 'number') {
      const text = (r: GroupRow) => { const c = r.cells[sort.key as number]; return typeof c === 'string' ? c : c?.text ?? '' }
      compared = text(a).localeCompare(text(b))
    } else {
      const av = sort.key === 'amount' ? a.amount : a.second
      const bv = sort.key === 'amount' ? b.amount : b.second
      if (av == null || bv == null) return av == null && bv == null ? 0 : av == null ? 1 : -1
      const factor = sort.key === 'amount' && flipSign ? -1n : 1n
      const x = BigInt(av) * factor, y = BigInt(bv) * factor
      compared = x < y ? -1 : x > y ? 1 : 0
    }
    return sort.direction === 'ascending' ? compared : -compared
  })
  const q = query.trim().toLowerCase()
  const shown = (v: bigint) => formatMoney(flipSign ? -v : v, { sign: 'accounting' })
  // The second column is what is OWED, which has no direction to flip: an
  // unspent credit note is already negative in it. Only the first column takes
  // the income page's sign.
  const owed = (v: bigint) => formatMoney(v, { sign: 'accounting' })

  const grouped = sections.map((section) => {
    const groups = new Map<string, {
      name: string | null; rows: GroupRow[]; total: bigint; second: bigint
    }>()
    for (const r of section.rows) {
      const key = r.partyId ?? '(none)'
      const g = groups.get(key) ?? { name: r.partyName, rows: [], total: 0n, second: 0n }
      g.rows.push(r.row)
      // A null is a row this column is not about — a payment, a draft, a
      // debt carried in from another range. Voided documents retain their
      // historical amount on the row but are excluded from amount subtotals.
      if (r.row.amount !== null && !r.row.excludeFromTotal) g.total += BigInt(r.row.amount)
      if (r.row.second != null) g.second += BigInt(r.row.second)
      groups.set(key, g)
    }
    const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => {
      if (ka === '(none)') return 1
      if (kb === '(none)') return -1
      return (a.name ?? '').localeCompare(b.name ?? '')
    }).filter(([, g]) => !q || (g.name ?? 'no party').toLowerCase().includes(q))
    return {
      title: section.title,
      ordered,
      total: ordered.reduce((s, [, g]) => s + g.total, 0n),
      second: ordered.reduce((s, [, g]) => s + g.second, 0n),
    }
  }).filter((s) => s.ordered.length > 0)

  const parties = new Set(grouped.flatMap((s) => s.ordered.map(([k]) => k))).size

  return (
    <>
      {toolbar ?? <FilterBar actions={<span className="text-metadata text-ink-muted">{formatNumber(parties)} {parties === 1 ? 'party' : 'parties'}</span>}>
        {filters}
        {searchLabel && <label className={`min-w-0 grow ${LABEL}`}>
          <span className="block">{searchLabel}</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                 className={`mt-1 w-full max-w-sm ${FIELD}`} />
        </label>}
        {filter && (
          <label className={LABEL}>
            <span className="block">{filter.label}</span>
            <select value={filter.value} onChange={(e) => filter.onChange(e.target.value)}
                    className={`mt-1 ${FIELD}`}>
              {filter.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        )}
      </FilterBar>}

      {grouped.length === 0 && (
        <div className="py-5 text-label text-ink-muted" role={emptyState ? undefined : 'status'}>
          {emptyState ?? <p>{q ? `No parties match “${query}”.` : filter && filter.value !== filter.options[0] ? 'No records match this kind.' : 'No records in this range.'}</p>}
          {(q || filter && filter.value !== filter.options[0]) && <button type="button" className={`mt-2 ${GHOST}`}
            onClick={() => { setQuery(''); if (filter) filter.onChange(filter.options[0]) }}>Clear filters</button>}
        </div>
      )}

      {grouped.length > 0 && (
        <TableViewport label="Records by party">
        <DataTable density="reading" className={`party-register ${partyColumn ? 'min-w-[48rem]' : 'min-w-[36rem]'}`}>
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              {partyColumn && <th className="w-48 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">Party</th>}
              {columns.map((c, i) => (
                <th key={i} aria-sort={sort?.key === i ? sort.direction : undefined}
                    className={`pb-1 text-xs font-medium uppercase tracking-wide text-neutral-500 ${c.width ?? ''} ${i > 0 || partyColumn ? 'pl-3' : ''}`}>
                  {c.sortable ? sortControl(i, c.label) : c.label}
                </th>
              ))}
              <th title={moneyTitle} aria-sort={sort?.key === 'amount' ? sort.direction : undefined} className="w-32 pb-1 pl-3 text-right text-xs font-medium uppercase tracking-wide text-neutral-500">
                {sortableAmounts ? sortControl('amount', moneyLabel) : moneyLabel}
              </th>
              {secondLabel && (
                <th aria-sort={sort?.key === 'second' ? sort.direction : undefined} className="w-32 pb-1 pl-3 text-right text-xs font-medium uppercase tracking-wide text-neutral-500">
                  {sortableAmounts ? sortControl('second', secondLabel) : secondLabel}
                </th>
              )}
            </tr>
          </thead>

          {grouped.map((section) => (
            <tbody key={section.title}>
              <tr className="register-section">
                <th colSpan={columns.length + (partyColumn ? 1 : 0)}
                    className="pt-6 text-left text-xs font-medium uppercase tracking-wide text-neutral-500">
                  {section.title}
                </th>
                <td className="pt-6 pl-3 text-right font-mono text-xs tabular-nums text-neutral-500">
                  {shown(section.total)}
                </td>
                {secondLabel && (
                  <td className="pt-6 pl-3 text-right font-mono text-xs tabular-nums text-neutral-500">
                    {owed(section.second)}
                  </td>
                )}
              </tr>
              {partyColumn ? <Group name={null}
                rows={sortedRows(section.ordered.flatMap(([, g]) => g.rows.map(row => ({ ...row, partyName: g.name }))))}
                total={section.total} second={secondLabel ? section.second : null}
                columns={columns} shown={shown} owed={owed} partyColumn /> : section.ordered.map(([key, g]) => (
                <Group key={key} name={g.name} rows={sortedRows(g.rows)} total={g.total}
                       second={secondLabel ? g.second : null}
                       columns={columns} shown={shown} owed={owed} />
              ))}
            </tbody>
          ))}
        </DataTable>
        </TableViewport>
      )}
    </>
  )
}

function Group({ name, rows, total, second, columns, shown, owed, partyColumn = false }: {
  name: string | null
  rows: GroupRow[]
  total: bigint
  /** null when the page has no second money column. */
  second: bigint | null
  columns: GroupColumn[]
  shown: (v: bigint) => string
  owed: (v: bigint) => string
  partyColumn?: boolean
}) {
  return (
    <>
      {!partyColumn && <tr className="register-group border-b border-neutral-300 dark:border-neutral-700">
        <th colSpan={columns.length} className="pt-4 text-left text-sm font-medium">
          {name ?? '(no party)'}
        </th>
        <td className="pt-4 pl-3 text-right font-mono text-sm tabular-nums">{shown(total)}</td>
        {second !== null && (
          <td className="pt-4 pl-3 text-right font-mono text-sm tabular-nums">{owed(second)}</td>
        )}
      </tr>}
      {/* `data-row` marks the register's own rows, so a check can find them
          without guessing: selecting "rows that contain a link" missed a row
          whose first cell rendered a state badge instead, and a row that
          drops out of the count cannot be found ragged (critic, 2026-09-03). */}
      {rows.map((r) => (
        <tr key={r.key} data-row className="border-b border-neutral-100 dark:border-neutral-900">
          {partyColumn && <td className="py-1.5 align-top text-ink-secondary">{r.partyName ?? '(no party)'}</td>}
          {columns.map((c, i) => {
            const cell = r.cells[i]
            const text = typeof cell === 'string' ? cell : cell?.text ?? ''
            const tone = typeof cell === 'object' && 'tone' in cell ? cell.tone : undefined
            const href = typeof cell === 'object' && 'href' in cell ? cell.href : undefined
            return (
              <td key={i}
                  className={`py-1.5 align-top ${i > 0 || partyColumn ? 'pl-3' : ''} ${c.mono ? 'font-mono text-xs' : ''} ${c.faint ? 'text-ink-muted' : ''} ${c.nowrap ? 'whitespace-nowrap' : ''}`}>
                {tone
                  ? <span className={`text-metadata ${TONE[tone]}`}>{text}</span>
                  : href
                    ? <Link href={href} className="font-medium underline underline-offset-2">{text}</Link>
                  : i === 0
                    ? <Link href={r.href} className="hover:underline">{text}</Link>
                    : text}
                {i === 0 && r.metadata && <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-metadata text-ink-muted">
                  {r.metadata.filter((m) => typeof m === 'string' ? !!m : !!m.text).map((m, j) =>
                    typeof m === 'string' ? <span key={j}>{m}</span>
                    : 'href' in m ? <Link key={j} href={m.href} className="underline underline-offset-2">{m.text}</Link>
                    : <span key={j} className={TONE[m.tone]}>{m.text}</span>)}
                </div>}
              </td>
            )
          })}
          <td className="py-1.5 pl-3 text-right align-top font-mono tabular-nums">
            {r.amount === null ? '' : shown(BigInt(r.amount))}
          </td>
          {second !== null && (
            <td className="py-1.5 pl-3 text-right align-top font-mono tabular-nums">
              {r.second == null ? '' : owed(BigInt(r.second))}
            </td>
          )}
        </tr>
      ))}
    </>
  )
}

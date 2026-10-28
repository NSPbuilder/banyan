import { PageHeader } from '@/components/PageHeader'
import { ModuleTabs } from '@/components/ModuleTabs'
import { FilterBar } from '@/components/FormLayout'
import { LinkFilter } from '@/components/LinkFilter'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { availableStatements } from '@/lib/statements'
import { DERIVED_STATEMENTS, isDerived } from '@/lib/derived-statements'
import { Derived } from './Derived'
import { COMPARE_LABEL, renderComparative, type CompareMode } from '@/lib/compare'
import { GROUPING_LABEL, renderColumned, type Grouping } from '@/lib/columns'
import { firstBookDay, resolvePeriodSpan } from '@/lib/balances'
import { rangePresets, spanLabel } from '@/lib/date-range'
import { localToday } from '@/lib/today'
import { formatMoney } from '@/lib/money'
import { accountReference } from '@/lib/account-reference'
import { Exports } from '@/components/Exports'
import { RangePicker } from '@/components/RangePicker'
import { tableIndent } from '@/lib/ui'

export const dynamic = 'force-dynamic'

export default async function Statements({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ template?: string; from?: string; to?: string; compare?: string; by?: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const wanted = await searchParams

  const [head] = await db.execute<{ entity: string; standard: string }>(sql`
    SELECT e.name AS entity, l.accounting_standard AS standard
      FROM ledger l JOIN entity e ON e.id = l.entity_id WHERE l.id = ${ledgerId}::uuid`)
  if (!head) notFound()
  const allFrom = await firstBookDay(ledgerId)

  // The templates, then the two statements that are not templates.
  const templates = [...(await availableStatements(head.standard)), ...DERIVED_STATEMENTS]

  const today = localToday()
  let { from, to } = wanted
  if (!from || !to) {
    // Default to the last month with anything in it — an empty statement tells
    // the reader nothing about whether it works.
    const [busiest] = await db.execute<{ start_date: string; end_date: string }>(sql`
      SELECT fp.start_date::text, fp.end_date::text
        FROM journal_entry je JOIN fiscal_period fp ON fp.id = je.period_id
       WHERE je.ledger_id = ${ledgerId}::uuid AND je.status IN ('posted','reversed')
       ORDER BY fp.start_date DESC LIMIT 1`)
    const thisMonth = rangePresets(today)[0]
    from = busiest?.start_date ?? thisMonth.from
    to = busiest?.end_date ?? thisMonth.to
  }

  const span = await resolvePeriodSpan(ledgerId, from, to)
  const spanName = span === null ? null : spanLabel(span.fromPeriod.name, span.toPeriod.name)

  const templateCode = wanted.template ?? templates[0]?.code
  // ONE OR THE OTHER, never both. Each puts columns beside the figure and two
  // sets of them at once is a table nobody can read; the breakdown wins because
  // it is the one just asked for, and choosing it clears the comparison in the
  // links below rather than leaving a control that silently does nothing.
  const by: Grouping | null = wanted.by === 'month' || wanted.by === 'quarter' ? wanted.by : null
  const compare: CompareMode | null = by ? null
    : wanted.compare === 'year' || wanted.compare === 'prior' ? wanted.compare : null
  const derived = isDerived(templateCode)
  const comparative = templateCode && span && !derived && !by
    ? await renderComparative(ledgerId, templateCode, span, compare)
    : null
  const columned = templateCode && span && !derived && by
    ? await renderColumned(ledgerId, templateCode, span, by)
    : null
  const statement = comparative?.current ?? columned?.whole ?? null
  const withCompare = comparative?.compare !== null && comparative?.compare !== undefined
  const compareName = comparative?.compareSpan
    ? spanLabel(comparative.compareSpan.fromPeriod.name, comparative.compareSpan.toPeriod.name)
    : null
  const q = (extra: string) => `/ledger/${ledgerId}/statements?template=${templateCode}&from=${from}&to=${to}${extra}`

  /**
   * ONE TABLE FOR BOTH. The comparison and the breakdown differ only in what
   * their columns are called and how many there are, so they are flattened to
   * the same shape here rather than each growing its own table — two tables is
   * two places for the zero-suppression rule and the drill link to drift.
   */
  const heads: string[] = columned && columned.columns.length > 0
    ? [...columned.columns.map((c) => c.label), columned.totalLabel]
    : withCompare ? [spanName ?? '', compareName ?? '', 'Change'] : []
  const rows = columned
    ? columned.lines.map((l) => ({ ...l, cells: [...l.amounts, l.total] as Array<bigint | null> }))
    : (comparative?.lines ?? []).map((l) => ({
        ...l,
        cells: (withCompare
          ? [l.current, l.compare ?? 0n, l.change]
          : [l.current]) as Array<bigint | null>,
      }))
  /** Whether a header row is wanted: the single-column view never had one. */
  const wide = heads.length > 0
  /**
   * Whether the breakdown's columns are actually on the page. Asking for `by`
   * on a span that refuses it (one fiscal month) gives the plain single column
   * with the reason beside the control — and that column must look and act
   * like the plain one: its figure opens the breakdown, nothing is set bold.
   * Keyed on this, never on `by` (independent critic, round 1).
   */
  const inColumns = !!columned && columned.columns.length > 0

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title="Statements" />

      <ModuleTabs label="Statement types" className="mt-4" items={templates.map((t) => ({
        href: `/ledger/${ledgerId}/statements?template=${t.code}&from=${from}&to=${to}${compare ? `&compare=${compare}` : ''}${by ? `&by=${by}` : ''}`,
        label: t.name, selected: t.code === templateCode,
      }))} />
      <FilterBar>
        <RangePicker from={from} to={to} today={today} allFrom={allFrom ?? undefined} />
        {!derived && <>
          <LinkFilter label="Compare" value={compare ?? ''} options={[
            { value: '', label: 'None', href: q('') },
            { value: 'year', label: COMPARE_LABEL.year, href: q('&compare=year') },
            { value: 'prior', label: COMPARE_LABEL.prior, href: q('&compare=prior') },
          ]} />
          <LinkFilter label="Columns" value={by ?? ''} options={[
            { value: '', label: 'One', href: q('') },
            { value: 'month', label: GROUPING_LABEL.month, href: q('&by=month') },
            { value: 'quarter', label: GROUPING_LABEL.quarter, href: q('&by=quarter') },
          ]} />
        </>}
      </FilterBar>
      {comparative?.reason && <p className="text-metadata text-amber-700 dark:text-amber-400">{comparative.reason}</p>}
      {columned?.reason && <p className="text-metadata text-amber-700 dark:text-amber-400">{columned.reason}</p>}
      {columned && columned.columns.length > 0 && !columned.totalIsSum && <p className="text-metadata text-ink-muted">Balances at column dates</p>}
      {span?.snapped && (
        <p className="mt-2 text-xs text-neutral-500">
          Fiscal months: {span.fromPeriod.start_date} to {span.toPeriod.end_date}.
        </p>
      )}

      {derived && span && spanName ? (
        <Derived ledgerId={ledgerId} code={templateCode} entity={head.entity} spanName={spanName}
                 fromPeriodId={span.fromPeriod.id} toPeriodId={span.toPeriod.id} from={from} to={to} />
      ) : !statement || !span ? (
        <p className="mt-10 text-sm text-neutral-500">
          {span === null
            ? `No fiscal months cover ${from} to ${to}, so there is nothing to report on.`
            : templateCode && !templates.some((t) => t.code === templateCode)
              ? `There is no statement called ${templateCode} here.`
              : 'No fiscal periods yet, so there is nothing to report on.'}
        </p>
      ) : (
        <>
          <Exports href={`/ledger/${ledgerId}/statements/pdf?template=${templateCode}&from=${from}&to=${to}${withCompare ? `&compare=${compare}` : ''}${by ? `&by=${by}` : ''}`}
                   csv={`/ledger/${ledgerId}/export?what=statement&template=${templateCode}&period=${span.toPeriod.id}&fromPeriod=${span.fromPeriod.id}`} />

          <header className="mt-6 text-center">
            <h2 className="text-lg font-medium">{head.entity}</h2>
            <p className="text-sm">{statement.template.name}</p>
            <p className="text-sm text-neutral-500">
              {statement.template.statementType === 'balance_sheet'
                ? `As at ${statement.period.endDate}`
                : `For ${spanName}`}
              {' · '}{statement.template.standard}{' · CAD'}
            </p>
          </header>

          {statement.problems.length > 0 && (
            <div className="mt-6 rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
              <p className="font-medium text-amber-900 dark:text-amber-200">
                This statement is not complete.
              </p>
              <ul className="mt-2 space-y-1 text-amber-800 dark:text-amber-300">
                {statement.problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>

            </div>
          )}

          <div className={wide ? 'mt-8 overflow-x-auto' : 'mt-8'}>
          <table data-report-layout={wide ? 'wide' : 'single'}
                 className={`${wide ? 'w-full min-w-[48rem]' : 'mx-auto w-full max-w-2xl'} text-sm`}>
            {wide && (
              <thead>
                <tr className="border-b border-neutral-300 text-right text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                  <th className="py-2 text-left font-medium" />
                  {heads.map((h, i) => (
                    <th key={i}
                        className={`py-2 pl-4 font-medium ${
                          inColumns && i === heads.length - 1 ? 'text-neutral-900 dark:text-white' : ''}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.map((l, i) => {
                const cols = 1 + (heads.length || 1)
                if (l.lineType === 'spacer') return <tr key={i}><td className="py-2" colSpan={cols} /></tr>
                if (l.lineType === 'header') {
                  return (
                    <tr key={i}>
                      <td className="pt-5 pb-1 font-medium" colSpan={cols}
                          style={tableIndent(l.indent, 1.25)}>
                        {l.label}
                      </td>
                    </tr>
                  )
                }
                // A detail line worth nothing in either span is noise on a
                // printed statement; totals always show, even at zero.
                if (l.lineType === 'detail' && l.cells.every((c) => (c ?? 0n) === 0n)) return null

                const isTotal = l.lineType === 'total'
                // Every figure opens its breakdown: the accounts that fed a
                // detail line, the lines a total added, the year-so-far
                // accounts behind current earnings. Addressed by line index —
                // the same render this page just did resolves it.
                const drill = `/ledger/${ledgerId}/breakdown?kind=statement-line&template=${templateCode}&line=${i}&from=${from}&to=${to}`
                const cell = `py-1 pl-4 text-right tabular-nums ${isTotal ? 'font-medium' : ''}`
                return (
                  <tr key={i} className={isTotal ? 'border-t border-neutral-300 dark:border-neutral-700' : ''}>
                    <td className={`py-1 ${isTotal ? 'font-medium' : ''}`}
                        style={tableIndent(l.indent, 1.25)}>
                      {l.label}
                      {accountReference(l.accounts) && (
                        <span className="ml-2 font-mono text-xs text-neutral-500">
                          {accountReference(l.accounts)}
                        </span>
                      )}
                    </td>
                    {l.cells.map((c, j) => {
                      // The FIRST figure opens the breakdown, and only when it
                      // is this span's own: the drill resolves a line of THIS
                      // span's render, and a month's column is a different
                      // render with its own dates.
                      const last = j === l.cells.length - 1
                      const strong = inColumns && last ? 'font-medium' : ''
                      const faint = !inColumns && j === 2 ? 'text-neutral-600 dark:text-neutral-400' : ''
                      return (
                        <td key={j} className={`${cell} ${strong} ${faint}`}>
                          {c === null ? '' : j === 0 && !inColumns
                            ? <Link href={drill} className="hover:underline">
                                {formatMoney(c, { sign: 'accounting' })}
                              </Link>
                            : formatMoney(c, { sign: 'accounting' })}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>

          <p className="mt-4 text-xs text-neutral-500">Posted entries · Zero rows excluded</p>
        </>
      )}
    </main>
  )
}

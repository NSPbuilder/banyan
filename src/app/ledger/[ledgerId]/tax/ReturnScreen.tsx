
import { DataTable } from '@/components/Table'
import { PageHeader } from '@/components/PageHeader'

import { formatNumber } from '@/lib/numbers'
import { LinkFilter } from '@/components/LinkFilter'
import { FilterBar } from '@/components/FormLayout'
import Link from 'next/link'
import type { TaxLine, TaxReturn } from '@/lib/tax'
import { formatMoney } from '@/lib/money'
import { Exports } from '@/components/Exports'

/**
 * A sales-tax return's worksheet: the boxes, the entries behind each, and
 * what to check before filing. One screen for the GST/HST return and the PST
 * return (2026-09-04) — the two differ in their boxes and their words, which
 * arrive as props; the trace, the review block and the period picker are the
 * same, so they are the same code.
 *
 * It computes nothing: `gstHstReturn` / `pstReturn` decided every figure.
 */
export function ReturnScreen({
  ledgerId, ret, lines, title, label, path, exportWhat, pdfQuery, choices, from, to, show,
  verdict, extra, controls,
}: {
  ledgerId: string
  ret: Omit<TaxReturn, 'lines'>
  /** The boxes in the form's order; the last is the net line. */
  lines: TaxLine[]
  title: string
  /** 'GST/HST' or 'PST' — used in the registration sentence. */
  label: string
  blurb: React.ReactNode
  /** The page's own path under the ledger, for the period links. */
  path: string
  exportWhat: string
  pdfQuery: string
  choices: Array<{ name: string; from: string; to: string }>
  from: string
  to: string
  show?: string
  /** The sentence under the table: what the net line means. */
  verdict: React.ReactNode
  footnote: React.ReactNode
  /** A line under the period picker — the PST page's late-filing switch. */
  extra?: React.ReactNode
  controls?: React.ReactNode
}) {
  const net = lines[lines.length - 1]
  const href = (f: string, t: string, s?: string) =>
    `/ledger/${ledgerId}${path}?from=${f}&to=${t}${s ? `&show=${s}` : ''}`

  const Row = ({ tax, strong }: { tax: TaxLine; strong?: boolean }) => (
    <>
      <tr className={strong ? 'border-t border-neutral-300 dark:border-neutral-700' : ''}>
        <td className="w-16 py-2 font-mono text-xs text-neutral-500">{tax.line}</td>
        <td className={`py-2 ${strong ? 'font-medium' : ''}`}>
          {tax.label}
          {tax.entries.length > 0 && (
            <Link href={href(from, to, show === tax.line ? undefined : tax.line)}
                  className="ml-2 text-xs text-neutral-500 hover:underline print:hidden">
              {show === tax.line
                ? 'hide'
                : tax.entries.length === 1 ? '1 entry' : `${formatNumber(tax.entries.length)} entries`}
            </Link>
          )}
        </td>
        <td className={`py-2 text-right tabular-nums ${strong ? 'font-medium' : ''}`}>
          {/* The figure opens its breakdown — same entries as the inline
              trace, but addressable and exportable on its own. A line with no
              entries of its own (net, commission) stays plain. */}
          {tax.entries.length === 0 ? formatMoney(tax.amount) : (
            <Link href={`/ledger/${ledgerId}/breakdown?kind=tax&line=${tax.line}&from=${from}&to=${to}${pdfQuery}`}
                  className="hover:underline">
              {formatMoney(tax.amount)}
            </Link>
          )}
          {tax.bookAmount !== undefined && <span className="mt-1 block text-caption font-normal text-ink-secondary">
            Books {formatMoney(tax.bookAmount)} · Adjustment {formatMoney(tax.adjustment ?? 0n)}
          </span>}
        </td>
      </tr>
      {show === tax.line && tax.entries.map((e, i) => (
        <tr key={i} className="text-xs text-neutral-600 dark:text-neutral-400">
          <td />
          <td className="py-0.5 pl-6">
            <span className="font-mono">{e.entryDate}</span>{' '}
            <span className="font-mono">{e.entryNo}</span>{' '}
            {e.description}
            <span className="ml-2 font-mono text-neutral-500">{e.accountCode}</span>
          </td>
          {/* The contribution, with its sign: a reversal reduces the line, and
              a column that does not add up to its total is not a trace. */}
          <td className="py-0.5 text-right tabular-nums">
            {formatMoney(e.contribution, { sign: 'accounting' })}
          </td>
        </tr>
      ))}
      {show === tax.line && tax.adjustment !== undefined && <tr className="text-xs text-neutral-600 dark:text-neutral-400">
        <td /><td className="py-1 pl-6">Manual adjustment · {tax.adjustmentReason}</td>
        <td className="py-1 text-right tabular-nums">{formatMoney(tax.adjustment)}</td>
      </tr>}
    </>
  )

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>{title}</>} backTo={`/ledger/${ledgerId}`} backLabel={`Back to ${ret.entity}`} />

      <p className="mt-2 max-w-2xl text-xs text-amber-800 dark:text-amber-400">
        Book figures can change until their months are closed. {controls && 'Manual return overrides are saved separately.'}
        Nothing is filed from here.
      </p>

      <FilterBar>
        <LinkFilter label="Filing period" value={`${from}/${to}`} options={choices.map((c) => ({
          value: `${c.from}/${c.to}`, label: c.name, href: href(c.from, c.to),
        }))} />
      </FilterBar>

      {extra && <p className="mt-2 print:hidden">{extra}</p>}

      <header className="mt-5 text-center">
        <h2 className="text-lg font-medium">{ret.entity}</h2>
        {ret.businessNumber && (
          <p className="font-mono text-sm text-neutral-500">{ret.businessNumber}</p>
        )}
        <p className="text-sm text-neutral-500">
          {from} to {to} · {ret.currency}
        </p>
        {/* Whether the company was registered is the first thing that decides
            whether these figures mean anything, so it sits with them and not in
            a settings page nobody opens. */}
        <p className="mt-1 text-sm print:hidden">
          {ret.coverage === 'none' ? (
            <Link href={`/ledger/${ledgerId}/tax/registration`}
                  className="font-medium text-amber-700 hover:underline dark:text-amber-400">
              Not registered for {label} — register
            </Link>
          ) : (
            <Link href={`/ledger/${ledgerId}/tax/registration`}
                  className={`hover:underline ${ret.coverage === 'part'
                    ? 'text-amber-700 dark:text-amber-400' : 'text-neutral-500'}`}>
              Registered {ret.registrations
                .map((r) => `${r.registeredOn} to ${r.ceasedOn ?? 'now'}`).join(', ')}
              {ret.coverage === 'part' && ' — part of this period only'}
            </Link>
          )}
        </p>
      </header>

      {ret.review.length > 0 && (
        <div className="mt-6 rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-200">Check before you file</p>
          <ul className="mt-2 space-y-2 text-amber-800 dark:text-amber-300">
            {ret.review.map((r, i) => (
              <li key={i}>
                <span className="font-medium">{r.what}.</span> {r.detail}
                {r.entries && (
                  <ul className="mt-1 font-mono text-xs">
                    {r.entries.map((e, j) => (
                      <li key={j}>
                        {e.entryDate} {e.entryNo} {e.description} — {e.accountCode}{' '}
                        {formatMoney(e.contribution, { sign: 'accounting' })}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <DataTable density="reading" className="mt-8 w-full text-sm">
        <tbody>
          {lines.map((l) => <Row key={l.line} tax={l} strong={l === net} />)}
        </tbody>
      </DataTable>

      <p className="mt-4 text-sm">{verdict}</p>
      {controls}

      <Exports href={`/ledger/${ledgerId}/tax/pdf?from=${from}&to=${to}${pdfQuery}`}
               csv={`/ledger/${ledgerId}/export?what=${exportWhat}&from=${from}&to=${to}`} />

      <p className="mt-4 text-xs text-neutral-500">Posted entries · Revenue excludes collected tax · Not filed</p>
    </main>
  )
}

import Link from 'next/link'
import { renderCashFlow } from '@/lib/cash-flow'
import { renderEquityChanges } from '@/lib/equity-changes'
import { DERIVED_STATEMENTS, type DerivedCode } from '@/lib/derived-statements'
import { formatMoney } from '@/lib/money'
import { accountReference } from '@/lib/account-reference'
import { Exports } from '@/components/Exports'
import { tableIndent } from '@/lib/ui'

/**
 * The two statements that are not templates, on the statements page. The
 * figures come from src/lib/cash-flow.ts and src/lib/equity-changes.ts;
 * nothing here decides a number. Same header, same problems box, same
 * download links as a template statement, so a reader cannot tell which
 * kind of renderer stood behind the page — and should not have to.
 */
export async function Derived({ ledgerId, code, entity, spanName, fromPeriodId, toPeriodId, from, to }: {
  ledgerId: string; code: DerivedCode; entity: string; spanName: string
  fromPeriodId: string; toPeriodId: string; from: string; to: string
}) {
  const named = DERIVED_STATEMENTS.find((d) => d.code === code)!
  const cf = code === 'CASH_FLOW' ? await renderCashFlow(ledgerId, toPeriodId, fromPeriodId) : null
  const eq = code === 'EQUITY_CHANGES' ? await renderEquityChanges(ledgerId, toPeriodId, fromPeriodId) : null
  const problems = cf?.problems ?? eq?.problems ?? []
  const cell = (bold: boolean) => `py-1 pl-4 text-right tabular-nums ${bold ? 'font-medium' : ''}`
  /**
   * Where a figure on either of these statements opens.
   *
   * Until now neither was clickable: the template statements have had a
   * breakdown behind every number since they were written, and these two —
   * which are the harder ones to believe, because nothing about them is a
   * balance you can look up — had none (owner, 2026-09-15).
   */
  const drill = (params: Record<string, string>) =>
    `/ledger/${ledgerId}/breakdown?${new URLSearchParams({ ...params, from, to })}`

  return (
    <>
      <Exports href={`/ledger/${ledgerId}/statements/pdf?template=${code}&from=${from}&to=${to}`} />

      <header className="mt-6 text-center">
        <h2 className="text-lg font-medium">{entity}</h2>
        <p className="text-sm">{named.name}</p>
        <p className="text-sm text-neutral-500">For {spanName} · IFRS · CAD</p>
      </header>

      {problems.length > 0 && (
        <div className="mt-6 rounded border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-200">This statement is not complete.</p>
          <ul className="mt-2 space-y-1 text-amber-800 dark:text-amber-300">
            {problems.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      {cf && (
        <table data-report-layout="single" className="mx-auto mt-8 w-full max-w-2xl text-sm">
          <tbody>
            {cf.lines.map((l, i) => {
              if (l.lineType === 'spacer') return <tr key={i}><td className="py-2" colSpan={2} /></tr>
              if (l.lineType === 'header') {
                return (
                  <tr key={i}>
                    <td className="pt-5 pb-1 font-medium" colSpan={2} style={tableIndent(l.indent, 1.25)}>
                      {l.label}
                    </td>
                  </tr>
                )
              }
              const isTotal = l.lineType === 'total'
              const reference = accountReference(l.accounts)
              return (
                <tr key={i} className={isTotal ? 'border-t border-neutral-300 dark:border-neutral-700' : ''}>
                  <td className={`py-1 ${isTotal ? 'font-medium' : ''}`} style={tableIndent(l.indent, 1.25)}>
                    {l.label}
                    {reference && (
                      <span className="ml-2 font-mono text-xs text-neutral-500">{reference}</span>
                    )}
                  </td>
                  <td className={cell(isTotal)}>
                    <Link href={drill({ kind: 'cash-flow-line', line: String(i) })}
                          className="hover:underline">
                      {formatMoney(l.raw, { sign: 'accounting' })}
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {eq && (
        <div className="overflow-x-auto">
          <table data-report-layout="wide" className="mt-8 w-full min-w-[48rem] text-sm">
            <thead>
              <tr className="border-b border-neutral-300 text-right text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <th className="py-2 text-left font-medium" />
                {eq.columns.map((c) => <th key={c.code} className="py-2 pl-4 font-medium">{c.label}</th>)}
                <th className="py-2 pl-4 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {eq.rows.map((r) => {
                const strong = r.lineType !== 'movement'
                // The row's own accounts are the LAST cell's — the Total
                // column is every other column put together (equity-changes.ts).
                const reference = accountReference(r.accounts[r.accounts.length - 1])
                return (
                  <tr key={r.code} className={r.lineType === 'closing' ? 'border-t border-neutral-300 dark:border-neutral-700' : ''}>
                    <td className={`py-1 ${strong ? 'font-medium' : ''}`}>
                      {r.label}
                      {reference && (
                        <span className="ml-2 font-mono text-xs font-normal text-neutral-500">{reference}</span>
                      )}
                    </td>
                    {r.shown.map((v, i) => (
                      <td key={i} className={cell(strong)}>
                        <Link href={drill({ kind: 'equity-cell', row: r.code, col: String(i) })}
                              className="hover:underline">
                          {formatMoney(v, { sign: 'accounting' })}
                        </Link>
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-neutral-500">Posted entries · {code === 'CASH_FLOW' ? 'Indirect method' : 'Unclosed result included'}</p>
    </>
  )
}

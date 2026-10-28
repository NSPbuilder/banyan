
import { DataTable } from '@/components/Table'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import Link from 'next/link'
import { breakdown } from '@/lib/breakdown'
import { formatMoney } from '@/lib/money'

/**
 * The rows behind a report figure — the ONE renderer for both exits (the
 * overlay a click opens, and the full page a refresh or shared link lands on).
 * The CSV and PDF links carry the same query this body was derived from, so
 * all four exits answer from the same `breakdown()` call shape.
 */
export async function BreakdownBody({
  ledgerId, query,
}: {
  ledgerId: string
  query: Record<string, string | undefined>
}) {
  const b = await breakdown(ledgerId, query)
  if (!b) {
    return (
      <p className="mt-4 text-sm text-neutral-500">
        Nothing to break down at this address — the figure it pointed at may have
        moved, or the link is incomplete.
      </p>
    )
  }

  const qs = new URLSearchParams(
    Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined))

  return (
    <div className="font-sans">
      <h2 className="text-lg font-semibold tracking-tight">{b.title}</h2>
      <p className="mt-0.5 text-sm text-neutral-500">{b.entity} · {b.subtitle}</p>
      {b.note && <p className="mt-2 max-w-xl text-xs text-neutral-500">{b.note}</p>}

      <div className="mt-3 flex justify-end gap-4 text-sm print:hidden">
        <a href={`/ledger/${ledgerId}/breakdown/pdf?${qs}&format=xlsx`}
           className={TOOL_BUTTON} title="Download Excel"><ToolAction kind="xlsx">Download Excel</ToolAction></a>
        <a href={`/ledger/${ledgerId}/breakdown/pdf?${qs}`} target="_blank"
           className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">Download PDF</ToolAction></a>
      </div>

      <div className="mt-2 overflow-x-auto">
        <DataTable density="reading" className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              {b.columns.map((c, i) => (
                <th key={i} className={`py-2 pr-3 font-medium ${c.align === 'right' ? 'text-right' : ''}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i}
                  className={`${r.rule ? 'border-t border-neutral-300 dark:border-neutral-700' : 'border-b border-neutral-100 dark:border-neutral-900'} ${r.bold ? 'font-medium' : ''}`}>
                {r.cells.map((c, j) =>
                  'money' in c ? (
                    <td key={j} className="py-1.5 pr-3 text-right font-mono tabular-nums">
                      {formatMoney(c.money, { sign: 'accounting' })}
                    </td>
                  ) : (
                    <td key={j} className={`py-1.5 pr-3 ${c.mono ? 'font-mono text-xs' : ''}`}>
                      {r.href && c.text ? (
                        <Link href={r.href} className="hover:underline">{c.text}</Link>
                      ) : c.text}
                    </td>
                  ))}
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </div>
  )
}

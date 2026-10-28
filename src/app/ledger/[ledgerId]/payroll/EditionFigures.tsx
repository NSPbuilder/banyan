
import { DataTable } from '@/components/Table'
import { EDITION_FIGURES, figureOf } from '@/lib/payroll/edition-fields'
import type { RateEdition } from '@/lib/payroll/rates'

/**
 * Every figure of one T4127 edition, grouped as the tables are, each with the
 * table it is read off — so the numbers payroll computes with can be held
 * against the PDF (owner, 2026-09-16: 「T4127 具体数据我在 app 里看不到」).
 * Read-only; the list it walks is `edition-fields.ts`, the same one the add
 * form asks from.
 */
export function EditionFigures({ edition }: { edition: RateEdition }) {
  return (
    <div className="mt-3 grid gap-4 md:grid-cols-2" data-edition-figures={edition.id}>
      {EDITION_FIGURES.map((group) => (
        <div key={group.title}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{group.title}</h4>
          <DataTable density="reading" className="mt-1 w-full text-xs">
            <tbody>
              {group.figures.map((f) => (
                <tr key={f.path} className="border-b border-neutral-100 align-top dark:border-neutral-900">
                  <td className="py-1 pr-3">{f.label}</td>
                  <td className="py-1 pr-3 text-right font-mono tabular-nums" data-figure={f.path}>
                    {figureOf(edition, f.path)}
                  </td>
                  <td className="w-12 py-1 text-right text-neutral-400">{f.table}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      ))}
    </div>
  )
}

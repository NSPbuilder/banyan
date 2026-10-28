'use client'

import { PageHeading } from '@/components/DialogHeading'

import { DataTable } from '@/components/Table'

import type { RenderedRegister } from '@/lib/registers'
import { DocHeader } from '@/components/DocHeader'

/**
 * One structure, three exits.
 *
 * This component draws whatever `renderRegister` built — it runs no query and
 * makes no decision about content. The generated PDF (`registerPdf`) is fed
 * by the SAME `renderRegisterForLedger`; printing this page (print CSS strips
 * the chrome) remains for paper. A separately-fed path would be a second
 * answer to the question this page exists to settle.
 */
export function RegisterView({ register, pdfHref }: {
  register: RenderedRegister
  pdfHref?: string
}) {
  return (
    <div data-register={register.kind}>
      <DocHeader pdfHref={pdfHref} />

      <PageHeading title={<>{register.title}</>} />
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{register.entityName}</p>

      <div className="mt-3 space-y-0.5 text-xs text-neutral-500" data-register-header>
        {/* The availability sentence is the bold one, found by what it SAYS.
            It used to be found by its position in the list, so adding a note
            above it would have quietly moved the emphasis onto another line. */}
        {register.headerNotes.map((n, i) => (
          <p key={i} className={n.startsWith('NOT available') ? 'font-semibold' : ''}>
            {n}
          </p>
        ))}
        <p>Generated {register.generatedAt}</p>
        {register.withheld.length > 0 && (
          <p data-withheld>
            Withheld from this audience: {register.withheld.join(', ')}
          </p>
        )}
      </div>

      {/* One table renderer, applied to every table the register has. The
          central securities register is a two-part document — who holds
          what, and the particulars of every issue and transfer — and two
          tables must not mean two ways of drawing a table. */}
      <Table columns={register.columns} rows={register.rows} asOf={register.asOf} />
      {register.detail && (
        <>
          <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            {register.detail.title}
          </h2>
          <Table columns={register.detail.columns} rows={register.detail.rows}
                 asOf={register.asOf} />
        </>
      )}
    </div>
  )
}

function Table({ columns, rows, asOf }: { columns: string[]; rows: string[][]; asOf: string }) {
  return (
    <DataTable density="reading" className="mt-6 w-full text-sm">
      <tbody>
        <tr className="border-b border-neutral-300 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
          {columns.map((c) => <td key={c} className="py-1 pr-3">{c}</td>)}
        </tr>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-neutral-200 last:border-0 dark:border-neutral-800">
            {row.map((cell, j) => (
              <td key={j} className={`py-2 pr-3 align-top ${cell === 'TOTAL ISSUED' ? 'font-semibold' : ''}`}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
        {rows.length === 0 && (
          <tr><td className="py-4 text-neutral-500" colSpan={columns.length}>
            Nothing on this register as at {asOf}.
          </td></tr>
        )}
      </tbody>
    </DataTable>
  )
}

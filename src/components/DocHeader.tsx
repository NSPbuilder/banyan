'use client'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { PdfPrintButton } from './PdfPrintButton'

/**
 * The compact tools over a printable document, stripped from print output.
 */
export function DocHeader({ pdfHref, printPdfHref }: { pdfHref?: string; printPdfHref?: string }) {
  return (
    <>
      <style>{`@media print { .no-print { display: none } body { background: white } }`}</style>

      <div className="no-print mb-4 flex flex-wrap items-center justify-end gap-2">
          {pdfHref && (
            <a href={pdfHref} target="_blank"
               className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">Download PDF</ToolAction></a>
          )}
          {printPdfHref ? <PdfPrintButton href={printPdfHref} /> : <button type="button" onClick={() => window.print()} className={TOOL_BUTTON} title="Print">
            <ToolAction kind="print">Print</ToolAction>
          </button>}
      </div>
    </>
  )
}


import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { PrintButton } from '@/app/PrintButton'

/**
 * A report's three exits, in the order every report screen offered them:
 * the PDF, the same file as a workbook, and the printer.
 */
export function Exports({ href, csv }: { href: string; csv?: string }) {
  return (
    <div className="mt-4 flex flex-wrap justify-end gap-2 print:hidden">
      <a href={href} target="_blank" className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">Download PDF</ToolAction></a>
      <a href={`${href}&format=xlsx`} className={TOOL_BUTTON} title="Download Excel"><ToolAction kind="xlsx">Download Excel</ToolAction></a>
      {/* The CSV route existed for every report and nothing linked to it
          (whole-project audit, 2026-09-13). */}
      {csv && <a href={csv} className={TOOL_BUTTON} title="Export CSV"><ToolAction kind="csv">Download CSV</ToolAction></a>}
      <PrintButton />
    </div>
  )
}

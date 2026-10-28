
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { localToday } from '@/lib/today'
import { DocumentError, renderCustomerStatement } from '@/lib/customer-docs'
import { StatementView } from './StatementView'
import { DateInput } from '@/components/DateInput'
import { FIELD } from '@/lib/ui'

export const dynamic = 'force-dynamic'

/**
 * One customer's statement. `renderCustomerStatement` is the single source —
 * this page runs no query of its own, and the aging line it shows is the
 * aging report's, called rather than recomputed.
 */
export default async function Statement({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string; partyId: string }>
  searchParams: Promise<{ asOf?: string }>
}) {
  await requireUser()

  const { ledgerId, partyId } = await params
  const q = await searchParams
  const asOf = q.asOf ?? localToday()

  let statement
  try {
    statement = await renderCustomerStatement(ledgerId, partyId, asOf)
  } catch (e) {
    if (e instanceof DocumentError) notFound()
    throw e
  }

  return (
    <main data-centered-paper className="mx-auto max-w-3xl p-10 font-sans">
      <div className="no-print">
        <Link href={`/ledger/${ledgerId}/aging`}
              className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Aging</ToolAction></Link>
        <form className="mt-3 flex items-end gap-3 text-xs text-neutral-500">
          <label className="flex flex-col gap-1">
            As at
            <DateInput name="asOf" defaultValue={asOf}
                   className={FIELD} />
          </label>
          <button className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
            Re-render
          </button>
        </form>
      </div>
      <div className="mt-4">
        <StatementView statement={statement}
          pdfHref={`/ledger/${ledgerId}/parties/${partyId}/statement/pdf?asOf=${asOf}`} />
        {/* The same paper as a workbook — every report has one (critic,
            2026-09-04: this was the one still PDF-only). */}
        <p className="mt-2 text-right text-sm print:hidden">
          <a href={`/ledger/${ledgerId}/parties/${partyId}/statement/pdf?asOf=${asOf}&format=xlsx`}
             className={TOOL_BUTTON} title="Download Excel"><ToolAction kind="xlsx">Download Excel</ToolAction></a>
        </p>
      </div>
    </main>
  )
}

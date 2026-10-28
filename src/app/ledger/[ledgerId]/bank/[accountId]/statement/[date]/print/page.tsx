
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { reconcileView } from '@/lib/bank'
import { PrintButton } from '@/app/PrintButton'
import { StatementReportView } from '../../../StatementReportView'

export const dynamic = 'force-dynamic'

/**
 * The printable copy of one statement's reconciliation report. The same
 * `StatementReportView` the reconcile screen shows — this file runs one query
 * for the header and asks `statementReport` for everything else, so the print
 * and the screen cannot disagree.
 */
export default async function PrintStatementReport({
  params,
}: { params: Promise<{ ledgerId: string; accountId: string; date: string }> }) {
  await requireUser()

  const { ledgerId, accountId, date } = await params

  const [head] = await db.execute<{ entity: string; code: string; name: string }>(sql`
    SELECT e.name AS entity, a.code, a.name
      FROM ledger l
      JOIN entity e ON e.id = l.entity_id
      JOIN account a ON a.entity_id = e.id
     WHERE l.id = ${ledgerId}::uuid AND a.id = ${accountId}::uuid`)
  if (!head) notFound()

  const report = await reconcileView(accountId, date)
  if (!report) notFound()

  return (
    <main data-centered-paper className="mx-auto max-w-3xl p-10 font-sans">
      <div className="flex items-baseline justify-between text-xs print:hidden">
        <Link href={`/ledger/${ledgerId}/bank/${accountId}/reconcile`}
              className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Reconcile</ToolAction></Link>
        <PrintButton />
      </div>

      <StatementReportView report={report} company={head.entity} account={`${head.code} ${head.name}`} />
    </main>
  )
}

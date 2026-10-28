import { PageHeader } from '@/components/PageHeader'

import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  deleteStatementAction, finishReconciliationAction, saveStatementAction, undoReconciliationAction,
  uploadStatementFileAction, removeStatementFileAction,
} from '@/app/actions'
import { reconcileView, statementsFor } from '@/lib/bank'
import { statementFilesOf } from '@/lib/attachments'
import { StatementSection } from '../StatementSection'
import { ReconcilePanel } from './ReconcilePanel'
import { StatementFiles } from './StatementFiles'

export const dynamic = 'force-dynamic'

/**
 * Reconcile one account — QuickBooks' Reconcile page (19).
 *
 * Two decisions are stored: the statement (its date and printed ending
 * balance, 0043) and whether it is finished (0055). Every figure on this page
 * is derived from those, the imported rows and the matches, at render time.
 */
export default async function Reconcile(
  { params, searchParams }: {
    params: Promise<{ ledgerId: string; accountId: string }>
    searchParams: Promise<{ st?: string }>
  },
) {
  await requireUser()

  const { ledgerId, accountId } = await params
  const { st } = await searchParams

  const [head] = await db.execute<{ entity: string; code: string; name: string;currency:string }>(sql`
    SELECT e.name AS entity, a.code, a.name,COALESCE(a.foreign_currency,l.currency) AS currency
      FROM ledger l
      JOIN entity e ON e.id = l.entity_id
      JOIN account a ON a.entity_id = e.id
     WHERE l.id = ${ledgerId}::uuid AND a.id = ${accountId}::uuid`)
  if (!head) notFound()

  // The statement shown is the one asked for, else the newest on file.
  const statements = await statementsFor(accountId)
  const chosen = (st && statements.find((x) => x.statement_date === st)) || statements[0]
  const view = chosen ? await reconcileView(accountId, chosen.statement_date) : null
  const files = chosen ? await statementFilesOf(ledgerId, accountId, chosen.id) : []

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Reconcile</>} backTo={`/ledger/${ledgerId}/bank/reconcile`} backLabel={`Back to Reconcile`} />
      <p className="mt-1 text-sm text-neutral-500">
        {head.code} — {head.name}.{' '}
        <Link href={`/ledger/${ledgerId}/bank/${accountId}`} className="underline">Bank feed</Link>
      </p>

      <StatementSection currency={head.currency}
        ledgerId={ledgerId} accountId={accountId}
        statements={statements} shown={view?.statementDate ?? null}
        saveAction={saveStatementAction} deleteAction={deleteStatementAction}
      />

      {view && chosen ? (
        <>
        <StatementFiles key={chosen.id} ledgerId={ledgerId} accountId={accountId} statementId={chosen.id}
                        statementDate={chosen.statement_date} finished={Boolean(view.finished)} files={files}
                        uploadAction={uploadStatementFileAction} removeAction={removeStatementFileAction} />
        <ReconcilePanel ledgerId={ledgerId} accountId={accountId} view={view}
                        actions={{ finish: finishReconciliationAction, undo: undoReconciliationAction }} />
        </>
      ) : (
        null
      )}
    </main>
  )
}

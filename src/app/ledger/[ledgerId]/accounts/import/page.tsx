import { PageHeader } from '@/components/PageHeader'

import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { ImportForm } from './ImportForm'
import { STARTER_CHART } from '@/lib/starter-chart'
import { chartOfAccounts } from '@/lib/accounts'

export const dynamic = 'force-dynamic'

export default async function ImportAccounts({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  const [head] = await db.execute<{ entity: string; entity_id: string; existing: string }>(sql`
    SELECT e.name AS entity, e.id::text AS entity_id,
           (SELECT count(*) FROM account a WHERE a.entity_id = e.id)::text AS existing
      FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  if (!head) notFound()

  /**
   * THE STARTER CHART, LESS WHAT THIS COMPANY ALREADY HAS.
   *
   * A new company arrives with the core accounts now (setup.ts,
   * `createCompanyReady`), and `importAccounts` refuses a paste containing a
   * code that exists — all or nothing, deliberately. So a prefill of the whole
   * chart would be a box that is refused the moment it is submitted, on the
   * one screen whose whole job is to get a chart in.
   *
   * Filtered here rather than made forgiving in the door: "nothing is written
   * unless every row is valid" is the promise that screen makes, and a door
   * that quietly skipped rows would break it to save a prefill.
   */
  const taken = new Set((await chartOfAccounts(head.entity_id)).map((a) => a.code))
  const prefill = STARTER_CHART.split('\n')
    .filter((line) => !taken.has(line.split(',')[0]?.trim()))
    .join('\n')

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Import accounts</>} backTo={`/ledger/${ledgerId}/accounts`} backLabel={`Back to Chart of accounts`} />
      <p className="mt-1 text-sm text-neutral-500">
        {head.entity} has {head.existing} account{head.existing === '1' ? '' : 's'}.
      </p>

      <div className="mt-6 rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <p className="font-medium">Columns</p>
        <p className="mt-1 font-mono text-xs text-neutral-600 dark:text-neutral-400">
          code, name, type, parent, roles, balance
        </p>

      </div>

      <ImportForm ledgerId={ledgerId} entityId={head.entity_id} prefill={prefill} />
    </main>
  )
}

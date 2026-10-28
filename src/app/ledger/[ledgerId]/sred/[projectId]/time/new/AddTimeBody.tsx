
import { PageHeading } from '@/components/DialogHeading'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { entityOfLedger } from '@/lib/access'
import { sredProjects, timeFor } from '@/lib/sred'
import { localToday } from '@/lib/today'
import { logSredTimeAction, logSredTimeBatchAction } from '@/app/ledger/[ledgerId]/sred/actions'
import { AddTimeForm } from './AddTimeForm'

/** Recording hours on a project, body only — floated over the Time tab, a full page on a deep link. */
export async function AddTimeBody({ ledgerId, projectId, copyId }: {
  ledgerId: string; projectId: string; copyId?: string
}) {
  const entityId = await entityOfLedger(ledgerId)
  if (!entityId) notFound()
  const project = (await sredProjects(entityId)).find((p) => p.id === projectId)
  if (!project) notFound()
  const source = copyId ? (await timeFor(projectId)).find((row) => row.id === copyId) : null
  if (copyId && !source) notFound()
  const employees = await db.execute<{ id: string; name: string; is_specified: boolean }>(sql`
    SELECT e.id::text, p.name, e.is_specified
      FROM payroll_employee e JOIN party p ON p.id = e.party_id
     WHERE e.entity_id = ${entityId}::uuid AND e.is_active ORDER BY p.name`)
  return (
    <>
      <PageHeading className="mt-2" title={<>{source ? 'Copy time' : 'Record time'}</>} />
      <p className="mt-1 text-sm text-neutral-500">
        <span className="font-mono">{project.code}</span> {project.title}
      </p>

      {employees.length === 0 && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          Nobody is on this company&apos;s payroll yet, so there is nobody to record hours for. Add them
          under Payroll → People first.
        </p>
      )}
      <AddTimeForm ledgerId={ledgerId} projectId={projectId} employees={employees} today={localToday()}
                   initial={source ? { employeeId: source.employee_id, onDate: source.on_date,
                     hours: source.hours, activity: source.activity } : undefined}
                   actions={{ logTime: logSredTimeAction, logTimeBatch: logSredTimeBatchAction }} />
    </>
  )
}


import { PageHeading } from '@/components/DialogHeading'
import { notFound } from 'next/navigation'
import { entityOfLedger } from '@/lib/access'
import { sredProjects, evidenceFor } from '@/lib/sred'
import { localToday } from '@/lib/today'
import { addSredEvidenceAction, addSredEvidenceBatchAction } from '@/app/ledger/[ledgerId]/sred/actions'
import { AddEvidenceForm } from './AddEvidenceForm'

/** Listing evidence on a project, body only — floated over the project, a full page on a deep link. */
export async function AddEvidenceBody({ ledgerId, projectId, copyId }: {
  ledgerId: string; projectId: string; copyId?: string
}) {
  const entityId = await entityOfLedger(ledgerId)
  if (!entityId) notFound()
  const project = (await sredProjects(entityId)).find((p) => p.id === projectId)
  if (!project) notFound()
  const source = copyId ? (await evidenceFor(projectId)).find((row) => row.id === copyId) : null
  if (copyId && !source) notFound()
  return (
    <>
      <PageHeading className="mt-2" title={<>{source ? 'Copy evidence' : 'Add evidence'}</>} />
      <p className="mt-1 text-sm text-neutral-500">
        <span className="font-mono">{project.code}</span> {project.title}
      </p>

      <AddEvidenceForm ledgerId={ledgerId} projectId={projectId} today={localToday()}
                       initial={source ? { kind: source.kind, title: source.title,
                         onDate: source.on_date, note: source.note ?? '' } : undefined}
                       actions={{ addEvidence: addSredEvidenceAction, addEvidenceBatch: addSredEvidenceBatchAction }} />
    </>
  )
}

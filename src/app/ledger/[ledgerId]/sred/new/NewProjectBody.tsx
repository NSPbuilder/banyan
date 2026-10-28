
import { PageHeading } from '@/components/DialogHeading'
import { createSredProjectAction } from '@/app/ledger/[ledgerId]/sred/actions'
import { NewProject } from '../NewProject'
import { entityOfLedger } from '@/lib/access'
import { sredProjects } from '@/lib/sred'
import { notFound } from 'next/navigation'

/** Opening a project, body only — floated over the project list, a full page on a deep link. */
export async function NewProjectBody({ ledgerId, copyId }: { ledgerId: string; copyId?: string }) {
  const entityId = await entityOfLedger(ledgerId)
  if (!entityId) notFound()
  const source = copyId ? (await sredProjects(entityId)).find((p) => p.id === copyId) : null
  if (copyId && !source) notFound()
  return (
    <>
      <PageHeading className="mt-2" title={<>{source ? 'Copy project' : 'Open a project'}</>} />

      <NewProject ledgerId={ledgerId} action={createSredProjectAction}
                  initial={source ? { title: source.title, startedOn: source.started_on,
                    fieldOfScience: source.field_of_science } : undefined} />
    </>
  )
}

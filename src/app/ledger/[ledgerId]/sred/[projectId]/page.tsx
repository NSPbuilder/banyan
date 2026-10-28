
import { PageHeader } from '@/components/PageHeader'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { entityOfLedger } from '@/lib/access'
import {
  allocatableLines, allocatableSalary, claimsFor, evidenceFor, evidenceStanding,
  sredProjects, timeFor, workingPaper,
} from '@/lib/sred'
import { viewedYear } from '@/lib/sred-kinds'
import {
  allocateSredAction,
  deleteSredEvidenceAction, deleteSredProjectAction, deleteSredTimeAction,
  fileSredClaimAction,
  openSredClaimAction, saveSredClaimAction, unallocateSredAction, unfileSredClaimAction, deleteSredClaimAction,
  updateSredEvidenceAction, updateSredProjectAction, updateSredTimeAction,
} from '@/app/ledger/[ledgerId]/sred/actions'
import { ProjectBody } from './ProjectBody'

export const dynamic = 'force-dynamic'

/**
 * One SR&ED project: what was uncertain, what was done, what it cost.
 *
 * Everything the screen needs is read here and handed down, so the body is a
 * client component a check can render with no server runtime (the ActionForm
 * rule). The working paper is computed for the year being looked at and for
 * that year only — a claim is per year, and so is the method.
 */
export default async function SredProject(
  { params, searchParams }: {
    params: Promise<{ ledgerId: string; projectId: string }>
    searchParams: Promise<{ year?: string }>
  },
) {
  await requireUser()
  const { ledgerId, projectId } = await params
  const asked = (await searchParams).year
  const entityId = await entityOfLedger(ledgerId)
  if (!entityId) notFound()

  const project = (await sredProjects(entityId)).find((p) => p.id === projectId)
  if (!project) notFound()

  const claims = await claimsFor(projectId)
  const years = await db.execute<{ id: string; name: string; start_date: string; end_date: string }>(sql`
    SELECT id::text, name, start_date::text, end_date::text
      FROM fiscal_year WHERE ledger_id = ${ledgerId}::uuid ORDER BY end_date DESC`)
  // Which year, and whether IT has a claim — `viewedYear` in sred-kinds.ts, so
  // the branches are callable by a check. The line this replaced borrowed
  // another year's claim when the asked one had none.
  const { year, claim, span } = viewedYear(years, claims, asked)

  const paper = claim ? await workingPaper(claim.id) : null

  const allocations = claim ? await db.execute<{
    id: string; source_kind: string; source_id: string; category: string
    percent: string; basis: string
  }>(sql`
    SELECT id::text, source_kind, source_id::text, category, percent::text, basis
      FROM sred_allocation WHERE claim_id = ${claim.id}::uuid`) : []

  return (
    <main className="mx-auto w-full max-w-6xl px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/sred`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to SR&amp;ED</ToolAction></Link>
      <PageHeader title={<><span className="font-mono text-ink-muted">{project.code}</span> {project.title}</>}>
        <Link href={`/ledger/${ledgerId}/sred/new?copy=${project.id}`}
              className={TOOL_BUTTON}>Copy</Link>
      </PageHeader>

      <ProjectBody
        ledgerId={ledgerId}
        project={project}
        years={years}
        claims={claims}
        claim={claim}
        yearId={year?.id ?? null}
        paper={paper}
        time={await timeFor(projectId)}
        evidence={await evidenceFor(projectId)}
        standing={await evidenceStanding(projectId)}
        salary={span ? await allocatableSalary(ledgerId, span.from, span.to) : []}
        lines={span ? await allocatableLines(ledgerId, span.from, span.to) : []}
        allocations={allocations}
        actions={{
          openClaim: openSredClaimAction,
          saveClaim: saveSredClaimAction,
          allocate: allocateSredAction,
          unallocate: unallocateSredAction,
          fileClaim: fileSredClaimAction,
          unfileClaim: unfileSredClaimAction, deleteClaim: deleteSredClaimAction,
          updateProject: updateSredProjectAction,
          deleteProject: deleteSredProjectAction,
          updateTime: updateSredTimeAction,
          deleteTime: deleteSredTimeAction,
          updateEvidence: updateSredEvidenceAction,
          deleteEvidence: deleteSredEvidenceAction,
        }}
      />
    </main>
  )
}


import { DataTable } from '@/components/Table'
import { PageHeader } from '@/components/PageHeader'

import { formatNumber } from '@/lib/numbers'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { entityOfLedger } from '@/lib/access'
import { localToday } from '@/lib/today'
import { sredAccountCategories, sredProjects, evidenceStanding, sredRateRows, sredRates } from '@/lib/sred'
import { deleteSredRateAction, saveSredRateAction, setSredAccountCategoryAction } from '@/app/ledger/[ledgerId]/sred/actions'
import { Rates } from './Rates'
import { AccountCategories } from './AccountCategories'
import { BUTTON, CARD } from '@/lib/ui'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'SR&ED' }

/**
 * SR&ED — the projects, and how ready each one is.
 *
 * The list leads with the two things that are lost by not looking at them:
 * the eighteen-month deadline, which has no relief provision, and how thin
 * the evidence is, which is far cheaper to fix while the work is happening.
 * The money is on the project's own page, because the money is the easy part.
 */
export default async function Sred({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  const entityId = await entityOfLedger(ledgerId)
  if (!entityId) notFound()

  const [head] = await db.execute<{ entity: string; is_ccpc: boolean | null }>(sql`
    SELECT name AS entity, is_ccpc FROM entity WHERE id = ${entityId}::uuid`)
  const projects = await sredProjects(entityId)
  const standing = await Promise.all(projects.map(async (p) => ({
    project: p,
    evidence: await evidenceStanding(p.id),
  })))

  // Every year that could still be claimed, with the deadline worked out from
  // its own end date — never typed, because missing it loses the claim.
  const years = await db.execute<{ id: string; name: string; end_date: string; deadline: string; days: string }>(sql`
    SELECT y.id::text, y.name, y.end_date::text,
           (y.end_date + interval '18 months')::date::text AS deadline,
           ((y.end_date + interval '18 months')::date - CURRENT_DATE)::text AS days
      FROM fiscal_year y
     WHERE y.ledger_id = ${ledgerId}::uuid
       AND (y.end_date + interval '18 months')::date >= CURRENT_DATE - interval '1 year'
     ORDER BY y.end_date DESC`)

  const unconfirmed = (await sredRates(localToday()))
    .filter((r) => r.confidence === 'unconfirmed')

  return (
    <main className="mx-auto w-full max-w-5xl px-8 py-10 font-sans">
      <PageHeader title={<>SR&amp;ED</>} backTo={`/ledger/${ledgerId}`} backLabel={`Back to ${head?.entity}`} />
      <p className="mt-1 max-w-2xl text-sm text-neutral-500">
        {head?.is_ccpc === null
          ? 'Nobody has said whether this company is a CCPC, and that decides the rate. Set it on the company before filing.'
          : head?.is_ccpc
            ? 'A CCPC: 35% on qualified expenditures up to the limit, refundable, plus 10% from BC.'
            : 'Not a CCPC: 15%, generally not refundable, plus 10% from BC.'}
      </p>

      <section className="mt-6 flex flex-wrap gap-3">
        {years.map((y) => {
          const days = Number(y.days)
          return (
            <div key={y.id} className={`${CARD} min-w-52`}>
              <div className="text-xs text-neutral-500">{y.name} · ended {y.end_date}</div>
              <div className="mt-1 font-serif text-lg font-semibold">{y.deadline}</div>
              <div className={`mt-0.5 text-xs ${days < 90 ? 'font-semibold text-red-700 dark:text-red-400' : 'text-neutral-500'}`}>
                {days < 0 ? 'the deadline has passed — the claim is lost' : `${days} days to file`}
              </div>
            </div>
          )
        })}
      </section>

      <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg font-semibold">Projects</h2>
        {/* A link the overlay floats (2026-09-16), not a form unfolding in the list. */}
        <Link href={`/ledger/${ledgerId}/sred/new`} className={BUTTON}>Open a project</Link>
      </div>
      {projects.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">
          Nothing yet.
        </p>
      ) : (
        <DataTable density="reading" className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-3 font-medium">Code</th>
              <th className="py-2 pr-3 font-medium">Project</th>
              <th className="py-2 pr-3 font-medium">Started</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 font-medium">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {standing.map(({ project, evidence }) => (
              <tr key={project.id} className="border-b border-neutral-100 dark:border-neutral-900">
                <td className="py-2 pr-3 font-mono text-xs">
                  <Link href={`/ledger/${ledgerId}/sred/${project.id}`} className="hover:underline">
                    {project.code}
                  </Link>
                </td>
                <td className="py-2 pr-3">
                  <Link href={`/ledger/${ledgerId}/sred/${project.id}`} className="hover:underline">
                    {project.title}
                  </Link>
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-neutral-500">{project.started_on}</td>
                <td className="py-2 pr-3 text-xs text-neutral-500">{project.status}</td>
                <td className="py-2 text-xs">
                  {evidence.map((e) => (
                    <span key={e.answers}
                          className={`mr-2 ${e.held === 0 ? 'text-red-700 dark:text-red-400' : 'text-neutral-500'}`}>
                      {e.answers} {e.held}/{e.kinds}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {unconfirmed.length > 0 && (
        <section className="mt-10 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-200">
            {formatNumber(unconfirmed.length)} rate{unconfirmed.length === 1 ? '' : 's'} on file {unconfirmed.length === 1 ? 'has' : 'have'} not been confirmed against the current rules.
          </p>
          <ul className="mt-2 space-y-1 text-xs text-amber-800 dark:text-amber-300">
            {unconfirmed.map((r) => (
              <li key={`${r.jurisdiction}-${r.name}`}>
                <span className="font-mono">{r.jurisdiction} {r.name} = {r.value}</span> · {r.authority} · {r.note}
              </li>
            ))}
          </ul>
        </section>
      )}

      <AccountCategories ledgerId={ledgerId} rows={await sredAccountCategories(entityId)}
                         action={setSredAccountCategoryAction} />

      <Rates ledgerId={ledgerId} rates={await sredRateRows()}
             actions={{ saveRate: saveSredRateAction, deleteRate: deleteSredRateAction }} />
    </main>
  )
}

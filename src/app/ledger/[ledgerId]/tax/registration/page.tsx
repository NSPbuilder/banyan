import { PageHeader } from '@/components/PageHeader'

import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  openProposals, registrationsFor, registrationView, taxesFor,
} from '@/lib/registrations'
import { localToday } from '@/lib/today'
import {
  ceaseTaxAction, correctTaxRegistrationAction, deleteTaxRegistrationAction, registerTaxAction,
} from '@/app/actions'
import { RegistrationSections } from './RegistrationSections'

export const dynamic = 'force-dynamic'

export default async function Registration({
  params,
}: {
  params: Promise<{ ledgerId: string }>
}) {
  await requireUser()

  const { ledgerId } = await params

  const [head] = await db.execute<{ entity_id: string; entity: string; province: string | null }>(sql`
    SELECT e.id::text AS entity_id, e.name AS entity, e.province
      FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  if (!head) notFound()

  const applicable = taxesFor(head.province)
  // One day for the whole page. Computed twice — once here, once inside
  // `registrationsFor` — the two could straddle midnight and the badge would
  // contradict the form beside it. And it is the LOCAL day: the UTC day is
  // already tomorrow here from 17:00 every evening.
  const today = localToday()
  const existing = await registrationsFor(head.entity_id, today)

  // Which forms to show and how each should read. A pure function, because
  // every one of those decisions was made here and rendered by nothing.
  const view = registrationView(applicable, existing, today)
  const { open } = view
  const proposals = await openProposals(head.entity_id, open)

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Sales tax registration</>} backTo={`/ledger/${ledgerId}/tax`} backLabel={`Back to GST/HST return`} />
      <p className="mt-1 text-sm text-neutral-500">
        {head.entity}
        {head.province ? ` · ${head.province}` : ' · no province on file'}
      </p>
      {!head.province && (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          No province is recorded for this company, so this page assumes GST alone. Set the
          province if it should be HST, QST or PST.
        </p>
      )}

      {/* Everything below the heading, in a component a check can render.
          The actions are handed down rather than imported there, which is what
          makes it renderable at all. */}
      <RegistrationSections
        ledgerId={ledgerId} entityId={head.entity_id}
        view={view} proposals={proposals} today={today}
        registerAction={registerTaxAction} ceaseAction={ceaseTaxAction}
        correctAction={correctTaxRegistrationAction} deleteAction={deleteTaxRegistrationAction} />

    </main>
  )
}

import { PageHeader } from '@/components/PageHeader'
import Link from 'next/link'

import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { createAccountAction, openingBalanceAction } from '@/app/actions'
import { openingBalanceFor, openingCandidates } from '@/lib/opening'
import { OpeningScreen } from './OpeningScreen'

export const dynamic = 'force-dynamic'

export default async function Opening({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()

  const { ledgerId } = await params

  const [head] = await db.execute<{
    entity: string; entity_id: string; first_day: string | null
  }>(sql`
    SELECT e.name AS entity, e.id::text AS entity_id,
           (SELECT min(p.start_date)::text
              FROM fiscal_period p JOIN fiscal_year y ON y.id = p.fiscal_year_id
             WHERE y.ledger_id = l.id) AS first_day
      FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  if (!head) notFound()

  const [existing, accounts] = await Promise.all([
    openingBalanceFor(ledgerId),
    openingCandidates(head.entity_id),
  ])

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeader title={<>Opening balances</>} backTo={`/ledger/${ledgerId}`} backLabel={`Back to ${head.entity}`} />

      <OpeningScreen
        ledgerId={ledgerId}
        entityName={head.entity}
        accounts={accounts}
        existing={existing}
        defaultDate={head.first_day ?? ''}
        action={openingBalanceAction}
        newAccount={createAccountAction}
      />

      <p className="mt-6 text-sm"><Link className="underline" href={`/ledger/${ledgerId}/opening/migration`}>CSV migration wizard</Link></p>

    </main>
  )
}

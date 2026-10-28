
import { PageHeading } from '@/components/DialogHeading'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { attachPartyAction } from '@/app/actions'
import { partiesFor, roleDefinitions } from '@/lib/parties'
import { localToday } from '@/lib/today'
import { PartiesScreen } from './PartiesScreen'
import { BUTTON, PAGE_HEADER } from '@/lib/ui'
import { ledgerHead } from '@/lib/ledger-head'

export const dynamic = 'force-dynamic'

export default async function Parties({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()

  const { ledgerId } = await params

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const [parties, roles, elsewhere] = await Promise.all([
    partiesFor(head.entity_id),
    roleDefinitions(),
    // Parties this company has no role with, so an existing organisation can be
    // given one here rather than being entered a second time. This list is the
    // whole reason the table is global.
    db.execute<{ id: string; name: string; kind: string; held: string; version: string }>(sql`
      SELECT p.id::text, p.name, p.kind, p.version::text,
             string_agg(DISTINCT e.name, ', ' ORDER BY e.name) AS held
        FROM party p
        JOIN party_role pr ON pr.party_id = p.id
        JOIN entity e ON e.id = pr.entity_id
       WHERE p.is_active
         AND NOT EXISTS (SELECT 1 FROM party_role x
                          WHERE x.party_id = p.id AND x.entity_id = ${head.entity_id}::uuid)
       GROUP BY p.id, p.name, p.kind
       ORDER BY p.name`),
  ])

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <div className={`mt-2 ${PAGE_HEADER}`}>
        <PageHeading title={<>Customers and suppliers</>} />
        <Link href={`/ledger/${ledgerId}/parties/new`}
              className={BUTTON}>
          New party
        </Link>
      </div>
      {/* The one fact a person cannot see from the list: it is shared. */}

      <PartiesScreen
        ledgerId={ledgerId}
        entityId={head.entity_id}
        entityName={head.entity}
        parties={parties}
        roles={roles}
        elsewhere={elsewhere}
        today={localToday()}
        actions={{ grant: attachPartyAction }}
      />
    </main>
  )
}

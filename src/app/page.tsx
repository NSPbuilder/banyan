import { requireUser } from '@/lib/gate'
import { accessFor, homeSeatForEntity, mayOpenEntity } from '@/lib/access'
import { LEDGER_NAV } from '@/lib/nav'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { Desk } from '@/components/Desk'

// Read on every request, not baked at build time. What that buys is a desk
// whose labels are right when the desk DOCUMENT loads; the names go to a
// client component that never refetches them, so a company renamed inside a
// tab shows its new name on the strip after the desk itself is reloaded
// (critic, 2026-09-03 — the first version of this comment claimed more).
export const dynamic = 'force-dynamic'

/**
 * The desk — what opening this application gives you.
 *
 * It is a tab strip and nothing else; every page of the app lives inside a
 * tab. That is what makes "Accounts and Parties at the same time" and "two
 * companies at the same time" the same feature (owner, 2026-09-03).
 *
 * The company list moved to `/companies` so that a tab can show it — a desk
 * that framed itself would nest forever, which is also why `N10` refuses any
 * link to `/` from inside the application.
 */
export default async function Home() {
  const me = await requireUser()

  // Only the companies this person may open. The desk is the LANDING page, and
  // until 2026-09-03 it listed every company in the system, with its primary
  // ledger id, to anybody signed in — while /companies, two clicks away, was
  // carefully filtered (critic). The same predicate now answers both.
  const rows = await db.execute<{ ledger_id: string; entity_id: string; name: string }>(sql`
    SELECT l.id::text AS ledger_id, e.id::text AS entity_id, e.name
      FROM entity e JOIN ledger l ON l.entity_id = e.id AND l.is_primary
     WHERE ${mayOpenEntity(me, sql`e.id`)}
     ORDER BY e.code`)
  const companies = Object.fromEntries(rows.map((r) => [r.ledger_id, r.name]))
  const access = await accessFor(me)
  const seats = LEDGER_NAV.map((item) => item.path)
  const homes = Object.fromEntries(rows.map((r) => {
    const seat = homeSeatForEntity(access, r.entity_id, seats)
    return [r.ledger_id, seat === null ? '/companies' : `/ledger/${r.ledger_id}${seat}`]
  }))
  return <Desk companies={companies} homes={homes} />
}

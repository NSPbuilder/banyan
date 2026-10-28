import { sql } from 'drizzle-orm'
import { db } from '../src/db/client'

/**
 * Every audit row a suite wrote must name a person — or 'system', or a
 * shell — and never the Postgres role.
 *
 * Twelve trigger functions write `current_user` as the actor; 0060 swaps it for
 * `app.actor` when the transaction has said who is acting (src/lib/acting.ts).
 * A write that fires one of those triggers without saying so still names the
 * role, and THIS is what finds it: not a list of the doors that were fixed,
 * but the state every one of them leaves behind. A suite that touches such a
 * table asks this once at its end, so a new door added without `acting()`
 * turns that suite red on the day it is written.
 */
export async function roleNamedRows() {
  return db.execute<{ action: string; n: string }>(sql`
    SELECT action, count(*)::text AS n FROM audit_log
     WHERE actor = current_user::text
     GROUP BY action ORDER BY action`)
}

export async function trailNamesPeople(
  check: (ok: boolean, label: string, detail?: string) => void, label: string,
) {
  const rows = await roleNamedRows()
  check(rows.length === 0, label,
    rows.length === 0
      ? 'no audit row names the database role'
      : rows.map((r) => `${r.action} ×${r.n}`).join(', ') + ' name the database role')
}

import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { CAPABILITIES, NEEDED_ROLES, type Capability } from './roles'

/**
 * Reading the chart against what the capabilities declared (src/lib/roles.ts).
 *
 * Split from the declarations because those are imported by seven modules and
 * must stay a leaf; this half touches the database and is imported by one
 * screen.
 */

export type { Capability }

export type Missing = {
  role: string
  /** The role's own label, from the database — not a second spelling of it here. */
  label: string
  /** The capabilities that cannot work without it. */
  stops: Capability[]
}

/**
 * Which needed roles no active, postable account in this company carries.
 *
 * The same test `accountWithRole` applies when a module actually reaches for
 * one — active AND postable — so this cannot say a company is ready and then
 * have the module refuse, which would be worse than saying nothing at all.
 *
 * The label comes from `role_definition`, so the words read here are the words
 * on the chart of accounts beside the tick.
 */
export async function missingRoles(ledgerId: string): Promise<Missing[]> {
  if (NEEDED_ROLES.length === 0) return []
  const rows = await db.execute<{ role: string; label: string; held: boolean }>(sql`
    SELECT rd.code AS role, rd.label,
           EXISTS (
             SELECT 1 FROM account_role ar
               JOIN account a ON a.id = ar.account_id
              WHERE ar.role = rd.code
                AND a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
                AND a.is_active AND a.is_postable
           ) AS held
      FROM role_definition rd
     WHERE rd.code IN (${sql.join(NEEDED_ROLES.map((r) => sql`${r}`), sql`, `)})
     ORDER BY rd.sort_order`)

  return rows
    .filter((r) => !r.held)
    .map((r) => ({
      role: r.role,
      label: r.label,
      stops: CAPABILITIES.filter((c) => c.roles.includes(r.role)),
    }))
}

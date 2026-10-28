/**
 * What this thing is called, in one place.
 *
 * It reaches the browser tab, and nothing else — the screens name the company
 * they are showing, which is what a person with several tabs open is actually
 * looking for. Changing the name is changing this line (owner asked for a tab
 * name, 2026-09-07; the tab still said "Create Next App", which is what the
 * Next.js scaffold writes and nobody had touched since day one).
 */
export const APP_NAME = 'Banyan'

/**
 * The title a ledger's tab carries: the company's own name.
 *
 * Here rather than inside the layout's `generateMetadata` because the layout
 * imports the rail, which imports `next/navigation`, which cannot be loaded
 * outside a Next runtime — so a check importing the layout to see what a tab
 * would say cannot even load it. This is the same boundary-extraction that
 * `panelStateFrom` and `readingCards` are: the decision moves to a function
 * something can call, and `P31` calls it (critic, 2026-09-07).
 */
export async function ledgerTitle(ledgerId: string): Promise<string> {
  const { db } = await import('@/db/client')
  const { sql } = await import('drizzle-orm')
  const [head] = await db.execute<{ name: string }>(sql`
    SELECT e.name FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  return head?.name ?? 'Company'
}

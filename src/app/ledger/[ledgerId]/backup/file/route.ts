import { BACKUP_EXT } from '@/lib/backup-name'
import { guardRoute } from '@/lib/gate'
import { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { exportCompany, packFigtree } from '@/lib/backup'

/**
 * The backup itself, as a download.
 *
 *   ?paper=yes   the receipts ride along; without it, the books alone
 *
 * A route rather than a server action because this hands back a FILE, and
 * because a company's books can be large — an action would have to bring the
 * whole thing back through the form's response.
 *
 * A GET, unlike `/backup/download`, which is POST and owner-only (RISKS §15b)
 * because it runs `pg_dump` over the WHOLE database unauthenticated. This one
 * is one company and goes through `guardRoute`, which resolves the path to the
 * `/backup` seat and refuses anybody without it — the same shape as
 * `/export?what=journal`, which has handed over a whole journal on a seat
 * since it was written. A download has to be a GET to be a link.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ledgerId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId } = await params
  const [head] = await db.execute<{ entity_id: string; code: string }>(sql`
    SELECT l.entity_id::text, e.code FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  if (!head) return new Response('No such company.', { status: 404 })

  const withFiles = request.nextUrl.searchParams.get('paper') === 'yes'
  const doc = await exportCompany(head.entity_id, { withFiles })
  const bytes = await packFigtree(doc)
  const day = doc.exportedAt.slice(0, 10)

  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': 'application/gzip',
      'content-length': String(bytes.length),
      'content-disposition': `attachment; filename="${head.code} ${day}${BACKUP_EXT}"`,
      // A backup is a point in time; nothing may hand back yesterday's.
      'cache-control': 'no-store',
    },
  })
}

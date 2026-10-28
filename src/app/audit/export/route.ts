import { NextRequest } from 'next/server'
import { guardRoute } from '@/lib/gate'
import {
  AUDIT_EXPORT_LIMIT, auditCsv, auditFilterFrom, auditTrail,
} from '@/lib/audit'

/** Owner-only working export of exactly the filters shown on /audit. */
export async function GET(request: NextRequest) {
  const who = await guardRoute({ owner: true })
  if (who instanceof Response) return who

  try {
    const values = Object.fromEntries(request.nextUrl.searchParams) as Record<string, string | undefined>
    const rows = await auditTrail({
      ...auditFilterFrom(values),
      // One extra row tells the file whether it was capped without a separate,
      // potentially expensive count over an append-only table.
      limit: AUDIT_EXPORT_LIMIT + 1,
    })
    const truncated = rows.length > AUDIT_EXPORT_LIMIT
    const day = new Date().toLocaleDateString('en-CA')
    return new Response(auditCsv(rows.slice(0, AUDIT_EXPORT_LIMIT)), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-trail-${day}.csv"`,
        'Cache-Control': 'no-store',
        'X-FigTree-Truncated': truncated ? 'true' : 'false',
      },
    })
  } catch (error) {
    const message = error instanceof Error
      ? ((error.cause as Error | undefined)?.message ?? error.message)
      : String(error)
    return new Response(`Audit export failed: ${message.split('\n')[0]}\n`, {
      status: 500,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  }
}

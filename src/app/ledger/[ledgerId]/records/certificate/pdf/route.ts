import { guardRoute } from '@/lib/gate'
import { localToday } from '@/lib/today'
import { actorOf } from '@/lib/gate'
import { shareCertificate } from '@/lib/certificate'
import { logRegisterExport } from '@/lib/registers'
import { pdfResponse } from '@/lib/pdf-reports'
import { filename } from '@/lib/csv'

export const dynamic = 'force-dynamic'

/**
 * A share certificate, as a file.
 *
 * A route rather than a page because a certificate is a document, not a
 * screen — there is nothing to browse and nothing to click on it. It logs an
 * export like every other register render: handing someone paper that says
 * who owns what is exactly the act that trail exists to record.
 */
export async function GET(
  req: Request, { params }: { params: Promise<{ ledgerId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId } = await params
  const q = new URL(req.url).searchParams
  const shareClassId = q.get('class') ?? ''
  const partyId = q.get('party') ?? ''
  const asOf = q.get('asOf') || localToday()

  const made = await shareCertificate(ledgerId, shareClassId, partyId, asOf)
  if (!made) {
    // Said plainly: the usual reason is that the holder's balance is zero as
    // at that date, and there is no certificate for nothing.
    return new Response(
      'No certificate: that holder held none of that class as at that date.',
      { status: 404 })
  }
  await logRegisterExport({
    entityId: made.facts.entityId, kind: 'central_securities', asOf,
    audience: 'director', actor: actorOf(who),
  })
  return pdfResponse({
    filename: filename([made.facts.company, 'share certificate', made.facts.holder, asOf], 'pdf'),
    buffer: made.buffer,
  })
}

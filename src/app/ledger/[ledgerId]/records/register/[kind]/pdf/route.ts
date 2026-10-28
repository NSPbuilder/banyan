import { guardRoute } from '@/lib/gate'
import { localToday } from '@/lib/today'
import { actorOf } from '@/lib/gate'
import { REGISTER_KINDS, logRegisterExport, type Audience, type RegisterKind } from '@/lib/registers'
import { pdfResponse } from '@/lib/pdf-reports'
import { registerPdf } from '@/modules/records/reports'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request, { params }: { params: Promise<{ ledgerId: string; kind: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId, kind } = await params
  if (!REGISTER_KINDS.includes(kind as RegisterKind)) return new Response('No such register.', { status: 404 })
  const q = new URL(req.url).searchParams
  const asOf = q.get('asOf') || localToday()
  const audience: Audience = q.get('audience') === 'public' ? 'public' : 'director'

  const pdf = await registerPdf(ledgerId, kind as RegisterKind, asOf, audience)
  if (!pdf) return new Response('No such register here.', { status: 404 })
  // The same export trail the register page writes: a generated file is an
  // export too, and the design doc wants to know who asked, for what, as at when.
  await logRegisterExport({
    entityId: pdf.entityId, kind: kind as RegisterKind, asOf, audience, actor: actorOf(who),
  })
  return pdfResponse(pdf)
}

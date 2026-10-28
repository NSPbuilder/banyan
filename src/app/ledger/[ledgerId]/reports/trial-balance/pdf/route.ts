import { guardRoute } from '@/lib/gate'
import { formatOf, pdfResponse, spanFromQuery, trialBalancePdf } from '@/lib/pdf-reports'
import { HIDE_ZEROS } from '@/lib/reporting-view'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request, { params }: { params: Promise<{ ledgerId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId } = await params
  const q = new URL(req.url).searchParams
  const span = await spanFromQuery(ledgerId, q)
  if (span instanceof Response) return span
  return pdfResponse(await trialBalancePdf(ledgerId, span,
    formatOf(q),
    { hideZeros: q.get(HIDE_ZEROS) === '1' }))
}

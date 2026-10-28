import { guardRoute } from '@/lib/gate'
import { formatOf, agingPdf, pdfResponse } from '@/lib/pdf-reports'
import { localToday } from '@/lib/today'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request, { params }: { params: Promise<{ ledgerId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId } = await params
  const q = new URL(req.url).searchParams
  const asOf = q.get('asOf') || localToday()
  return pdfResponse(await agingPdf(ledgerId, asOf, formatOf(q)))
}

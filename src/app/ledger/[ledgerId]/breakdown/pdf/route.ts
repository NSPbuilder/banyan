import { guardRoute } from '@/lib/gate'
import { formatOf, breakdownPdf, pdfResponse } from '@/lib/pdf-reports'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request, { params }: { params: Promise<{ ledgerId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId } = await params
  const q = new URL(req.url).searchParams
  const pdf = await breakdownPdf(ledgerId, Object.fromEntries(q), formatOf(q))
  if (!pdf) return new Response('No such breakdown.', { status: 404 })
  return pdfResponse(pdf)
}

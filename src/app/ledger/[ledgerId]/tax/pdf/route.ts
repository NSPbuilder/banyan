import { guardRoute } from '@/lib/gate'
import { formatOf, pdfResponse, taxReturnPdf } from '@/lib/pdf-reports'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request, { params }: { params: Promise<{ ledgerId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId } = await params
  const q = new URL(req.url).searchParams
  const from = q.get('from')
  const to = q.get('to')
  if (!from || !to) return new Response('from and to are needed', { status: 400 })
  const pdf = await taxReturnPdf(ledgerId, from, to, q.get('tax') === 'pst' ? 'PST' : 'GST_HST', q.get('late') === '1',
    formatOf(q))
  if (!pdf) return new Response('Nothing to report for that range.', { status: 404 })
  return pdfResponse(pdf)
}

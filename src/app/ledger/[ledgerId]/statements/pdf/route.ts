import { guardRoute } from '@/lib/gate'
import { formatOf, pdfResponse, spanFor, statementPdf } from '@/lib/pdf-reports'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request, { params }: { params: Promise<{ ledgerId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId } = await params
  const q = new URL(req.url).searchParams
  const template = q.get('template')
  const from = q.get('from')
  const to = q.get('to')
  if (!template || !from || !to) return new Response('template, from and to are needed', { status: 400 })
  const span = await spanFor(ledgerId, from, to)
  if (!span) return new Response('No periods cover that range.', { status: 404 })
  const c = q.get('compare')
  const by = q.get('by')
  const pdf = await statementPdf(ledgerId, template, span, c === 'year' || c === 'prior' ? c : null,
    formatOf(q), by === 'month' || by === 'quarter' ? by : null)
  if (!pdf) return new Response('No such statement template here.', { status: 404 })
  return pdfResponse(pdf)
}

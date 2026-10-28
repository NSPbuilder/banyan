import { nativeReconciliationExport } from './native-export'
import { guardRoute } from '@/lib/gate'
import { formatOf, pdfResponse } from '@/lib/pdf-reports'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ledgerId: string; accountId: string; date: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId, accountId, date } = await params
  const q = new URL(_req.url).searchParams
  const pdf = await nativeReconciliationExport(ledgerId, accountId, date, formatOf(q))
  if (!pdf) return new Response('No statement on file for that date.', { status: 404 })
  return pdfResponse(pdf)
}

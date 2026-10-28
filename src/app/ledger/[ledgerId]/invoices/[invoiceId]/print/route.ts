import { guardRoute } from '@/lib/gate'

export const dynamic = 'force-dynamic'

/** Redirect before rendering a layout so old preview bookmarks open the PDF. */
export async function GET(
  _request: Request, { params }: { params: Promise<{ ledgerId: string; invoiceId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who
  const { ledgerId, invoiceId } = await params
  return new Response(null, {
    status: 307,
    headers: {
      Location: `/ledger/${encodeURIComponent(ledgerId)}/invoices/${encodeURIComponent(invoiceId)}/pdf`,
      'Cache-Control': 'private, no-store',
    },
  })
}

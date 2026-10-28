import { guardRoute } from '@/lib/gate'
import { DocumentError } from '@/lib/customer-docs'
import { invoicePdf, pdfResponse } from '@/lib/pdf-reports'
import { ours } from '@/lib/ours'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request, { params }: { params: Promise<{ ledgerId: string; invoiceId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId, invoiceId } = await params
  if (!await ours('invoice', invoiceId, ledgerId)) return new Response('That invoice does not exist.', { status: 404 })
  try {
    return pdfResponse(await invoicePdf(invoiceId))
  } catch (e) {
    // The library's refusals are sentences for the person, not stack traces.
    if (e instanceof DocumentError) {
      return new Response(e.message, { status: e.code === 'NO_INVOICE' ? 404 : 400 })
    }
    throw e
  }
}

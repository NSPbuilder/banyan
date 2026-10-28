import 'server-only'
import { DocumentError, type InvoiceDocument } from './customer-docs'
import { invoicePaperPdf, pdfResponse } from './pdf-reports'
import { appendReceiptSupporting, type ReceiptSupportingFile } from './receipt-supporting-pdf'

/** Routes perform their normal module gate before reaching this shared read-only response. */
export async function receiptResponse(request: Request, load: () => Promise<InvoiceDocument>, supporting?: () => Promise<ReceiptSupportingFile[]>): Promise<Response> {
  try {
    // Validate the Receipt before opening supporting. The loader must be scoped
    // to the same payment as the route, never an arbitrary client entry/file.
    const paper = await invoicePaperPdf(await load())
    if(supporting)paper.buffer=await appendReceiptSupporting(paper.buffer,await supporting())
    const response = pdfResponse(paper)
    if (new URL(request.url).searchParams.get('download') === '1')
      response.headers.set('Content-Disposition', response.headers.get('Content-Disposition')!.replace(/^inline;/, 'attachment;'))
    return response
  } catch (error) {
    if (error instanceof DocumentError) return new Response(error.message, { status: error.code === 'NO_RECEIPT' ? 404 : 400, headers: { 'Cache-Control': 'no-store' } })
    throw error
  }
}

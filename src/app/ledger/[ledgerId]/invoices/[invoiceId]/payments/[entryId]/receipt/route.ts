import { guardRoute } from '@/lib/gate'
import { renderPaymentReceipt } from '@/lib/receipts'
import { receiptResponse } from '@/lib/receipt-http'
import { entryReceiptAttachments } from '@/lib/receipt-attachments'

export const dynamic = 'force-dynamic'
export async function GET(request: Request, { params }: { params: Promise<{ ledgerId: string; invoiceId: string; entryId: string }> }) {
  const who = await guardRoute()
  if (who instanceof Response) return who
  const { ledgerId, invoiceId, entryId } = await params
  return receiptResponse(request, () => renderPaymentReceipt(ledgerId, entryId, invoiceId), () => entryReceiptAttachments(ledgerId, entryId))
}

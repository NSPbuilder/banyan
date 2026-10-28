import { guardRoute } from '@/lib/gate'
import { renderPaymentReceipt } from '@/lib/receipts'
import { receiptResponse } from '@/lib/receipt-http'
import { entryReceiptAttachments } from '@/lib/receipt-attachments'

export const dynamic = 'force-dynamic'
export async function GET(request: Request, { params }: { params: Promise<{ ledgerId: string; entryId: string }> }) {
  const who = await guardRoute()
  if (who instanceof Response) return who
  const { ledgerId, entryId } = await params
  return receiptResponse(request, () => renderPaymentReceipt(ledgerId, entryId), () => entryReceiptAttachments(ledgerId, entryId))
}

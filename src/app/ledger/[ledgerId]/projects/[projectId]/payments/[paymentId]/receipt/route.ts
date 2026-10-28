import { guardRoute } from '@/lib/gate'
import { renderProjectPaymentReceipt } from '@/lib/receipts'
import { receiptResponse } from '@/lib/receipt-http'
import { projectReceiptAttachments } from '@/lib/project-attachments'

export const dynamic = 'force-dynamic'
export async function GET(request: Request, { params }: { params: Promise<{ ledgerId: string; projectId: string; paymentId: string }> }) {
  const who = await guardRoute()
  if (who instanceof Response) return who
  const { ledgerId, projectId, paymentId } = await params
  return receiptResponse(request, () => renderProjectPaymentReceipt(ledgerId, projectId, paymentId), () => projectReceiptAttachments(ledgerId, projectId, paymentId))
}

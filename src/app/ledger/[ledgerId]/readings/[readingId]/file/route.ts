import { guardRoute } from '@/lib/gate'
import { readingFile } from '@/lib/bill-reading'
import { fileResponse } from '@/lib/pdf-reports'

export const dynamic = 'force-dynamic'

/**
 * The picture that was read, shown beside the review form so the person can
 * check the proposal against the paper. Same gate as an attachment: a bill
 * somebody may not open is the same leak as its page.
 */
export async function GET(
  _req: Request, { params }: { params: Promise<{ ledgerId: string; readingId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId, readingId } = await params
  const file = await readingFile(ledgerId, readingId)
  if (!file) return new Response('No such reading.', { status: 404 })
  return fileResponse(file)
}

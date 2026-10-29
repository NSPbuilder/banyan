import { guardRoute } from '@/lib/gate'
import { attachmentFile } from '@/lib/attachments'
import { fileResponse } from '@/lib/pdf-reports'

export const dynamic = 'force-dynamic'

/** The receipt itself, straight from the store, shown in the browser. */
export async function GET(
  _req: Request, { params }: { params: Promise<{ ledgerId: string; attachmentId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId, attachmentId } = await params
  try {
    const file = await attachmentFile(ledgerId, attachmentId)
    if (!file) return new Response('No such attachment.', { status: 404 })
    return fileResponse(file)
  } catch {
    return new Response(
      'The books know this attachment, but its file is missing from the store — '
      + 'run the folder rebuild, or restore the attachments backup.\n', { status: 404 })
  }
}

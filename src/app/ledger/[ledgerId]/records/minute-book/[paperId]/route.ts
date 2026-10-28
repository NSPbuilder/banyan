import { guardRoute } from '@/lib/gate'
import { minuteBookPaperFile } from '@/modules/records/attachments'
import { fileResponse } from '@/lib/pdf-reports'

export const dynamic = 'force-dynamic'

/** A minute-book record's document, straight from the store (0081), shown in the browser. */
export async function GET(
  request: Request, { params }: { params: Promise<{ ledgerId: string; paperId: string }> },
) {
  const who = await guardRoute()
  if (who instanceof Response) return who

  const { ledgerId, paperId } = await params
  try {
    const file = await minuteBookPaperFile(ledgerId, paperId)
    if (!file) return new Response('No such document.', { status: 404 })
    const response = fileResponse({ ...file, filename: 'document' })
    const disposition = new URL(request.url).searchParams.get('download') === '1' ? 'attachment' : 'inline'
    const fallback = file.uploaded.replace(/[^\x20-\x7e]|["\\]/g, '_')
    const encoded = encodeURIComponent(file.uploaded).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    response.headers.set('Content-Disposition', `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`)
    return response
  } catch {
    return new Response(
      'The books know this document, but its file is missing from the store — '
      + 'run the folder rebuild, or restore the attachments backup.\n', { status: 404 })
  }
}

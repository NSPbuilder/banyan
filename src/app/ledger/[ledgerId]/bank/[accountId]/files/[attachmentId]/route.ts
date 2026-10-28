import { guardRoute } from '@/lib/gate'
import { statementFile } from '@/lib/attachments'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: {
  params: Promise<{ ledgerId: string; accountId: string; attachmentId: string }>
}) {
  const who = await guardRoute()
  if (who instanceof Response) return who
  const { ledgerId, accountId, attachmentId } = await params
  try {
    const file = await statementFile(ledgerId, accountId, attachmentId)
    if (!file) return new Response('Statement file not found.', { status: 404 })
    const disposition = new URL(request.url).searchParams.get('download') === '1' ? 'attachment' : 'inline'
    const ascii = file.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
    return new Response(new Uint8Array(file.bytes), { headers: {
      'Content-Type': file.mime,
      'Content-Disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, '%27')}`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } })
  } catch {
    return new Response('Statement file not found. Check the attachment store or restore its backup.', { status: 404 })
  }
}

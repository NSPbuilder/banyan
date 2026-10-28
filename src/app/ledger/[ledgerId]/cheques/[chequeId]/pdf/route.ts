import { guardRoute } from '@/lib/gate'
import { ChequePrintError, chequePdf } from '@/lib/cheque-pdf'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: {
  params: Promise<{ ledgerId: string; chequeId: string }>
}) {
  const who = await guardRoute()
  if (who instanceof Response) return who
  const { ledgerId, chequeId } = await params
  let doc
  try { doc = await chequePdf(ledgerId, chequeId) }
  catch (e) {
    if (e instanceof ChequePrintError) return new Response(e.message, { status: 422 })
    throw e
  }
  if (!doc) return new Response('No printable cheque at that address.', { status: 404 })
  return new Response(new Uint8Array(doc.buffer), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${doc.filename}"`,
    },
  })
}

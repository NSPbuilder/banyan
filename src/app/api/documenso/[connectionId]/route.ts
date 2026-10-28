import { guardRoute } from '@/lib/gate'
import { receiveSigningEvent, webhookConnection, EsignError } from '@/lib/esign'

export async function POST(request: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params, connection = await webhookConnection(connectionId)
  const denied = await guardRoute({ serviceSecretHash: connection?.webhook_hash ?? '', serviceSecretHeader: 'x-documenso-secret' })
  if (denied) return denied
  if (!connection) return new Response('Unauthorized.', { status: 401 })
  if (Number(request.headers.get('content-length')) > 128 * 1024) return new Response('Payload too large.', { status: 413 })
  try {
    if (!request.body) throw new EsignError('EVENT', 'Missing event.')
    const reader = request.body.getReader(), parts: Uint8Array[] = []; let size = 0
    for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 128 * 1024) { await reader.cancel(); return new Response('Payload too large.', { status: 413 }) } parts.push(value) }
    await receiveSigningEvent(connection, Buffer.concat(parts))
    return Response.json({ received: true })
  } catch (error) { return new Response(error instanceof EsignError ? 'Invalid event.' : 'Event could not be saved.', { status: error instanceof EsignError ? 400 : 503 }) }
}

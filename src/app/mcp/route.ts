import { guardRoute } from '@/lib/gate'
import { handleMcp, mcpResponse } from '@/lib/mcp-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const who = await guardRoute({ mcp: request })
  if (who instanceof Response) return who
  return handleMcp(request, who)
}

export async function GET(request: Request) {
  const who = await guardRoute({ mcp: request })
  if (who instanceof Response) return who
  return mcpResponse(new Response(null, { status: 405, headers: { Allow: 'POST' } }))
}

export async function DELETE(request: Request) {
  const who = await guardRoute({ mcp: request })
  if (who instanceof Response) return who
  // Stateless transport: there is no server session to terminate.
  return mcpResponse(new Response(null, { status: 405, headers: { Allow: 'POST' } }))
}

export async function OPTIONS(request: Request) {
  const who = await guardRoute({ mcp: request })
  if (who instanceof Response) return who
  return mcpResponse(new Response(null, { status: 405, headers: { Allow: 'POST' } }))
}

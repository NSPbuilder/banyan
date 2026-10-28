import { guardRoute } from '@/lib/gate'
import { signingCompany, signingDocument, signingFiles, signingId, EsignError } from '@/lib/esign'
import { signingBytes } from '@/lib/esign-storage'

export async function GET(request: Request, { params }: { params: Promise<{ ledgerId: string; documentId: string; fileId: string }> }) {
  const who = await guardRoute(); if (who instanceof Response) return who
  try {
    const { ledgerId, documentId, fileId } = await params, company = await signingCompany(ledgerId)
    await signingDocument(company.id, documentId); signingId(fileId)
    const file = (await signingFiles(company.id, documentId)).find(row => row.id === fileId)
    if (!file) return new Response('Document file not found.', { status: 404 })
    const bytes = await signingBytes(company.name, file.sha256)
    const disposition = new URL(request.url).searchParams.get('download') === 'yes' ? 'attachment' : 'inline'
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length), 'Content-Disposition': `${disposition}; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g, '%27')}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  } catch (error) { return new Response(error instanceof EsignError ? 'Document file not found.' : 'Document bytes are missing or damaged.', { status: error instanceof EsignError ? 404 : 503 }) }
}

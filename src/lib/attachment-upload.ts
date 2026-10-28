import 'server-only'
import { ATTACHMENT_MAX_BYTES } from './forms'

// Allow multipart headers above the file's 25 MB limit, but bound chunked
// requests too. The attachment store independently checks the file itself.
const MAX_BODY_BYTES = ATTACHMENT_MAX_BYTES + 1024 * 1024

export class UploadRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'UploadRequestError'
  }
}

/** Browser uploads must come from the same origin, including behind a proxy. */
export function isSameOriginUpload(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin || request.headers.get('sec-fetch-site') === 'cross-site') return false
  const url = new URL(request.url)
  const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim()
    || request.headers.get('host') || url.host
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0].trim()
    || url.protocol.slice(0, -1)
  if (protocol !== 'http' && protocol !== 'https') return false
  try {
    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin
  } catch {
    return false
  }
}

/** Parse ordinary multipart without putting a file through React Flight. */
export async function readAttachmentUpload(request: Request): Promise<FormData> {
  const type = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data\s*;/i.test(type)) {
    throw new UploadRequestError(400, 'Choose a PDF or image to upload.')
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new UploadRequestError(413, 'The file is too large. The limit is 25 MB.')
  }
  if (!request.body) throw new UploadRequestError(400, 'Choose a file first.')
  const reader = request.body.getReader()
  const parts: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new UploadRequestError(413, 'The file is too large. The limit is 25 MB.')
      }
      parts.push(Buffer.from(value))
    }
    return await new Response(new Uint8Array(Buffer.concat(parts)), {
      headers: { 'content-type': type },
    }).formData()
  } catch (error) {
    if (error instanceof UploadRequestError) throw error
    throw new UploadRequestError(400, 'Could not read the upload. Choose the file again.')
  } finally {
    reader.releaseLock()
  }
}

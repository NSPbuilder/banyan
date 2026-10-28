import assert from 'node:assert/strict'
import { isSameOriginUpload, readAttachmentUpload, UploadRequestError } from '../src/lib/attachment-upload'
import { ATTACHMENT_MAX_BYTES } from '../src/lib/forms'

async function main() {
  const at = 'http://127.0.0.1:3122/upload'
  const req = (origin?: string, extra: Record<string, string> = {}) => new Request(at, {
    method: 'POST', headers: { ...(origin ? { origin } : {}), ...extra },
  })
  assert(isSameOriginUpload(req('http://127.0.0.1:3122')))
  assert(!isSameOriginUpload(req()))
  assert(!isSameOriginUpload(req('null')))
  assert(!isSameOriginUpload(req('https://evil.example')))
  assert(!isSameOriginUpload(req('https://127.0.0.1:3122')))
  assert(!isSameOriginUpload(req('http://127.0.0.1:3122', { 'sec-fetch-site': 'cross-site' })))
  assert(isSameOriginUpload(req('https://figtree.example.test', {
    'x-forwarded-host': 'figtree.example.test', 'x-forwarded-proto': 'https',
  })))
  assert(!isSameOriginUpload(req('https://evil.example', {
    'x-forwarded-host': 'figtree.example.test', 'x-forwarded-proto': 'https',
  })))
  await assert.rejects(readAttachmentUpload(new Request(at, { method: 'POST', body: 'x' })),
    (e: unknown) => e instanceof UploadRequestError && e.status === 400)
  await assert.rejects(readAttachmentUpload(new Request(at, { method: 'POST', body: 'x', headers: {
    'content-type': 'multipart/form-data; boundary=x', 'content-length': String(ATTACHMENT_MAX_BYTES + 1024 * 1024 + 1),
  } })), (e: unknown) => e instanceof UploadRequestError && e.status === 413)
  let canceled = false
  let emitted = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { emitted++; controller.enqueue(new Uint8Array(1024 * 1024)) },
    cancel() { canceled = true },
  })
  const chunked = new Request(at, { method: 'POST', body, duplex: 'half',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
  } as RequestInit)
  await assert.rejects(readAttachmentUpload(chunked),
    (e: unknown) => e instanceof UploadRequestError && e.status === 413)
  assert(canceled); assert(emitted <= 29)
  console.log(JSON.stringify({ sameOrigin: true, forwardedOrigin: true, missingOriginRejected: true,
    wrongOriginRejected: true, wrongTypeRejected: true, declaredOversizeRejected: true, chunkedOversizeCanceled: true }))
}
main().catch(e => { console.error(e); process.exitCode = 1 })

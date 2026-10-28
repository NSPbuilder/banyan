import 'server-only'
import { createHash } from 'node:crypto'
import { readBlobBytes, writeBlobBytes } from './attachments'

export const pdfHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export function assertSigningPdf(bytes: Buffer) {
  if (!bytes.length || bytes.length > 25 * 1024 * 1024 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new Error('Upload a non-empty PDF up to 25 MB. Convert Word documents to PDF first.')
}
export function signingFilename(name: string) {
  return name.replaceAll('\\', '/').split('/').at(-1)?.replace(/[\r\n\0]/g, '').slice(0, 240) || 'document.pdf'
}
export async function signingBytes(company: string, sha: string) {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('The document file reference is invalid.')
  const bytes = await readBlobBytes(company, sha)
  if (!bytes || pdfHash(bytes) !== sha) throw new Error('Document bytes are missing or damaged. Restore them from a verified backup.')
  assertSigningPdf(bytes)
  return bytes
}
export async function keepSigningBytes(company: string, bytes: Buffer) {
  assertSigningPdf(bytes)
  const sha = pdfHash(bytes), existing = await readBlobBytes(company, sha)
  if (existing && !existing.equals(bytes)) throw new Error('An existing document file is damaged. It was not overwritten.')
  await writeBlobBytes(company, sha, bytes)
  await signingBytes(company, sha)
  return sha
}

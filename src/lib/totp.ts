import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// RFC 6238 / 4226, independently expressed with Node's existing crypto API.
export function totp(secret: Buffer, seconds = Math.floor(Date.now() / 1000), digits = 6): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)))
  const digest = createHmac('sha1', secret).update(counter).digest()
  const offset = digest[digest.length - 1] & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0')
}
export function matchingCounter(secret: Buffer, code: string, seconds = Math.floor(Date.now() / 1000)): number | null {
  if (!/^\d{6}$/.test(code)) return null
  for (const delta of [0, -1, 1]) {
    const time = seconds + delta * 30
    if (timingSafeEqual(Buffer.from(totp(secret, time)), Buffer.from(code))) return Math.floor(time / 30)
  }
  return null
}
export function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, value = 0, result = ''
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31] }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31]
  return result
}
function encryptionKey() {
  const key = Buffer.from(process.env.AUTH_MFA_KEY ?? '', 'base64')
  if (key.length !== 32) throw new Error('AUTH_MFA_KEY must be a dedicated 32-byte base64 key.')
  return key
}
export function encryptMfa(secret: Buffer, userId: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(Buffer.from(`FigTree:TOTP:v1:${userId}`))
  const bytes = Buffer.concat([cipher.update(secret), cipher.final()])
  return [iv, cipher.getAuthTag(), bytes].map(b => b.toString('base64')).join('.')
}
export function decryptMfa(value: string, userId: string): Buffer {
  const [iv, tag, encrypted] = value.split('.').map(s => Buffer.from(s, 'base64'))
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(Buffer.from(`FigTree:TOTP:v1:${userId}`)); cipher.setAuthTag(tag)
  return Buffer.concat([cipher.update(encrypted), cipher.final()])
}

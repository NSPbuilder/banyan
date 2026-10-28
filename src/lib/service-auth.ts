import { createHash, timingSafeEqual } from 'node:crypto'

export function serviceSecretMatches(secret: string | null, expectedHash: string) {
  if (!secret || !/^[a-f0-9]{64}$/.test(expectedHash)) return false
  return timingSafeEqual(createHash('sha256').update(secret).digest(), Buffer.from(expectedHash, 'hex'))
}

import { isIP } from 'node:net'

/** Only configure a header if the reverse proxy overwrites it on every request.
 * No implicit trust of X-Forwarded-For (nor its attacker-controlled left edge).
 */
export function trustedClientIp(headers: Pick<Headers, 'get'>): string {
  const name = process.env.AUTH_TRUSTED_IP_HEADER?.toLowerCase()
  if (!name) return 'unconfigured'
  if (!['x-real-ip', 'cf-connecting-ip'].includes(name)) throw new Error('Unsupported trusted IP header.')
  const value = headers.get(name)?.trim() ?? ''
  return isIP(value) ? value : 'unconfigured'
}

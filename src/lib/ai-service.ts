import 'server-only'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { auditRow } from './audit-row'
import { hostOf, pricesFrom, serviceFrom, type Prices, type Service } from './assistant'

/**
 * Each person's AI service, kept encrypted (0063).
 *
 * The key is AES-256-GCM under AI_KEY_SECRET from .env.local — never the
 * database, never a backup. GCM authenticates: a row read under a different
 * secret, or altered, does not decrypt to garbage, it fails, and the page
 * says the key must be entered again. The row keeps the last four characters
 * beside the ciphertext so the page can say which key is saved.
 *
 * Nothing here logs or returns the plaintext except `serviceState`, which
 * hands it to `ask` for the one request — the same boundary 0062 drew.
 */

export class AiServiceError extends Error {
  constructor(public code: 'NO_SECRET' | 'INCOMPLETE' | 'BAD_ADDRESS' | 'SHORT_KEY', message: string) {
    super(message)
  }
}

/**
 * The shortest key this will keep. Not a security floor — a service's key is
 * whatever it is — but the hint is the last four characters, and a key of
 * four or five would be half-published by its own hint, in the row, in the
 * audit trail and in the sentence the door answers with (critic).
 */
export const MIN_KEY_LENGTH = 8

const NO_SECRET = 'Keys cannot be kept until the owner puts AI_KEY_SECRET in .env.local — any long random string, '
  + 'for example the output of "openssl rand -hex 32" — and restarts the application.'

export function secretIsSet(): boolean {
  return (process.env.AI_KEY_SECRET ?? '').trim().length >= 16
}

/** The 32-byte cipher key: the secret, hashed, so its length and alphabet do not matter. */
function cipherKey(secret: string): Buffer {
  return createHash('sha256').update(secret.trim()).digest()
}

const IV_BYTES = 12, TAG_BYTES = 16

export function encryptKey(plain: string, secret = process.env.AI_KEY_SECRET ?? ''): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', cipherKey(secret), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

/** The key back, or null: a different secret, a truncated or altered blob. */
export function decryptKey(blob: Buffer, secret = process.env.AI_KEY_SECRET ?? ''): string | null {
  if (blob.length < IV_BYTES + TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', cipherKey(secret), blob.subarray(0, IV_BYTES))
    decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    return null // the secret is not the one it was written under, or the blob was altered
  }
}

export const hintOf = (apiKey: string) => (apiKey.length >= MIN_KEY_LENGTH ? apiKey.slice(-4) : '')

export type SavedService = {
  service: Service
  prices: Prices | null
  hint: string
  updatedAt: string
}

/** What the page and `ask` see: nothing saved, a key that cannot be read any more, or a service ready to use. */
export type ServiceState =
  | { kind: 'none' }
  | { kind: 'unreadable'; host: string; baseUrl: string; model: string; hint: string }
  | { kind: 'ready'; saved: SavedService }

type Row = {
  base_url: string; model: string; key_enc: Buffer; key_hint: string
  price_input: string | null; price_output: string | null; price_cached: string | null; price_unit: string | null
  updated_at: string
}

async function rowOf(userId: string): Promise<Row | null> {
  const [row] = await db.execute<Row>(sql`
    SELECT base_url, model, key_enc, key_hint, price_input::text, price_output::text, price_cached::text, price_unit,
           updated_at::text
      FROM user_ai_service WHERE user_id = ${userId}::uuid`)
  return row ?? null
}

const pricesOf = (r: Row): Prices | null =>
  pricesFrom({ priceInput: r.price_input, priceOutput: r.price_output, priceCached: r.price_cached, priceUnit: r.price_unit })

/**
 * What the screen may know: the same service, with the key taken out.
 *
 * The panel is a client component, so whatever this returns is serialised
 * into the page the browser downloads — printed or not. That makes this
 * function, not the markup, the boundary between the saved key and the
 * network, and `AI19` watches THIS (the first version had the check build
 * its own props, so the mutation that widened this one changed nothing it
 * could see — critic).
 */
export type PanelState =
  | { kind: 'none' }
  | { kind: 'unreadable'; host: string; baseUrl: string; model: string; hint: string }
  | { kind: 'ready'; host: string; baseUrl: string; model: string; hint: string
      prices: { input: number; output: number; cached: number; unit: string } | null }

export function panelStateFrom(state: ServiceState): PanelState {
  if (state.kind === 'none') return { kind: 'none' }
  if (state.kind === 'unreadable') {
    return { kind: 'unreadable', host: state.host, baseUrl: state.baseUrl, model: state.model, hint: state.hint }
  }
  return {
    kind: 'ready',
    host: hostOf(state.saved.service.baseUrl),
    baseUrl: state.saved.service.baseUrl,
    model: state.saved.service.model,
    hint: state.saved.hint,
    prices: state.saved.prices,
  }
}

export async function serviceState(userId: string): Promise<ServiceState> {
  const row = await rowOf(userId)
  if (!row) return { kind: 'none' }
  const apiKey = secretIsSet() ? decryptKey(Buffer.from(row.key_enc)) : null
  if (apiKey === null) return { kind: 'unreadable', host: hostOf(row.base_url), baseUrl: row.base_url, model: row.model, hint: row.key_hint }
  const service = serviceFrom({ baseUrl: row.base_url, apiKey, model: row.model })
  if (!service) return { kind: 'unreadable', host: hostOf(row.base_url), baseUrl: row.base_url, model: row.model, hint: row.key_hint }
  return { kind: 'ready', saved: { service, prices: pricesOf(row), hint: row.key_hint, updatedAt: row.updated_at } }
}

/**
 * Save or replace a person's service. A blank key with a readable service
 * already saved keeps that key — changing the model or the prices must not
 * mean typing the key again. Audited without the key: host, model, hint.
 */
export async function saveService(input: {
  userId: string; baseUrl: string; apiKey: string; model: string
  priceInput?: string; priceOutput?: string; priceCached?: string; priceUnit?: string
  actor: string
}): Promise<SavedService> {
  if (!secretIsSet()) throw new AiServiceError('NO_SECRET', NO_SECRET)
  let apiKey = input.apiKey.trim()
  const existing = await serviceState(input.userId)
  if (!apiKey && existing.kind === 'ready') apiKey = existing.saved.service.apiKey
  if (!apiKey) throw new AiServiceError('INCOMPLETE', 'An address, a key and a model name are all needed.')
  if (apiKey.length < MIN_KEY_LENGTH) {
    throw new AiServiceError('SHORT_KEY',
      `That key is ${apiKey.length} characters. A service's key is longer than ${MIN_KEY_LENGTH}; check you pasted the whole of it.`)
  }
  const service = serviceFrom({ baseUrl: input.baseUrl, apiKey, model: input.model })
  if (!service) {
    throw new AiServiceError((input.baseUrl.trim() && input.model.trim()) ? 'BAD_ADDRESS' : 'INCOMPLETE',
      (input.baseUrl.trim() && input.model.trim())
        ? 'The address must be a web address (http or https) — the root that ends in /v1.'
        : 'An address, a key and a model name are all needed.')
  }
  const prices = pricesFrom(input)
  const enc = encryptKey(service.apiKey)
  const hint = hintOf(service.apiKey)
  const after = { host: hostOf(service.baseUrl), model: service.model, key_hint: hint, priced: prices !== null }
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO user_ai_service (user_id, base_url, model, key_enc, key_hint, price_input, price_output, price_cached, price_unit, updated_at)
      VALUES (${input.userId}::uuid, ${service.baseUrl}, ${service.model}, ${enc}, ${hint},
              ${prices?.input ?? null}, ${prices?.output ?? null}, ${prices?.cached ?? null}, ${prices?.unit ?? null}, now())
      ON CONFLICT (user_id) DO UPDATE
        SET base_url = EXCLUDED.base_url, model = EXCLUDED.model, key_enc = EXCLUDED.key_enc, key_hint = EXCLUDED.key_hint,
            price_input = EXCLUDED.price_input, price_output = EXCLUDED.price_output,
            price_cached = EXCLUDED.price_cached, price_unit = EXCLUDED.price_unit, updated_at = now()`)
    await auditRow(tx, {
      actor: input.actor, action: 'set_ai_service', table: 'user_ai_service', recordId: input.userId,
      before: existing.kind === 'ready'
        ? { host: hostOf(existing.saved.service.baseUrl), model: existing.saved.service.model, key_hint: existing.saved.hint }
        : existing.kind === 'unreadable' ? { host: existing.host, model: existing.model, key_hint: existing.hint } : null,
      after,
    })
  })
  const [row] = await db.execute<{ updated_at: string }>(sql`
    SELECT updated_at::text FROM user_ai_service WHERE user_id = ${input.userId}::uuid`)
  return { service, prices, hint, updatedAt: row.updated_at }
}

/** Forget a person's service. The row goes; the askings it made stay, keyless as they always were. */
export async function clearService(userId: string, actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    const gone = await tx.execute<{ base_url: string; model: string; key_hint: string }>(sql`
      DELETE FROM user_ai_service WHERE user_id = ${userId}::uuid RETURNING base_url, model, key_hint`)
    if (gone.length === 0) return
    await auditRow(tx, {
      actor, action: 'clear_ai_service', table: 'user_ai_service', recordId: userId,
      before: { host: hostOf(gone[0].base_url), model: gone[0].model, key_hint: gone[0].key_hint }, after: null,
    })
  })
}

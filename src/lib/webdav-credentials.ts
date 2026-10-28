import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { accessFor } from './access'
import { auditRow } from './audit-row'
import type { UserRecord } from './users'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAV_SEATS = ['/entries', '/invoices', '/records'] as const
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export class WebDavError extends Error {}

export async function webdavRights(user: Pick<UserRecord, 'id' | 'is_owner'>, entityId: string) {
  if (!UUID.test(entityId)) return { journal: false, records: false }
  const [person] = await db.execute<{ webdav_enabled: boolean }>(sql`
    SELECT webdav_enabled FROM app_user
     WHERE id = ${user.id}::uuid AND is_active`)
  if (!person?.webdav_enabled) return { journal: false, records: false }
  const access = await accessFor(user)
  if (access.byEntity === null) return { journal: true, records: true }
  const seats = access.byEntity.get(entityId)
  return {
    journal: !!seats && (seats.has('/entries') || seats.has('/invoices')),
    records: !!seats && seats.has('/records'),
  }
}

export async function webdavCredentialStatus(userId: string): Promise<Set<string>> {
  const rows = await db.execute<{ entity_id: string }>(sql`
    SELECT entity_id::text FROM webdav_credential
     WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`)
  return new Set(rows.map((row) => row.entity_id))
}

async function permittedCompany(user: UserRecord, entityId: string) {
  const rights = await webdavRights(user, entityId)
  if (!rights.journal && !rights.records) {
    throw new WebDavError('You do not have attachment access to that company.')
  }
  const [entity] = await db.execute<{ name: string }>(sql`
    SELECT name FROM entity WHERE id = ${entityId}::uuid`)
  if (!entity) throw new WebDavError('No such company.')
  return entity.name
}

/** Replace the one company password atomically; the old one stops working. */
export async function rotateWebDavCredential(user: UserRecord, entityId: string) {
  const company = await permittedCompany(user, entityId)
  const secret = randomBytes(32).toString('base64url')
  await db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO webdav_credential (user_id, entity_id, token_hash)
      VALUES (${user.id}::uuid, ${entityId}::uuid, ${hash(secret)})
      ON CONFLICT (user_id, entity_id) DO UPDATE
        SET token_hash = EXCLUDED.token_hash, created_at = now(),
            last_used_at = NULL, revoked_at = NULL
      RETURNING id::text`)
    await auditRow(tx, {
      actor: user.email, action: 'rotate_webdav_credential',
      table: 'webdav_credential', recordId: row.id,
      entityId, scope: 'company', targetLabel: company,
      after: { active: true },
    })
  })
  return secret
}

export async function revokeWebDavCredential(user: UserRecord, entityId: string) {
  const company = await permittedCompany(user, entityId)
  await db.transaction(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      UPDATE webdav_credential SET revoked_at = now()
       WHERE user_id = ${user.id}::uuid AND entity_id = ${entityId}::uuid
         AND revoked_at IS NULL
      RETURNING id::text`)
    if (!row) return
    await auditRow(tx, {
      actor: user.email, action: 'revoke_webdav_credential',
      table: 'webdav_credential', recordId: row.id,
      entityId, scope: 'company', targetLabel: company,
      after: { active: false },
    })
  })
}

/** Basic auth carries email and a random app password, never the login password. */
export async function authenticateWebDav(
  authorization: string | null, entityId: string,
): Promise<Pick<UserRecord, 'id' | 'is_owner'> | null> {
  if (!UUID.test(entityId) || !authorization?.startsWith('Basic ')) return null
  const encoded = authorization.slice(6)
  if (encoded.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null
  let decoded: string
  try { decoded = Buffer.from(encoded, 'base64').toString('utf8') } catch { return null }
  const separator = decoded.indexOf(':')
  if (separator < 1) return null
  const email = decoded.slice(0, separator).toLowerCase()
  const secret = decoded.slice(separator + 1)
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null
  const [row] = await db.execute<{ id: string; is_owner: boolean }>(sql`
    SELECT u.id::text, u.is_owner
      FROM webdav_credential c JOIN app_user u ON u.id = c.user_id
     WHERE c.entity_id = ${entityId}::uuid AND c.token_hash = ${hash(secret)}
       AND c.revoked_at IS NULL AND u.email = ${email} AND u.is_active
       AND u.webdav_enabled`)
  if (!row) return null
  const rights = await webdavRights(row, entityId)
  if (!rights.journal && !rights.records) return null
  await db.execute(sql`
    UPDATE webdav_credential SET last_used_at = now()
     WHERE user_id = ${row.id}::uuid AND entity_id = ${entityId}::uuid
       AND token_hash = ${hash(secret)} AND revoked_at IS NULL`)
  return row
}

export const hasWebDavSeat = (seats: Set<string>) =>
  DAV_SEATS.some((seat) => seats.has(seat))

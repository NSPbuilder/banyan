import 'server-only'
import { randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Tx, acting } from './acting'
import { auditRow } from './audit-row'
import { UserError, tokenHash, verifyPassword } from './users'
import { base32, decryptMfa, encryptMfa, matchingCounter } from './totp'

export const authRefusal = () => new UserError('BAD_CREDENTIALS', 'That email and password do not match.')
const number = (key: string, fallback: number) => {
  const n = Number(process.env[key] ?? fallback)
  if (!Number.isSafeInteger(n) || n < 1 || n > 3600) throw new Error(`Invalid ${key}`)
  return n
}

/** Reserve attempts BEFORE expensive work; commit refusals too. Shared SQL
 * rows make parallel requests and multiple application processes obey limits.
 */
export async function authAttempt(kind: 'login' | 'totp' | 'recovery' | 'reauth' | 'reset' | 'passkey', account: string, ip = 'unconfigured') {
  const clean = account.trim().toLowerCase().slice(0, 320)
  const keys = [
    { key: `${kind}:pair:${clean}:${ip}`, limit: number('AUTH_PAIR_LIMIT', 8) },
    { key: `${kind}:account:${clean}`, limit: number('AUTH_ACCOUNT_LIMIT', 20) },
    { key: `${kind}:ip:${ip}`, limit: number('AUTH_IP_LIMIT', 120) },
  ].map(k => ({ ...k, hash: tokenHash(k.key) })).sort((a, b) => a.hash.localeCompare(b.hash))
  const window = number('AUTH_WINDOW_SECONDS', 60)
  const allowed = await db.transaction(async tx => {
    let ok = true
    for (const k of keys) {
      const [r] = await tx.execute<{ attempts: number }>(sql`
        INSERT INTO auth_rate_bucket(bucket_hash,attempts,expires_at)
        VALUES (${k.hash},1,clock_timestamp()+${window}*interval '1 second')
        ON CONFLICT(bucket_hash) DO UPDATE SET
          attempts=CASE WHEN auth_rate_bucket.expires_at<=clock_timestamp() THEN 1 ELSE LEAST(auth_rate_bucket.attempts+1,100000) END,
          expires_at=CASE WHEN auth_rate_bucket.expires_at<=clock_timestamp() THEN EXCLUDED.expires_at ELSE auth_rate_bucket.expires_at END
        RETURNING attempts`)
      if (r.attempts > k.limit) ok = false
    }
    // Expiry uses the indexed clock; cleanup contains no plaintext identifiers.
    await tx.execute(sql`DELETE FROM auth_rate_bucket WHERE bucket_hash IN (
      SELECT bucket_hash FROM auth_rate_bucket WHERE expires_at<clock_timestamp()-interval '1 day' LIMIT 100)`)
    return ok
  })
  if (!allowed) throw authRefusal()
}


export async function authSucceeded(tx: Tx, kind: string, account: string, ip = 'unconfigured') {
  const clean=account.trim().toLowerCase().slice(0,320)
  const keys=[`${kind}:account:${clean}`,`${kind}:pair:${clean}:${ip}`].map(tokenHash).sort()
  for(const hash of keys)await tx.execute(sql`DELETE FROM auth_rate_bucket WHERE bucket_hash=${hash}`)
}

/** Requires the live session in the transaction, not a cached page identity. */
export async function liveAuth(tx: Tx, token: string, recent = false, allowMfaSetup = false) {
  const [session] = await tx.execute<{ id: string; email: string; kind: string; user_id: string }>(sql`
    SELECT s.id::text,u.id::text AS user_id,u.email,u.kind
    FROM app_user u JOIN user_session s ON s.user_id=u.id
    WHERE s.token_hash=${tokenHash(token)} AND s.revoked_at IS NULL
      AND s.expires_at>clock_timestamp() AND u.is_active
      AND (${!recent} OR s.reauthenticated_at>clock_timestamp()-interval '5 minutes')
      AND (${process.env.AUTH_ADMIN_MFA_REQUIRED !== 'true' || allowMfaSetup}
        OR u.kind NOT IN ('owner','superadmin') OR u.mfa_secret_ciphertext IS NOT NULL OR s.strong_authenticated_at IS NOT NULL)
      AND (${process.env.AUTH_ADMIN_MFA_REQUIRED !== 'true'} OR u.kind NOT IN ('owner','superadmin')
        OR u.mfa_secret_ciphertext IS NOT NULL OR s.strong_authenticated_at IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM auth_passkey WHERE user_id=u.id AND revoked_at IS NULL))
    FOR UPDATE OF u,s`)
  if (!session) throw new UserError('REAUTH_REQUIRED', 'Sign in again or verify your identity in Account security.')
  return session
}

export async function consumeFactor(tx: Tx, userId: string, secret: string, code: string, recovery: boolean) {
  if (recovery) {
    const rows = await tx.execute(sql`UPDATE auth_recovery_code SET consumed_at=clock_timestamp()
      WHERE user_id=${userId}::uuid AND code_hash=${tokenHash(code.trim().toLowerCase())}
        AND consumed_at IS NULL RETURNING code_hash`)
    if (rows.length !== 1) throw authRefusal()
  } else {
    const counter = matchingCounter(decryptMfa(secret, userId), code.trim())
    if (counter === null) throw authRefusal()
    const rows = await tx.execute(sql`UPDATE app_user SET mfa_last_counter=${counter}
      WHERE id=${userId}::uuid AND mfa_last_counter<${counter} RETURNING id`)
    if (rows.length !== 1) throw authRefusal()
  }
}

export async function reauthenticate(token: string, password: string, code: string, ip: string) {
  // Password KDF outside locks; recheck the exact hash under the lock.
  const [candidate] = await db.execute<{ password_hash: string; email: string; mfa_secret_ciphertext: string | null }>(sql`
    SELECT u.password_hash,u.email,u.mfa_secret_ciphertext FROM app_user u JOIN user_session s ON s.user_id=u.id WHERE s.token_hash=${tokenHash(token)}`)
  await authAttempt('reauth', candidate?.email ?? 'invalid-session', ip)
  if (!candidate || !(await verifyPassword(password, candidate.password_hash))) throw authRefusal()
  if (candidate.mfa_secret_ciphertext) await authAttempt(/^\d{6}$/.test(code.trim()) ? 'totp' : 'recovery', candidate.email, ip)
  return db.transaction(async tx => {
    const who = await liveAuth(tx, token, false, true)
    const [u] = await tx.execute<{ password_hash: string; mfa_secret_ciphertext: string | null }>(sql`
      SELECT password_hash,mfa_secret_ciphertext FROM app_user WHERE id=${who.user_id}::uuid FOR UPDATE`)
    if (u.password_hash !== candidate.password_hash) throw authRefusal()
    if (u.mfa_secret_ciphertext) {
      const recovery = !/^\d{6}$/.test(code.trim())
      await consumeFactor(tx, who.user_id, u.mfa_secret_ciphertext, code, recovery)
    }
    await tx.execute(sql`UPDATE user_session SET reauthenticated_at=clock_timestamp(),
      strong_authenticated_at=CASE WHEN ${!!u.mfa_secret_ciphertext} THEN clock_timestamp() ELSE strong_authenticated_at END WHERE id=${who.id}::uuid`)
    await auditRow(tx, { actor: who.email, action: 'reauthenticate', table: 'app_user', recordId: who.user_id })
  })
}

export async function manageMfa(token: string, operation: 'begin' | 'confirm' | 'disable', code = '') {
  return db.transaction(async tx => {
    const who = await liveAuth(tx, token, true, true)
    await acting(tx, who.email)
    const [u] = await tx.execute<{ mfa_secret_ciphertext: string | null; mfa_pending_ciphertext: string | null; pending_live: boolean }>(sql`
      SELECT mfa_secret_ciphertext,mfa_pending_ciphertext,mfa_pending_until>clock_timestamp() AS pending_live
      FROM app_user WHERE id=${who.user_id}::uuid FOR UPDATE`)
    if (operation === 'begin') {
      if (u.mfa_secret_ciphertext) throw new UserError('MFA_ENABLED', 'Disable your current authenticator before replacing it.')
      const secret = randomBytes(20)
      await tx.execute(sql`UPDATE app_user SET mfa_pending_ciphertext=${encryptMfa(secret, who.user_id)},
        mfa_pending_until=clock_timestamp()+interval '10 minutes' WHERE id=${who.user_id}::uuid`)
      await auditRow(tx, { actor: who.email, action: 'mfa_setup_started', table: 'app_user', recordId: who.user_id })
      return { setupKey: base32(secret) }
    }
    let codes: string[] | undefined
    if (operation === 'confirm') {
      if (u.mfa_secret_ciphertext || !u.mfa_pending_ciphertext || !u.pending_live) throw authRefusal()
      const counter = matchingCounter(decryptMfa(u.mfa_pending_ciphertext, who.user_id), code.trim())
      if (counter === null) throw authRefusal()
      await tx.execute(sql`UPDATE app_user SET mfa_secret_ciphertext=mfa_pending_ciphertext,
        mfa_enabled_at=clock_timestamp(),mfa_last_counter=${counter},mfa_pending_ciphertext=NULL,mfa_pending_until=NULL
        WHERE id=${who.user_id}::uuid`)
      codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'))
      await tx.execute(sql`DELETE FROM auth_recovery_code WHERE user_id=${who.user_id}::uuid`)
      for (const recovery of codes) await tx.execute(sql`INSERT INTO auth_recovery_code(user_id,code_hash)
        VALUES (${who.user_id}::uuid,${tokenHash(recovery)})`)
    } else {
      if(process.env.AUTH_ADMIN_MFA_REQUIRED==='true'&&['owner','superadmin'].includes(who.kind)){
        const keys=await tx.execute(sql`SELECT id FROM auth_passkey WHERE user_id=${who.user_id}::uuid AND revoked_at IS NULL
          AND ${process.env.PASSKEYS_ENABLED==='true'} AND rp_id=${process.env.WEBAUTHN_RP_ID??''} AND origin=${process.env.WEBAUTHN_ORIGIN??''}`)
        if(!keys.length)throw new UserError('ALTERNATIVE_REQUIRED','Keep a usable passkey before disabling your last required authenticator.')
      }
      await tx.execute(sql`UPDATE app_user SET mfa_secret_ciphertext=NULL,mfa_enabled_at=NULL,
        mfa_pending_ciphertext=NULL,mfa_pending_until=NULL,mfa_last_counter=-1 WHERE id=${who.user_id}::uuid`)
      await tx.execute(sql`DELETE FROM auth_recovery_code WHERE user_id=${who.user_id}::uuid`)
    }
    await tx.execute(sql`UPDATE user_session SET reauthenticated_at=NULL,
      strong_authenticated_at=CASE WHEN ${operation==='confirm'} THEN clock_timestamp() ELSE strong_authenticated_at END WHERE id=${who.id}::uuid`)
    // Factor changes end every other session; only this recently verified one survives.
    await tx.execute(sql`UPDATE user_session SET revoked_at=clock_timestamp()
      WHERE user_id=${who.user_id}::uuid AND id<>${who.id}::uuid AND revoked_at IS NULL`)
    await auditRow(tx, { actor: who.email, action: operation === 'confirm' ? 'mfa_enabled' : 'mfa_disabled', table: 'app_user', recordId: who.user_id })
    return { recoveryCodes: codes }
  })
}

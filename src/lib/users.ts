import 'server-only'
import { randomBytes, scrypt as scryptCb, createHash, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { causesOf } from './db-errors'
import type { Appearance, AppearanceMode, DetailLevel, ThemeName } from './appearance'
import { auditRow } from './audit-row'
import { authAttempt, authRefusal, authSucceeded, consumeFactor, liveAuth } from './auth-security'
import { type UserKind, aKind, isUserKind, mayAssign, mayManage, refuseKind } from './user-kinds'

/**
 * People, passwords and sessions.
 *
 * RISKS §15 said from the beginning that nothing here knew a person; §15b said
 * what that becomes once the port is reachable. This file is the half of the
 * answer that stores things; `gate.ts` is the half that refuses.
 *
 * NO NEW DEPENDENCY. Passwords are scrypt from `node:crypto`, which is a
 * memory-hard KDF and is in the platform. A password library would be one more
 * thing to keep patched in a system whose whole point is that one person can
 * hold all of it in their head.
 */

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/**
 * scrypt needs 128 × N × r bytes, and node:crypto's own default ceiling is
 * 32 MB — which the parameters below exceed, so every hash threw
 * "memory limit exceeded" until this was passed. Twice the requirement, so
 * raising the cost later does not immediately hit the ceiling again.
 */
const maxmemFor = (N: number, r: number) => 2 * 128 * N * r

/**
 * Cost parameters, stored WITH each hash rather than beside it. Raising them
 * later re-hashes on next sign-in instead of locking everybody out — which is
 * why the string carries N, r and p and the verifier reads them back.
 *
 * N=2^15 is about 100ms here. The number to care about is not the benchmark on
 * this machine but the one on the machine of somebody who stole the table.
 */
const COST = { N: 32768, r: 8, p: 1 }
const KEYLEN = 64

export class UserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'UserError'
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEYLEN,
                           { ...COST, maxmem: maxmemFor(COST.N, COST.r) })
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

/**
 * Constant time, and false rather than throwing on a malformed stored hash — a
 * verifier that throws tells an attacker something a verifier that returns
 * false does not.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, keyB64] = parts
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(keyB64, 'base64')
  let actual: Buffer
  try {
    actual = await scrypt(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
      // From the stored parameters, not from COST: an old hash made with
      // different ones must still verify.
      maxmem: maxmemFor(Number(n), Number(r)),
    })
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * What goes in `audit_log.actor`, `created_by` and every column like them.
 *
 * The EMAIL, not the id and not the display name: unique, readable years
 * later, and recorded as it was at the time of the action — an audit trail is
 * a snapshot of who somebody was, so renaming them afterwards must not rewrite
 * what the books say happened. Replaces `WEB_ACTOR`, which recorded the
 * surface a change came through because nothing knew a person (RISKS §15).
 *
 * It lives HERE and not in `gate.ts` because it is about a user record and not
 * about a request — and because `gate.ts` imports `next/navigation`, which
 * drags React's client context into anything that touches it. A check could
 * not import it at all until it moved.
 */
export const actorOf = (user: Pick<UserRecord, 'email'>): string => user.email

/** A session token: 32 random bytes for the browser, its SHA-256 for the table. */
export const newToken = () => randomBytes(32).toString('base64url')
export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex')

/** How long a session lasts without being used. */
export const SESSION_DAYS = 30

export type UserRecord = {
  id: string
  email: string
  first_name: string
  last_name: string | null
  /** Derived, never stored: a third copy would drift the first time somebody is renamed. */
  display_name: string
  /** superadmin, owner or user — the ladder is in user-kinds.ts. */
  kind: UserKind
  /** Derived in the table (kind <> 'user'): may administer. */
  is_owner: boolean
  /** Separately granted folder access; company and module grants still apply. */
  webdav_enabled: boolean
  /** How this person's screen looks (0067). Read by the shell, chosen in Settings. */
  theme: ThemeName
  appearance_mode: AppearanceMode
  detail: DetailLevel
  liquid_tint: string
  is_active: boolean
  created_at: string
  last_seen_at: string | null
  mfa_enabled?: boolean
  strong_auth?: boolean
  passkeys_enabled?: boolean
}

const cleanEmail = (raw: string) => {
  const email = raw.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new UserError('BAD_EMAIL', `"${raw}" does not read as an email address.`)
  }
  return email
}

/**
 * The one rule about passwords, and it is length.
 *
 * Not "one capital, one digit, one symbol": those rules push people towards
 * Passw0rd! and towards writing it down. Length is what scrypt is defending.
 */
const checkedPassword = (password: string) => {
  if (password.length < 12) {
    throw new UserError('WEAK_PASSWORD',
      'A password needs at least 12 characters. Length is what makes it hard to '
      + 'guess — a long ordinary sentence beats a short clever one.')
  }
  if (password.length > 256) {
    throw new UserError('LONG_PASSWORD', 'That is longer than 256 characters.')
  }
  return password
}

/** Nobody has signed up yet — the only state in which anybody may. */
export async function noUsersYet(): Promise<boolean> {
  const [row] = await db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM app_user WHERE is_active`)
  return row.n === '0'
}

export function listUsers() {
  return db.execute<UserRecord>(sql`
    SELECT id::text, email, first_name, last_name,
           concat_ws(' ', first_name, last_name) AS display_name,
           kind, is_owner, webdav_enabled, is_active, created_at::text, last_seen_at::text
      FROM app_user
     ORDER BY is_active DESC, last_name NULLS LAST, first_name`)
}

export async function createUser(input: {
  email: string; firstName: string; lastName?: string | null; password: string
  kind?: UserKind; actor: string
}): Promise<UserRecord> {
  const email = cleanEmail(input.email)
  const firstName = input.firstName.trim()
  const lastName = (input.lastName ?? '').trim() || null
  if (!firstName) throw new UserError('NO_NAME', 'What is this person called?')
  const hash = await hashPassword(checkedPassword(input.password))
  try {
    const [row] = await db.execute<UserRecord>(sql`
      INSERT INTO app_user (email, first_name, last_name, password_hash, kind, created_by)
      VALUES (${email}, ${firstName}, ${lastName}, ${hash},
              ${input.kind ?? 'user'}, ${input.actor})
      RETURNING id::text, email, first_name, last_name,
                concat_ws(' ', first_name, last_name) AS display_name,
                kind, is_owner, webdav_enabled, is_active, created_at::text, last_seen_at::text`)
    return row
  } catch (e) {
    if (causesOf(e).includes('app_user_email_key')) {
      throw new UserError('EMAIL_TAKEN', `${email} already has an account.`)
    }
    throw e
  }
}

/**
 * The FIRST account. Allowed only while there are none — otherwise anybody who
 * can reach the page could make themselves an owner, which is the whole thing
 * this file exists to prevent.
 */
export async function createFirstOwner(input: {
  email: string; firstName: string; lastName?: string | null; password: string
}): Promise<UserRecord> {
  if (!(await noUsersYet())) {
    throw new UserError('ALREADY_SET_UP',
      'This system already has users. Ask an owner to make you an account.')
  }
  // The first account is the superadmin: the one kind that can make owners.
  return createUser({ ...input, kind: 'superadmin', actor: 'first run' })
}

/**
 * A real hash to verify against when there is nothing to verify against.
 *
 * It has to be a hash `verifyPassword` will actually COMPUTE. The first version
 * used `scrypt$1$1$1$AAAA$AAAA`, and N=1 is not a legal scrypt parameter, so it
 * threw and the catch returned false in 0.6 ms against 88 ms for a real
 * verify — the timing defence it was written to be did not run at all
 * (critic measured both). These are the live parameters, so the work matches.
 */
const DUMMY_HASH =
  `scrypt$${COST.N}$${COST.r}$${COST.p}$${Buffer.alloc(16).toString('base64')}`
  + `$${Buffer.alloc(KEYLEN).toString('base64')}`

/**
 * Sign in. One refusal for every way of failing — a wrong address and a wrong
 * password must not be distinguishable, or the form becomes a way to find out
 * who has an account here.
 */
export async function signIn(input: {
  email: string; password: string; userAgent?: string
  clientIp?: string; factor?: string
  /**
   * A session token the caller is about to overwrite. Signing in again
   * replaced the cookie and left the old row LIVE for thirty days — pointed at
   * by nothing and revocable by nobody who could see it (critic).
   */
  replaces?: string
}): Promise<{ token: string; user: UserRecord }> {
  const wrong = authRefusal()
  await authAttempt('login', input.email, input.clientIp)
  let email: string
  try {
    email = cleanEmail(input.email)
  } catch {
    // A malformed address still costs a hash, so timing does not answer
    // "is this even a user here".
    await verifyPassword(input.password, DUMMY_HASH)
    throw wrong
  }

  const [found] = await db.execute<UserRecord & { password_hash: string }>(sql`
    SELECT id::text, email, first_name, last_name,
           concat_ws(' ', first_name, last_name) AS display_name,
           kind, is_owner, webdav_enabled, is_active, created_at::text, last_seen_at::text, password_hash
      FROM app_user WHERE email = ${email}`)

  // Verify against SOMETHING either way, so an unknown address does not return
  // faster than a known one.
  const ok = await verifyPassword(input.password, found?.password_hash ?? DUMMY_HASH)
  if (!found || !ok || !found.is_active) throw wrong

  const factor = input.factor?.trim() ?? ''
  // Separate second-factor protection, independent from the password budget.
  await authAttempt(/^\d{6}$/.test(factor) ? 'totp' : 'recovery', email, input.clientIp)
  return db.transaction(async tx => {
    const [current] = await tx.execute<{password_hash:string;is_active:boolean;mfa_secret_ciphertext:string|null;kind:string}>(sql`
      SELECT password_hash,is_active,mfa_secret_ciphertext,kind FROM app_user WHERE id=${found.id}::uuid FOR UPDATE`)
    if (!current?.is_active || current.password_hash !== found.password_hash) throw wrong
    if(process.env.AUTH_ADMIN_MFA_REQUIRED==='true'&&['owner','superadmin'].includes(current.kind)&&!current.mfa_secret_ciphertext){
      const keys=await tx.execute(sql`SELECT id FROM auth_passkey WHERE user_id=${found.id}::uuid AND revoked_at IS NULL LIMIT 1`)
      if(keys.length)throw wrong
    }
    if (current.mfa_secret_ciphertext) {
      if (!factor) throw wrong
      await consumeFactor(tx, found.id, current.mfa_secret_ciphertext, factor, !/^\d{6}$/.test(factor))
    }
    if (input.replaces) await tx.execute(sql`UPDATE user_session SET revoked_at=clock_timestamp()
      WHERE token_hash=${tokenHash(input.replaces)} AND revoked_at IS NULL`)
    await authSucceeded(tx,'login',email,input.clientIp)
    await authSucceeded(tx,/^\d{6}$/.test(factor)?'totp':'recovery',email,input.clientIp)
    const token = newToken()
    await tx.execute(sql`INSERT INTO user_session(user_id,token_hash,expires_at,user_agent,reauthenticated_at,strong_authenticated_at)
      VALUES (${found.id}::uuid,${tokenHash(token)},now()+${`${SESSION_DAYS} days`}::interval,
              ${input.userAgent ?? null},clock_timestamp(),CASE WHEN ${!!current.mfa_secret_ciphertext} THEN clock_timestamp() ELSE NULL END)`)
    await tx.execute(sql`UPDATE app_user SET last_seen_at=now() WHERE id=${found.id}::uuid`)
    const user = Object.fromEntries(Object.entries(found).filter(([key]) => key !== 'password_hash')) as UserRecord
    return { token, user }
  })
}

/**
 * Who is asking, or null. Reads the session, checks it is live, and slides its
 * expiry forward — a session in daily use should not end mid-month.
 */
/**
 * How this person wants it to look, saved (0067).
 *
 * Their own row and nobody else's: there is no version of this that takes a
 * user id, because there is no version of this act that is done to somebody
 * else. The values are checked in the database as well — `appearanceFrom`
 * turns anything unexpected into the default before it gets here.
 */
export async function saveAppearance(userId: string, look: Appearance): Promise<void> {
  await db.execute(sql`
    UPDATE app_user SET theme = ${look.theme}, appearance_mode = ${look.mode},
                        liquid_tint = ${look.liquidTint}
     WHERE id = ${userId}::uuid`)
}

export async function userForToken(token: string): Promise<UserRecord | null> {
  if (!token) return null
  const [row] = await db.execute<UserRecord & { session_id: string }>(sql`
    SELECT u.id::text, u.email, u.first_name, u.last_name,
           concat_ws(' ', u.first_name, u.last_name) AS display_name,
           u.kind, u.is_owner, u.webdav_enabled, u.is_active, u.theme, u.appearance_mode, u.detail, u.liquid_tint,
           u.created_at::text, u.last_seen_at::text, (u.mfa_enabled_at IS NOT NULL) AS mfa_enabled,
           (s.strong_authenticated_at IS NOT NULL) AS strong_auth,
           EXISTS(SELECT 1 FROM auth_passkey WHERE user_id=u.id AND revoked_at IS NULL) AS passkeys_enabled, s.id::text AS session_id
      FROM user_session s
      JOIN app_user u ON u.id = s.user_id
     WHERE s.token_hash = ${tokenHash(token)}
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.is_active`)
  if (!row) return null

  await db.execute(sql`
    UPDATE user_session
       SET last_seen_at = now(), expires_at = now() + ${`${SESSION_DAYS} days`}::interval
     WHERE id = ${row.session_id}::uuid`)

  const user = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'session_id')) as Omit<typeof row, 'session_id'>
  return user
}

export async function signOut(token: string): Promise<void> {
  await db.execute(sql`
    UPDATE user_session SET revoked_at = now()
     WHERE token_hash = ${tokenHash(token)} AND revoked_at IS NULL`)
}

/** Every live session of one person — and the way to end them all. */
export function sessionsOf(userId: string) {
  return db.execute<{
    id: string; created_at: string; last_seen_at: string; expires_at: string
    user_agent: string | null
  }>(sql`
    SELECT id::text, created_at::text, last_seen_at::text, expires_at::text, user_agent
      FROM user_session
     WHERE user_id = ${userId}::uuid AND revoked_at IS NULL AND expires_at > now()
     ORDER BY last_seen_at DESC`)
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE user_session SET revoked_at = now()
     WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`)
}

export async function setPassword(input: {
  userId: string; password: string; actor: string; sessionToken?: string
}): Promise<void> {
  const hash = await hashPassword(checkedPassword(input.password))
  await db.transaction(async (tx) => {
    const caller = input.sessionToken === undefined ? null : await liveAuth(tx, input.sessionToken, true)
    if (caller) {
      if (caller.email !== input.actor || !['owner','superadmin'].includes(caller.kind)) throw authRefusal()
    }
    const [who] = await tx.execute<{ email: string; kind: UserKind }>(sql`
      SELECT email,kind FROM app_user WHERE id = ${input.userId}::uuid FOR UPDATE`)
    if (!who) throw new UserError('NO_SUCH_USER', 'Nobody by that id.')
    if(caller && caller.user_id!==input.userId && !mayManage({id:caller.user_id,kind:caller.kind as UserKind},{id:input.userId,kind:who.kind}))
      throw new UserError('OUTRANKED','Your current role cannot reset this password.')
    await tx.execute(sql`
      UPDATE app_user SET password_hash = ${hash}, updated_at = now()
       WHERE id = ${input.userId}::uuid`)
    // Every session, INCLUDING the one doing it. Somebody changing a password
    // after a scare wants everything that holds the old one dead, and there is no
    // way to tell "the browser I am in" from "the browser they are in" here.
    // Whoever does it signs in again — which is the cheap half of the trade.
    // `US9` asserts exactly this; the comment used to claim the opposite.
    const ended = await tx.execute<{ id: string }>(sql`
      UPDATE user_session SET revoked_at = now()
       WHERE user_id = ${input.userId}::uuid AND revoked_at IS NULL
       RETURNING id::text`)
    // A password reset after a scare must also end the separate Finder
    // passwords. Otherwise a WebDAV client keeps reading the same paper after
    // every browser session has been signed out.
    const davEnded = await tx.execute<{ id: string }>(sql`
      UPDATE webdav_credential SET revoked_at = now()
       WHERE user_id = ${input.userId}::uuid AND revoked_at IS NULL
       RETURNING id::text`)
    const mcpEnded=await tx.execute(sql`UPDATE mcp_credential SET revoked_at=clock_timestamp() WHERE user_id=${input.userId}::uuid AND revoked_at IS NULL RETURNING id`)
    const keysEnded=await tx.execute(sql`UPDATE auth_passkey SET revoked_at=clock_timestamp() WHERE user_id=${input.userId}::uuid AND revoked_at IS NULL RETURNING id`)
    await tx.execute(sql`UPDATE auth_webauthn_challenge SET consumed_at=clock_timestamp() WHERE user_id=${input.userId}::uuid AND consumed_at IS NULL`)
    // The one door that must never record what it changed — so it records
    // that it changed it, by whom, and how many sessions that ended (`US34`).
    await auditRow(tx, {
      actor: input.actor, action: 'set_password', table: 'app_user', recordId: input.userId,
      after: { sessions_signed_out: ended.length,
               webdav_passwords_revoked: davEnded.length,mcp_credentials_revoked:mcpEnded.length,passkeys_revoked:keysEnded.length },
      context: { email: who.email },
    })
  })
}

export async function setUserStatus(input: {
  userId: string; isActive?: boolean; actor: string
}): Promise<void> {
  const before = await userById(input.userId)
  if (!before) throw new UserError('NO_SUCH_USER', 'Nobody by that id.')
  const after = { ...before, is_active: input.isActive ?? before.is_active }
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE app_user
           SET is_active = COALESCE(${input.isActive ?? null}::boolean, is_active),
               updated_at = now()
         WHERE id = ${input.userId}::uuid`)
      if (input.isActive === false) await tx.execute(sql`
        UPDATE webdav_credential SET revoked_at = now()
         WHERE user_id = ${input.userId}::uuid AND revoked_at IS NULL`)
      if (input.isActive === false) await tx.execute(sql`
        UPDATE mcp_credential SET revoked_at=clock_timestamp()
        WHERE user_id=${input.userId}::uuid AND revoked_at IS NULL`)
      await audited(tx, input.actor, 'set_status', before, after)
    })
  } catch (e) {
    lastSuperadmin(e)
  }
  if (input.isActive === false) await revokeAllSessions(input.userId)
}

/**
 * The people doors write their own trail. `app_user` has no audit trigger
 * (0053 attached none), so until the critic's round on 0057 a deletion or a
 * change of kind left no row saying who did it or when — the one kind of
 * history this table must not lose. Same transaction as the change; the
 * record is a UserRecord, which never carries the password hash.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
const audited = (
  tx: Tx, actor: string, action: 'set_status' | 'set_kind' | 'delete_user' | 'set_identity',
  before: UserRecord | null, after: UserRecord | null,
) => auditRow(tx, {
  actor, action, table: 'app_user', recordId: (before ?? after)!.id, before, after,
})

/** The trigger's refusal, in a sentence — shared by every door it can shut. */
const lastSuperadmin = (e: unknown): never => {
  if (causesOf(e).includes('LAST_SUPERADMIN')) {
    throw new UserError('LAST_SUPERADMIN',
      'Somebody has to be able to administer this. Make another user a superadmin first.')
  }
  throw e
}

/** One person by id, or null. */
export async function userById(id: string, on: import('./acting').Runner = db): Promise<UserRecord | null> {
  const [row] = await on.execute<UserRecord>(sql`
    SELECT id::text, email, first_name, last_name,
           concat_ws(' ', first_name, last_name) AS display_name,
           kind, is_owner, webdav_enabled, is_active, created_at::text, last_seen_at::text
      FROM app_user WHERE id = ${id}::uuid`)
  return row ?? null
}

/**
 * The ladder, applied (owner, 2026-09-04): an owner manages users; a
 * superadmin manages owners and users; nobody manages themselves here.
 *
 * Every door that changes somebody — sign off, password, access, kind,
 * delete — asks this first. Without it an owner could reset the superadmin's
 * password and walk in as them, which would make the rung decorative.
 */
export async function assertMayManage(actor: UserRecord, userId: string): Promise<UserRecord> {
  const target = await userById(userId)
  if (!target) throw new UserError('NO_SUCH_USER', 'Nobody by that id.')
  if (target.id === actor.id) {
    throw new UserError('NOT_YOURSELF',
      'Not on your own account — ask another administrator.')
  }
  if (!mayManage(actor, target)) {
    throw new UserError('OUTRANKED',
      `An owner manages users. Only a superadmin can change ${target.display_name}, `
      + `who is ${aKind(target.kind)}.`)
  }
  return target
}

export async function setUserKind(input: {
  userId: string; kind: UserKind; actor: UserRecord
}): Promise<void> {
  if (!isUserKind(input.kind)) {
    throw new UserError('BAD_KIND', `"${input.kind}" is not a kind of person.`)
  }
  const target = await assertMayManage(input.actor, input.userId)
  if (!mayAssign(input.actor, input.kind)) {
    throw new UserError(input.kind === 'superadmin' ? 'ONE_SUPERADMIN' : 'OUTRANKED',
      refuseKind(input.kind))
  }
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE app_user SET kind = ${input.kind}, updated_at = now()
         WHERE id = ${target.id}::uuid`)
      if (target.kind !== input.kind) await tx.execute(sql`
        UPDATE webdav_credential SET revoked_at = now()
         WHERE user_id = ${target.id}::uuid AND revoked_at IS NULL`)
      if (target.kind !== input.kind) await tx.execute(sql`
        UPDATE mcp_credential SET revoked_at=clock_timestamp()
        WHERE user_id=${target.id}::uuid AND revoked_at IS NULL`)
      await audited(tx, actorOf(input.actor), 'set_kind', target, { ...target, kind: input.kind })
    })
  } catch (e) {
    lastSuperadmin(e)
  }
}

/**
 * A person's name and email, put right (0084; owner, 2026-09-16:
 * 「所有的紀錄儘量都可以編輯刪除」). Your own is yours to change; anybody else's
 * is the ladder's, as a password is. Rows they already wrote keep the email
 * they were written under — that is text, not a key.
 */
export async function setUserIdentity(input: {
  userId: string; firstName: string; lastName?: string | null; email: string; actor: UserRecord
}): Promise<UserRecord> {
  const target = input.userId === input.actor.id ? input.actor : await assertMayManage(input.actor, input.userId)
  const email = cleanEmail(input.email)
  const firstName = input.firstName.trim()
  const lastName = (input.lastName ?? '').trim() || null
  if (!firstName) throw new UserError('NO_NAME', 'What is this person called?')
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.execute<UserRecord>(sql`
        UPDATE app_user SET first_name = ${firstName}, last_name = ${lastName}, email = ${email}, updated_at = now()
         WHERE id = ${target.id}::uuid
        RETURNING id::text, email, first_name, last_name,
                  concat_ws(' ', first_name, last_name) AS display_name,
                  kind, is_owner, webdav_enabled, is_active, created_at::text, last_seen_at::text`)
      await audited(tx, actorOf(input.actor), 'set_identity', target, row)
      return row
    })
  } catch (e) {
    if (causesOf(e).includes('app_user_email_key')) {
      throw new UserError('EMAIL_TAKEN', `${email} already has an account.`)
    }
    throw e
  }
}

/**
 * Gone. Their sessions and grants go with them (0057 cascades); every row
 * they wrote still names them, by email, because that is text and not a key.
 */
export async function deleteUser(input: { userId: string; actor: UserRecord }): Promise<UserRecord> {
  const target = await assertMayManage(input.actor, input.userId)
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM app_user WHERE id = ${target.id}::uuid`)
      await audited(tx, actorOf(input.actor), 'delete_user', target, null)
    })
  } catch (e) {
    lastSuperadmin(e)
  }
  return target
}

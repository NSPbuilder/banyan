import 'server-only'
import {
  UserError, type UserRecord, actorOf, assertMayManage, createFirstOwner, createUser,
  deleteUser, setPassword, setUserIdentity, setUserKind, setUserStatus, signIn,
} from './users'
import { aKind, isUserKind, mayAssign, refuseKind } from './user-kinds'
import { g, USER_FIELDS, type UserFormResult } from './forms'
import { AccessError, setGrantMatrix, setGrants, setWebDavAccess } from './access'
import { causesOf } from './db-errors'

/**
 * Reading the sign-in and user forms. Separate from `app/actions.ts` for the
 * reason every other *-forms.ts is: a check can call this and cannot call a
 * server action.
 */



/**
 * Where to send somebody after they sign in — and nowhere else.
 *
 * `next` comes from the URL, so it is attacker-supplied end to end. The first
 * version tested `/^\/(?!\/)/`, which reads as "one slash, then not another"
 * and is not what a browser does: `/\evil.com` passes it, and resolving that
 * against the origin gives `http://evil.com/` — the browser treats a backslash
 * as a slash. `/\/evil.com` too. Verified with the same WHATWG URL parser a
 * browser uses (critic).
 *
 * So it is not guessed with a pattern. The value is RESOLVED against this
 * origin and the result must still be on it; anything else is home.
 */
const HERE = 'http://erp.invalid'
export function somewhereHere(wanted: string): string {
  if (!wanted.startsWith('/')) return '/'
  // A control character can end a header line; nothing legitimate carries one.
  if (/[\u0000-\u001f\u007f]/.test(wanted)) return '/'
  try {
    const url = new URL(wanted, HERE)
    return url.origin === HERE ? url.pathname + url.search : '/'
  } catch {
    return '/'
  }
}

/** What to show somebody. A UserError was written for them; nothing else was. */
const said = (e: unknown) =>
  e instanceof UserError ? e.message : 'Something went wrong signing in.'

export async function signInFromForm(f: FormData, replaces?: string, clientIp?: string): Promise<UserFormResult> {
  try {
    const { token } = await signIn({
      email: g(f, USER_FIELDS.email),
      password: String(f.get(USER_FIELDS.password) ?? ''),
      userAgent: g(f, 'userAgent') || undefined,
      replaces, clientIp, factor: g(f, 'factor'),
    })
    return { ok: 'Signed in.', token, next: somewhereHere(g(f, USER_FIELDS.next)) }
  } catch (e) {
    return { error: said(e) }
  }
}

export async function firstRunFromForm(f: FormData): Promise<UserFormResult> {
  try {
    await createFirstOwner({
      email: g(f, USER_FIELDS.email),
      firstName: g(f, USER_FIELDS.firstName),
      lastName: g(f, USER_FIELDS.lastName) || null,
      password: String(f.get(USER_FIELDS.password) ?? ''),
    })
    const { token } = await signIn({
      email: g(f, USER_FIELDS.email),
      password: String(f.get(USER_FIELDS.password) ?? ''),
    })
    return { ok: 'Account created.', token, next: '/' }
  } catch (e) {
    return { error: e instanceof UserError ? e.message : String(e) }
  }
}

/**
 * Every door below takes the ACTING PERSON, not their email: the ladder in
 * user-kinds.ts is judged on who they are, and `assertMayManage` is asked
 * before anything is changed about somebody else.
 */
export async function createUserFromForm(f: FormData, actor: UserRecord): Promise<UserFormResult> {
  try {
    const kind = f.get(USER_FIELDS.kind) ?? 'user'
    if (!isUserKind(kind)) throw new UserError('BAD_KIND', `"${String(kind)}" is not a kind of person.`)
    if (!mayAssign(actor, kind)) {
      throw new UserError(kind === 'superadmin' ? 'ONE_SUPERADMIN' : 'OUTRANKED', refuseKind(kind))
    }
    const user = await createUser({
      email: g(f, USER_FIELDS.email),
      firstName: g(f, USER_FIELDS.firstName),
      lastName: g(f, USER_FIELDS.lastName) || null,
      password: String(f.get(USER_FIELDS.password) ?? ''),
      kind,
      actor: actorOf(actor),
    })
    return { ok: `${user.display_name} can now sign in.` }
  } catch (e) {
    return { error: e instanceof UserError ? e.message : String(e) }
  }
}

export async function setPasswordFromForm(f: FormData, actor: UserRecord, sessionToken?: string): Promise<UserFormResult> {
  try {
    const userId = g(f, USER_FIELDS.userId)
    // Your own password is yours to change; anybody else's is the ladder's.
    if (userId !== actor.id) await assertMayManage(actor, userId)
    await setPassword({ userId, password: String(f.get(USER_FIELDS.password) ?? ''), actor: actorOf(actor), sessionToken })
    return {
      ok: userId === actor.id
        ? 'Password changed. Every session has been signed out, including this one.'
        : 'Password changed. Every session that person had has been signed out.',
    }
  } catch (e) {
    return { error: e instanceof UserError ? e.message : 'Password reset unavailable. Try again after verifying your identity.' }
  }
}

/** A name and email put right — your own, or somebody the ladder lets you manage (0084). */
export async function setIdentityFromForm(f: FormData, actor: UserRecord): Promise<UserFormResult> {
  try {
    const saved = await setUserIdentity({
      userId: g(f, USER_FIELDS.userId), firstName: g(f, USER_FIELDS.firstName),
      lastName: g(f, USER_FIELDS.lastName), email: g(f, USER_FIELDS.email), actor,
    })
    return { ok: `Saved: ${saved.display_name}, ${saved.email}.` }
  } catch (e) {
    return { error: e instanceof UserError ? e.message : String(e) }
  }
}

export async function setStatusFromForm(f: FormData, actor: UserRecord): Promise<UserFormResult> {
  try {
    const userId = g(f, USER_FIELDS.userId)
    await assertMayManage(actor, userId)
    await setUserStatus({ userId, isActive: f.get('setActive') === 'true', actor: actorOf(actor) })
    return { ok: 'Saved.' }
  } catch (e) {
    return { error: e instanceof UserError ? e.message : String(e) }
  }
}

export async function setKindFromForm(f: FormData, actor: UserRecord): Promise<UserFormResult> {
  try {
    const kind = f.get(USER_FIELDS.kind)
    if (!isUserKind(kind)) throw new UserError('BAD_KIND', `"${String(kind)}" is not a kind of person.`)
    await setUserKind({ userId: g(f, USER_FIELDS.userId), kind, actor })
    return { ok: `Saved — now ${aKind(kind)}.` }
  } catch (e) {
    return { error: e instanceof UserError ? e.message : String(e) }
  }
}

export async function deleteUserFromForm(f: FormData, actor: UserRecord): Promise<UserFormResult> {
  try {
    const gone = await deleteUser({ userId: g(f, USER_FIELDS.userId), actor })
    return { ok: `${gone.display_name} has been deleted. Everything they did still names ${gone.email}.` }
  } catch (e) {
    return { error: e instanceof UserError ? e.message : String(e) }
  }
}

export async function setGrantsFromForm(f: FormData, actor: UserRecord): Promise<UserFormResult> {
  try {
    const userId = g(f, USER_FIELDS.userId)
    const mode = g(f, USER_FIELDS.grantMode)
    // Only an administrator choosing their own WebDAV setting is an exception
    // to the ordinary management ladder. Check the ladder before form details.
    if (mode !== 'webdav' || userId !== actor.id || !actor.is_owner) {
      await assertMayManage(actor, userId)
    }
    const reason = g(f, USER_FIELDS.reason).trim()
    if (!reason) return { error: 'Say why this person\'s access is changing.' }
    const webdavEnabled = f.get(USER_FIELDS.webdavEnabled) === 'true'
    if (mode === 'webdav') {
      // The superadmin has no manager. An administrator may choose their own
      // folder access, but nobody else may grant it to themselves.
      await setWebDavAccess({ userId, enabled: webdavEnabled, actor: actorOf(actor), reason })
    } else if (mode === 'matrix') {
      const grants = f.getAll(USER_FIELDS.grant).map(String).filter(Boolean).map((value) => {
        const split = value.indexOf('|')
        if (split < 1) throw new AccessError('BAD_GRANT', 'One access choice was not understood.')
        return { entityId: value.slice(0, split), module: value.slice(split + 1) }
      })
      await setGrantMatrix({ userId, grants, actor: actorOf(actor), reason, webdavEnabled })
    } else {
      // Compatibility for scripts and older forms: two independent lists mean
      // their Cartesian product, exactly as they did before 0087.
      await setGrants({
        userId,
        entityIds: f.getAll(USER_FIELDS.entityId).map(String).filter(Boolean),
        modules: f.getAll(USER_FIELDS.module).map(String),
        actor: actorOf(actor),
        reason,
      })
    }
    return { ok: 'Saved. They will see it the next time they load a page.' }
  } catch (e) {
    return { error: e instanceof AccessError ? e.message : causesOf(e) }
  }
}

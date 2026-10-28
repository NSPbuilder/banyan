/**
 * Three kinds of person (owner, 2026-09-04): superadmin, owner, user.
 *
 * Pure — no database, no 'server-only' — because the screen decides which
 * buttons to draw with the SAME function the library refuses with. Two
 * copies of a ladder drift the first time a rung is added.
 *
 * The ladder, as the owner ruled it (2026-09-04, "1不可以，2不能，3不保留"):
 *   - there is exactly ONE superadmin — the account that set the system up.
 *     Nobody can be made a second (here, and 0059's unique index in the
 *     table), and nobody manages a superadmin — so that account is
 *     permanent: only they change their password;
 *   - the superadmin manages owners and users;
 *   - an owner manages users, and no other owner;
 *   - nobody manages themselves, because the one thing you must not be able
 *     to do from your own row is lock yourself out or promote yourself.
 */
export type UserKind = 'superadmin' | 'owner' | 'user'

export const USER_KINDS: readonly UserKind[] = ['superadmin', 'owner', 'user'] as const

export const isUserKind = (v: unknown): v is UserKind =>
  USER_KINDS.includes(v as UserKind)

type Person = { id: string; kind: UserKind }

/** May `actor` sign off, reset, grant to, re-kind, or delete `target`? */
export function mayManage(actor: Person, target: Person): boolean {
  if (actor.id === target.id) return false
  if (target.kind === 'superadmin') return false
  if (actor.kind === 'superadmin') return true
  if (actor.kind === 'owner') return target.kind === 'user'
  return false
}

/** Which kinds `actor` may hand out — on creation or by changing somebody's. */
export function mayAssign(actor: Pick<Person, 'kind'>, kind: UserKind): boolean {
  if (kind === 'superadmin') return false
  if (actor.kind === 'superadmin') return true
  return actor.kind === 'owner' && kind === 'user'
}

export const assignableBy = (actor: Pick<Person, 'kind'>): UserKind[] =>
  USER_KINDS.filter((k) => mayAssign(actor, k))

/** "a user", "an owner", "a superadmin" — for a sentence. */
export const aKind = (k: UserKind) => (k === 'owner' ? 'an owner' : `a ${k}`)

/** Why `kind` cannot be handed out, in a sentence — the same one at every door. */
export const refuseKind = (kind: UserKind) =>
  kind === 'superadmin'
    ? 'There is exactly one superadmin — the account that set this system up.'
    : `Only a superadmin can make somebody ${aKind(kind)}.`

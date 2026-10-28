import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * Who is acting, said once per transaction.
 *
 * Half of the audit trail is written by the application, which names the
 * signed-in person. The other half is written by triggers — a draft
 * discarded, an account renamed, a year closed — and a trigger can only see
 * the Postgres role. 0060 puts a trigger at the door of audit_log that swaps
 * the role's name for `app.actor` when the transaction has set it; this is
 * where it is set. Transaction-local (`set_config(..., true)`), so it cannot
 * leak to the next request on a pooled connection and there is nothing to
 * reset.
 *
 * A write that fires an audit trigger and does not go through here writes
 * the role's name, which every suite that touches such a table now refuses
 * (`roleNamedRows` in scripts/actor-trail.ts). That check is the reason this
 * can be a convention rather than a wrapper around every statement.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * What a door writes through: the pool, or a transaction somebody else opened.
 *
 * A door that takes one (defaulting to the pool) is called exactly as before by
 * a screen entering one thing — and a form entering twelve rows at once hands
 * all twelve the same transaction, so the twelfth refused takes the other
 * eleven back with it (the corporate record's add forms, 2026-09-16). A door
 * that opens a transaction of its own opens it ON the runner, which inside a
 * transaction is a savepoint.
 */
export type Runner = typeof db | Tx

export const acting = (tx: Tx, actor: string) =>
  tx.execute(sql`SELECT set_config('app.actor', ${actor}, true)`)

/** A transaction that begins by saying who is acting. */
export const actingAs = <T>(actor: string, fn: (tx: Tx) => Promise<T>, on: Runner = db): Promise<T> =>
  on.transaction(async (tx) => {
    await acting(tx, actor)
    return fn(tx)
  })

/**
 * One bank account at a time, for the doors that change what a statement
 * reconciles against: rows, matches, ignores, statements, and Finish itself.
 *
 * Finish computes the difference inside its own snapshot (0055). An import or
 * a match that commits between that read and Finish's commit leaves a finished
 * statement whose difference is no longer zero, and the freeze then holds the
 * rows at that figure (RISKS §21b). A transaction-scoped advisory lock keyed on
 * the account makes the three serialise; it is released with the transaction,
 * so nothing can forget to unlock. The key is hashed from a prefixed string so
 * it cannot collide with any other advisory lock this system might grow.
 */
export const lockBankAccount = (tx: Tx, accountId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('bank_account:' || ${accountId}, 0))`)

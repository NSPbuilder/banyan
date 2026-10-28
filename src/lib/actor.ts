/**
 * Who a change is recorded as — HISTORICALLY.
 *
 * This file used to be the answer. It is now the record of what the answer was
 * before 0053, kept because the audit trail still contains these values and a
 * reader in 2028 has to be able to tell what `web` meant.
 *
 * **The answer today is `gate.ts`**: `currentActor()` returns the signed-in
 * person's email, and every form handler passes that. RISKS §15 said this had
 * to happen before a second person ever touched the books, because the history
 * written in between could never be attributed afterwards.
 *
 * What the audit log recorded BEFORE that, and still contains:
 *
 *   WEB_ACTOR ('web')  a form in the browser
 *   'system'           a library call with no actor given
 *   anything else      a script, which passes its own
 *
 * That is less than it looks like. Migration 0016 exists because ending a
 * registration used to log `current_user`, the Postgres role — and it is worth
 * having, because the role is the same string for the web app and for every
 * script, so it could not tell them apart. But `ceased_by = 'web'` still does
 * not answer "who", and no report should be written as though it does. See
 * RISKS 15.
 */
/**
 * No longer written by anything. Kept exported so that a check can assert it is
 * unused — the value survives in old rows, and deleting the constant would make
 * those rows harder to read rather than easier.
 */
export const WEB_ACTOR = 'web'

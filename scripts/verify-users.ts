/**
 * People, passwords and sessions.
 *   npm run db:verify-users   (resets the database first)
 *
 * THE PROPERTIES THAT MATTER HERE ARE NOT "IT LETS ME IN". They are:
 *
 *   — a copy of the database is not a set of working credentials (`US3`, `US4`)
 *   — a forged, revoked or expired token is refused (`US7`, `US8`)
 *   — the two ways of failing a sign-in are indistinguishable, so the form is
 *     not a way to find out who has an account here (`US5`)
 *   — the system cannot be left with nobody able to administer it (`US11`)
 *
 * WHAT THIS SUITE CANNOT REACH: `gate.ts` reads `cookies()` from next/headers,
 * which needs a request context, so `requireUser`/`guardRoute` cannot be called
 * from a script at all. That is why `N14`, `N15` and `N16` in verify-shell.ts
 * read the source instead — every page and route reaching the gate, the backup
 * route being a POST behind an owner, and nothing still writing the old
 * placeholder actor. Neither half is enough alone and both are in the battery.
 */
import './env'
import { reporter } from './suite'
import { sql as raw } from 'drizzle-orm'
import { causesOf } from '../src/lib/db-errors'
import { db, sql as conn } from '../src/db/client'
import {
  UserError, actorOf, createFirstOwner, createUser, deleteUser, hashPassword, listUsers,
  noUsersYet, revokeAllSessions, sessionsOf, setPassword, setUserKind, setUserStatus,
  signIn, signOut, tokenHash, userById, userForToken, verifyPassword,
} from '../src/lib/users'
import {
  createUserFromForm, deleteUserFromForm, setGrantsFromForm, setKindFromForm,
  setIdentityFromForm, setPasswordFromForm, setStatusFromForm, somewhereHere,
} from '../src/lib/user-forms'
import { USER_FIELDS } from '../src/lib/forms'
import { execFileSync } from 'node:child_process'
import {
  AccessError, accessFor, grantsOf, mayOpenEntity, refuseFor,
  refuseForEntity, refuseForLedger, seatsFor, setGrants,
} from '../src/lib/access'
import {
  activeNavPath, DETAIL_ROUTES, GRANTABLE_MODULES, MODULE_PATHS,
} from '../src/lib/nav'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** A stand-in ledger id for asking nav.ts what a path would belong to. */
const LID = 'L'.repeat(36)
import { createCompanyWithYear } from '../src/lib/setup'

const r = reporter(58)
const { fail, check } = r

/**
 * The summary line and the exit, in ONE place — and the only way out.
 *
 * Every check below the fixtures needs somebody to be able to sign in, so a
 * broken password or a missing owner takes the whole suite down. A suite that
 * dies prints no summary, and `mutations.sh` cannot tell "no summary" from
 * "nothing was red" — it throws the whole run away instead, which is an hour.
 * Two of this node's own mutation blocks did exactly that until this existed.
 */
async function done(): Promise<never> {
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

/** A sign-in the suite depends on. Its failure is a red line, not a crash. */
async function mustSignIn(email: string, password: string, why: string) {
  try {
    return await signIn({ email, password })
  } catch (e) {
    fail(why, `could not sign in as ${email}: ${causesOf(e).slice(0, 90)}`)
    return null
  }
}

const PW = 'a long ordinary sentence'
/** A backslash, written this way so the source carries no escape puzzles. */
const BS = String.fromCharCode(92)
const said = async (what: () => Promise<unknown>) => {
  try { await what(); return '' } catch (e) {
    // `causesOf`, not String(e): a refusal raised by a trigger arrives wrapped
    // in "Failed query: …" and reading only the top has been mistaken for no
    // refusal three separate times in this repository.
    return e instanceof UserError ? `${e.code}: ${e.message}` : causesOf(e)
  }
}

async function main() {
  // ------------------------------------------------------------------- US1
  {
    const hash = await hashPassword(PW)
    const right = await verifyPassword(PW, hash)
    const wrong = await verifyPassword(PW + '!', hash)
    check(right && !wrong,
      'US1 a password verifies, and a different one does not',
      `right → ${right}, wrong → ${wrong}`)
  }

  // ------------------------------------------------------------------- US2
  // The cost parameters travel WITH the hash. A hash made under different ones
  // must still verify, or raising the cost later locks everybody out — and the
  // first version of this could not hash at all, because N=32768 with r=8 needs
  // 33.5 MB and node:crypto's own default ceiling is 32. It threw on every
  // attempt, the screen showed nothing, and no user was created.
  {
    const hash = await hashPassword(PW)
    const [scheme, n, r, p] = hash.split('$')
    // An older, cheaper hash: the shape a previous version would have written.
    const cheap = 'scrypt$16384$8$1$' + hash.split('$').slice(4).join('$')
    check(scheme === 'scrypt' && n === '32768' && r === '8' && p === '1'
          && hash.split('$').length === 6
          && (await verifyPassword('anything', cheap)) === false,
      'US2 the hash carries its own cost, so it can be raised later',
      `${scheme} N=${n} r=${r} p=${p}; a hash with other parameters is read, not rejected outright`)
  }

  // ------------------------------------------------------------------- US3
  // Two hashes of ONE password differ — there is a salt — and neither contains
  // the password. A table of hashes must not be a rainbow-table lookup.
  {
    const a = await hashPassword(PW)
    const b = await hashPassword(PW)
    check(a !== b && !a.includes(PW) && (await verifyPassword(PW, a)) && (await verifyPassword(PW, b)),
      'US3 the same password hashes differently every time',
      'salted; neither hash contains the password, both verify')
  }

  // -------------------------------------------------------------------------
  // Everything past here needs somebody who can sign in.
  let owner
  try {
    owner = await createFirstOwner({
      email: 'Owner@Example.Test', firstName: 'The', lastName: 'Owner', password: PW,
    })
  } catch (e) {
    fail('US4 the session table holds a hash, never the token',
      `no account could be created at all: ${causesOf(e).slice(0, 100)}`)
    return done()
  }

  // ------------------------------------------------------------------- US4
  // The cookie's value is NEVER stored. Whoever holds the raw token holds the
  // session; a stolen database must not be a set of live sessions.
  {
    const first = await mustSignIn('owner@example.test', PW,
      'US4 the session table holds a hash, never the token')
    if (!first) return done()
    const { token } = first
    const [row] = await db.execute<{ token_hash: string }>(raw`
      SELECT token_hash FROM user_session ORDER BY created_at DESC LIMIT 1`)
    const [anywhere] = await db.execute<{ n: string }>(raw`
      SELECT COUNT(*)::text AS n FROM user_session WHERE token_hash = ${token}`)
    check(row.token_hash === tokenHash(token) && row.token_hash !== token
          && row.token_hash.length === 64 && anywhere.n === '0',
      'US4 the session table holds a hash, never the token',
      `stored ${row.token_hash.slice(0, 16)}… (${row.token_hash.length} hex chars); `
      + 'the raw token appears in no row')
  }

  // ------------------------------------------------------------------- US5
  // A wrong password and an address with no account must be INDISTINGUISHABLE,
  // or the form answers "does this person have an account here".
  {
    // The MESSAGE and the WORK. Comparing only the message is what the first
    // version did, and it passed while the malformed-address path returned in
    // 0.6 ms against 88 ms for the other two — because the dummy hash it
    // verified against had illegal parameters, so scrypt threw instead of
    // computing and the timing defence never ran (critic measured it).
    //
    // The floor is deliberately far below the ~90 ms a real verify costs: this
    // is asking "did it do the work at all", not benchmarking the machine.
    const timed = async (what: () => Promise<unknown>) => {
      const at = performance.now()
      const message = await said(what)
      return { message, ms: performance.now() - at }
    }
    const wrong = await timed(() =>
      signIn({ email: 'owner@example.test', password: 'not the password' }))
    const unknown = await timed(() => signIn({ email: 'nobody@example.test', password: PW }))
    const malformed = await timed(() => signIn({ email: 'not an email', password: PW }))

    const FLOOR = 15
    const tooFast = [['wrong password', wrong], ['unknown address', unknown],
                     ['malformed address', malformed]]
      .filter(([, r]) => (r as { ms: number }).ms < FLOOR)
      .map(([n, r]) => `${n} in ${(r as { ms: number }).ms.toFixed(1)}ms`)

    check(wrong.message === unknown.message && unknown.message === malformed.message
          && wrong.message.startsWith('BAD_CREDENTIALS') && tooFast.length === 0,
      'US5 one refusal, and the same work, whichever half was wrong',
      wrong.message !== unknown.message
        ? `wrong password: ${wrong.message} | unknown: ${unknown.message}`
        : tooFast.length > 0
          ? `answered without hashing: ${tooFast.join(', ')} (floor ${FLOOR}ms)`
          : `all three "${wrong.message.slice(0, 40)}…" in `
            + `${[wrong, unknown, malformed].map((r) => r.ms.toFixed(0)).join('/')} ms`)
  }

  // ------------------------------------------------------------------- US6
  // Email is matched case-insensitively, because it was lower-cased going in —
  // Owner@ and owner@ are one person, not two accounts and not a failed login.
  {
    const mixed = await mustSignIn('  OWNER@EXAMPLE.TEST  ', PW,
      'US6 an address is one address however it is typed')
    if (!mixed) return done()
    const { user } = mixed
    check(user.email === 'owner@example.test' && user.id === owner.id,
      'US6 an address is one address however it is typed',
      `"  OWNER@EXAMPLE.TEST  " signed in as ${user.email}`)
  }

  // ------------------------------------------------------------------- US7
  // A token that was never issued, one that was revoked, and one that has
  // expired are all nobody. This is the boundary `proxy.ts` deliberately does
  // NOT enforce — it only checks the cookie is present.
  {
    const forged = await userForToken('this-was-never-issued')
    const doomedIn = await mustSignIn('owner@example.test', PW,
      'US7 forged, expired and revoked tokens are all nobody')
    if (!doomedIn) return done()
    const { token: doomed } = doomedIn
    // Aged, not force-expired: `CHECK (expires_at > created_at)` refuses a
    // session that ran out before it began, and it is right to — revoking is
    // the way to end one early. So the whole row is moved into the past, which
    // is what a month of not signing in actually looks like.
    await db.execute(raw`
      UPDATE user_session
         SET created_at = now() - interval '60 days',
             expires_at = now() - interval '30 days',
             last_seen_at = now() - interval '60 days'
       WHERE token_hash = ${tokenHash(doomed)}`)
    const expired = await userForToken(doomed)
    const revokedIn = await mustSignIn('owner@example.test', PW,
      'US7 forged, expired and revoked tokens are all nobody')
    if (!revokedIn) return done()
    const { token: revoked } = revokedIn
    await signOut(revoked)
    const gone = await userForToken(revoked)
    check(forged === null && expired === null && gone === null && (await userForToken('')) === null,
      'US7 forged, expired and revoked tokens are all nobody',
      'four tokens offered, four refusals')
  }

  // ------------------------------------------------------------------- US8
  // Using a session slides its expiry: somebody who works in this every day
  // should not be signed out mid-month.
  {
    const live = await mustSignIn('owner@example.test', PW,
      'US8 a session in use does not run out')
    if (!live) return done()
    const { token } = live
    const before = await db.execute<{ expires_at: string }>(raw`
      SELECT expires_at::text FROM user_session WHERE token_hash = ${tokenHash(token)}`)
    await db.execute(raw`
      UPDATE user_session SET expires_at = now() + interval '2 days'
       WHERE token_hash = ${tokenHash(token)}`)
    await userForToken(token)
    const after = await db.execute<{ expires_at: string }>(raw`
      SELECT expires_at::text FROM user_session WHERE token_hash = ${tokenHash(token)}`)
    check(before.length === 1 && after[0].expires_at > before[0].expires_at,
      'US8 a session in use does not run out',
      `pushed from 2 days back out to ${after[0].expires_at.slice(0, 10)}`)
  }

  // ------------------------------------------------------------------- US9
  // Changing a password ends every session. That is what somebody changing a
  // password after a scare is actually asking for.
  {
    const inA = await mustSignIn('owner@example.test', PW,
      'US9 changing a password signs every session out')
    const inB = await mustSignIn('owner@example.test', PW,
      'US9 changing a password signs every session out')
    if (!inA || !inB) return done()
    const { token: a } = inA
    const { token: b } = inB
    const open = (await sessionsOf(owner.id)).length
    await setPassword({ userId: owner.id, password: 'another long ordinary sentence', actor: 'check' })
    const afterA = await userForToken(a)
    const afterB = await userForToken(b)
    const oldPassword = await said(() => signIn({ email: 'owner@example.test', password: PW }))
    check(open >= 2 && afterA === null && afterB === null
          && oldPassword.startsWith('BAD_CREDENTIALS'),
      'US9 changing a password signs every session out',
      `${open} sessions were open; both tokens now answer nobody, and the old password is refused`)
  }

  // ------------------------------------------------------------------- US10
  // The first account can be made only while there are none. Otherwise the page
  // that exists so somebody can get in becomes the way anybody gets in.
  {
    const again = await said(() => createFirstOwner({
      email: 'gatecrasher@example.test', firstName: 'Nope', password: PW,
    }))
    check(again.startsWith('ALREADY_SET_UP') && !(await noUsersYet()),
      'US10 the first-account door is shut once there is one',
      again)
  }

  // ------------------------------------------------------------------- US11
  // The system must never be left with nobody able to administer it. The guard
  // is a deferred constraint trigger, so it judges the table as it WILL be —
  // a per-row BEFORE trigger cannot see an UPDATE that demotes two at once.
  {
    const second = await createUser({
      email: 'book@example.test', firstName: 'The', lastName: 'Bookkeeper', password: PW,
      actor: actorOf({ ...owner }),
    })
    // Since 0057 the rung the guard keeps is SUPERADMIN, and the first account
    // is one. Demoting goes through the table directly: the library refuses
    // to touch your own row before the trigger gets a say, and the trigger is
    // what is under test here.
    const demote = await said(() => db.execute(raw`
      UPDATE app_user SET kind = 'owner' WHERE id = ${owner.id}::uuid`))
    const deactivate = await said(() => setUserStatus({ userId: owner.id, isActive: false, actor: 'check' }))
    // There is exactly one superadmin (0059), so "two at once" has no second
    // to demote; the statement that names the rung rather than the row is
    // the third way.
    const byKind = await said(() => db.execute(raw`
      UPDATE app_user SET kind = 'user' WHERE kind = 'superadmin'`))
    void second
    const ways = { demote, deactivate, byKind }
    const allowed = Object.entries(ways)
      .filter(([, r]) => !r.includes('LAST_SUPERADMIN'))
      .map(([k, r]) => `${k} → ${r || '(no refusal at all)'}`)
    check(allowed.length === 0,
      'US11 the superadmin cannot be demoted or deactivated, by row or by kind',
      allowed.length === 0
        ? 'three ways of leaving nobody in charge, three refusals'
        : allowed.join(' | '))
  }

  // ------------------------------------------------------------------- US12
  // Signing somebody off ends their sessions at once, rather than letting the
  // browser they left open keep working for a month.
  {
    const [book] = (await listUsers()).filter((u) => u.email === 'book@example.test')
    const bookIn = await mustSignIn('book@example.test', PW,
      'US12 signing somebody off ends the session they already had')
    if (!bookIn) return done()
    const { token } = bookIn
    await setUserStatus({ userId: book.id, isActive: false, actor: 'check' })
    const after = await userForToken(token)
    const cannotSignIn = await said(() => signIn({ email: 'book@example.test', password: PW }))
    check(after === null && cannotSignIn.startsWith('BAD_CREDENTIALS'),
      'US12 signing somebody off ends the session they already had',
      'the open token answers nobody, and they cannot sign in again')
  }

  // ------------------------------------------------------------------- US13
  // What the audit trail records. RISKS §15: `web` said which SURFACE a change
  // came through and could not tell two people apart. `actorOf` is the email,
  // recorded as it was at the time — renaming somebody later must not rewrite
  // what the books say happened.
  {
    const [row] = await db.execute<{ created_by: string }>(raw`
      SELECT created_by FROM app_user WHERE email = 'book@example.test'`)
    check(actorOf(owner) === 'owner@example.test'
          && row.created_by === 'owner@example.test'
          && actorOf(owner) !== 'web',
      'US13 the trail records a person, not a surface',
      `the bookkeeper's row was created by ${row.created_by}`)
  }

  // ------------------------------------------------------------------- US14
  // Length is the rule, because length is what scrypt is defending. A refusal
  // that says why beats one that says "invalid password".
  {
    const short = await said(() => createUser({
      email: 'short@example.test', firstName: 'Short', password: 'hunter2', actor: 'check',
    }))
    const taken = await said(() => createUser({
      email: 'OWNER@example.test', firstName: 'Twin', password: PW, actor: 'check',
    }))
    const notAnEmail = await said(() => createUser({
      email: 'nope', firstName: 'Nope', password: PW, actor: 'check',
    }))
    check(short.startsWith('WEAK_PASSWORD') && short.includes('12')
          && taken.startsWith('EMAIL_TAKEN') && notAnEmail.startsWith('BAD_EMAIL'),
      'US14 a refused account says which part was refused',
      [short, taken, notAnEmail].map((s) => s.split(':')[0]).join(', '))
  }

  // ------------------------------------------------------------------- US15
  // Revoking every session of one person leaves everybody else alone — the
  // failure this guards is a "sign out everywhere" that signs out everyone.
  {
    const [book] = (await listUsers()).filter((u) => u.email === 'book@example.test')
    await setUserStatus({ userId: book.id, isActive: true, actor: 'check' })
    const theirsIn = await mustSignIn('book@example.test', PW,
      'US15 signing one person out leaves everybody else signed in')
    const mineIn = await mustSignIn('owner@example.test', 'another long ordinary sentence',
      'US15 signing one person out leaves everybody else signed in')
    if (!theirsIn || !mineIn) return done()
    const { token: theirs } = theirsIn
    const { token: mine } = mineIn
    await revokeAllSessions(book.id)
    check((await userForToken(theirs)) === null && (await userForToken(mine)) !== null,
      'US15 signing one person out leaves everybody else signed in',
      'the bookkeeper is out, the owner is still in')
  }

  // ------------------------------------------------------------------ US16
  // Where sign-in sends somebody afterwards. `next` is attacker-supplied end
  // to end — it comes off the URL, into a hidden field, and into a redirect.
  //
  // The first version tested a pattern meaning "one slash, then not another",
  // which is NOT what a browser does: a backslash is a slash to the URL parser,
  // so a value starting slash-backslash passed and resolved to another host
  // entirely (critic). The rule is now resolution against this origin, and this
  // asks the same question the browser will.
  {
    const escapes = ['/' + BS + 'evil.com', '/' + BS + '/evil.com', '//evil.com',
                     'https://evil.com', 'javascript:alert(1)', '/ /evil']
    const leaves = escapes.filter(
      (v) => new URL(somewhereHere(v), 'http://erp.test').host !== 'erp.test')
    const kept = ['/companies', '/ledger/abc/payroll?year=2026', '/users']
      .filter((v) => somewhereHere(v) !== v)
    check(leaves.length === 0 && kept.length === 0 && somewhereHere('') === '/',
      'US16 signing in cannot send you off this site',
      leaves.length > 0
        ? `escapes: ${leaves.map((v) => `${JSON.stringify(v)} -> ${somewhereHere(v)}`).join(', ')}`
        : kept.length > 0
          ? `mangled a real destination: ${kept.join(', ')}`
          : `${escapes.length} escapes refused, 3 real destinations kept`)
  }

  // ------------------------------------------------------------------ US17
  // Signing in again must not leave the session being replaced alive. The
  // cookie is overwritten, so nothing points at the old row — and it stayed
  // valid for thirty days, referenced by nobody and revocable by nobody who
  // could see it (critic).
  {
    const a = await mustSignIn('owner@example.test', 'another long ordinary sentence',
      'US17 signing in again ends the session being replaced')
    if (!a) return done()
    const b = await signIn({
      email: 'owner@example.test', password: 'another long ordinary sentence',
      replaces: a.token,
    })
    check((await userForToken(a.token)) === null && (await userForToken(b.token)) !== null,
      'US17 signing in again ends the session being replaced',
      'the token the browser was carrying is revoked; the new one works')
  }

  // ------------------------------------------------------------------ US18
  // Two companies, one bookkeeper, one of them theirs. The company half is the
  // one that actually protects the books — a permission that says "not Payroll"
  // while leaving every company's ledger reachable has moved the lock without
  // locking anything.
  const north = await createCompanyWithYear({ code: 'ACN', name: 'Northwind Ltd.' }, 'check')
  const south = await createCompanyWithYear({ code: 'ACS', name: 'Southwind Ltd.' }, 'check')
  const book = (await listUsers()).find((u) => u.email === 'book@example.test')!
  // US11 left them an owner (it needed a second one to try demoting both at
  // once) and US12 signed them off. An owner is exempt from everything below,
  // so put them back to being an ordinary person first.
  await db.execute(raw`UPDATE app_user SET kind = 'user' WHERE id = ${book.id}::uuid`)
  await setUserStatus({ userId: book.id, isActive: true, actor: 'check' })
  await setGrants({
    userId: book.id,
    entityIds: [north.company.id],
    modules: ['/entries', '/parties'],
    actor: 'owner@example.test',
  })
  const bookkeeper = (await listUsers()).find((u) => u.id === book.id)!

  {
    const theirs = await refuseFor(bookkeeper, `/ledger/${north.ledger.id}/entries`)
    const notTheirs = await refuseFor(bookkeeper, `/ledger/${south.ledger.id}/entries`)
    check(theirs === null && notTheirs?.code === 'NO_COMPANY',
      'US18 a company somebody was not given is refused',
      `their own company answers ${theirs?.code ?? 'nothing — it opens'}; `
      + `the other answers ${notTheirs?.code ?? 'nothing at all'}`)
  }

  // ------------------------------------------------------------------ US19
  // And the module half, inside a company they DO have. Also that `covers`
  // works: /aging belongs to the Reports seat, so a person without Reports is
  // refused there — the mapping is `activeNavPath`, the same one the rail
  // highlights with, so "which module is this page" has one answer.
  {
    const given = await refuseFor(bookkeeper, `/ledger/${north.ledger.id}/parties`)
    const notGiven = await refuseFor(bookkeeper, `/ledger/${north.ledger.id}/payroll`)
    const covered = await refuseFor(bookkeeper, `/ledger/${north.ledger.id}/aging`)
    check(given === null && notGiven?.code === 'NO_MODULE' && covered?.code === 'NO_MODULE',
      'US19 a module somebody was not given is refused, covers included',
      `/parties → ${given?.code ?? 'opens'}; /payroll → ${notGiven?.code ?? 'opens'}; `
      + `/aging, a page under the Reports seat → ${covered?.code ?? 'opens'}`)
  }

  // ------------------------------------------------------------------ US20
  // The modules on offer are the seats that EXIST, and a stored value naming
  // no seat is refused.
  //
  // The first half used to compare `LEDGER_NAV.map(i => i.path)` against
  // `MODULE_PATHS`, which is defined as `LEDGER_NAV.map(i => i.path)` — an
  // expression against itself, green whatever anybody did (critic,
  // 2026-09-03). Block 348 appeared to prove it only because the hand-typed
  // list it substituted happened to be one entry short; a second list typed
  // CORRECTLY passed, which is exactly the case the block's prose describes.
  //
  // So the comparison is against a source that is not nav.ts: the ROUTE TREE.
  // Every seat must have a directory, every top-level ledger directory must be
  // a seat or a declared seatless route, and the screen must offer all of them.
  {
    const offered = GRANTABLE_MODULES.map((m) => m.path).sort()
    const seats = MODULE_PATHS.slice().sort()
    const root = 'src/app/ledger/[ledgerId]'
    const dirs = readdirSync(root)
      .filter((e) => statSync(join(root, e)).isDirectory() && !e.startsWith('@'))
    const withoutSeat = dirs.filter((d) =>
      activeNavPath(LID, `/ledger/${LID}/${d}`) === null
      && !DETAIL_ROUTES.some((r) => r.segment === d))
    const seatsWithoutDir = seats.filter((p) => p !== '' && !dirs.includes(p.split('/')[1]))

    let refused = ''
    try {
      await setGrants({ userId: book.id, entityIds: [north.company.id],
                        modules: ['/not-a-module'], actor: 'check' })
    } catch (e) { refused = e instanceof AccessError ? e.code : causesOf(e) }
    // Put back what US18 and US19 rely on.
    await setGrants({ userId: book.id, entityIds: [north.company.id],
                      modules: ['/entries', '/parties'], actor: 'check' })

    check(offered.join(' ') === seats.join(' ')
          && withoutSeat.length === 0 && seatsWithoutDir.length === 0
          && refused === 'NO_SUCH_MODULE',
      'US20 the modules on offer are the seats the route tree actually has',
      offered.join(' ') !== seats.join(' ')
        ? 'the granting screen and the gate read different lists'
        : withoutSeat.length > 0
          ? `route directories belonging to no seat and undeclared: ${withoutSeat.join(', ')}`
          : seatsWithoutDir.length > 0
            ? `seats with no route directory: ${seatsWithoutDir.join(', ')}`
            : `${seats.length} seats, ${dirs.length} ledger directories, each accounted `
              + `for; a module that is not a seat is refused (${refused})`)
  }

  // ------------------------------------------------------------------ US24
  // The paths that are not pages. `/export` hands out a CSV of whatever `what`
  // asks for and `/attachments/<id>` hands out a filed receipt; neither lights
  // a nav seat, so until 2026-09-03 neither was module-checked at all and any
  // seat at all bought both (critic). US18-US23 could not see it, because every
  // one of them asks about a page.
  {
    const at = (p: string) => refuseFor(bookkeeper, `/ledger/${north.ledger.id}${p}`)
    const journal = await at('/export?what=journal')          // /entries — held
    const trial = await at('/export?what=trial-balance')      // /reports — not
    const gst = await at('/export?what=gst-hst')              // /tax — not
    const receipt = await at('/attachments/' + north.ledger.id)  // /entries — held
    const unknown = await at('/export?what=something-new')    // falls back
    check(journal === null && receipt === null
          && trial?.code === 'NO_MODULE' && gst?.code === 'NO_MODULE'
          && unknown?.code === 'NO_MODULE',
      'US24 a download is refused by the same seats its screen is',
      `?what=journal opens (they have Journal entries); ?what=trial-balance and `
      + `?what=gst-hst refuse; a receipt opens; an unnamed what refuses`)
  }

  // ------------------------------------------------------------------ US25
  // And a ledger path nobody has decided about REFUSES rather than opening.
  // The old code let a seatless path through on the theory that the company
  // check had already settled it — true of the company, false of the module.
  {
    const madeUp = await refuseFor(bookkeeper, `/ledger/${north.ledger.id}/not-a-thing`)
    check(madeUp?.code === 'NO_MODULE',
      'US25 a ledger path belonging to no seat is shut, not open',
      `an undeclared path answers ${madeUp?.code ?? 'nothing — it opens'}`)
  }

  // ------------------------------------------------------------------ US38
  // An ESCAPED ledger id. The gate read the raw path, matched no ledger in
  // `/ledger/%66…/backup/file`, and admitted it as a path outside every
  // company — while the router decoded it and handed the page the real id, so
  // anybody signed in who knew a ledger's id could open every module of it
  // (security review, 2026-10-20). Asked through the proxy, because the proxy
  // decides what the gate is shown: the header it forwards must name the
  // ledger the router will route to, and a raw escaped path that reaches the
  // gate anyway must refuse rather than open.
  {
    const { proxy, PATH_HEADER } = await import('../src/proxy')
    const { NextRequest } = await import('next/server')
    const through = async (path: string) => {
      const res = await proxy(new NextRequest(new URL(path, 'http://localhost:3000'),
        { headers: { cookie: 'erp_session=check' } }))
      return { status: res.status, path: res.headers.get(`x-middleware-request-${PATH_HEADER}`) }
    }
    const id = south.ledger.id
    const escaped = `/ledger/%${id.charCodeAt(0).toString(16)}${id.slice(1)}/backup/file?paper=yes`
    const sent = await through(escaped)
    const viaProxy = sent.path === null ? null : await refuseFor(bookkeeper, sent.path)
    const direct = await refuseFor(bookkeeper, escaped)
    const seat = await through(`/ledger/${north.ledger.id}/%70ayroll`)
    const seatRefused = seat.path === null ? null : await refuseFor(bookkeeper, seat.path)
    const unreadable = await through(`/ledger/%zz/entries`)
    check(sent.path === `/ledger/${id}/backup/file?paper=yes` && viaProxy?.code === 'NO_COMPANY'
          && direct?.code === 'NO_COMPANY' && seatRefused?.code === 'NO_MODULE' && unreadable.status === 400,
      'US38 an escaped ledger id or module is judged as the router reads it',
      `proxy forwards ${sent.path ?? 'nothing'} → ${viaProxy?.code ?? 'opens'}; the raw escaped path → `
      + `${direct?.code ?? 'opens'}; an escaped /payroll → ${seatRefused?.code ?? 'opens'}; `
      + `an undecodable path → ${unreadable.status}`)
  }

  // ------------------------------------------------------------------ US26
  // The question asked about an id in a FORM BODY rather than a URL.
  //
  // A server action POSTs to the page it is on, so `refuseFor` judges that page
  // and never sees the ledger the form names. Standing on a company they hold,
  // one POST wrote into a company they do not (critic, 2026-09-03). Thirty-one
  // actions read their ledger out of the form.
  {
    const own = await refuseForLedger(bookkeeper, north.ledger.id, '/entries')
    const otherCompany = await refuseForLedger(bookkeeper, south.ledger.id, '/entries')
    const otherModule = await refuseForLedger(bookkeeper, north.ledger.id, '/payroll')
    const eitherOf = await refuseForLedger(bookkeeper, north.ledger.id, ['/payroll', '/parties'])
    const noId = await refuseForLedger(bookkeeper, '', '/entries')
    check(own === null && eitherOf === null
          && otherCompany?.code === 'NO_COMPANY'
          && otherModule?.code === 'NO_MODULE'
          && noId?.code === 'NO_COMPANY',
      'US26 an action is judged by the ledger in its form, not the page it was posted from',
      `their own ledger in a seat they hold opens; another company answers `
      + `${otherCompany?.code}; a seat they lack answers ${otherModule?.code}; `
      + `a list passes on any one of them; an empty id answers ${noId?.code} `
      + 'rather than reaching the database')
  }

  // ------------------------------------------------------------------ US27
  // And the company list itself — the DESK listed every company in the system,
  // with its primary ledger id, to anybody signed in, while /companies two
  // clicks away was filtered (critic). One predicate answers both now.
  {
    const theirs = await db.execute<{ name: string }>(raw`
      SELECT e.name FROM entity e
       WHERE ${mayOpenEntity(bookkeeper, raw`e.id`)} ORDER BY e.code`)
    const ownerNow = (await listUsers()).find((u) => u.email === 'owner@example.test')!
    const all = await db.execute<{ name: string }>(raw`
      SELECT e.name FROM entity e
       WHERE ${mayOpenEntity(ownerNow, raw`e.id`)} ORDER BY e.code`)
    const noEntity = await refuseForEntity(bookkeeper, south.company.id)
    check(theirs.length === 1 && theirs[0].name === 'Northwind Ltd.'
          && all.length >= 2 && noEntity?.code === 'NO_COMPANY',
      'US27 a company list shows the companies that person may open',
      `the bookkeeper sees ${theirs.length} (${theirs[0]?.name}); `
      + `the owner sees ${all.length}; naming the other one directly answers `
      + `${noEntity?.code}`)
  }

  // ------------------------------------------------------------------ US28
  // The audit trail's reader (2026-09-04). This suite has written plenty of
  // rows by now — users created, grants set, reconciliations undone. Newest
  // first, filtered by who and by what, and capped.
  {
    const { auditTrail, auditVocabulary } = await import('../src/lib/audit')
    const all = await auditTrail({ limit: 1000 })
    const ordered = all.every((r, i) => i === 0 || r.occurred_at <= all[i - 1].occurred_at)
    // Filter by whatever the trail actually holds at this point in the suite,
    // rather than by names another suite writes: the reader is what is under
    // test, not the fixtures.
    const vocab = await auditVocabulary()
    const who = vocab.actors[0], what = vocab.actions[0]
    const byActor = await auditTrail({ actor: who })
    const byAction = await auditTrail({ action: what })
    const capped = await auditTrail({ limit: 3 })
    const none = await auditTrail({ actor: 'nobody@example.test' })
    // The date window is calendar days in this machine's zone (critic): today
    // holds everything the suite wrote; a window ending yesterday holds none.
    const today = new Date().toLocaleDateString('en-CA')
    const inToday = await auditTrail({ from: today, to: today, limit: 1000 })
    const before = await auditTrail({ to: '2000-01-01' })
    check(all.length >= 3 && ordered
          && byActor.length > 0 && byActor.every((r) => r.actor === who)
          && byAction.length > 0 && byAction.every((r) => r.action === what)
          && capped.length === 3 && none.length === 0
          && all.slice(0, 3).every((r, i) => r.id === capped[i].id)
          && inToday.length === all.length && before.length === 0,
      'US28 the audit trail reads back newest first, by who, by what and by local day, and capped',
      `${all.length} rows; ${byActor.length} by ${who}; ${byAction.length} × ${what}; today holds all, before 2000 none; cap 3 → the newest 3`)
  }

  // ------------------------------------------------------------------ US21
  // An owner is exempt from both, and the rail draws what a person may open.
  // The rail is a COURTESY — the gate refuses the URL either way — but offering
  // a door somebody will be turned away from is its own small cruelty.
  {
    const ownerNow = (await listUsers()).find((u) => u.email === 'owner@example.test')!
    const ownerAccess = await accessFor(ownerNow)
    const theirs = await accessFor(bookkeeper)
    const ownerSeats = seatsFor(ownerAccess, MODULE_PATHS)
    const bookSeats = seatsFor(theirs, MODULE_PATHS)
    check(ownerAccess.entities === null && ownerAccess.modules === null
          && ownerSeats.length === MODULE_PATHS.length
          && bookSeats.length === 2
          && (await refuseFor(ownerNow, `/ledger/${south.ledger.id}/payroll`)) === null,
      'US21 an owner sees everything; everybody else sees what they were given',
      `owner: all ${ownerSeats.length} seats and any company; `
      + `the bookkeeper: ${bookSeats.join(' and ')}`)
  }

  // ------------------------------------------------------------------ US22
  // A module without a company is a grant that lies to whoever made it: it
  // shows as ticked and the person still cannot reach any books through it.
  //
  // And a refused save must leave what was there ALONE. `setGrants` replaces —
  // it deletes both sets and writes them again — so without one transaction
  // around it, a refusal partway through takes away access that was working and
  // gives nothing back. The screen would say "give this person a company as
  // well" while having already stripped the company they had.
  {
    const alone = await createUser({
      email: 'alone@example.test', firstName: 'Alone', password: PW, actor: 'check',
    })
    await setGrants({
      userId: alone.id, entityIds: [south.company.id], modules: ['/records'], actor: 'check',
    })
    let refused = ''
    try {
      await setGrants({ userId: alone.id, entityIds: [], modules: ['/entries'], actor: 'check' })
    } catch (e) { refused = e instanceof AccessError ? e.code : causesOf(e) }
    const after = await grantsOf(alone.id)
    check(refused === 'NO_COMPANY_YET'
          && after.entities.join() === south.company.id
          && after.modules.join() === '/records',
      'US22 a module with no company to use it in is refused, and the refusal '
      + 'leaves what they had',
      `${refused || 'nothing was refused'}; they still have `
      + `${after.entities.length} company and ${after.modules.join(' ') || 'no module'}`)
  }

  // ------------------------------------------------------------------ US23
  // A person has a first name and a last name, and the displayed name is
  // DERIVED from them. A stored third copy would drift the first time somebody
  // was renamed — which is why `display_name` was dropped rather than kept
  // alongside (0054).
  {
    const named = await createUser({
      email: 'two.names@example.test', firstName: 'Wren', lastName: 'Halloran',
      password: PW, actor: 'check',
    })
    const oneName = await createUser({
      email: 'one.name@example.test', firstName: 'Prince', password: PW, actor: 'check',
    })
    const [stored] = await db.execute<{ n: string }>(raw`
      SELECT COUNT(*)::text AS n FROM information_schema.columns
       WHERE table_name = 'app_user' AND column_name = 'display_name'`)
    check(named.display_name === 'Wren Halloran' && named.last_name === 'Halloran'
          && oneName.display_name === 'Prince' && oneName.last_name === null
          && stored.n === '0',
      'US23 a name has two parts, and the whole is derived from them',
      `"${named.display_name}" and "${oneName.display_name}"; `
      + 'no display_name column survives to disagree with them')
  }

  // ------------------------------------------------------------------ US29
  // Three kinds of person (0057). The first account is the superadmin; a
  // person made with no kind is a user; is_owner is DERIVED from the kind and
  // nobody can write it — so every gate that reads it kept its answer.
  {
    const first = (await userById(owner.id))!
    const plain = await createUser({
      email: 'plain@example.test', firstName: 'Plain', password: PW, actor: 'check',
    })
    const written = await said(() => db.execute(raw`
      UPDATE app_user SET is_owner = true WHERE id = ${plain.id}::uuid`))
    const [gen] = await db.execute<{ g: string }>(raw`
      SELECT is_generated AS g FROM information_schema.columns
       WHERE table_name = 'app_user' AND column_name = 'is_owner'`)
    check(first.kind === 'superadmin' && first.is_owner
          && plain.kind === 'user' && !plain.is_owner
          && written !== '' && gen.g === 'ALWAYS',
      'US29 superadmin, owner, user — and is_owner is derived from the kind',
      `first account ${first.kind}; a new person is ${plain.kind}; `
      + `writing is_owner: ${written.slice(0, 50) || '(allowed)'}`)
  }

  // ------------------------------------------------------------------ US30
  // The ladder (owner, 2026-09-04): an owner manages users and nothing above;
  // a superadmin manages everybody but themselves; nobody manages themselves.
  // Asked at every door — sign off, password, access, kind, delete, create —
  // because an owner who could reset the superadmin's password would BE the
  // superadmin.
  const form = (fields: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(fields)) f.set(k, v)
    return f
  }
  {
    const su = (await userById(owner.id))!
    const boss = await createUser({
      email: 'boss@example.test', firstName: 'Boss', password: PW, kind: 'owner', actor: 'check',
    })
    const boss2 = await createUser({
      email: 'boss2@example.test', firstName: 'Boss', lastName: 'Two', password: PW,
      kind: 'owner', actor: 'check',
    })
    const plain = (await listUsers()).find((u) => u.email === 'plain@example.test')!
    const refused = {
      ownerDeletesOwner: await said(() => deleteUser({ userId: boss2.id, actor: boss })),
      ownerPromotesToOwner: await said(() => setUserKind({ userId: plain.id, kind: 'owner', actor: boss })),
      ownerAddsOwner: (await createUserFromForm(form({
        [USER_FIELDS.email]: 'sneak@example.test', [USER_FIELDS.firstName]: 'Sneak',
        [USER_FIELDS.password]: PW, [USER_FIELDS.kind]: 'owner',
      }), boss)).error ?? '',
      ownerResetsSuperadmin: (await setPasswordFromForm(form({
        [USER_FIELDS.userId]: su.id, [USER_FIELDS.password]: 'the owner walks in as you',
      }), boss)).error ?? '',
      ownerGrantsToOwner: (await setGrantsFromForm(form({ [USER_FIELDS.userId]: boss2.id }), boss)).error ?? '',
      ownerDeletesSelf: await said(() => deleteUser({ userId: boss.id, actor: boss })),
      superadminDemotesSelf: await said(() => setUserKind({ userId: su.id, kind: 'user', actor: su })),
      // The two doors the screen actually posts through — the form readers —
      // not only the library under them (critic).
      ownerDeletesOwnerByForm: (await deleteUserFromForm(form({ [USER_FIELDS.userId]: boss2.id }), boss)).error ?? '',
      ownerRekindsByForm: (await setKindFromForm(form({
        [USER_FIELDS.userId]: plain.id, [USER_FIELDS.kind]: 'owner',
      }), boss)).error ?? '',
      // Exactly one superadmin (owner's ruling, 0059): not even the
      // superadmin makes another.
      superadminMakesSuperadmin: (await setKindFromForm(form({
        [USER_FIELDS.userId]: plain.id, [USER_FIELDS.kind]: 'superadmin',
      }), su)).error ?? '',
    }
    const allowed = {
      ownerSignsOffUser: (await setStatusFromForm(form({
        [USER_FIELDS.userId]: plain.id, setActive: 'false',
      }), boss)).error ?? '',
      ownerResetsOwnPassword: (await setPasswordFromForm(form({
        [USER_FIELDS.userId]: boss.id, [USER_FIELDS.password]: 'a new long ordinary sentence',
      }), boss)).error ?? '',
      superadminPromotes: (await setKindFromForm(form({
        [USER_FIELDS.userId]: plain.id, [USER_FIELDS.kind]: 'owner',
      }), su)).error ?? '',
      superadminDemotes: (await setKindFromForm(form({
        [USER_FIELDS.userId]: plain.id, [USER_FIELDS.kind]: 'user',
      }), su)).error ?? '',
      ownerDeletesUser: (await deleteUserFromForm(form({ [USER_FIELDS.userId]: plain.id }), boss)).error ?? '',
    }
    const letThrough = Object.entries(refused)
      .filter(([, r]) => !/OUTRANKED|NOT_YOURSELF|ONE_SUPERADMIN|Only a superadmin|Not on your own|exactly one superadmin/.test(r))
      .map(([k, r]) => `${k} → ${r || '(no refusal)'}`)
    const blocked = Object.entries(allowed).filter(([, r]) => r !== '')
      .map(([k, r]) => `${k} → ${r}`)
    const stillThere = await userById(plain.id)
    check(letThrough.length === 0 && blocked.length === 0 && stillThere === null,
      'US30 an owner manages users; a superadmin manages owners; nobody manages themselves',
      [...letThrough, ...blocked].join('; ')
      || 'ten refusals where the ladder says no, five saves where it says yes — the form doors included')
  }

  // ------------------------------------------------------------------ US31
  // Deleting an owner (by a superadmin) takes their sessions and grants with
  // them and NOTHING else: every row they wrote still names them, because a
  // created_by is their email as text and not a key to their account.
  {
    const su = (await userById(owner.id))!
    const boss = (await listUsers()).find((u) => u.email === 'boss@example.test')!
    const bossIn = await signIn({ email: 'boss@example.test', password: 'a new long ordinary sentence' })
    const theirs = await createUser({
      email: 'made.by.boss@example.test', firstName: 'Made', password: PW,
      actor: actorOf(boss),
    })
    const seat = GRANTABLE_MODULES[0].path
    await setGrants({ userId: theirs.id, entityIds: [north.company.id], modules: [seat], actor: 'check' })
    const gone = await deleteUser({ userId: boss.id, actor: su })
    const [sessions] = await db.execute<{ n: string }>(raw`
      SELECT COUNT(*)::text AS n FROM user_session WHERE user_id = ${boss.id}::uuid`)
    const [named] = await db.execute<{ created_by: string }>(raw`
      SELECT created_by FROM app_user WHERE id = ${theirs.id}::uuid`)
    const token = await userForToken(bossIn.token)
    // A person's OWN grants go with them — asserted, not inherited from 0054
    // (critic): delete somebody who has some.
    const granted = await createUser({
      email: 'granted@example.test', firstName: 'Granted', password: PW, actor: 'check',
    })
    await setGrants({ userId: granted.id, entityIds: [north.company.id], modules: [seat], actor: 'check' })
    await deleteUser({ userId: granted.id, actor: su })
    const [left] = await db.execute<{ n: string }>(raw`
      SELECT ((SELECT COUNT(*) FROM user_entity_access WHERE user_id = ${granted.id}::uuid)
            + (SELECT COUNT(*) FROM user_module_access WHERE user_id = ${granted.id}::uuid))::text AS n`)
    // And the trail says who did it. app_user has no audit trigger, so the
    // doors write their own rows; a deletion nobody recorded is the one kind
    // of history this table must not lose (critic).
    const trail = await db.execute<{ action: string; actor: string; record_id: string }>(raw`
      SELECT action, actor, record_id FROM audit_log
       WHERE table_name = 'app_user' AND record_id IN (${boss.id}, ${granted.id}, ${theirs.id})
       ORDER BY id`)
    const deletes = trail.filter((t) => t.action === 'delete_user' && t.actor === su.email)
    const [kinds] = await db.execute<{ n: string }>(raw`
      SELECT COUNT(*)::text AS n FROM audit_log WHERE table_name = 'app_user' AND action = 'set_kind'`)
    const [hashes] = await db.execute<{ n: string }>(raw`
      SELECT COUNT(*)::text AS n FROM audit_log
       WHERE table_name = 'app_user' AND (before ? 'password_hash' OR after ? 'password_hash')`)
    check(gone.id === boss.id && (await userById(boss.id)) === null
          && sessions.n === '0' && token === null
          && named.created_by === 'boss@example.test'
          && (await grantsOf(theirs.id)).modules.includes(seat)
          && left.n === '0'
          && deletes.map((d) => d.record_id).sort().join() === [boss.id, granted.id].sort().join()
          && Number(kinds.n) >= 2 && hashes.n === '0',
      'US31 a deleted person takes their sessions and grants, the trail names the deleter, and every row they wrote still names them',
      `account and ${sessions.n === '0' ? 'session' : sessions.n + ' sessions'} gone; `
      + `${left.n} grant rows left; ${deletes.length} delete_user rows by ${su.email}; `
      + `${kinds.n} set_kind rows; created_by still "${named.created_by}"`)
  }

  // ------------------------------------------------------------------ US32
  // There is exactly ONE superadmin — the account that set the system up
  // (owner, 2026-09-04: "1不可以，2不能"). No door removes them, and no door
  // makes a second: the library refuses the kind, the form refuses it, and
  // the TABLE refuses the row (0059's unique index), so a direct UPDATE
  // cannot do what the screen will not.
  {
    const su = (await userById(owner.id))!
    // Under block 397 an owner has already deleted boss2; a check that then
    // dereferences them dies, and a suite that dies is not a suite that went
    // red — the battery reads it as unfinished. Say so and stop here.
    const boss2 = (await listUsers()).find((u) => u.email === 'boss2@example.test')
    if (!boss2) {
      fail('US32 there is exactly one superadmin: no door removes them, and no door makes a second',
        'boss2 is gone before this check ran — an owner deleted an owner')
      return done()
    }
    const rawDelete = await said(() => db.execute(raw`DELETE FROM app_user WHERE id = ${su.id}::uuid`))
    const rawOff = await said(() => db.execute(raw`
      UPDATE app_user SET is_active = false WHERE id = ${su.id}::uuid`))
    const rawSecond = await said(() => db.execute(raw`
      UPDATE app_user SET kind = 'superadmin' WHERE id = ${boss2.id}::uuid`))
    const bySuperadmin = await said(() => setUserKind({ userId: boss2.id, kind: 'superadmin', actor: su }))
    const byForm = (await createUserFromForm(form({
      [USER_FIELDS.email]: 'second.su@example.test', [USER_FIELDS.firstName]: 'Second',
      [USER_FIELDS.password]: PW, [USER_FIELDS.kind]: 'superadmin',
    }), su)).error ?? ''
    const [count] = await db.execute<{ n: string }>(raw`
      SELECT COUNT(*)::text AS n FROM app_user WHERE kind = 'superadmin'`)
    await deleteUser({ userId: boss2.id, actor: su })
    check(rawDelete.includes('LAST_SUPERADMIN') && rawOff.includes('LAST_SUPERADMIN')
          && rawSecond.includes('app_user_one_superadmin')
          && bySuperadmin.startsWith('ONE_SUPERADMIN') && /exactly one superadmin/.test(byForm)
          && count.n === '1' && (await userById(boss2.id)) === null,
      'US32 there is exactly one superadmin: no door removes them, and no door makes a second',
      `delete and sign-off refused by the table; a second refused by the index, the library and the form; `
      + `${count.n} superadmin`)
  }

  // ------------------------------------------------------------------ US33
  // The screen draws the ladder: RENDERED, once as an owner and once as a
  // superadmin, and each row read back for what it offers. The first version
  // grepped the source for a few words and `manageable = … || true` stayed
  // green (critic). The harness is a process of its own because
  // react-dom/server does not exist under this suite's react-server condition.
  {
    const mk = (id: string, kind: 'superadmin' | 'owner' | 'user', email: string) => ({
      id, email, first_name: email.split('@')[0], last_name: null,
      display_name: email.split('@')[0], kind, is_owner: kind !== 'user',
      webdav_enabled: false, is_active: true, last_seen_at: null,
    })
    const S = mk('S', 'superadmin', 'sue@x.test')
    const O = mk('O', 'owner', 'olive@x.test'), O2 = mk('O2', 'owner', 'oscar@x.test')
    const U = mk('U', 'user', 'bev@x.test')
    type Row = { email: string; type: string | { options: string[] }; buttons: string[] }
    const render = (me: ReturnType<typeof mk>) => JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-user-admin.tsx', JSON.stringify({
        me, people: [S, O, O2, U],
        companies: [{ id: 'c1', code: 'ACN', name: 'Northwind' }],
        modules: GRANTABLE_MODULES,
        grants: { U: { entities: ['c1'], modules: [GRANTABLE_MODULES[0].path] } },
      }),
      // WITHOUT this suite's react-server condition, which the child would
      // otherwise inherit and react-dom/server would refuse under.
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as {
      headers: string[]; rows: Row[]; grantBoxes: number; canAdminister: boolean
    }
    const asSu = render(S), asOwner = render(O)
    const offers = (r: { rows: Row[] }, email: string) => r.rows.find((x) => x.email === email)!.buttons.join()
    const chooses = (r: { rows: Row[] }, email: string) => {
      const t = r.rows.find((x) => x.email === email)!.type
      return typeof t === 'string' ? t : `select:${t.options.join('/')}`
    }
    const wrong: string[] = []
    const expect = (who: string, r: { rows: Row[] }, email: string, buttons: string, type: string) => {
      if (offers(r, email) !== buttons) wrong.push(`${who} sees ${email}: [${offers(r, email)}] not [${buttons}]`)
      if (chooses(r, email) !== type) wrong.push(`${who} sees ${email}'s type as ${chooses(r, email)} not ${type}`)
    }
    // The superadmin: everybody but themselves is theirs to manage, and the
    // Type is a choice of owner or user — never superadmin, there is one; an
    // owner sees everything but may not touch it.
    // Only list triggers count here. Native dialog and nested exit controls
    // do not appear until their corresponding action is opened.
    const NAME = 'Edit'
    const COPY = 'Copy'
    expect('superadmin', asSu, 'sue@x.test', `Password,${NAME},Access`, 'superadmin')
    expect('superadmin', asSu, 'olive@x.test', `${COPY},Sign off,Password,${NAME},Access,Delete`, 'select:owner/user')
    expect('superadmin', asSu, 'bev@x.test', `${COPY},Sign off,Password,${NAME},Access,Delete`, 'select:owner/user')
    // An owner: users only; their own password and name; nothing on anybody above or beside them.
    expect('owner', asOwner, 'sue@x.test', '', 'superadmin')
    expect('owner', asOwner, 'olive@x.test', `Password,${NAME},Access`, 'owner')
    expect('owner', asOwner, 'oscar@x.test', '', 'owner')
    expect('owner', asOwner, 'bev@x.test', `${COPY},Sign off,Password,${NAME},Access,Delete`, 'user')
    if (asSu.grantBoxes + asOwner.grantBoxes !== 0) wrong.push(`${asSu.grantBoxes + asOwner.grantBoxes} grant boxes rendered with no row open`)
    if (!asSu.headers.includes('Type') || asSu.canAdminister) wrong.push('the column is not "Type"')
    if (asSu.grantBoxes !== 0 || asOwner.grantBoxes !== 0) {
      wrong.push(`unopened grant boxes: superadmin ${asSu.grantBoxes}, owner ${asOwner.grantBoxes}`)
    }
    check(wrong.length === 0,
      'US33 the screen offers each row exactly what the ladder allows, and no grants until a row is opened',
      wrong.join('; ') || 'rendered as the superadmin and as an owner: 7 rows read back, 0 grant boxes')
  }

  // ------------------------------------------------------ US34, US35, US36
  // The two doors that wrote no trail (17-users-and-access.md said so), and
  // the way back in when the superadmin's password is lost.
  {
    const su = (await userById(owner.id))!
    const pat = await createUser({
      email: 'pat@x.test', firstName: 'Pat', lastName: null, password: PW, kind: 'user', actor: actorOf(su),
    })
    await mustSignIn('pat@x.test', PW, 'US34')
    await mustSignIn('pat@x.test', PW, 'US34')
    await setPassword({ userId: pat.id, password: 'a different long sentence', actor: actorOf(su) })
    const [pw] = await db.execute<{
      actor: string; after: { sessions_signed_out: number } | null; context: { email: string } | null
    }>(raw`
      SELECT actor, after, context FROM audit_log
       WHERE table_name = 'app_user' AND action = 'set_password' AND record_id = ${pat.id}
       ORDER BY id DESC LIMIT 1`)
    const live = await sessionsOf(pat.id)
    check(pw?.actor === su.email && pw?.after?.sessions_signed_out === 2
          && pw?.context?.email === 'pat@x.test' && live.length === 0,
      'US34 changing a password writes who did it and how many sessions it ended, never the password',
      pw ? `${pw.actor} ended ${pw.after?.sessions_signed_out} session(s) for ${pw.context?.email}; ${live.length} live`
         : 'no set_password row')

    await setGrants({ userId: pat.id, entityIds: [north.company.id], modules: [GRANTABLE_MODULES[0].path], actor: actorOf(su) })
    await setGrants({ userId: pat.id, entityIds: [north.company.id], modules: [], actor: actorOf(su) })
    const grants = await db.execute<{
      actor: string; before: { entities: string[]; modules: string[] }; after: { entities: string[]; modules: string[] }
    }>(raw`
      SELECT actor, before, after FROM audit_log
       WHERE table_name = 'app_user' AND action = 'set_grants' AND record_id = ${pat.id}
       ORDER BY id`)
    check(grants.length === 2 && grants.every((g) => g.actor === su.email)
          && grants[0].before.entities.length === 0 && grants[0].before.modules.length === 0
          && grants[0].after.entities[0] === north.company.id && grants[0].after.modules.length === 1
          && grants[1].before.modules.length === 1 && grants[1].after.modules.length === 0
          && grants[1].after.entities[0] === north.company.id,
      'US35 every change of grants writes what they had and what they have now',
      grants.length === 2
        ? `1: ${grants[0].before.modules.length}→${grants[0].after.modules.length} module(s); 2: ${grants[1].before.modules.length}→${grants[1].after.modules.length}; by ${grants[0].actor}`
        : `${grants.length} set_grants row(s)`)

    // The shell door: the same setPassword, run as a child process against
    // THIS database (DATABASE_URL in the environment, which dotenv leaves
    // alone), the address typed in the wrong case on purpose.
    let out = ''
    try {
      out = execFileSync('npx', ['tsx', 'scripts/reset-password.ts', 'PAT@x.test', '--password', 'set from the shell tonight'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      out = `exit: ${String((e as { stderr?: string }).stderr ?? e).slice(0, 200)}`
    }
    const back = await mustSignIn('pat@x.test', 'set from the shell tonight', 'US36')
    const [cli] = await db.execute<{ actor: string }>(raw`
      SELECT actor FROM audit_log
       WHERE table_name = 'app_user' AND action = 'set_password' AND record_id = ${pat.id}
       ORDER BY id DESC LIMIT 1`)
    check(back !== null && out.includes('Password set for pat@x.test') && (cli?.actor ?? '').startsWith('shell:'),
      'US36 a password can be set from the shell, and the trail says a shell did it',
      `${out.split('\n')[0].slice(0, 70)}; actor ${cli?.actor ?? 'none'}; sign-in ${back ? 'ok' : 'refused'}`)
  }

  // ------------------------------------------------------------------ US37
  // A name typed wrong and an email that changed are put right (0084; owner,
  // 2026-09-16: 「所有的紀錄儘量都可以編輯刪除」). An owner fixes a user's name
  // and email, and the user signs in with the new one; an email somebody else
  // has is refused; the superadmin is not an owner's to change; your own name
  // is yours; the trail keeps the old email beside the new.
  {
    const su = (await userById(owner.id))!
    const namer = await createUser({ email: 'namer@example.test', firstName: 'Namer', password: PW, kind: 'owner', actor: 'check' })
    const typo = await createUser({ email: 'tpyo@example.test', firstName: 'Tpyo', password: PW, actor: 'check' })
    const namerRec = (await userById(namer.id))!
    const fd = (userId: string, first: string, last: string, email: string) => {
      const f = new FormData()
      f.set(USER_FIELDS.userId, userId); f.set(USER_FIELDS.firstName, first)
      f.set(USER_FIELDS.lastName, last); f.set(USER_FIELDS.email, email)
      return f
    }
    const fixed = await setIdentityFromForm(fd(typo.id, 'Typo', 'Fixed', 'fixed@example.test'), namerRec)
    const after = await userById(typo.id)
    let signedIn = ''
    try { await signIn({ email: 'fixed@example.test', password: PW }); signedIn = 'ok' } catch (e) { signedIn = String(e) }
    const taken = await setIdentityFromForm(fd(typo.id, 'Typo', 'Fixed', 'namer@example.test'), namerRec)
    const outranked = await setIdentityFromForm(fd(su.id, 'Changed', '', su.email), namerRec)
    const self = await setIdentityFromForm(fd(namer.id, 'Namer', 'Owner', 'namer@example.test'), namerRec)
    const [trail] = await db.execute<{ before: { email?: string }; after: { email?: string } }>(raw`
      SELECT before, after FROM audit_log WHERE table_name = 'app_user' AND action = 'set_identity' AND record_id = ${typo.id}
       ORDER BY id LIMIT 1`)
    check(fixed.ok !== undefined && after?.display_name === 'Typo Fixed' && after.email === 'fixed@example.test' && signedIn === 'ok'
          && taken.error?.includes('already has an account') === true && outranked.error !== undefined
          && (await userById(su.id))?.first_name === su.first_name && self.ok !== undefined
          && trail?.before?.email === 'tpyo@example.test' && trail.after?.email === 'fixed@example.test',
      'US37 a name and email are put right by whoever may manage the person, or by the person, and the trail keeps both',
      `fixed: ${fixed.ok ?? fixed.error} (sign-in with the new email ${signedIn}); taken: ${taken.error ?? 'SAVED'}; `
        + `the superadmin by an owner: ${(outranked.error ?? 'SAVED').slice(0, 50)}; own name: ${self.ok ?? self.error}; `
        + `trail ${trail ? `${trail.before?.email} → ${trail.after?.email}` : 'nothing'}`)
  }

  return done()
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

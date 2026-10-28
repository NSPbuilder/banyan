/**
 * Drafts: the first mutable thing the ledger holds.
 *   npm run db:verify-drafts   (resets the database first)
 */
import './env'
import { errorText, expectCode, reporter } from './suite'
import { execFileSync } from 'node:child_process'
// The attachment store for this run is a scratch directory, set BEFORE the
// lib is ever called: the create doors now file paper, and the dev store must
// never be touched by a suite.
import nodePath from 'node:path'
import nodeOs from 'node:os'
import { mkdtempSync as mkTemp } from 'node:fs'
process.env.ATTACHMENTS_DIR = mkTemp(nodePath.join(nodeOs.tmpdir(), 'erp-draft-'))
import { byHand } from './by-hand'
import { trailNamesPeople } from './actor-trail'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { createAccount, importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { entryLinesFrom, postEntryFromForm } from '../src/lib/entry-forms'
import { computeTax } from '../src/lib/tax-rates'
import { attachmentsOf } from '../src/lib/attachments'
import { ATTACH_FIELD } from '../src/lib/forms'
import {
  amendEntry, discardDraft, postDraft, PostingError, reverseEntry, saveDraft, saveThenPost, deleteEntry, editEntry, postEntry,
} from '../src/lib/posting'
import { parseMoney } from '../src/lib/money'

const r = reporter(50)
const { pass, fail } = r

const expectError = expectCode(r)

const CHART = `1000,Cash — Operating,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
2100,GST/HST Payable,liability,,gst_hst_payable
1300,GST/HST Recoverable,asset,,gst_hst_recoverable
3000,Share Capital,equity,,share_capital
4000,Consulting Revenue,revenue,,revenue_from_contracts
5100,Professional Fees,expense,,professional_fees fn_administrative_expenses`

async function main() {
  const acme = await createCompany({ code: 'ACME', name: 'Acme Consulting Inc.', province: 'ON' }, 'alicio@example.test')
  await createFiscalYear(acme.ledger.id, '2026-12-31', 'alicio@example.test')
  const accts = await importAccounts(acme.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: acme.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  const L = acme.ledger.id

  // D1 — an unbalanced draft is allowed. That is the whole point of a draft.
  const draft = await saveDraft({
    ledgerId: L, entryDate: '2026-03-10', description: 'Invoice 1001 — work in progress',
    actor: 'alicio@example.test',
    // Two lines that do not agree — a real half-finished entry, not a stub.
    lines: [
      { accountId: id['1200'], amount: parseMoney('5650.00') },
      { accountId: id['4000'], amount: -parseMoney('5000.00') },
    ],
  })
  draft.status === 'draft' && draft.entryNo === null && draft.periodId === null
    ? pass('D1 an unbalanced draft saves', 'off by 650.00, no entry number, no period')
    : fail('D1 an unbalanced draft saves', JSON.stringify(draft))

  // D2 — and it is invisible to the ledger
  const [visible] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
     WHERE je.status IN ('posted','reversed')`)
  const [balances] = await db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM period_balance`)
  visible.n === '0' && balances.n === '0'
    ? pass('D2 a draft is in no balance and no statement', 'period_balance untouched')
    : fail('D2 a draft is in no balance and no statement', JSON.stringify({ visible, balances }))

  // D3 — posting it must be refused while it does not balance. The draft has
  //       two lines, so this cannot pass on the too-few-lines check instead.
  await expectError('D3 an unbalanced draft cannot be posted', 'OUT_OF_BALANCE', () => postDraft(draft.id, 'alicio@example.test'))

  // D3b — and a one-line draft fails for its own reason, not that one
  const oneLine = await saveDraft({
    ledgerId: L, entryDate: '2026-03-12', description: 'Only one side',
    lines: [{ accountId: id['1000'], amount: parseMoney('40.00') }],
  })
  await expectError('D3b a one-line draft cannot be posted', 'TOO_FEW_LINES', () => postDraft(oneLine.id, 'alicio@example.test'))
  await discardDraft(oneLine.id)

  // D4 — the same gate a finished entry goes through
  await saveDraft({
    ledgerId: L, entryDate: '2026-03-10', description: 'Invoice 1001 — consulting',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('5650.00') },
      { accountId: id['4000'], amount: -parseMoney('5000.00') },
      { accountId: id['2100'], amount: -parseMoney('650.00') },
    ],
  }, draft.id)
  const posted = await postDraft(draft.id, 'alicio@example.test')
  posted.status === 'posted' && posted.entryNo === 'JE-00001' && posted.periodId !== null
    ? pass('D4 a balanced draft posts and is numbered', posted.entryNo!)
    : fail('D4 a balanced draft posts and is numbered', JSON.stringify(posted))

  // D5 — the balance cache caught up
  const [afterPost] = await db.execute<{ n: string; drift: string }>(raw`
    SELECT (SELECT count(*)::text FROM period_balance) AS n,
           (SELECT count(*)::text FROM check_balance_integrity(${L}::uuid)) AS drift`)
  Number(afterPost.n) > 0 && afterPost.drift === '0'
    ? pass('D5 posting a draft updates the balances', `${afterPost.n} rows, no drift`)
    : fail('D5 posting a draft updates the balances', JSON.stringify(afterPost))

  await expectError('D6 a posted entry cannot be re-posted', 'ALREADY_POSTED', () => postDraft(draft.id, 'alicio@example.test'))
  await expectError('D7 a posted entry cannot be edited as a draft', 'NOT_DRAFT', () =>
    saveDraft({ ledgerId: L, entryDate: '2026-03-11', description: 'sneaky', lines: [] }, draft.id))
  await expectError('D8 a posted entry cannot be discarded', 'NOT_DRAFT', () => discardDraft(draft.id))

  // D9 — THE ONE DRAFTS MAKE POSSIBLE. Save a draft into an open period, close
  //      that period, then post. A draft that stored its period at save time
  //      would sail straight into the closed period.
  const stale = await saveDraft({
    ledgerId: L, entryDate: '2026-04-15', description: 'Saved while April was open',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['5100'], amount: parseMoney('900.00') },
      { accountId: id['1000'], amount: -parseMoney('900.00') },
    ],
  })
  await byHand((tx) => tx.execute(raw`
    UPDATE fiscal_period SET status='closed', closed_at=now(), closed_by='alicio@example.test'
     WHERE ledger_id = ${L} AND period_no = 4`))
  await expectError('D9 a draft cannot post into a period closed since', 'PERIOD_CLOSED',
    () => postDraft(stale.id, 'alicio@example.test'))

  // D10 — and reopening lets it through, so D9 was the period and not something else
  await byHand((tx) => tx.execute(raw`UPDATE fiscal_period SET status='open' WHERE ledger_id = ${L} AND period_no = 4`))
  const late = await postDraft(stale.id, 'alicio@example.test')
  late.entryNo === 'JE-00002'
    ? pass('D10 reopening the period lets the same draft post', late.entryNo!)
    : fail('D10 reopening the period lets the same draft post', JSON.stringify(late))

  // D11 — two tabs pressing Post at once must post once
  const race = await saveDraft({
    ledgerId: L, entryDate: '2026-05-02', description: 'Double-click me',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['5100'], amount: parseMoney('120.00') },
      { accountId: id['1000'], amount: -parseMoney('120.00') },
    ],
  })
  const [before11] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry WHERE status IN ('posted','reversed')`)
  const postedBefore = Number(before11.n)
  const results = await Promise.allSettled([
    postDraft(race.id, 'alicio@example.test'), postDraft(race.id, 'alicio@example.test'), postDraft(race.id, 'alicio@example.test'),
  ])
  const won = results.filter((r) => r.status === 'fulfilled').length
  // Counting entries with this description proves nothing: postDraft only ever
  // UPDATEs, so the count is 1 from the moment saveDraft created it. What can
  // fail is that the two losers were refused for the right reason, and that the
  // ledger gained exactly one posted entry.
  const loserCodes = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as PostingError).code)
  const [postedNow] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry WHERE status IN ('posted','reversed')`)
  won === 1 && loserCodes.length === 2 && loserCodes.every((c) => c === 'ALREADY_POSTED')
    && Number(postedNow.n) === postedBefore + 1
    ? pass('D11 concurrent posting posts once',
           `1 of 3 won, losers ${loserCodes.join('/')}, posted ${postedBefore} -> ${postedNow.n}`)
    : fail('D11 concurrent posting posts once',
           `${won} won, losers ${loserCodes.join(',')}, posted ${postedBefore} -> ${postedNow.n}`)

  // D12 — a draft cannot be moved to another company's ledger, which would
  //       leave its lines pointing at accounts it no longer owns
  const beta = await createCompany({ code: 'BETA', name: 'Beta Holdings Inc.' }, 'alicio@example.test')
  const orphan = await saveDraft({
    ledgerId: L, entryDate: '2026-06-01', description: 'Stays where it was made',
    lines: [
      { accountId: id['5100'], amount: parseMoney('50.00') },
      { accountId: id['1000'], amount: -parseMoney('50.00') },
    ],
  })
  try {
    await byHand((tx) => tx.execute(raw`UPDATE journal_entry SET ledger_id = ${beta.ledger.id} WHERE id = ${orphan.id}`))
    fail('D12 a draft cannot change ledger', 'it was moved')
  } catch (e) {
    errorText(e).includes('cannot be moved to another ledger')
      ? pass('D12 a draft cannot change ledger', 'its lines would point at another company')
      : fail('D12 a draft cannot change ledger', errorText(e).slice(0, 120))
  }

  // D13 — a draft cannot carry an entry number or a period
  try {
    await byHand((tx) => tx.execute(raw`UPDATE journal_entry SET entry_no = 'JE-FAKE' WHERE id = ${orphan.id}`))
    fail('D13 a draft cannot carry an entry number', 'it was accepted')
  } catch (e) {
    errorText(e).includes('journal_entry_draft_is_bare')
      ? pass('D13 a draft cannot carry an entry number', 'a numbered draft is an entry missing its identity')
      : fail('D13 a draft cannot carry an entry number', errorText(e).slice(0, 120))
  }

  // D14 — stale drafts are reported rather than accumulating quietly
  // Two lines that disagree, so this is reported as unbalanced rather than as
  // the more basic "needs at least two lines".
  await saveDraft({
    ledgerId: L, entryDate: '2026-04-20', description: 'Left unbalanced',
    lines: [
      { accountId: id['1000'], amount: parseMoney('10.00') },
      { accountId: id['4000'], amount: -parseMoney('7.00') },
    ],
  })
  await byHand((tx) => tx.execute(raw`UPDATE fiscal_period SET status='closed', closed_at=now() WHERE ledger_id = ${L} AND period_no = 6`))
  const staleList = await db.execute<{ description: string; reason: string }>(
    raw`SELECT description, reason FROM check_stale_drafts(${L}::uuid)`)
  const reasons = new Set(staleList.map((r) => r.reason))
  reasons.has('does not balance') && reasons.has('its period has closed since it was saved')
    ? pass('D14 stale drafts are reported with a reason', [...reasons].join(' / '))
    : fail('D14 stale drafts are reported with a reason', JSON.stringify(staleList))
  await byHand((tx) => tx.execute(raw`UPDATE fiscal_period SET status='open' WHERE ledger_id = ${L} AND period_no = 6`))

  // D14b — the two cases the detector used to miss entirely. Both can never
  //        post, and both were invisible: a blank draft sums to zero, and a
  //        deactivated account is not something the old check asked about.
  const blank = await saveDraft({
    ledgerId: L, entryDate: '2026-09-01', description: 'Nothing in it yet', lines: [],
  })
  const deactivated = await saveDraft({
    ledgerId: L, entryDate: '2026-09-02', description: 'Names an account since retired',
    lines: [
      { accountId: id['5100'], amount: parseMoney('30.00') },
      { accountId: id['1000'], amount: -parseMoney('30.00') },
    ],
  })
  await byHand((tx) => tx.execute(raw`UPDATE account SET is_active = false WHERE id = ${id['5100']}::uuid`))

  const readiness = await db.execute<{ description: string; reason: string }>(
    raw`SELECT description, reason FROM check_stale_drafts(${L}::uuid)`)
  const byDesc = Object.fromEntries(readiness.map((r) => [r.description, r.reason]))
  byDesc['Nothing in it yet'] === 'needs at least two lines'
    && byDesc['Names an account since retired'] === 'names an account that can no longer be posted to'
    ? pass('D14b drafts that can never post are reported',
           `blank -> ${byDesc['Nothing in it yet']}; retired account -> reported`)
    : fail('D14b drafts that can never post are reported', JSON.stringify(byDesc))

  // D14c — and posting each one is refused, so the report agrees with reality
  await expectError('D14c a blank draft is refused at posting', 'TOO_FEW_LINES', () => postDraft(blank.id, 'alicio@example.test'))
  await expectError('D14d a retired account is refused at posting', 'INACTIVE_ACCOUNT',
    () => postDraft(deactivated.id, 'alicio@example.test'))
  await byHand((tx) => tx.execute(raw`UPDATE account SET is_active = true WHERE id = ${id['5100']}::uuid`))
  await discardDraft(blank.id)
  await discardDraft(deactivated.id)

  // D15 — a healthy draft is NOT reported, so D14 was not passing on everything
  const healthy = await saveDraft({
    ledgerId: L, entryDate: '2026-07-01', description: 'Perfectly fine',
    lines: [
      { accountId: id['5100'], amount: parseMoney('75.00') },
      { accountId: id['1000'], amount: -parseMoney('75.00') },
    ],
  })
  const stillStale = await db.execute<{ description: string }>(
    raw`SELECT description FROM check_stale_drafts(${L}::uuid)`)
  !stillStale.some((r) => r.description === 'Perfectly fine')
    ? pass('D15 a healthy draft is not reported', `${stillStale.length} stale, none of them this one`)
    : fail('D15 a healthy draft is not reported', JSON.stringify(stillStale))

  // D16 — discarding leaves a trail; the lines go with it
  const [before16] = await db.execute<{ n: string }>(
    raw`SELECT count(*)::text AS n FROM audit_log WHERE action='discard_draft'`)
  await discardDraft(healthy.id)
  const [gone] = await db.execute<{ lines: string; audit: string }>(raw`
    SELECT (SELECT count(*)::text FROM journal_line WHERE entry_id = ${healthy.id}) AS lines,
           (SELECT count(*)::text FROM audit_log WHERE action='discard_draft') AS audit`)
  Number(gone.audit) === Number(before16.n) + 1 && gone.lines === '0'
    ? pass('D16 discarding removes the lines and is audited',
           `discard_draft ${before16.n} -> ${gone.audit}, lines gone`)
    : fail('D16 discarding removes the lines and is audited', JSON.stringify(gone))

  // D17 — the whole draft life is on the record
  const life = await db.execute<{ action: string; n: string }>(raw`
    SELECT action, count(*)::text AS n FROM audit_log
     WHERE action IN ('save_draft','edit_draft','edit_draft_lines','discard_draft','post')
     GROUP BY action ORDER BY action`)
  const byAction = Object.fromEntries(life.map((r) => [r.action, Number(r.n)]))
  byAction.save_draft >= 5 && byAction.discard_draft >= 2
    && byAction.edit_draft >= 1 && byAction.edit_draft_lines >= 1 && byAction.post >= 3
    ? pass('D17 the draft lifecycle is audited', life.map((r) => `${r.action}:${r.n}`).join(' '))
    : fail('D17 the draft lifecycle is audited', JSON.stringify(byAction))

  // D18 — after all of it, the ledger still agrees with itself
  const drift = await db.execute<{ check_name: string }>(raw`SELECT check_name FROM check_balance_integrity(${L}::uuid)`)
  drift.length === 0
    ? pass('D18 the ledger still reconciles', 'no drift after drafts, posts and a discard')
    : fail('D18 the ledger still reconciles', JSON.stringify(drift))

  // D19 — a rejected post must not pile up drafts on retry.
  //
  //        The previous version of this check handed saveDraft the id it had
  //        just been given, so "the id stayed the same" was true by
  //        construction and it passed against the broken code. It now drives
  //        saveThenPost the way the screen does — feeding back only what the
  //        action RETURNS — so reverting the fix makes it go red.
  await byHand((tx) => tx.execute(raw`UPDATE fiscal_period SET status='closed', closed_at=now() WHERE ledger_id = ${L} AND period_no = 8`))
  const payload = {
    ledgerId: L, entryDate: '2026-08-15', description: 'Retried into a closed period',
    actor: 'web',
    lines: [
      { accountId: id['5100'], amount: parseMoney('60.00') },
      { accountId: id['1000'], amount: -parseMoney('60.00') },
    ],
  }
  let carried: string | undefined            // exactly what the screen holds
  const codes: string[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await saveThenPost(payload, carried)
    if (r.ok) { codes.push('POSTED'); break }
    codes.push(r.code)
    carried = r.entryId                      // if the action drops this, drafts multiply
  }
  const [retries] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry WHERE description = 'Retried into a closed period'`)
  retries.n === '1' && codes.every((c) => c === 'PERIOD_CLOSED')
    ? pass('D19 retrying a rejected post reuses the draft', `3 attempts (${codes[0]}), 1 draft`)
    : fail('D19 retrying a rejected post reuses the draft', `${retries.n} drafts, codes ${codes.join(',')}`)

  // D20 — and if the id is NOT carried back, drafts DO multiply. This is the
  //       proof that D19 tests something: same loop, id dropped.
  const [beforeDrop] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry WHERE description = 'Id dropped on retry'`)
  for (let attempt = 0; attempt < 3; attempt++) {
    await saveThenPost({ ...payload, description: 'Id dropped on retry' }, undefined)
  }
  const [afterDrop] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry WHERE description = 'Id dropped on retry'`)
  beforeDrop.n === '0' && afterDrop.n === '3'
    ? pass('D20 dropping the id is what multiplies drafts', '3 attempts without the id -> 3 drafts')
    : fail('D20 dropping the id is what multiplies drafts', `${beforeDrop.n} -> ${afterDrop.n}`)

  await byHand((tx) => tx.execute(raw`UPDATE fiscal_period SET status='open' WHERE ledger_id = ${L} AND period_no = 8`))
  await byHand((tx) => tx.execute(raw`DELETE FROM journal_entry WHERE description IN ('Retried into a closed period','Id dropped on retry')`))

  // ---------------------------------------------------------------- amend --
  // A21-A26 cover the question "how do I fix a posted entry?", which until now
  // had only one honest answer: psql.

  const wrong = await saveThenPost({
    ledgerId: L, entryDate: '2026-10-05', description: 'Invoice 1002 — wrong amount',
    actor: 'web',
    lines: [
      { accountId: id['1200'], amount: parseMoney('1000.00') },
      { accountId: id['4000'], amount: -parseMoney('1000.00') },
    ],
  })
  // Its own id, and it actually guards.
  //
  // Giving it A21's label made a setup failure read as the correction having
  // been tried and not reversed, and would let a block that only breaks
  // `saveThenPost` count A21 as covered. But the split alone left it ANNOUNCING
  // rather than guarding: execution ran on into `amendEntry('')`, which throws,
  // and A21 through A27 went with it — the dying-suite habit in another
  // costume, which is the thing the sibling guards exist to avoid.
  if (!wrong.ok) {
    fail('A21a setup: post an entry to correct', wrong.error)
  } else {
  const original = wrong.entryId
  const [beforeAmend] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry WHERE status IN ('posted','reversed')`)

  const corrected = await amendEntry(original, {
    entryDate: '2026-10-05', description: 'Invoice 1002 — corrected',
    actor: 'web',
    lines: [
      { accountId: id['1200'], amount: parseMoney('1500.00') },
      { accountId: id['4000'], amount: -parseMoney('1500.00') },
    ],
  }, 'web')

  const [orig] = await db.execute<{ status: string; entry_no: string; reversed_by: string | null }>(raw`
    SELECT status, entry_no, (SELECT entry_no FROM journal_entry r WHERE r.id = journal_entry.reversed_by_id) AS reversed_by
      FROM journal_entry WHERE id = ${original}`)
  orig.status === 'reversed' && orig.reversed_by === corrected.reversal.entryNo
    ? pass('A21 correcting reverses the original', `${orig.entry_no} reversed by ${orig.reversed_by}`)
    : fail('A21 correcting reverses the original', JSON.stringify(orig))

  const [after] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry WHERE status IN ('posted','reversed')`)
  Number(after.n) === Number(beforeAmend.n) + 2
    ? pass('A22 all three entries stay in the ledger', `${beforeAmend.n} -> ${after.n}: original, reversal, replacement`)
    : fail('A22 all three entries stay in the ledger', `${beforeAmend.n} -> ${after.n}`)

  // A23 — the three entries together contribute 1,500 to receivables: the
  //       mistake and its reversal cancel, leaving only the correction. Summing
  //       exactly these three is what shows that — the account carries earlier
  //       entries too, and a whole-account total would hide the arithmetic.
  const [trio] = await db.execute<{ n: string; total: string }>(raw`
    SELECT count(DISTINCT je.id)::text AS n, COALESCE(SUM(jl.amount), 0)::text AS total
      FROM journal_entry je JOIN journal_line jl ON jl.entry_id = je.id
     WHERE je.id IN (${original}, ${corrected.reversal.id}, ${corrected.replacement.id})
       AND jl.account_id = ${id['1200']}::uuid`)
  const [drift23] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM check_balance_integrity(${L}::uuid)`)
  trio.n === '3' && BigInt(trio.total) === parseMoney('1500.00') && drift23.n === '0'
    ? pass('A23 the books show the corrected figure',
           '1,000 mistake + (1,000) reversal + 1,500 correction = 1,500 in receivables')
    : fail('A23 the books show the corrected figure',
           `${trio.n} entries totalling ${trio.total}, expected 3 totalling 150000`)

  // A24 — a correction that cannot post takes the reversal with it
  const keeper = await saveThenPost({
    ledgerId: L, entryDate: '2026-11-05', description: 'Must survive a failed correction',
    actor: 'web',
    lines: [
      { accountId: id['1200'], amount: parseMoney('200.00') },
      { accountId: id['4000'], amount: -parseMoney('200.00') },
    ],
  })
  // Guarded, not just named. `keeper.ok ? keeper.entryId : ''` was the last
  // `.ok ? … : ''` in scripts/, and it is the construction A21a replaced three
  // lines of comment ago: with an empty id, `amendEntry('')` throws into the
  // bare catch below, whose query then runs `WHERE id = ''` with no `::uuid`
  // cast — a Postgres type error that escapes `main()` entirely, printing a
  // stack trace where a red line belongs and taking A24 through A27 with it.
  if (!keeper.ok) {
    fail('A24a setup: post the entry A24 tries to break', keeper.error)
  } else {
  const keeperId = keeper.entryId
  try {
    await amendEntry(keeperId, {
      entryDate: '2026-11-05', description: 'Unbalanced replacement',
      lines: [
        { accountId: id['1200'], amount: parseMoney('200.00') },
        { accountId: id['4000'], amount: -parseMoney('150.00') },
      ],
    }, 'web')
    fail('A24 a failed correction leaves the original posted', 'the bad correction was accepted')
  } catch {
    const [still] = await db.execute<{ status: string }>(raw`SELECT status FROM journal_entry WHERE id = ${keeperId}`)
    still.status === 'posted'
      ? pass('A24 a failed correction leaves the original posted', 'reversal rolled back with it')
      : fail('A24 a failed correction leaves the original posted', still.status)
  }

  // A25 — reversing without replacing
  const [beforeRev] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry WHERE status IN ('posted','reversed')`)
  const reversed = await reverseEntry(keeperId, '2026-11-30', 'billed the wrong client', 'web')
  const [revOrig] = await db.execute<{ status: string }>(raw`SELECT status FROM journal_entry WHERE id = ${keeperId}`)
  const [afterRev] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_entry WHERE status IN ('posted','reversed')`)
  revOrig.status === 'reversed' && Number(afterRev.n) === Number(beforeRev.n) + 1
    ? pass('A25 reversing without replacing', `${reversed.reversal.entryNo} cancels it, nothing replaces it`)
    : fail('A25 reversing without replacing', JSON.stringify({ revOrig, afterRev }))

  // A26 — an already-reversed entry cannot be corrected again
  await expectError('A26 an entry cannot be reversed twice', 'NOT_POSTED',
    () => reverseEntry(keeperId, '2026-12-01', 'again', 'web'))

  const [finalDrift] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM check_balance_integrity(${L}::uuid)`)
  finalDrift.n === '0'
    ? pass('A27 the ledger reconciles after corrections', 'no drift')
    : fail('A27 the ledger reconciles after corrections', finalDrift.n)
  } // end of the A24a guard. A24 breaks its entry and A25/A26 reuse the id;
    // A27 uses nothing from it, but sits inside because integrity-checking a
    // ledger whose setup half-ran answers a question nobody asked.
  } // end of the A21a guard. A21-A23 read the correction it posts; the rest
    // sit inside for the same reason as A27 above, not because they use it.

  // D22 — a tax tag on a journal line (owner, 2026-09-07: "journal entry 也需要
  //       能指定税"). The form has no side nominated to absorb a tax, so the
  //       tag SPLITS the line it is on, inclusive: what was typed is the
  //       total, and the entry's own totals do not move. Which side the tax
  //       lands on is the line's sign — a debit is something bought, a credit
  //       is something sold — and PST paid folds back into the line, because
  //       in BC that is part of what the thing cost.
  {
    const id = (code: string) => accts.find((a) => a.code === code)!.id
    const rows = (taxCode: string) => JSON.stringify([
      { accountId: id('5100'), debit: '113.44', credit: '', description: 'Consulting', partyId: '', taxCode },
      { accountId: id('1000'), debit: '', credit: '113.44', description: '', partyId: '', taxCode: '' },
    ])
    const bought = await entryLinesFrom(acme.ledger.id, rows('GST_PST'), '2026-05-01')
    // GST only on the sold side: this chart has no PST payable account, which
    // is what the refusal below is about.
    const sold = await entryLinesFrom(acme.ledger.id, JSON.stringify([
      { accountId: id('4000'), debit: '', credit: '113.44', description: 'Fees', partyId: '', taxCode: 'GST' },
      { accountId: id('1000'), debit: '113.44', credit: '', description: '', partyId: '', taxCode: '' },
    ]), '2026-05-01')
    const untagged = await entryLinesFrom(acme.ledger.id, rows(''), '2026-05-01')
    const by = (ls: Array<{ accountId: string; amount: bigint }>) => {
      const m: Record<string, bigint> = {}
      for (const l of ls) {
        const code = accts.find((a) => a.id === l.accountId)!.code
        m[code] = (m[code] ?? 0n) + l.amount
      }
      return m
    }
    const b = by(bought.lines), sl = by(sold.lines)
    const sum = (m: Record<string, bigint>) => Object.values(m).reduce((t, v) => t + v, 0n)
    // 113.44 at 5 + 7: base 101.29, GST 5.06, PST 7.09. Bought keeps the PST.
    const okBought = b['5100'] === 10838n && b['1300'] === 506n && b['1000'] === -11344n && sum(b) === 0n
    const okSold = sl['4000'] === -10804n && sl['2100'] === -540n && sl['1000'] === 11344n && sum(sl) === 0n
    const okPlain = untagged.lines.length === 2
    // A tag with nowhere to land is refused by name rather than posted quietly
    // into the account it was typed against.
    let refused = ''
    try {
      await entryLinesFrom(acme.ledger.id, JSON.stringify([
        { accountId: id('4000'), debit: '', credit: '50.00', description: '', partyId: '', taxCode: 'PST' },
      ]), '2026-05-01')
      refused = 'allowed'
    } catch (e) { refused = e instanceof Error ? e.message : String(e) }
    // THE LIMIT, recorded rather than left to be discovered: the sign is not a
    // direction of trade. A supplier's refund arriving at the bank is money
    // in, so a credit line reads as something sold and its GST goes to the
    // payable account — which is wrong for a refund, and is why a refund is
    // entered without a tag until a door carries its own direction
    // (critic, 2026-09-07; design 13 §2).
    const refund = await entryLinesFrom(acme.ledger.id, JSON.stringify([
      { accountId: id('5100'), debit: '', credit: '113.44', description: 'Refund from the supplier', partyId: '', taxCode: 'GST' },
      { accountId: id('1000'), debit: '113.44', credit: '', description: '', partyId: '', taxCode: '' },
    ]), '2026-05-01')
    const r = by(refund.lines)
    const refundGoesToPayable = r['2100'] === -540n && r['1300'] === undefined

    okBought && okSold && okPlain && refundGoesToPayable && refused.includes('qst_pst_payable')
      ? pass('D22 a tagged line splits inclusive, on the side its sign says, and the entry still balances',
             `bought: 5100 ${b['5100']} + 1300 ${b['1300']}; sold: 4000 ${sl['4000']} + 2100 ${sl['2100']}; `
             + `a refund's GST goes to payable (the recorded limit): ${r['2100']}; `
             + `no PST account → ${refused.slice(0, 40)}`)
      : fail('D22 a tagged line splits inclusive, on the side its sign says, and the entry still balances',
             `${JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v)])))} / `
             + `${JSON.stringify(Object.fromEntries(Object.entries(sl).map(([k, v]) => [k, String(v)])))} / ${refused.slice(0, 60)}`)
  }

  // D42 — one entry asking two tax roles lands each on its own account. The
  //       role lookup is memoised per expansion (whole-project audit,
  //       2026-09-13); a memo that lost its key would hand the first-asked
  //       account to every role, and D22 never asks two roles in one entry.
  //       (Runs after D22 on purpose: D22's refusal case needs no PST account
  //       to exist yet.)
  {
    const pstAcct = await createAccount({ entityId: acme.company.id, code: '2110',
      name: 'PST payable', accountType: 'liability', roles: ['qst_pst_payable'] }, 'alicio@example.test')
    const t = computeTax(11200n, 'GST_PST', true, '2026-05-01')
    const sale = await entryLinesFrom(acme.ledger.id, JSON.stringify([
      { accountId: accts.find((a) => a.code === '4000')!.id, debit: '', credit: '112.00', description: 'Taxable sale', partyId: '', taxCode: 'GST_PST' },
      { accountId: accts.find((a) => a.code === '1000')!.id, debit: '112.00', credit: '', description: '', partyId: '', taxCode: '' },
    ]), '2026-05-01')
    const all = [...accts, pstAcct]
    const m: Record<string, bigint> = {}
    for (const l of sale.lines) {
      const code = all.find((a) => a.id === l.accountId)!.code
      m[code] = (m[code] ?? 0n) + l.amount
    }
    const detail = `GST ${m['2100'] ?? 'nowhere'} on 2100 (expected ${-t.gst}), PST ${m['2110'] ?? 'nowhere'} on 2110 `
      + `(expected ${-t.pst}), balanced ${Object.values(m).reduce((x, v) => x + v, 0n) === 0n}`
    t.gst > 0n && t.pst > 0n && m['2100'] === -t.gst && m['2110'] === -t.pst
      && Object.values(m).reduce((x, v) => x + v, 0n) === 0n
      ? pass('D42 one entry asking two tax roles lands each on its own account', detail)
      : fail('D42 one entry asking two tax roles lands each on its own account', detail)
  }

  // D23 — the journal entry carries its paper too. The post door is a form
  //        reader now rather than a body inside the server action, for the
  //        reason every *-forms.ts is: a check can call it (owner asked for
  //        attachments on the journal entry, 2026-09-07).
  {
    const id = (code: string) => accts.find((a) => a.code === code)!.id
    const f = new FormData()
    f.set('ledgerId', acme.ledger.id)
    f.set('entryDate', '2026-04-20')
    f.set('description', 'Typed with its paper')
    f.set('lines', JSON.stringify([
      { accountId: id('5100'), debit: '45.00', credit: '', description: '', partyId: '' },
      { accountId: id('1000'), debit: '', credit: '45.00', description: '', partyId: '' },
    ]))
    f.set(ATTACH_FIELD, new File([Buffer.from('%PDF-1.4 the paper')], 'DSC_0099.pdf', { type: 'application/pdf' }))
    const posted = await postEntryFromForm(f, { ledgerId: acme.ledger.id, actor: 'alicio@example.test' })
    const filed = posted.entryId ? await attachmentsOf(posted.entryId) : []
    posted.ok?.startsWith('Posted as') === true && posted.ok.includes('filed against it')
      && filed.length === 1 && filed[0].filename === '2026-04-20 45.00.pdf'
      && filed[0].uploaded === 'DSC_0099.pdf'
      ? pass('D23 a journal entry posted with its paper files it, renamed for the date and amount',
             `${posted.ok}; ${filed[0].filename}`)
      : fail('D23 a journal entry posted with its paper files it, renamed for the date and amount',
             `${posted.ok ?? posted.error}; ${filed.map((a) => a.filename).join(',') || 'nothing filed'}`)
  }

  // D41 — THE ID BESIDE THE LEDGER, at the five entry doors. Each takes the
  //       ledger the form was posted from and asks `ours()` before touching
  //       the entry (audit, 2026-09-13). The other company's posted entry and
  //       draft, each door with THIS ledger; then both exactly as they were.
  {
    const theirs = await createCompany({ code: 'THEIRS', name: 'Somebody Else Ltd.' }, 'alicio@example.test')
    await createFiscalYear(theirs.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirAccts = await importAccounts(theirs.company.id,
      parseAccountsCsv('code,name,type,parent,roles\n1000,Their cash,asset,,cash_and_cash_equivalents\n5000,Their fees,expense,,professional_fees')
        .map((r) => ({ ...r, entityId: theirs.company.id })), 'alicio@example.test')
    const tid = Object.fromEntries(theirAccts.map((a) => [a.code, a.id]))
    const posted = await postEntry({
      ledgerId: theirs.ledger.id, entryDate: '2026-03-10', description: 'Their fee', actor: 'alicio@example.test',
      lines: [{ accountId: tid['5000']!, amount: 5000n }, { accountId: tid['1000']!, amount: -5000n }],
    })
    const draft = await saveDraft({
      ledgerId: theirs.ledger.id, entryDate: '2026-03-11', description: 'Their draft', actor: 'alicio@example.test',
      lines: [{ accountId: tid['5000']!, amount: 100n }, { accountId: tid['1000']!, amount: -100n }],
    })
    const lines = [{ accountId: tid['5000']!, amount: 5000n }, { accountId: tid['1000']!, amount: -5000n }]
    const said = (e: unknown) => (e instanceof PostingError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e))
    const wrong: string[] = []
    const doors: Array<[string, () => Promise<unknown>]> = [
      ['edit', () => editEntry(posted.entry.id, { entryDate: '2026-03-10', description: 'Ours now', lines }, 'alicio@example.test', L)],
      ['delete', () => deleteEntry(posted.entry.id, 'alicio@example.test', L)],
      ['reverse', () => reverseEntry(posted.entry.id, '2026-03-12', 'from the wrong company', 'alicio@example.test', L)],
      ['amend', () => amendEntry(posted.entry.id, { entryDate: '2026-03-10', description: 'Ours now', actor: 'alicio@example.test', lines }, 'alicio@example.test', L)],
      ['discard', () => discardDraft(draft.id, 'alicio@example.test', L)],
    ]
    for (const [label, fn] of doors) {
      try { await fn(); wrong.push(`${label} went through`) }
      catch (e) { if (!(e instanceof PostingError) || e.code !== 'NOT_OURS') wrong.push(`${label}: ${said(e)}`) }
    }
    const [still] = await db.execute<{ posted: string; drafts: string; entries: string }>(raw`
      SELECT (SELECT status FROM journal_entry WHERE id = ${posted.entry.id}::uuid) AS posted,
             (SELECT count(*) FROM journal_entry WHERE id = ${draft.id}::uuid)::text AS drafts,
             (SELECT count(*) FROM journal_entry WHERE ledger_id = ${theirs.ledger.id}::uuid)::text AS entries`)
    ;(wrong.length === 0 && still?.posted === 'posted' && still?.drafts === '1' && still?.entries === '2' ? pass : fail)(
      "D41 editing, deleting, reversing, amending or discarding another company's entry under this ledger is refused before anything happens",
      wrong.length ? wrong.join('; ') : `five doors refused as NOT_OURS; their entry still ${still?.posted}, their draft still there, ${still?.entries} entries in their books`)
  }

  await trailNamesPeople((ok, l, d) => (ok ? pass(l, d) : fail(l, d)), 'D21 every audit row this suite wrote names a person, not the database role')
  // D40 — A LONG ENTRY DOES NOT TAKE THE WHOLE SCREEN. The journal list drew
  //       every line of every entry, so a pay run touching a dozen accounts
  //       pushed the next entry off the page (owner, 2026-09-07). Two lines
  //       is what an entry IS — something went somewhere and came from
  //       somewhere — and the rest folds, saying how many it is hiding.
  {
    const render = (lines: number) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-entry-lines.tsx', JSON.stringify({ lines }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html

    const short = render(2)
    const long = render(9)
    const rowsIn = (h: string) => (h.match(/<tr>/g) ?? []).length
    const label = 'D40 an entry over two lines folds, and says how many it is hiding'
    // Two lines: two rows and no button. Nine: two rows, one button, and the
    // count on it — a fold that does not say what it hides is a line you have
    // to open to find out whether you wanted it.
    rowsIn(short) === 2 && !short.includes('more line')
      && rowsIn(long) === 3 && long.includes('7 more lines')
      ? pass(label, `2 lines → ${rowsIn(short)} rows, no fold; 9 lines → 2 shown, "7 more lines…"`)
      : fail(label, `${rowsIn(short)} / ${rowsIn(long)}; ${long.includes('7 more lines')}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

/**
 * The bank module's two doors (docs/design/19-bank-feed-and-reconcile.md).
 *
 * One: the FEED suggests and never decides — an exact match when there is
 * exactly one, the remembered account otherwise, and a batch accept that
 * re-judges every row on the server.
 *
 * Two: RECONCILE. The difference is one number computed in one place — the
 * database function the Finish guard calls — and finishing freezes everything
 * up to that date: rows, matches, ignores, statements. A freeze nobody has
 * watched refuse is a freeze on trust, so every door it shuts is pushed on
 * here, and then Undo is shown to open them again.
 */
import './env'
import { errorText, expectDbRefusal, reporter } from './suite'
import { byHand } from './by-hand'
import { trailNamesPeople } from './actor-trail'
import { execFileSync } from 'node:child_process'
import { sql as raw } from 'drizzle-orm'
import { stringify } from './json-bigint'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts } from '../src/lib/accounts'
import { amendEntry, deleteEntry, editEntry, postEntry } from '../src/lib/posting'
import { createParty } from '../src/lib/parties'
import {
  acceptMatches, accountStandings, bankRows, candidateEntries, feed, reconciliation,
  finishReconciliation, ignoreBankRow, importBankRows, matchEntry, matchesFor, postFromBankRow,
  reconcileView, rememberedContra, saveStatement, statementsFor, undoReconciliation,
  unignoreBankRow, unmatch,
} from '../src/lib/bank'
import {
  acceptMatchesFromForm, deleteStatementFromForm, finishFromForm, ignoreFromForm, matchFromForm,
  postFromRowForm, reconciledSentence, saveStatementFromForm, undoFromForm, unignoreFromForm,
  unmatchFromForm,
} from '../src/lib/match-forms'
import { importBankFromForm } from '../src/lib/bank-forms'
import { BANK_FIELDS, rowsToField } from '../src/lib/bank-wire'
import { MATCH_FIELDS as F } from '../src/lib/forms'
import { MODULE_PATHS } from '../src/lib/nav'

const r = reporter(58)
const { pass, fail, check } = r

const expectDbError = expectDbRefusal(r, { passSlice: 80, failSlice: 150 })

const CHART: Array<[string, string, 'asset' | 'revenue' | 'expense' | 'liability', string[]?]> = [
  ['1000', 'Cash — Operating', 'asset'],
  ['1010', 'Cash — Savings', 'asset'],
  ['1200', 'Accounts Receivable', 'asset'],
  // The tax accounts an Add's tag lands on, by role — the same roles the
  // quick and invoice doors look up.
  ['1300', 'GST recoverable', 'asset', ['gst_hst_recoverable']],
  ['2300', 'GST payable', 'liability', ['gst_hst_payable']],
  ['2310', 'PST payable', 'liability', ['qst_pst_payable']],
  ['4000', 'Consulting Revenue', 'revenue'],
  ['5000', 'Bank Charges', 'expense'],
  ['5100', 'Utilities', 'expense'],
]

async function main() {
  try {
    await body()
  } catch (e) {
    fail('the suite threw before it finished', errorText(e).slice(0, 110))
  }
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

async function body() {
  const acme = await createCompany({ code: 'ACME', name: 'Acme Consulting Inc.', province: 'BC' }, 'alicio@example.test')
  await createFiscalYear(acme.ledger.id, '2026-12-31', 'alicio@example.test')
  const ledgerId = acme.ledger.id
  const chart = await importAccounts(acme.company.id, CHART.map(([code, name, accountType, roles]) =>
    ({ entityId: acme.company.id, code, name, accountType, roles: roles ?? [] })), 'alicio@example.test')
  const at = (code: string) => chart.find((a) => a.code === code)!
  const cash = at('1000'), ar = at('1200'), charges = at('5000'), utilities = at('5100')

  const entryOn = async (date: string, amount: bigint, description: string, other = ar.id) =>
    postEntry({
      ledgerId, entryDate: date, description, actor: 'alicio@example.test',
      lines: [{ accountId: cash.id, amount }, { accountId: other, amount: -amount }],
    })
  const rowsIn = async (rows: Array<[string, bigint, string]>) =>
    importBankRows({
      accountId: cash.id, actor: 'alicio@example.test',
      rows: rows.map(([date, amount, description]) => ({ date, amount, description })),
    })
  const rowNamed = async (description: string) =>
    (await bankRows(cash.id)).find((r) => r.description === description)!
  const statementOf = async (date: string) =>
    (await statementsFor(cash.id)).find((s) => s.statement_date === date)!

  // ---------------------------------------------------------------- the feed --

  await rowsIn([
    ['2026-03-02', 320000n, 'CLIENT DEPOSIT'],
    ['2026-03-03', -1695n, 'MONTHLY FEE'],
    ['2026-03-04', -8800n, 'SHAW CABLE 4471'],
    ['2026-03-05', 120000n, 'TWO CANDIDATES'],
    ['2026-03-09', -4200n, 'NOTHING KNOWN'],
  ])

  {
    // Exactly one entry with exactly the right room → a match is suggested.
    const paid = await entryOn('2026-03-02', 320000n, 'Invoice 41 paid')
    // Two entries with the right room → no suggestion; the person chooses.
    await entryOn('2026-03-05', 120000n, 'Invoice 42 paid')
    await entryOn('2026-03-05', 120000n, 'Invoice 43 paid')

    const f = await feed(cash.id)
    const deposit = f.pending.find((v) => v.row.description === 'CLIENT DEPOSIT')!
    const two = f.pending.find((v) => v.row.description === 'TWO CANDIDATES')!
    check(deposit.suggestion.kind === 'match'
          && deposit.suggestion.entry.entry_id === paid.entry.id,
      'RC1 one entry with exactly the room needed is suggested as the match',
      deposit.suggestion.kind === 'match' ? `entry ${deposit.suggestion.entry.entry_no}` : deposit.suggestion.kind)
    const exact = two.candidates.filter((c) => c.room === two.row.unmatched_amount)
    check(two.suggestion.kind === 'none' && exact.length === 2,
      'RC2 two such entries is a choice, not a suggestion',
      `${exact.length} exact of ${two.candidates.length} candidates, suggestion ${two.suggestion.kind}`)
  }

  {
    // The remembered account: post one SHAW row to Utilities, and the next
    // SHAW row — different reference number — is suggested to go there.
    const shaw = await rowNamed('SHAW CABLE 4471')
    await postFromBankRow({ bankTransactionId: shaw.id, contraAccountId: utilities.id, actor: 'alicio@example.test' })
    await rowsIn([['2026-04-04', -8800n, 'SHAW CABLE 9920']])
    const again = await rowNamed('SHAW CABLE 9920')
    const remembered = await rememberedContra(cash.id, again.description)
    const f = await feed(cash.id)
    const v = f.pending.find((x) => x.row.id === again.id)!
    check(remembered?.account_id === utilities.id && v.suggestion.kind === 'add'
          && v.suggestion.contraAccountId === utilities.id,
      'RC3 a row like one posted before is suggested to the same account, digits ignored',
      `${v.suggestion.kind}${v.suggestion.kind === 'add' ? ` → ${v.suggestion.contraLabel}` : ''}`)
    const unknown = f.pending.find((x) => x.row.description === 'NOTHING KNOWN')!
    check(unknown.suggestion.kind === 'none',
      'RC4 and a row like nothing before is suggested nothing', unknown.suggestion.kind)
  }

  {
    // The tabs partition the rows: every row in exactly one.
    const shaw = await rowNamed('SHAW CABLE 9920')
    await ignoreBankRow(shaw.id, 'checking the excluded tab', 'alicio@example.test')
    const f = await feed(cash.id)
    const all = await bankRows(cash.id)
    const ids = [...f.pending, ...f.posted, ...f.excluded].map((v) => v.row.id)
    check(ids.length === all.length && new Set(ids).size === all.length
          && f.excluded.some((v) => v.row.id === shaw.id)
          && f.posted.some((v) => v.row.description === 'SHAW CABLE 4471'),
      'RC5 the three tabs hold every row once',
      `${f.pending.length} to review, ${f.posted.length} categorized, ${f.excluded.length} excluded`)
    await unignoreBankRow(shaw.id)
  }

  {
    // Batch accept re-judges on the server. Two rows are ticked: one whose
    // suggestion is still exact, one whose suggested entry was claimed by
    // somebody else in between. One accepted, one skipped, and it says so.
    const deposit = await rowNamed('CLIENT DEPOSIT')
    const fee = await rowNamed('MONTHLY FEE')
    const feeEntry = await entryOn('2026-03-03', -1695n, 'Service charge', charges.id)
    // A near miss for the fee: same direction, wrong amount. A batch accept
    // that stops re-judging would take it (block 376); one that re-judges
    // skips the row, because near is not exact.
    await entryOn('2026-03-07', -5000n, 'Some other charge', charges.id)
    // Claim the fee's only exact entry through a different row first.
    await rowsIn([['2026-03-03', -1695n, 'MONTHLY FEE DUPLICATE']])
    const dup = await rowNamed('MONTHLY FEE DUPLICATE')
    await matchEntry({ bankTransactionId: dup.id, entryId: feeEntry.entry.id, actor: 'alicio@example.test' })

    const r = await acceptMatches({ accountId: cash.id, rowIds: [deposit.id, fee.id], actor: 'alicio@example.test' })
    const after = await bankRows(cash.id)
    const skippedTotal = Object.values(r.skipped).reduce((a, b) => a + b, 0)
    check(r.accepted === 1 && skippedTotal === 1 && r.skipped['no longer an exact match'] === 1
          && after.find((x) => x.id === deposit.id)?.state === 'matched'
          && after.find((x) => x.id === fee.id)?.state === 'unmatched',
      'RC6 batch accept takes the exact matches and skips the rest, re-judged now, saying why',
      `${r.accepted} accepted, skipped: ${JSON.stringify(r.skipped)}`)

    const fd = new FormData()
    fd.set(F.ledgerId, ledgerId)
    fd.set(F.accountId, cash.id)
    fd.append(F.rowIds, deposit.id)
    const said = await acceptMatchesFromForm(fd, 'alicio@example.test')
    check(!!said.ok && said.ok.includes('Nothing was accepted'),
      'RC7 and the form says so when there was nothing left to accept', said.ok ?? said.error ?? '')

    // Unclaim the duplicate so the fee row can be settled properly below.
    const [dupMatch] = await matchesFor(dup.id)
    await unmatch(dupMatch.id)
    await ignoreBankRow(dup.id, 'the same fee twice — the bank reversed it', 'alicio@example.test')
    await rowsIn([['2026-03-03', 1695n, 'MONTHLY FEE REVERSAL']])
    await ignoreBankRow((await rowNamed('MONTHLY FEE REVERSAL')).id, 'reversal of the duplicate', 'alicio@example.test')
  }

  // ------------------------------------------------------------ reconcile --

  // March: every row matched or posted, two set-aside rows that net to zero.
  {
    const fee = await rowNamed('MONTHLY FEE')
    const feeEntry = (await candidateEntries(fee.id, 5))[0]
    await matchEntry({ bankTransactionId: fee.id, entryId: feeEntry.entry_id, actor: 'alicio@example.test' })
    const two = await rowNamed('TWO CANDIDATES')
    const pick = (await candidateEntries(two.id, 5))[0]
    await matchEntry({ bankTransactionId: two.id, entryId: pick.entry_id, actor: 'alicio@example.test' })
    const unknown = await rowNamed('NOTHING KNOWN')
    await postFromBankRow({ bankTransactionId: unknown.id, contraAccountId: charges.id, actor: 'alicio@example.test' })
  }

  // The March statement: printed ending = what the rows add up to.
  const marchRows = (await bankRows(cash.id)).filter((r) => r.txn_date <= '2026-03-31')
  const marchEnding = marchRows.reduce((a, r) => a + r.amount, 0n)
  await saveStatement({ accountId: cash.id, statementDate: '2026-03-31', endingBalance: marchEnding, actor: 'alicio@example.test' })

  {
    const v = (await reconcileView(cash.id, '2026-03-31'))!
    // The same figure two ways: from the database function, and by hand.
    const matched = marchRows.reduce((a, r) => a + r.matched_amount, 0n)
    const byHand = marchEnding - (0n + matched)
    const unmatched = marchRows.reduce((a, r) => a + r.unmatched_amount, 0n)
    check(v.difference === byHand && v.difference === v.importGap + unmatched
          && v.cleared === matched,
      'RC8 the difference is ending − (beginning + cleared), and equals import gap + unmatched',
      `${v.difference} = ${v.importGap} + ${unmatched}; cleared ${v.cleared}`)
    check(v.difference === 0n && v.pendingRows.length === 2
          && v.pendingRows.every((r) => r.state === 'ignored'),
      'RC9 two set-aside rows that cancel out leave the difference at zero',
      `${v.pendingRows.length} pending, all set aside, difference ${v.difference}`)
  }

  {
    // A lone set-aside row does NOT balance: it moved the bank and nothing in
    // the books accounts for it.
    await rowsIn([['2026-04-10', -2500n, 'LONE ERROR']])
    const lone = await rowNamed('LONE ERROR')
    await ignoreBankRow(lone.id, 'bank error, no reversal yet', 'alicio@example.test')
    await saveStatement({ accountId: cash.id, statementDate: '2026-04-30',
                          endingBalance: marchEnding - 8800n - 2500n, actor: 'alicio@example.test' })
    const v = (await reconcileView(cash.id, '2026-04-30'))!
    // What the period still owes the books, worked out by hand: the lone
    // set-aside row and whatever else in April is not yet accounted for.
    const april = (await bankRows(cash.id)).filter((r) => r.txn_date > '2026-03-31' && r.txn_date <= '2026-04-30')
    const owed = april.reduce((a, r) => a + r.unmatched_amount, 0n)
    const loneShare = april.find((r) => r.description === 'LONE ERROR')!.unmatched_amount
    check(v.difference === v.importGap + owed && loneShare === -2500n && v.difference !== 0n,
      'RC10 one set-aside row on its own is a difference, not an explanation',
      `difference ${v.difference} = gap ${v.importGap} + owed ${owed}, of which the set-aside row is ${loneShare}`)
    await expectDbError('RC11 and finishing is refused while the difference is not zero',
      'NOT_BALANCED', async () => finishReconciliation((await statementOf('2026-04-30')).id, 'alicio@example.test'))
    const said = await (async () => {
      const fd = new FormData(); fd.set(F.ledgerId, ledgerId)
      fd.set(F.statementId, (await statementOf('2026-04-30')).id)
      return finishFromForm(fd, 'alicio@example.test')
    })()
    check(!!said.error && said.error.includes('not zero'),
      'RC12 in a sentence a person can act on', said.error ?? '')
  }

  {
    // Finishing in order: April cannot be finished before March.
    // (April is not balanced anyway; push it to balanced first.)
    const lone = await rowNamed('LONE ERROR')
    await unignoreBankRow(lone.id)
    await postFromBankRow({ bankTransactionId: lone.id, contraAccountId: charges.id, actor: 'alicio@example.test' })
    const shaw = await rowNamed('SHAW CABLE 9920')
    await postFromBankRow({ bankTransactionId: shaw.id, contraAccountId: utilities.id, actor: 'alicio@example.test' })
    const april = (await reconcileView(cash.id, '2026-04-30'))!
    check(april.difference === 0n && april.earlierOpen === '2026-03-31',
      'RC13 April balances, and knows March is still open',
      `difference ${april.difference}, earlier open ${april.earlierOpen}`)
    await expectDbError('RC14 finishing April before March is refused',
      'EARLIER_OPEN', async () => finishReconciliation((await statementOf('2026-04-30')).id, 'alicio@example.test'))
  }

  {
    await finishReconciliation((await statementOf('2026-03-31')).id, 'alicio@example.test')
    const st = await statementOf('2026-03-31')
    const standings = await accountStandings(acme.company.id)
    const mine = standings.find((s) => s.id === cash.id)!
    check(st.reconciled_at !== null && st.reconciled_by === 'alicio@example.test'
          && mine.finishedThrough === '2026-03-31',
      'RC15 finishing March records who and when, and the account is reconciled through it',
      `by ${st.reconciled_by}, through ${mine.finishedThrough}`)
    const [audit] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM audit_log
       WHERE action = 'reconciliation_finished' AND record_id = ${st.id}`)
    check(audit.n === '1', 'RC16 and the audit trail has the decision', `${audit.n} row`)
  }

  // --------------------------------------------------------------- freeze --

  {
    const deposit = await rowNamed('CLIENT DEPOSIT')
    const [m] = await matchesFor(deposit.id)
    await expectDbError('RC17 a match inside a finished reconciliation cannot be undone',
      'RECONCILED', () => unmatch(m.id))
    const fee = await rowNamed('MONTHLY FEE DUPLICATE')
    await expectDbError('RC18 nor can a row there be put back',
      'RECONCILED', () => unignoreBankRow(fee.id))
    const two = await rowNamed('TWO CANDIDATES')
    await expectDbError('RC19 nor set aside',
      'RECONCILED', () => ignoreBankRow(two.id, 'trying inside the freeze', 'alicio@example.test'))
    await expectDbError('RC20 nor deleted',
      'RECONCILED', () => byHand((tx) => tx.execute(raw`DELETE FROM bank_transaction WHERE id = ${two.id}::uuid`)))

    // A late file with one row inside the freeze: the whole import is refused,
    // the row after the freeze included — an import is one transaction.
    const before = (await bankRows(cash.id)).length
    await expectDbError('RC21 a late row inside the freeze refuses the whole import',
      'RECONCILED', () => rowsIn([['2026-03-15', -1000n, 'LATE ARRIVAL'], ['2026-05-02', -1000n, 'MAY ROW']]))
    check((await bankRows(cash.id)).length === before,
      'RC22 including the row that was fine', `${before} rows before and after`)

    await expectDbError('RC23 a statement cannot be slipped in behind the freeze',
      'RECONCILED', () => saveStatement({ accountId: cash.id, statementDate: '2026-02-28', endingBalance: 0n, actor: 'alicio@example.test' }))
    await expectDbError('RC24 nor can the finished statement be deleted',
      'RECONCILED', async () => db.execute(raw`DELETE FROM bank_statement WHERE id = ${(await statementOf('2026-03-31')).id}::uuid`))
    await expectDbError('RC25 nor its printed figure changed',
      'STATEMENT_IMMUTABLE', async () => db.execute(raw`
        UPDATE bank_statement SET ending_balance = ending_balance + 1 WHERE id = ${(await statementOf('2026-03-31')).id}::uuid`))

    // Amending a matched entry moves its match (07 §3b) — and moving is a change.
    const [dm] = await matchesFor(deposit.id)
    await expectDbError('RC26 amending an entry matched inside the freeze is refused',
      'RECONCILED', () => amendEntry(dm.entry_id, {
        entryDate: '2026-03-02', description: 'Invoice 41 paid (amended)', actor: 'alicio@example.test',
        lines: [{ accountId: cash.id, amount: 320000n }, { accountId: ar.id, amount: -320000n }],
      }, 'alicio@example.test'))

    // And the row AFTER the freeze is still free: May is not March.
    await rowsIn([['2026-05-02', -1000n, 'MAY ROW']])
    const may = await rowNamed('MAY ROW')
    await ignoreBankRow(may.id, 'outside the freeze', 'alicio@example.test')
    await unignoreBankRow(may.id)
    pass('RC27 a row after the freeze can still be set aside and put back')
  }

  // ----------------------------------------------------------------- undo --

  {
    await finishReconciliation((await statementOf('2026-04-30')).id, 'alicio@example.test')
    await expectDbError('RC28 only the newest finished reconciliation can be undone',
      'NOT_THE_NEWEST', async () => undoReconciliation((await statementOf('2026-03-31')).id, 'alicio@example.test', 'verification'))
    const fd = new FormData(); fd.set(F.ledgerId, ledgerId)
    fd.set(F.statementId, (await statementOf('2026-03-31')).id)
    fd.set(F.reason, 'verification')
    const said = await undoFromForm(fd, 'alicio@example.test')
    check(!!said.error && said.error.includes('2026-04-30'),
      'RC29 and the refusal names which one can', said.error ?? '')

    await undoReconciliation((await statementOf('2026-04-30')).id, 'alicio@example.test', 'verification')
    await undoReconciliation((await statementOf('2026-03-31')).id, 'alicio@example.test', 'verification')
    const deposit = await rowNamed('CLIENT DEPOSIT')
    const [m] = await matchesFor(deposit.id)
    await unmatch(m.id)
    check((await rowNamed('CLIENT DEPOSIT')).state === 'unmatched',
      'RC30 undone in order, the freeze lifts and the match can be undone',
      'CLIENT DEPOSIT is unmatched again')
    const [audit] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM audit_log WHERE action = 'reconciliation_undone'`)
    check(audit.n === '2', 'RC31 both undos are on the trail', `${audit.n} rows`)
  }

  // ------------------------------------------------------------- the seat --

  check(MODULE_PATHS.includes('/bank') && !MODULE_PATHS.includes('/bank/import'),
    'RC32 the Bank seat is /bank, and the upload is a step inside it, not a seat',
    MODULE_PATHS.filter((p) => p.startsWith('/bank')).join(' '))

  // ------------------------------------------------------------ the panel --

  {
    // What the reconcile panel prints, rendered from the same view the page
    // renders, read back as a person would: four figures, the buttons, the
    // cleared rows. The library checks above cannot see the screen.
    const deposit = await rowNamed('CLIENT DEPOSIT')
    const c = (await candidateEntries(deposit.id, 5))[0]
    await matchEntry({ bankTransactionId: deposit.id, entryId: c.entry_id, actor: 'alicio@example.test' })
    const view = (await reconcileView(cash.id, '2026-03-31'))!
    const render = (v: typeof view) => JSON.parse(execFileSync('npx',
      ['tsx', 'scripts/render-reconcile-panel.tsx', stringify({ ledgerId, accountId: cash.id, view: v })],
      { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } })) as {
        figures: Record<string, string>; forms: string[]; cleared: number; pending: number
      }
    const open = render(view)
    check(open.figures['Beginning balance'] === String(view.beginningBalance)
          && open.figures['Cleared balance'] === String(view.cleared)
          && open.figures['Statement ending balance'] === String(view.endingBalance)
          && open.figures['Difference'] === String(view.difference),
      'RC33 the panel prints the four figures the view holds',
      Object.entries(open.figures).map(([k, v]) => `${k.split(' ')[0]} ${v}`).join(', '))
    check(open.forms.includes('/finish') && !open.forms.includes('/undo')
          && open.cleared === view.clearedRows.length && open.pending === view.pendingRows.length,
      'RC34 an open statement offers Finish and not Undo, and lists every cleared and pending row',
      `forms ${open.forms.join(' ')}; ${open.cleared} cleared, ${open.pending} pending`)

    await finishReconciliation(view.statementId, 'alicio@example.test')
    const done = render((await reconcileView(cash.id, '2026-03-31'))!)
    check(done.forms.includes('/undo') && !done.forms.includes('/finish'),
      'RC35 a finished one offers Undo and not Finish', `forms ${done.forms.join(' ')}`)
    await undoReconciliation(view.statementId, 'alicio@example.test', 'verification')
  }

  // ------------------------------------------------------- the accept form --

  {
    // The tick in each row must reach the accept form. It lives outside the
    // form (a row's own forms cannot nest inside it) and names it by `form=`;
    // the first version named a span beside the form, and every tick fell on
    // the floor (critic). The harness reads the id off the <form> tag and
    // counts only inputs naming that id.
    const deposit = await rowNamed('CLIENT DEPOSIT')
    const [dm] = await matchesFor(deposit.id)
    await unmatch(dm.id)
    const views = []
    for (const row of await bankRows(cash.id)) {
      const open = row.state === 'unmatched' || row.state === 'part'
      views.push({ row, matches: row.matched_amount === 0n ? [] : await matchesFor(row.id),
                   candidates: open ? await candidateEntries(row.id, 8) : [] })
    }
    const rendered = JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-reconcile.tsx',
      stringify({ ledgerId, accountId: cash.id, recon: await reconciliation(cash.id, '2026-12-31'),
                  views, contraAccounts: [{ id: charges.id, code: '5000', name: 'Bank Charges' }] })],
      { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } })) as {
        forms: Array<{ action: string; fields: Record<string, string> }>
        suggested: Record<string, string>
        formIds: string[]
        orphaned: string[]
      }
    // RC36b — EVERY BOX ON A ROW REACHES A FORM THAT EXISTS. A table cannot
    //         hold a form spanning its cells, so each row puts one in its last
    //         cell and the boxes name it by id. A box naming a form that is
    //         not there looks exactly like one that works and submits nothing
    //         — which is what the rebuilt screen did to the tax and party
    //         boxes on any row with a suggested match, for one build.
    check(rendered.orphaned.length === 0 && rendered.formIds.length > 0,
      'RC36b every box on a row belongs to a form that is on the page',
      rendered.orphaned.length === 0
        ? `${rendered.formIds.length} form(s), nothing pointing at a missing one`
        : `pointing at nothing: ${rendered.orphaned.join(', ')}`)

    const accept = rendered.forms.find((f) => f.action === '/accept')
    const ticked = (accept?.fields[F.rowIds] ?? '').split(',').filter(Boolean)
    const suggestedMatches = Object.entries(rendered.suggested).filter(([, v]) => v.startsWith('match:')).map(([k]) => k)
    check(!!accept && ticked.length === suggestedMatches.length && ticked.length > 0
          && suggestedMatches.every((id) => ticked.includes(id)),
      'RC36 every row with a suggested match has a tick that reaches the accept form',
      `${ticked.length} tick${ticked.length === 1 ? '' : 's'} associated with the accept form, `
      + `${suggestedMatches.length} suggested match${suggestedMatches.length === 1 ? '' : 'es'} on screen`)
    await matchEntry({ bankTransactionId: deposit.id, entryId: dm.entry_id, actor: 'alicio@example.test' })
  }

  // ---------------------------------------------------- whose id is this? --

  {
    // Company B, with its own bank account, rows, a statement and a match.
    // Every handler is then handed B's id with A's ledger id, the way a request
    // built by hand would — and must refuse before touching anything.
    const other = await createCompany({ code: 'OTHR', name: 'Other Ventures Ltd.', province: 'BC' }, 'alicio@example.test')
    await createFiscalYear(other.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirs = await importAccounts(other.company.id, [
      { entityId: other.company.id, code: '1000', name: 'Their Cash', accountType: 'asset' },
      { entityId: other.company.id, code: '5000', name: 'Their Charges', accountType: 'expense' },
    ], 'alicio@example.test')
    const theirCash = theirs.find((a) => a.code === '1000')!
    await importBankRows({ accountId: theirCash.id, actor: 'alicio@example.test',
      rows: [{ date: '2026-06-01', amount: -700n, description: 'THEIR FEE' }] })
    const theirRow = (await bankRows(theirCash.id))[0]
    const theirEntry = await postEntry({
      ledgerId: other.ledger.id, entryDate: '2026-06-01', description: 'Their fee', actor: 'alicio@example.test',
      lines: [{ accountId: theirCash.id, amount: -700n }, { accountId: theirs[1].id, amount: 700n }],
    })
    await matchEntry({ bankTransactionId: theirRow.id, entryId: theirEntry.entry.id, actor: 'alicio@example.test' })
    const [theirMatch] = await matchesFor(theirRow.id)
    await saveStatement({ accountId: theirCash.id, statementDate: '2026-06-30', endingBalance: -700n, actor: 'alicio@example.test' })
    const theirStatement = (await statementsFor(theirCash.id))[0]

    const withA = (fields: Record<string, string>) => {
      const fd = new FormData()
      fd.set(F.ledgerId, ledgerId)          // company A's ledger, always
      for (const [k, v] of Object.entries(fields)) fd.set(k, v)
      return fd
    }
    const REFUSED = "not in this company's books"
    const cases: Array<[string, () => Promise<{ error?: string; ok?: string }>]> = [
      ['RC37 match', () => matchFromForm(withA({ [F.rowId]: theirRow.id, [F.entryId]: theirEntry.entry.id }), 'alicio@example.test')],
      ['RC38 unmatch', () => unmatchFromForm(withA({ [F.matchId]: theirMatch.id }), 'alicio@example.test')],
      ['RC39 exclude', () => ignoreFromForm(withA({ [F.rowId]: theirRow.id, [F.reason]: 'from the wrong company' }), 'alicio@example.test')],
      ['RC40 put back', () => unignoreFromForm(withA({ [F.rowId]: theirRow.id }), 'alicio@example.test')],
      ['RC41 add', () => postFromRowForm(withA({ [F.rowId]: theirRow.id, [F.contraAccountId]: charges.id }), 'alicio@example.test')],
      ['RC42 record statement', () => saveStatementFromForm(withA({ [F.accountId]: theirCash.id, [F.statementDate]: '2026-07-31', [F.endingBalance]: '1.00' }), 'alicio@example.test')],
      ['RC43 delete statement', () => deleteStatementFromForm(withA({ [F.statementId]: theirStatement.id }), 'alicio@example.test')],
      ['RC44 finish', () => finishFromForm(withA({ [F.statementId]: theirStatement.id }), 'alicio@example.test')],
      ['RC45 accept matches', () => acceptMatchesFromForm((() => { const fd = withA({ [F.accountId]: theirCash.id }); fd.append(F.rowIds, theirRow.id); return fd })(), 'alicio@example.test')],
    ]
    for (const [label, fn] of cases) {
      const r = await fn()
      check(!!r.error && r.error.includes(REFUSED),
        `${label} with the other company's id is refused before anything happens`,
        r.error ?? r.ok ?? '')
    }
    // And nothing happened: their statement is still open, their match still there.
    const still = (await statementsFor(theirCash.id))[0]
    check(still.reconciled_at === null && (await matchesFor(theirRow.id)).length === 1
          && (await bankRows(theirCash.id))[0].state === 'matched',
      'RC45b and the other company\'s books are exactly as they were',
      'statement open, match in place')
  }

  // ------------------------------------------- the overlapping file, again --

  {
    // Finish March, then re-import a file that overlaps March by rows already
    // on file: the ordinary next-month case. It must land, counting the
    // overlap as duplicates, because a BEFORE INSERT trigger runs before ON
    // CONFLICT can discard a row (critic; 0056). A genuinely NEW row inside
    // March is still refused — through the form, in a sentence, and the whole
    // file with it.
    const march = await statementOf('2026-03-31')
    await finishReconciliation(march.id, 'alicio@example.test')
    const before = (await bankRows(cash.id)).length
    // A refusal here is the defect (block 382), and it must be a red line,
    // not a dead suite — the check that reports a broken import cannot be the
    // thing the broken import kills (06 §5b).
    try {
      const overlap = await rowsIn([
        ['2026-03-02', 320000n, 'CLIENT DEPOSIT'],   // already on file, inside the freeze
        ['2026-03-09', -4200n, 'NOTHING KNOWN'],     // already on file, inside the freeze
        ['2026-06-03', -1500n, 'JUNE ROW'],          // new, after it
      ])
      check(overlap.inserted === 1 && overlap.duplicates === 2 && (await bankRows(cash.id)).length === before + 1,
        'RC46 a file overlapping a finished period by rows already on file lands as usual',
        `${overlap.inserted} saved, ${overlap.duplicates} already there`)
    } catch (e) {
      fail('RC46 a file overlapping a finished period by rows already on file lands as usual',
        `the whole file was refused: ${errorText(e).split(' | ').find((x) => x.includes('RECONCILED'))?.slice(0, 80) ?? errorText(e).slice(0, 80)}`)
      // Land the June row anyway so the checks after this one have it.
      await undoReconciliation(march.id, 'alicio@example.test', 'verification')
      await rowsIn([['2026-06-03', -1500n, 'JUNE ROW']])
      await finishReconciliation(march.id, 'alicio@example.test')
    }

    const fd = new FormData()
    fd.set(BANK_FIELDS.ledgerId, ledgerId); fd.set(BANK_FIELDS.accountId, cash.id)
    fd.set(BANK_FIELDS.rows, rowsToField([
      { date: '2026-03-20', amount: -999n, description: 'ADDED AFTER SIGN-OFF' },
      { date: '2026-06-04', amount: -1n, description: 'JUNE TOO' },
    ]))
    const said = await importBankFromForm(fd, 'alicio@example.test')
    check(!!said.error && said.error.includes('2026-03-31') && said.error.includes('Nothing was saved')
          && (await bankRows(cash.id)).length === before + 1,
      'RC46b a new row inside it refuses the whole file, in a sentence',
      said.error ?? said.ok ?? '')
    await undoReconciliation(march.id, 'alicio@example.test', 'verification')
  }

  // ------------------------------------- moving a match off a frozen row --

  {
    const march = await statementOf('2026-03-31')
    await finishReconciliation(march.id, 'alicio@example.test')
    const deposit = await rowNamed('CLIENT DEPOSIT')
    const [dm] = await matchesFor(deposit.id)
    const june = await rowNamed('JUNE ROW')
    await expectDbError('RC47 a match cannot be moved OFF a row inside the freeze either',
      'RECONCILED', () => db.execute(raw`
        UPDATE bank_match SET bank_transaction_id = ${june.id}::uuid WHERE id = ${dm.id}::uuid`))

    // Deleting an entry releases its matches (posting.ts); inside the freeze
    // that is refused, and the sentence the action shows names the date.
    let sentence = ''
    try { await deleteEntry(dm.entry_id, 'alicio@example.test') } catch (e) { sentence = errorText(e) }
    const said = reconciledSentence(sentence)
    check(sentence.includes('RECONCILED') && !!said && said.includes('2026-03-31'),
      'RC48 nor can an entry matched inside it be deleted, and the person is told which reconciliation',
      said ?? sentence.slice(0, 90))
    await undoReconciliation(march.id, 'alicio@example.test', 'verification')
  }

  // ------------------------------------------------------------ the report --

  {
    // The printed report, read back as a person would. Two things the model
    // cannot prove about paper: that the Summary FOOTS — beginning, payments,
    // deposits and any difference reach the printed ending — and that every
    // count in a heading equals the rows listed under it.
    const view = (await reconcileView(cash.id, '2026-03-31'))!
    const shown = JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-statement-report.tsx', stringify(view)],
      { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } })) as { lines: string[]; amounts: string[] }
    const after = (label: string) => {
      const i = shown.lines.findIndex((l) => l.startsWith(label))
      const m = shown.lines.slice(i + 1, i + 3).map((l) => /^\(?-?[\d,]+\.\d\d\)?$/.test(l) ? l : null).find(Boolean)
      if (!m) return null
      const neg = m.startsWith('-') || m.startsWith('(')
      const v = BigInt(m.replace(/[^\d]/g, ''))
      return neg ? -v : v
    }
    const b = after('Statement beginning balance'), p = after('Cheques and payments cleared'),
          d = after('Deposits and other credits cleared'), e = after('Statement ending balance'),
          diff = after('Difference') ?? 0n
    check(b !== null && p !== null && d !== null && e !== null && b + p + d + diff === e,
      'RC49 the printed Summary foots: beginning + payments + deposits (+ difference) = ending',
      `${b} + ${p} + ${d} + ${diff} = ${e}`)

    // And on a statement that does NOT balance, the Difference line is what
    // makes it foot — a report that quietly left it out would print four
    // figures that do not add up (block 385). A May statement whose printed
    // ending is a dollar off, and nothing cleared in May.
    await rowsIn([['2026-05-20', -3000n, 'MAY FEE']])
    await saveStatement({ accountId: cash.id, statementDate: '2026-05-31',
                          endingBalance: (await reconcileView(cash.id, '2026-04-30'))!.endingBalance - 3000n - 100n, actor: 'alicio@example.test' })
    const open = (await reconcileView(cash.id, '2026-05-31'))!
    const shownOpen = JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-statement-report.tsx', stringify(open)],
      { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } })) as { lines: string[] }
    const pick = (label: string) => {
      const i = shownOpen.lines.findIndex((l) => l.startsWith(label))
      const m = shownOpen.lines.slice(i + 1, i + 3).find((l) => /^\(?-?[\d,]+\.\d\d\)?$/.test(l))
      if (i < 0 || !m) return null
      const v = BigInt(m.replace(/[^\d]/g, ''))
      return m.startsWith('-') || m.startsWith('(') ? -v : v
    }
    const ob = pick('Statement beginning balance'), op = pick('Cheques and payments cleared'),
          od = pick('Deposits and other credits cleared'), oe = pick('Statement ending balance'),
          odiff = pick('Difference')
    check(open.difference !== 0n && odiff !== null && odiff === open.difference
          && ob !== null && op !== null && od !== null && oe !== null && ob + op + od + odiff === oe,
      'RC49b and an unfinished statement prints the Difference line that makes it foot',
      odiff === null ? 'no Difference line printed' : `${ob} + ${op} + ${od} + ${odiff} = ${oe}`)

    const counted = (label: string) => {
      const line = shown.lines.find((l) => l.startsWith(label))
      return Number(/\((\d+)\)/.exec(line ?? '')?.[1] ?? -1)
    }
    const payments = view.clearedRows.filter((r) => r.amount < 0n).flatMap((r) => r.entries).length
    const deposits = view.clearedRows.filter((r) => r.amount > 0n).flatMap((r) => r.entries).length
    check(counted('Cheques and payments cleared') === payments && counted('Deposits and other credits cleared') === deposits
          && shown.lines.filter((l) => l === 'Total').length >= 2,
      'RC50 and every heading counts the rows listed under it, each list with a Total',
      `${counted('Cheques and payments cleared')} payments, ${counted('Deposits and other credits cleared')} deposits`)
  }
  // ------------------------------------------------------ RC51, RC52, RC53
  // One bank account at a time (RISKS §21b): Finish computes the difference in
  // its own snapshot, so an import or a match committing beside it left a
  // finished statement whose difference was no longer zero. Now every door
  // that changes what a statement reconciles against takes the account's
  // advisory lock first. A second connection holds that lock the way a Finish
  // in flight does; the door under test must not land until it lets go.
  {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const holding = (accountId: string) => {
      let release!: () => void
      let taken!: () => void
      const released = new Promise<void>((r) => { release = r })
      const locked = new Promise<void>((r) => { taken = r })
      // The SAME key the doors use — typed here, not imported, so a change to
      // either side shows up as this check going red.
      const held = conn.begin(async (t) => {
        await t`SELECT pg_advisory_xact_lock(hashtextextended(${'bank_account:' + accountId}, 0))`
        taken()
        await released
      })
      return { locked, release: async () => { release(); await held } }
    }
    /** Does the door wait for the lock? Also reports what the door said. */
    const waits = async (door: () => Promise<unknown>, accountId: string) => {
      const hold = holding(accountId)
      await hold.locked
      let landed: string | null = null
      const attempt = door().then(() => { landed = 'landed' }, (e) => { landed = errorText(e) })
      await sleep(250)
      const waited = landed === null
      await hold.release()
      await attempt
      return { waited, said: landed as unknown as string }
    }

    const imp = await waits(() => rowsIn([['2026-09-01', 1n, 'WHILE HELD']]), cash.id)
    check(imp.waited && imp.said === 'landed',
      'RC51 an import waits while somebody holds the account',
      imp.waited ? `held for 250 ms, then ${imp.said}` : `did not wait: ${imp.said}`)

    const savings = at('1010')
    await saveStatement({ accountId: savings.id, statementDate: '2026-09-30', endingBalance: 0n, actor: 'alicio@example.test' })
    const st = (await statementsFor(savings.id)).find((x) => x.statement_date === '2026-09-30')!
    const fin = await waits(() => finishReconciliation(st.id, 'alicio@example.test'), savings.id)
    const after = (await statementsFor(savings.id)).find((x) => x.statement_date === '2026-09-30')!
    check(fin.waited && fin.said === 'landed' && after.reconciled_at !== null,
      'RC52 and so does Finish, and it still finishes once the lock is released',
      fin.waited ? `held for 250 ms, then ${fin.said}; reconciled_at ${after.reconciled_at ? 'set' : 'NOT set'}`
                 : `did not wait: ${fin.said}`)

    await trailNamesPeople(check, 'RC53 every audit row this suite wrote names a person, not the database role')

    // RC54 — deleting a matched entry releases its match, which changes what a
    //        statement reconciles against, so it waits like an import does.
    //        The first version locked ten doors and not this one (critic).
    const doomed = await entryOn('2026-11-15', 555n, 'To be deleted while matched')
    await rowsIn([['2026-11-15', 555n, 'MATCHED THEN DELETED']])
    const doomedRow = await rowNamed('MATCHED THEN DELETED')
    await matchEntry({ bankTransactionId: doomedRow.id, entryId: doomed.entry.id, actor: 'alicio@example.test' })
    const del = await waits(() => deleteEntry(doomed.entry.id, 'alicio@example.test'), cash.id)
    const [left] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM bank_match WHERE bank_transaction_id = ${doomedRow.id}::uuid`)
    check(del.waited && del.said === 'landed' && left.n === '0',
      'RC54 deleting a matched entry waits for the account too, and its match is released after',
      del.waited ? `held for 250 ms, then ${del.said}; ${left.n} match(es) left` : `did not wait: ${del.said}`)
  }

  // ------------------------------------------------------------------ RC55
  // An Add names who it was with and what tax the row already includes
  // (owner, 2026-09-07). The bank line is the whole row, because that is what
  // the bank moved; the tag splits the OTHER side, inclusive — so 112.00 out
  // tagged GST is 106.67 of expense and 5.33 recoverable, and the entry
  // balances without anybody adjusting the amount they were given.
  {
    const staples = await createParty({
      kind: 'organisation', name: 'Staples Canada ULC', actor: 'alicio@example.test',
      roles: [{ entityId: acme.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
    })
    await rowsIn([['2026-05-02', -11200n, 'STAPLES 8891'], ['2026-05-03', 22400n, 'CLIENT PAID 77']])
    const out = await rowNamed('STAPLES 8891')
    const paid = await postFromBankRow({
      bankTransactionId: out.id, contraAccountId: at('5100').id, partyId: staples.id,
      taxCode: 'GST', actor: 'alicio@example.test',
    })
    const outLines = await db.execute<{ code: string; amount: bigint; party: string | null }>(raw`
      SELECT a.code, jl.amount, jl.party_id::text AS party
        FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${paid.entryId}::uuid ORDER BY a.code`)
    const by = Object.fromEntries(outLines.map((l) => [l.code, l.amount]))
    const partyOn = outLines.find((l) => l.party !== null)
    // Money IN is something sold: the same tag lands on the payable side.
    const inRow = await rowNamed('CLIENT PAID 77')
    const got = await postFromBankRow({
      bankTransactionId: inRow.id, contraAccountId: at('4000').id, taxCode: 'GST',
      actor: 'alicio@example.test',
    })
    const inLines = Object.fromEntries((await db.execute<{ code: string; amount: bigint }>(raw`
      SELECT a.code, jl.amount FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${got.entryId}::uuid`)).map((l) => [l.code, l.amount]))
    const sum = (o: Record<string, bigint>) => Object.values(o).reduce((t, v) => t + v, 0n)
    // Debit positive: money out credits the bank and debits the expense and
    // the recoverable tax; money in is the mirror of that.
    // The form door, with a party that holds no transacting role here: refused
    // by the gate every other id on this screen goes through, and 0025 stands
    // behind it (critic, 2026-09-07).
    const elsewhere = await createCompany(
      { code: 'ELSE', name: 'Elsewhere Holdings Ltd.', province: 'BC' }, 'alicio@example.test')
    const stranger = await createParty({
      kind: 'organisation', name: 'Someone Else Ltd.', actor: 'alicio@example.test',
      roles: [{ entityId: elsewhere.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
    })
    await rowsIn([['2026-05-02', -5000n, 'NOT OUR SUPPLIER']])
    const foreignRow = await rowNamed('NOT OUR SUPPLIER')
    const f = new FormData()
    f.set(F.ledgerId, ledgerId); f.set(F.accountId, cash.id); f.set(F.rowId, foreignRow.id)
    f.set(F.contraAccountId, at('5100').id); f.set(F.partyId, stranger.id)
    const refusedParty = await postFromRowForm(f, 'alicio@example.test')
    const [nothingPosted] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM bank_match WHERE bank_transaction_id = ${foreignRow.id}::uuid`)

    check(!!refusedParty.error && refusedParty.error.includes("this company") && nothingPosted.n === '0'
      && by['1000'] === -11200n && by['5100'] === 10667n && by['1300'] === 533n
      && partyOn?.code === '5100' && partyOn.party === staples.id && sum(by) === 0n
      && inLines['1000'] === 22400n && inLines['4000'] === -21333n && inLines['2300'] === -1067n
      && sum(inLines) === 0n,
      'RC55 an Add names the party and splits the tax the row already includes, each way',
      `out: bank ${by['1000']}, expense ${by['5100']}, recoverable ${by['1300']}, party on ${partyOn?.code}; `
      + `in: bank ${inLines['1000']}, revenue ${inLines['4000']}, payable ${inLines['2300']}; `
      + `another company's party → ${refusedParty.error?.slice(0, 40)}`)
  }

  // ------------------------------------------------------------------ RC56
  // Correcting an Add is an edit, not a reversal (owner, 2026-09-07: "不必要
  // 一定要冲掉旧帐做新帐"). The row's match RIDES ALONG, because the match is
  // why the entry exists; an edit that takes the entry off the bank account
  // is refused whole, with the row still settled by what it was.
  {
    await rowsIn([['2026-05-04', -4500n, 'WRONG ACCOUNT 1']])
    const row = await rowNamed('WRONG ACCOUNT 1')
    const posted = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: at('5000').id, actor: 'alicio@example.test',
    })
    const fixed = await editEntry(posted.entryId, {
      entryDate: '2026-05-04', description: 'Utilities, not bank charges',
      lines: [{ accountId: cash.id, amount: -4500n }, { accountId: at('5100').id, amount: 4500n }],
    }, 'alicio@example.test')
    const after = Object.fromEntries((await db.execute<{ code: string; amount: bigint }>(raw`
      SELECT a.code, jl.amount FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${posted.entryId}::uuid`)).map((l) => [l.code, l.amount]))
    const kept = await matchesFor(row.id)
    // An edit that no longer settles the row is refused, and changes nothing.
    let broke = ''
    try {
      await editEntry(posted.entryId, {
        entryDate: '2026-05-04', description: 'Off the bank account entirely',
        lines: [{ accountId: at('5100').id, amount: 4500n }, { accountId: ar.id, amount: -4500n }],
      }, 'alicio@example.test')
      broke = 'allowed'
    } catch (e) { broke = errorText(e) }
    const stillThere = Object.fromEntries((await db.execute<{ code: string; amount: bigint }>(raw`
      SELECT a.code, jl.amount FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${posted.entryId}::uuid`)).map((l) => [l.code, l.amount]))
    // And an edit that leaves a line on the account but a SMALLER one: the
    // BEFORE trigger is happy (there is still a line, moving the same way) and
    // only the deferred total guard can see it, at commit. Two different
    // guards, two different edits — the first version checked one and claimed
    // both (critic, 2026-09-07).
    let shrank = ''
    try {
      await editEntry(posted.entryId, {
        entryDate: '2026-05-04', description: 'Smaller than what it settles',
        lines: [{ accountId: cash.id, amount: -1000n }, { accountId: at('5100').id, amount: 1000n }],
      }, 'alicio@example.test')
      shrank = 'allowed'
    } catch (e) { shrank = errorText(e) }
    const sizeNow = Object.fromEntries((await db.execute<{ code: string; amount: bigint }>(raw`
      SELECT a.code, jl.amount FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${posted.entryId}::uuid`)).map((l) => [l.code, l.amount]))
    check(after['5100'] === 4500n && after['5000'] === undefined && fixed.releasedMatches === 0
      && kept.length === 1 && kept[0].amount === -4500n
      && broke !== 'allowed' && broke.includes('ENTRY_NOT_ON_ACCOUNT')
      && shrank !== 'allowed' && shrank.includes('ENTRY_OVER_MATCHED') && sizeNow['1000'] === -4500n
      && stillThere['1000'] === -4500n && (await matchesFor(row.id)).length === 1,
      'RC56 a bank entry is edited in place and keeps its match; an edit that stops settling the row is refused',
      `moved to ${Object.keys(after).join('+')}; released ${fixed.releasedMatches}; `
      + `kept ${kept.length} match(es); off the account → ${broke.includes('ENTRY_NOT_ON_ACCOUNT') ? 'ENTRY_NOT_ON_ACCOUNT' : broke.slice(0, 40)}; `
      + `smaller than the match → ${shrank.includes('ENTRY_OVER_MATCHED') ? 'ENTRY_OVER_MATCHED' : shrank.slice(0, 40)}`)
  }

  // ------------------------------------------------------------------ RC57
  // And deleting one puts the row back in the feed, which is the honest
  // answer: the entry is gone, so nothing accounts for the money any more.
  {
    await rowsIn([['2026-05-05', -1900n, 'ADDED BY MISTAKE']])
    const row = await rowNamed('ADDED BY MISTAKE')
    const posted = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: at('5000').id, actor: 'alicio@example.test',
    })
    const gone = await deleteEntry(posted.entryId, 'alicio@example.test')
    const [after] = await db.execute<{ state: string }>(raw`
      SELECT state FROM bank_row_state WHERE id = ${row.id}::uuid`)
    const [still] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry WHERE id = ${posted.entryId}::uuid`)
    check(gone.releasedMatches === 1 && after.state === 'unmatched' && still.n === '0',
      'RC57 deleting a bank entry releases the row back into the feed',
      `released ${gone.releasedMatches}; the row is ${after.state}; ${still.n} entr(ies) left`)
  }

  // ----------------------------------------------------------------- RC57b
  // Inside a finished reconciliation, neither door opens. The carry path
  // returns BEFORE the delete that used to be how an edit met the freeze, so
  // it reaches `trg_a_bank_match_frozen` only through `recheckMatches` — an
  // ordering nothing exercised until this check (critic, 2026-09-07).
  //
  // On the savings account, AFTER the 2026-09-30 one RC52 finished there — a
  // reconciliation only finishes at a difference of zero, and the operating
  // account carries rows left unaccounted for on purpose. Inside that earlier
  // freeze even the import is refused, which is RC21's rule doing its job.
  {
    const savings = at('1010')
    await importBankRows({
      accountId: savings.id, actor: 'alicio@example.test',
      rows: [{ date: '2026-10-10', amount: -2500n, description: 'INSIDE THE FREEZE' }],
    })
    const row = (await bankRows(savings.id)).find((r) => r.description === 'INSIDE THE FREEZE')!
    const posted = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: at('5000').id, actor: 'alicio@example.test',
    })
    await saveStatement({
      accountId: savings.id, statementDate: '2026-10-31', endingBalance: -2500n,
      actor: 'alicio@example.test',
    })
    const october = (await statementsFor(savings.id)).find((st) => st.statement_date === '2026-10-31')!
    const view = (await reconcileView(savings.id, '2026-10-31'))!
    let finished = ''
    try { await finishReconciliation(october.id, 'alicio@example.test') } catch (e) { finished = errorText(e) }
    let edited = '', deleted = ''
    try {
      await editEntry(posted.entryId, {
        entryDate: '2026-10-10', description: 'Not while it is frozen',
        lines: [{ accountId: savings.id, amount: -2500n }, { accountId: at('5100').id, amount: 2500n }],
      }, 'alicio@example.test')
      edited = 'allowed'
    } catch (e) { edited = errorText(e) }
    try { await deleteEntry(posted.entryId, 'alicio@example.test'); deleted = 'allowed' }
    catch (e) { deleted = errorText(e) }
    const [survives] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry WHERE id = ${posted.entryId}::uuid`)
    check(view.difference === 0n && finished === ''
      && edited.includes('RECONCILED') && deleted.includes('RECONCILED')
      && !!reconciledSentence(edited) && reconciledSentence(edited)!.includes('2026-10-31')
      && survives.n === '1' && (await matchesFor(row.id)).length === 1,
      'RC57b a finished reconciliation refuses both doors on a bank entry, and says which one to undo',
      `difference ${view.difference}; finish: ${finished || 'done'}; `
      + `edit → ${reconciledSentence(edited)?.slice(0, 60) ?? edited.slice(0, 40)}; `
      + `delete → ${deleted.includes('RECONCILED') ? 'RECONCILED' : deleted.slice(0, 40)}`)
    await undoReconciliation(october.id, 'alicio@example.test', 'verification')
  }

  // ------------------------------------------------------------------ RC58
  // The replay key knows WHAT is being posted, not just how much is left. On
  // the remainder alone, Adding the same row again with the right account
  // replayed the first entry and reported success — the correction vanished.
  {
    await rowsIn([['2026-05-06', -700n, 'REPLAY GUARD']])
    const row = await rowNamed('REPLAY GUARD')
    const first = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: at('5000').id, actor: 'alicio@example.test',
    })
    // Undo the match and the row is whole again, so the remainder — the only
    // thing the old key knew — is exactly what it was the first time.
    await unmatch((await matchesFor(row.id))[0].id, 'alicio@example.test')
    const second = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: at('5100').id, actor: 'alicio@example.test',
    })
    const where = Object.keys(Object.fromEntries((await db.execute<{ code: string }>(raw`
      SELECT a.code FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${second.entryId}::uuid`)).map((l) => [l.code, true])))
    const [firstStill] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry WHERE id = ${first.entryId}::uuid`)
    check(!second.replayed && second.entryId !== first.entryId && where.includes('5100') && firstStill.n === '1',
      'RC58 Adding a row again against a different account is a new entry, not a replay',
      `replayed ${second.replayed}; landed on ${where.join('+')}; the first entry is still there: ${firstStill.n === '1'}`)
  }

}

main()

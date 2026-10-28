/**
 * Reconciling a bank row against the books: matching, partial matching, posting
 * an entry from a row, and the arithmetic that has to hold afterwards.
 *   npm run db:verify-bank-match   (resets the database first)
 *
 * Two things this suite is really about.
 *
 * One: a match is a claim on both sides. A row can only be claimed up to what it
 * is, and an entry can only be claimed up to what it did on that account —
 * otherwise one $500 payment settles five different $500 deposits and every one
 * of them looks reconciled.
 *
 * Two: an entry made from a bank row has to be an ordinary entry. If the import
 * can put rows in the ledger by any route other than `postEntryCore`, then every
 * guard the ledger has is optional from that direction.
 */
import './env'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync } from 'node:fs'
process.env.ATTACHMENTS_DIR = mkdtempSync(path.join(os.tmpdir(), 'figtree-bank-post-'))
import { cleanupWith, errorText, expectCode, expectDbRefusal, reporter } from './suite'
import { byHand } from './by-hand'
import { trailNamesPeople } from './actor-trail'
import { execFileSync } from 'node:child_process'
import { sql as raw } from 'drizzle-orm'
import { stringify } from './json-bigint'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts } from '../src/lib/accounts'
import { createParty, transactingPartyRoles } from '../src/lib/parties'
import { attachmentsOf } from '../src/lib/attachments'
import { amendEntry, deleteEntry, postEntry, reverseEntry, saveDraft } from '../src/lib/posting'
import { closePeriod } from '../src/lib/periods'
import { postOpeningBalance } from '../src/lib/opening'
import {
  bankRows, bankTotals, candidateEntries, deleteStatement, ignoreBankRow,
  importBankRows, matchEntry, matchesFor, postFromBankRow, reconciliation, reconcileView, saveStatement,
  statementsFor, unignoreBankRow, unmatch,
} from '../src/lib/bank'
import { ATTACH_FIELD, MATCH_FIELDS as F, bankPartyOptions } from '../src/lib/forms'
import {
  deleteRowFromForm, ignoreFromForm, matchFromForm, postFromRowForm, unignoreFromForm, unmatchFromForm,
} from '../src/lib/match-forms'
import { reconciliationPdf } from '../src/lib/pdf-reports'
import { pdfText } from './pdf-text'
import { formatMoney } from '../src/lib/money'

const r = reporter(58)
const { fail, check } = r

const expectDbError = expectDbRefusal(r, { passSlice: 80, failSlice: 150 })

const expectError = expectCode(r, { passSlice: 78, failText: (e) => errorText(e).slice(0, 90) })

/** Restores go through here; a restore that cannot happen is a named failure. */
const cleanup = cleanupWith(r)

const CHART: Array<[string, string, 'asset' | 'revenue' | 'expense' | 'liability']> = [
  ['1000', 'Cash — Operating', 'asset'],
  ['1200', 'Accounts Receivable', 'asset'],
  ['2000', 'Accounts Payable', 'liability'],
  ['4000', 'Consulting Revenue', 'revenue'],
  ['5000', 'Bank Charges', 'expense'],
]

async function main() {
  try {
    await body()
  } catch (e) {
    fail('the suite threw before it finished', errorText(e).slice(0, 110))
  }
  await trailNamesPeople(check, 'M78 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

async function body() {
  const acme = await createCompany({ code: 'ACME', name: 'Acme Consulting Inc.', province: 'BC' }, 'alicio@example.test')
  await createFiscalYear(acme.ledger.id, '2026-12-31', 'alicio@example.test')
  const ledgerId = acme.ledger.id

  const chart = await importAccounts(acme.company.id, CHART.map(([code, name, accountType]) =>
    ({ entityId: acme.company.id, code, name, accountType })), 'alicio@example.test')
  const at = (code: string) => chart.find((a) => a.code === code)!
  const cash = at('1000')
  const ar = at('1200')
  const revenue = at('4000')
  const charges = at('5000')

  // Both signs of a bank row can name every role that may transact on that
  // row's own date. The usual counterparty is first, but never the only one.
  const roles = ['customer', 'supplier', 'employee', 'director', 'shareholder'] as const
  const partyIds: string[] = []
  for (const role of roles) {
    const party = await createParty({
      kind: role === 'customer' || role === 'supplier' ? 'organisation' : 'person',
      name: `Bank ${role}`, actor: 'alicio@example.test',
      roles: [{ entityId: acme.company.id, role, heldFrom: '2026-01-01' }],
    })
    partyIds.push(party.id)
  }
  const future = await createParty({
    kind: 'person', name: 'Later director', actor: 'alicio@example.test',
    roles: [{ entityId: acme.company.id, role: 'director', heldFrom: '2026-06-01' }],
  })
  const ended = await createParty({ kind: 'person', name: 'Ended director', actor: 'alicio@example.test',
    roles: [{ entityId: acme.company.id, role: 'director', heldFrom: '2026-06-01', heldTo: '2026-02-28' }] })
  const bankRoles = await transactingPartyRoles(acme.company.id)
  const incoming = bankPartyOptions(bankRoles, '2026-03-02', false)
  const outgoing = bankPartyOptions(bankRoles, '2026-03-02', true)
  check(partyIds.every((id) => incoming.some((p) => p.id === id)
      && outgoing.some((p) => p.id === id))
    && incoming.some((p) => p.id === future.id) && !incoming.some((p) => p.id === ended.id)
    && outgoing.some((p) => p.id === future.id) && !outgoing.some((p) => p.id === ended.id)
    && incoming[0]?.group === 'Customers' && outgoing[0]?.group === 'Suppliers',
    'M00 bank choices ignore legacy starts and still respect role endings',
    `in ${incoming.map((p) => p.group).join(', ')}; out ${outgoing.map((p) => p.group).join(', ')}`)

  /** A posted entry that moves the bank account by `amount` (signed). */
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

  const stateOf = async (id: string) => (await bankRows(cash.id)).find((r) => r.id === id)
  const rowNamed = async (description: string) =>
    (await bankRows(cash.id)).find((r) => r.description === description)!

  await rowsIn([
    ['2026-03-02', 320000n, 'CLIENT DEPOSIT'],
    ['2026-03-03', -1695n, 'MONTHLY FEE'],
    ['2026-03-04', 500000n, 'BIG DEPOSIT'],
    ['2026-03-05', 120000n, 'INSTALMENT ONE'],
    ['2026-03-06', 80000n, 'INSTALMENT TWO'],
    ['2026-03-09', -4200n, 'INTERAC'],
  ])

  // --------------------------------------------------------------- basics --

  {
    const before = await rowNamed('CLIENT DEPOSIT')
    check(before.state === 'unmatched' && before.matched_amount === 0n,
      'M01 a landed row starts unmatched', `${before.state}, ${before.matched_amount} matched`)

    const paid = await entryOn('2026-03-02', 320000n, 'Invoice 41 paid')
    await matchEntry({ bankTransactionId: before.id, entryId: paid.entry.id, actor: 'alicio@example.test' })

    const after = await stateOf(before.id)
    check(after?.state === 'matched' && after.matched_amount === 320000n
      && after.unmatched_amount === 0n,
      'M02 matching it to an entry accounts for the whole row',
      `${after?.state}, ${after?.matched_amount} of ${after?.amount}`)

    // The pair. Without it, a state column that said "matched" for everything
    // would pass M02 and nothing would notice.
    const other = await rowNamed('MONTHLY FEE')
    check(other.state === 'unmatched',
      'M03 and the row beside it is untouched', other.state)
  }

  // -------------------------------------------------------------- partial --

  {
    const big = await rowNamed('BIG DEPOSIT')
    const first = await entryOn('2026-03-04', 300000n, 'Invoice 42 paid')

    // Sized by BOTH remainders, and guarded: a version that took the whole row
    // over-claims this entry, and the failure arrives from the database at
    // COMMIT — which killed the run rather than failing a check.
    try {
      await matchEntry({ bankTransactionId: big.id, entryId: first.entry.id, actor: 'alicio@example.test' })
      const [link] = await matchesFor(big.id)
      check(link?.amount === 300000n,
        'M03b a match is sized by the smaller of the two remainders',
        `${link?.amount} against a row of 500000 and an entry with 300000 left`)
    } catch (e) {
      fail('M03b a match is sized by the smaller of the two remainders',
        errorText(e).slice(0, 96))
    }

    const part = await stateOf(big.id)
    check(part?.state === 'part' && part.matched_amount === 300000n
      && part.unmatched_amount === 200000n,
      'M04 a deposit covering more than one invoice is partly matched',
      `${part?.state}, ${part?.unmatched_amount} left`)

    const second = await entryOn('2026-03-04', 200000n, 'Invoice 43 paid')
    await matchEntry({ bankTransactionId: big.id, entryId: second.entry.id, actor: 'alicio@example.test' })

    const whole = await stateOf(big.id)
    check(whole?.state === 'matched' && whole.unmatched_amount === 0n,
      'M05 and it is matched once the parts foot to the row',
      `${whole?.state}, ${whole?.unmatched_amount} left`)

    const links = await matchesFor(big.id)
    check(links.length === 2 && links.reduce((a, l) => a + l.amount, 0n) === 500000n,
      'M06 with both entries recorded against it',
      `${links.length} matches totalling ${links.reduce((a, l) => a + l.amount, 0n)}`)
  }

  {
    // The other direction: one invoice settled by two deposits.
    const one = await rowNamed('INSTALMENT ONE')
    const two = await rowNamed('INSTALMENT TWO')
    const invoice = await entryOn('2026-03-05', 200000n, 'Invoice 44 paid in two')

    await matchEntry({ bankTransactionId: one.id, entryId: invoice.entry.id, actor: 'alicio@example.test' })
    await matchEntry({ bankTransactionId: two.id, entryId: invoice.entry.id, actor: 'alicio@example.test' })

    const a = await stateOf(one.id)
    const b = await stateOf(two.id)
    check(a?.state === 'matched' && b?.state === 'matched',
      'M07 one entry can be settled by two rows', `${a?.state} / ${b?.state}`)

    // And it is now full: a third row cannot claim any more of it.
    const spare = await rowNamed('INTERAC')
    await expectError('M08 and it cannot then be claimed a third time', 'ENTRY_FULL', () =>
      matchEntry({ bankTransactionId: spare.id, entryId: invoice.entry.id, actor: 'alicio@example.test' }))
  }

  // --------------------------------------------------------------- guards --

  {
    const fee = await rowNamed('MONTHLY FEE')

    const draft = await saveDraft({
      ledgerId, entryDate: '2026-03-03', description: 'Not posted yet', actor: 'alicio@example.test',
      lines: [{ accountId: cash.id, amount: -1695n }, { accountId: charges.id, amount: 1695n }],
    })
    await expectDbError('M09 a draft entry cannot settle a bank row', 'ENTRY_NOT_POSTED', () =>
      db.execute(raw`
        INSERT INTO bank_match (bank_transaction_id, entry_id, amount, matched_by)
        VALUES (${fee.id}::uuid, ${draft.id}::uuid, -1695, 'alicio@example.test')`))

    const reversible = await entryOn('2026-03-03', -1695n, 'Fee, then reversed', charges.id)
    await reverseEntry(reversible.entry.id, '2026-03-03', 'wrong account', 'alicio@example.test')
    await expectDbError('M10 nor a reversed one', 'ENTRY_NOT_POSTED', () =>
      db.execute(raw`
        INSERT INTO bank_match (bank_transaction_id, entry_id, amount, matched_by)
        VALUES (${fee.id}::uuid, ${reversible.entry.id}::uuid, -1695, 'alicio@example.test')`))

    const elsewhere = await postEntry({
      ledgerId, entryDate: '2026-03-03', description: 'Nothing to do with the bank', actor: 'alicio@example.test',
      lines: [{ accountId: ar.id, amount: 5000n }, { accountId: revenue.id, amount: -5000n }],
    })
    await expectError('M11 nor an entry that never touched this account', 'ENTRY_NOT_ON_ACCOUNT', () =>
      matchEntry({ bankTransactionId: fee.id, entryId: elsewhere.entry.id, actor: 'alicio@example.test' }))

    const inbound = await entryOn('2026-03-03', 1695n, 'Money the other way')
    await expectDbError('M12 nor one that moved the account the other way', 'MATCH_SIGN', () =>
      db.execute(raw`
        INSERT INTO bank_match (bank_transaction_id, entry_id, amount, matched_by)
        VALUES (${fee.id}::uuid, ${inbound.entry.id}::uuid, 1695, 'alicio@example.test')`))
  }

  {
    // Over-claiming the ROW, isolated from over-claiming the entry.
    //
    // The entry deliberately has far more room than the row, so the only bound
    // that can refuse this is the row's own. The first version used an entry the
    // same size and passed for the other guard's reason — the mutation that
    // removes the row bound turned nothing red, which is how it was found.
    //
    // And the fragment is the long one: `ENTRY_OVER_MATCHED` contains
    // `OVER_MATCHED`, so the short spelling matches whichever fires.
    const spare = await rowNamed('INTERAC')
    const roomy = await entryOn('2026-03-09', -20000n, 'A much bigger payment', charges.id)

    await expectDbError('M13 a row cannot be matched for more than it is',
      'OVER_MATCHED: that row is', () =>
        db.execute(raw`
          INSERT INTO bank_match (bank_transaction_id, entry_id, amount, matched_by)
          VALUES (${spare.id}::uuid, ${roomy.entry.id}::uuid, -9000, 'alicio@example.test')`))

    // The pair: exactly the row is fine. Without it, a guard that refused every
    // match would pass the check above.
    await matchEntry({ bankTransactionId: spare.id, entryId: roomy.entry.id, actor: 'alicio@example.test' })
    const done = await stateOf(spare.id)
    check(done?.state === 'matched', 'M14 and matching it for exactly what it is works', done?.state ?? '?')
  }

  {
    // The one that matters most: one payment cannot settle several deposits.
    await rowsIn([
      ['2026-04-01', 50000n, 'DEPOSIT A'],
      ['2026-04-02', 50000n, 'DEPOSIT B'],
    ])
    const a = await rowNamed('DEPOSIT A')
    const b = await rowNamed('DEPOSIT B')
    const once = await entryOn('2026-04-01', 50000n, 'One payment of 500')

    await matchEntry({ bankTransactionId: a.id, entryId: once.entry.id, actor: 'alicio@example.test' })
    await expectError('M15 one entry cannot settle two different rows for its whole value',
      'ENTRY_FULL', () =>
        matchEntry({ bankTransactionId: b.id, entryId: once.entry.id, actor: 'alicio@example.test' }))

    // And the database says so too, not only the library.
    await expectDbError('M16 and the database refuses it as well', 'ENTRY_OVER_MATCHED', () =>
      db.execute(raw`
        INSERT INTO bank_match (bank_transaction_id, entry_id, amount, matched_by)
        VALUES (${b.id}::uuid, ${once.entry.id}::uuid, 50000, 'alicio@example.test')`))
  }

  // -------------------------------------------------------- ignore vs match --

  {
    await rowsIn([['2026-04-05', -2500n, 'OWN TRANSFER']])
    const t = await rowNamed('OWN TRANSFER')
    await ignoreBankRow(t.id, 'moved to my savings, already in the books', 'alicio@example.test')

    const paid = await entryOn('2026-04-05', -2500n, 'Something else', charges.id)
    await expectDbError('M17 an ignored row cannot be matched', 'ROW_IGNORED', () =>
      db.execute(raw`
        INSERT INTO bank_match (bank_transaction_id, entry_id, amount, matched_by)
        VALUES (${t.id}::uuid, ${paid.entry.id}::uuid, -2500, 'alicio@example.test')`))

    await cleanup('un-ignore the transfer row', () => unignoreBankRow(t.id))

    // And the other way round, which had no guard until this suite went looking:
    // a matched row set aside would leave its matches claiming parts of entries
    // while the reconciliation stopped showing it.
    const matched = await rowNamed('CLIENT DEPOSIT')
    await expectDbError('M18 and a matched row cannot be ignored', 'ROW_IS_MATCHED', () =>
      byHand((tx) => tx.execute(raw`
        UPDATE bank_transaction SET ignored_at = now(), ignored_by = 'alicio@example.test',
               ignored_reason = 'changed my mind' WHERE id = ${matched.id}::uuid`)))
  }

  // -------------------------------------------------------------- unmatch --

  {
    const row = await rowNamed('CLIENT DEPOSIT')
    await expectDbError('M19 a matched row cannot be deleted', 'BANK_ROW_MATCHED', () =>
      byHand((tx) => tx.execute(raw`DELETE FROM bank_transaction WHERE id = ${row.id}::uuid`)))

    const [link] = await matchesFor(row.id)
    await unmatch(link.id)
    const after = await stateOf(row.id)
    check(after?.state === 'unmatched' && after.matched_amount === 0n,
      'M20 undoing the match puts the row back', `${after?.state}`)

    // Put it back so the reconciliation numbers below are about matching and
    // not about this probe.
    await cleanup('re-match the client deposit', () =>
      matchEntry({ bankTransactionId: row.id, entryId: link.entry_id, actor: 'alicio@example.test' }))
  }

  // ----------------------------------------------------------- candidates --

  {
    await rowsIn([['2026-05-02', 75000n, 'SUGGEST ME']])
    const row = await rowNamed('SUGGEST ME')

    const near = await entryOn('2026-05-02', 75000n, 'Exactly right, same day')
    const far = await entryOn('2026-05-20', 75000n, 'Right amount, weeks later')
    const wrongWay = await entryOn('2026-05-02', -75000n, 'Same size, other direction', charges.id)
    const notPosted = await saveDraft({
      ledgerId, entryDate: '2026-05-02', description: 'Still a draft', actor: 'alicio@example.test',
      lines: [{ accountId: cash.id, amount: 75000n }, { accountId: revenue.id, amount: -75000n }],
    })

    const suggested = await candidateEntries(row.id)
    const ids = suggested.map((c) => c.entry_id)
    check(ids[0] === near.entry.id,
      'M21 the exact amount on the same day is suggested first',
      suggested[0]?.description ?? 'nothing suggested')
    check(ids.includes(far.entry.id) && !ids.includes(wrongWay.entry.id)
      && !ids.includes(notPosted.id),
      'M22 and drafts and wrong-way entries are not suggested at all',
      `${ids.length} suggestions`)

    // Once an entry is full it stops being offered — the discriminating half,
    // since a list that offered everything would pass M21 too.
    await matchEntry({ bankTransactionId: row.id, entryId: near.entry.id, actor: 'alicio@example.test' })
    await rowsIn([['2026-05-03', 75000n, 'SUGGEST ME TOO']])
    const second = await rowNamed('SUGGEST ME TOO')
    const again = (await candidateEntries(second.id)).map((c) => c.entry_id)
    check(!again.includes(near.entry.id) && again.includes(far.entry.id),
      'M23 and an entry already claimed in full drops off the list',
      `${again.length} left`)
  }

  // -------------------------------------------------- an entry from a row --

  {
    await rowsIn([['2026-06-01', -3500n, 'WIRE FEE']])
    const row = await rowNamed('WIRE FEE')

    const posted = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: charges.id, actor: 'alicio@example.test',
    })

    const after = await stateOf(row.id)
    check(after?.state === 'matched' && after.matched_amount === -3500n,
      'M24 posting an entry from a row matches it in the same breath',
      `${after?.state}, entry ${posted.entryNo}`)

    const [entry] = await db.execute<{
      status: string; entry_no: string | null; source_type: string; source_id: string | null
      period_id: string | null; lines: string; total: bigint
    }>(raw`
      SELECT e.status, e.entry_no, e.source_type, e.source_id::text, e.period_id::text,
             count(jl.*)::text AS lines, coalesce(sum(jl.amount), 0)::bigint AS total
        FROM journal_entry e JOIN journal_line jl ON jl.entry_id = e.id
       WHERE e.id = ${posted.entryId}::uuid
       GROUP BY e.status, e.entry_no, e.source_type, e.source_id, e.period_id`)

    check(entry.status === 'posted' && entry.entry_no !== null && entry.period_id !== null
      && entry.lines === '2' && entry.total === 0n,
      'M25 and it is an ordinary posted entry — numbered, in a period, balanced',
      `${entry.entry_no}, ${entry.lines} lines, sum ${entry.total}`)
    check(entry.source_type === 'bank' && entry.source_id === row.id,
      'M26 that knows which statement row it came from',
      `${entry.source_type} ${entry.source_id?.slice(0, 8)}`)

    const [wording] = await db.execute<{ summary: string; item: string | null; memo: string }>(raw`
      SELECT e.description AS summary, jl.description AS item, b.description AS memo
        FROM journal_entry e JOIN bank_transaction b ON b.id = e.source_id
        JOIN journal_line jl ON jl.entry_id = e.id AND jl.account_id = ${charges.id}::uuid
       WHERE e.id = ${posted.entryId}::uuid`)
    check(wording.summary === charges.name && wording.item === charges.name && wording.memo === 'WIRE FEE',
      'M26b blank wording uses the category for summary and item, preserving the bank memo',
      `${wording.summary} / ${wording.item}; bank: ${wording.memo}`)

    // The point of going through postEntryCore: everything else the ledger
    // refuses, it refuses here too.
    await expectDbError('M27 and the ledger will not let it be edited either', 'through the application', () =>
      db.execute(raw`
        UPDATE journal_line SET amount = 1 WHERE entry_id = ${posted.entryId}::uuid`))

    // Open books now cover THIS entry too (owner, 2026-09-07: "银行 add 的
    // 交易也要能编辑能删除，不必要一定要冲掉旧帐做新帐"). A row Added against the
    // wrong account is a typo, and reverse-and-replace left three entries
    // behind every one of them. Deleting it releases the row back into the
    // feed, which is the honest state: nothing accounts for that money now.
    // The reconciliation still cannot point at money that changed under it —
    // the match goes with the entry, by count, and RC56 has the other half
    // (an edit keeps the match, and one that stops settling the row is
    // refused whole).
    {
      const gone = await deleteEntry(posted.entryId, 'alicio@example.test')
      const after = await stateOf(row.id)
      const [left] = await db.execute<{ n: string }>(raw`
        SELECT count(*)::text AS n FROM journal_entry WHERE id = ${posted.entryId}::uuid`)
      check(gone.releasedMatches === 1 && after?.state === 'unmatched' && left.n === '0',
        'M27b a bank entry is deleted at the entry door, and the row goes back into the feed',
        `released ${gone.releasedMatches}; the row is ${after?.state}; ${left.n} entr(ies) left`)
      // Put it back, so what follows still faces a settled row.
      await postFromBankRow({
        bankTransactionId: row.id, contraAccountId: charges.id, actor: 'alicio@example.test',
      })
    }

    await expectError('M28 posting from the same row twice is refused', 'ROW_FULL', () =>
      postFromBankRow({ bankTransactionId: row.id, contraAccountId: charges.id, actor: 'alicio@example.test' }))

    await rowsIn([['2026-06-02', -100n, 'NOWHERE']])
    const nowhere = await rowNamed('NOWHERE')
    await expectError('M29 and the other side cannot be the bank account itself', 'SAME_ACCOUNT', () =>
      postFromBankRow({ bankTransactionId: nowhere.id, contraAccountId: cash.id, actor: 'alicio@example.test' }))
  }

  {
    // The strongest statement that there is no second way in: a closed period
    // refuses an entry from a bank row exactly as it refuses a typed one.
    const [period] = await db.execute<{ id: string }>(raw`
      SELECT p.id::text FROM fiscal_period p JOIN fiscal_year y ON y.id = p.fiscal_year_id
       WHERE y.ledger_id = ${ledgerId}::uuid AND p.period_no = 1`)
    await closePeriod(ledgerId, period.id, { actor: 'alicio@example.test' })

    await rowsIn([['2026-01-15', -900n, 'JANUARY FEE']])
    const jan = await rowNamed('JANUARY FEE')
    // Refused by `postEntryCore`'s own check, with its own code — the same
    // refusal a typed journal gets, which is the whole reason for going through
    // it rather than inserting rows here.
    await expectError('M30 a closed period refuses an entry from a bank row too',
      'PERIOD_CLOSED', () =>
        postFromBankRow({ bankTransactionId: jan.id, contraAccountId: charges.id, actor: 'alicio@example.test' }))

    const still = await stateOf(jan.id)
    check(still?.state === 'unmatched',
      'M31 and the row is left alone when the entry is refused', still?.state ?? 'gone')
  }

  // ------------------------------------------------------------ reconcile --

  const identity = (r: Awaited<ReturnType<typeof reconciliation>>) =>
    r.statementUnaccounted - r.booksUnclaimed + r.straddling

  {
    const r = await reconciliation(cash.id, '2026-12-31')
    // Arithmetic, not evidence: substitute the definitions and the matched
    // totals cancel, so this holds for every input including wrong ones. Kept
    // because a source edit to `reconciliation` can still break it — see M54
    // for the one that can fail on data.
    check(r.difference === identity(r),
      'M32 (arithmetic) the three explanations add up to the difference',
      `${r.difference} = ${r.statementUnaccounted} - ${r.booksUnclaimed} + ${r.straddling}`)

    // The pair: it has to be a real difference, not zero on both sides.
    check(r.statement !== 0n && r.books !== 0n,
      'M33 with real money on both sides of it', `statement ${r.statement}, books ${r.books}`)
  }

  {
    // A cheque written in one month and cleared in the next. The match spans the
    // cut-off, and `straddling` is what stops the other two numbers absorbing it.
    await rowsIn([['2026-08-03', -60000n, 'CHEQUE CLEARED']])
    const cleared = await rowNamed('CHEQUE CLEARED')
    const written = await entryOn('2026-07-30', -60000n, 'Cheque 118 written', ar.id)
    await matchEntry({ bankTransactionId: cleared.id, entryId: written.entry.id, actor: 'alicio@example.test' })

    const july = await reconciliation(cash.id, '2026-07-31')
    check(july.straddling !== 0n,
      'M34 a match spanning the cut-off is named as a timing difference',
      `straddling ${july.straddling}`)
    check(july.difference === identity(july),
      'M35 and the identity still holds across it',
      `${july.difference} = ${july.statementUnaccounted} - ${july.booksUnclaimed} + ${july.straddling}`)
  }

  // ------------------------------------------- the opening balance is not it --

  {
    // An opening cash balance is where the account started, not something that
    // moved — so it cannot be what a statement row records. Offered as a
    // candidate it would settle any deposit up to the whole opening position,
    // and the row would read reconciled afterwards.
    const seventh = await createCompany({ code: 'SEVENTH', name: 'Seventh Ltd.' }, 'alicio@example.test')
    await createFiscalYear(seventh.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirs = await importAccounts(seventh.company.id, [
      { entityId: seventh.company.id, code: '1000', name: 'Cash', accountType: 'asset' as const },
      { entityId: seventh.company.id, code: '3000', name: 'Capital', accountType: 'equity' as const },
    ], 'alicio@example.test')
    const theirCash = theirs[0]

    await postOpeningBalance({
      ledgerId: seventh.ledger.id, entryDate: '2026-01-01', actor: 'alicio@example.test',
      lines: [
        { accountId: theirCash.id, amount: 1250000n },
        { accountId: theirs[1].id, amount: -1250000n },
      ],
    })
    await importBankRows({
      accountId: theirCash.id, actor: 'alicio@example.test',
      rows: [{ date: '2026-01-05', amount: 300000n, description: 'CUSTOMER DEPOSIT' }],
    })
    const [theirRow] = await bankRows(theirCash.id)

    const suggested = await candidateEntries(theirRow.id)
    check(suggested.length === 0,
      'M59 the opening balance is not offered to settle a bank row',
      `${suggested.length} suggestions`)

    const [opening] = await db.execute<{ id: string }>(raw`
      SELECT id::text FROM journal_entry
       WHERE ledger_id = ${seventh.ledger.id}::uuid AND source_type = 'opening_balance'`)
    await expectDbError('M60 and the database refuses it even by hand', 'ENTRY_IS_OPENING', () =>
      db.execute(raw`
        INSERT INTO bank_match (bank_transaction_id, entry_id, amount, matched_by)
        VALUES (${theirRow.id}::uuid, ${opening.id}::uuid, 300000, 'alicio@example.test')`))

    // The pair: an ordinary entry on the same account still is offered, so the
    // filter is about what the entry IS and not about refusing everything.
    const real = await postEntry({
      ledgerId: seventh.ledger.id, entryDate: '2026-01-05', description: 'Fee income',
      actor: 'alicio@example.test',
      lines: [{ accountId: theirCash.id, amount: 300000n },
              { accountId: theirs[1].id, amount: -300000n }],
    })
    const now = await candidateEntries(theirRow.id)
    check(now.length === 1 && now[0].entry_id === real.entry.id,
      'M61 while an ordinary entry on the same account still is', `${now.length} suggestion`)

    // And the reconciliation names where the account started rather than leaving
    // it as an unexplained gap.
    const r = await reconciliation(theirCash.id, '2026-12-31')
    check(r.openingPosition === 1250000n,
      'M62 the reconciliation names the opening position', `${r.openingPosition}`)
    check(r.difference === r.statementUnaccounted - r.booksUnclaimed + r.straddling,
      'M63 and the arithmetic still closes with it inside booksUnclaimed',
      `${r.difference} = ${r.statementUnaccounted} - ${r.booksUnclaimed} + ${r.straddling}`)

    // M63 is an identity: it holds whatever the numbers are, because
    // `openingPosition` sits INSIDE `booksUnclaimed` and never appears in it.
    // The screen is where the split actually happens — four rows, of which two
    // are the halves of `booksUnclaimed` and have to be shown net of each other.
    // Double-count the opening position there and M32, M63 and M65 all stay
    // green while the column stops adding up.
    //
    // It has to be rendered HERE, on a ledger whose opening position is not
    // zero. The other render block's account has no opening balance, so the
    // split is `x` against `0` and no arithmetic mistake in it can show.
    const theirViews = []
    for (const row of await bankRows(theirCash.id)) {
      const open = row.state === 'unmatched' || row.state === 'part'
      theirViews.push({
        row,
        matches: row.matched_amount === 0n ? [] : await matchesFor(row.id),
        candidates: open ? await candidateEntries(row.id, 5) : [],
      })
    }
    const theirScreen = JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-reconcile.tsx',
      stringify({
        ledgerId: seventh.ledger.id, accountId: theirCash.id, recon: r, views: theirViews,
        contraAccounts: [{ id: theirs[1].id, code: '3000', name: 'Capital' }],
      })],
      { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } },
    )) as { partAmounts: string[]; totals: string[]; summary: string[] }

    const printed = theirScreen.partAmounts.map(BigInt)
    const printedDifference = theirScreen.totals.map(BigInt).at(-1)
    check(printed.length === 4 && printed.reduce((a, b) => a + b, 0n) === printedDifference,
      'M66 and the four printed parts add up to the printed difference',
      `${printed.join(' + ')} = ${printedDifference}`)

    // The pair: the opening position is one of those four and it is not zero,
    // so the check above is answering the question its label asks.
    check(printed.includes(-1250000n),
      'M67 with the opening position among them, and not zero',
      `${printed.join(', ')}`)
  }

  {
    // The general shape of O28, on the column O28 cannot reach.
    //
    // O28 proves an amendment keeps `source_type`; nothing proved it keeps
    // `source_id`, which is the half that says WHICH row. An opening balance
    // has no source_id to lose, so the proof has to be here: amend an entry
    // that was generated from a statement row and it must still name that row.
    await rowsIn([['2026-11-02', -2200n, 'AMEND PROVENANCE']])
    const provRow = await rowNamed('AMEND PROVENANCE')
    const born = await postFromBankRow({
      bankTransactionId: provRow.id, contraAccountId: charges.id, actor: 'alicio@example.test',
    })

    let carried: Awaited<ReturnType<typeof amendEntry>> | null = null
    let said = false
    try {
      carried = await amendEntry(born.entryId, {
        entryDate: '2026-11-02', description: 'Bank charge, described properly', actor: 'alicio@example.test',
        lines: [{ accountId: cash.id, amount: -2200n }, { accountId: charges.id, amount: 2200n }],
      }, 'alicio@example.test')
    } catch (e) {
      said = true
      fail('M63g the amendment M64 inspects went through',
        `it was refused: ${errorText(e).slice(0, 74)}`)
    }

    if (carried) {
      const [prov] = await db.execute<{ source_type: string; source_id: string | null }>(raw`
        SELECT source_type, source_id::text
          FROM journal_entry WHERE id = ${carried.replacement.id}::uuid`)
      check(prov.source_type === 'bank' && prov.source_id === provRow.id,
        'M64 an amended entry still knows which statement row it came from',
        `${prov.source_type} ${prov.source_id?.slice(0, 8) ?? 'null'}`)
    } else if (!said) {
      // Only when the catch did NOT already say why. Renaming this to `M63g`
      // last round moved the id and left the defect: a single refusal went
      // through the catch AND this branch, so one failure printed two lines and
      // the block's summary counted four failures for three assertions.
      fail('M63g the amendment M64 inspects went through', 'it never happened')
    }
  }

  // ----------------------------------------------------------------- forms --

  {
    const fd = (pairs: Record<string, string>) => {
      const f = new FormData()
      f.set(F.ledgerId, ledgerId)
      f.set(F.accountId, cash.id)
      for (const [k, v] of Object.entries(pairs)) f.set(k, v)
      return f
    }

    await rowsIn([['2026-09-01', 25000n, 'FORM DEPOSIT']])
    const row = await rowNamed('FORM DEPOSIT')
    const entry = await entryOn('2026-09-01', 25000n, 'Invoice 51 paid')

    const matched = await matchFromForm(fd({ [F.rowId]: row.id, [F.entryId]: entry.entry.id }), 'alicio@example.test')
    check(matched.ok === 'Matched.' && (await stateOf(row.id))?.state === 'matched',
      'M37 the match form matches', matched.ok ?? matched.error ?? '')

    const [link] = await matchesFor(row.id)
    const undone = await unmatchFromForm(fd({ [F.matchId]: link.id }), 'alicio@example.test')
    check(undone.ok === 'Match undone.' && (await stateOf(row.id))?.state === 'unmatched',
      'M38 and the undo form undoes it', undone.ok ?? undone.error ?? '')

    const aside = await ignoreFromForm(fd({ [F.rowId]: row.id, [F.reason]: 'a duplicate' }), 'alicio@example.test')
    check(aside.ok === 'Set aside.' && (await stateOf(row.id))?.state === 'ignored',
      'M39 the ignore form needs a reason and takes one', aside.ok ?? aside.error ?? '')

    const noReason = await ignoreFromForm(fd({ [F.rowId]: row.id, [F.reason]: ' ' }), 'alicio@example.test')
    check(noReason.error?.includes('Say why') === true,
      'M40 and refuses without one', noReason.error ?? 'no error')

    const back = await unignoreFromForm(fd({ [F.rowId]: row.id }), 'alicio@example.test')
    check(back.ok === 'Back in play.' && (await stateOf(row.id))?.state === 'unmatched',
      'M41 and the un-ignore form puts it back', back.ok ?? back.error ?? '')

    // Dollars where cents belong, the same boundary the import has.
    const dollars = await matchFromForm(
      fd({ [F.rowId]: row.id, [F.entryId]: entry.entry.id, [F.amount]: '250.00' }), 'alicio@example.test')
    check(dollars.error?.includes('whole cents') === true,
      'M42 an amount in dollars is refused, not rounded', dollars.error ?? 'no error')

    await rowsIn([['2026-09-02', -1200n, 'FORM FEE']])
    const fee = await rowNamed('FORM FEE')
    const feeForm = fd({ [F.rowId]: fee.id, [F.contraAccountId]: charges.id, [F.description]: '  Wire fee  ' })
    feeForm.set(ATTACH_FIELD, new File([Buffer.from('%PDF-1.4 bank receipt')], 'bank-fee.pdf', { type: 'application/pdf' }))
    const posted = await postFromRowForm(feeForm, 'alicio@example.test')
    const feeMatch = (await matchesFor(fee.id))[0]
    const feePaper = feeMatch ? await attachmentsOf(feeMatch.entry_id) : []
    check(posted.ok?.startsWith('Posted as') === true
      && posted.ok.includes('file is filed against it')
      && (await stateOf(fee.id))?.state === 'matched'
      && feePaper.length === 1,
      'M43 the post form posts, matches and files its paper', posted.ok ?? posted.error ?? '')

    const [feeWording] = await db.execute<{ summary: string; item: string | null; memo: string }>(raw`
      SELECT e.description AS summary, jl.description AS item, b.description AS memo
        FROM journal_entry e JOIN bank_transaction b ON b.id = e.source_id
        JOIN journal_line jl ON jl.entry_id = e.id AND jl.account_id = ${charges.id}::uuid
       WHERE e.id = ${feeMatch.entry_id}::uuid`)
    check(feeWording.summary === 'Wire fee' && feeWording.item === 'Wire fee' && feeWording.memo === 'FORM FEE',
      'M43b the form saves trimmed business wording on summary and item without changing the bank memo',
      `${feeWording.summary} / ${feeWording.item}; bank: ${feeWording.memo}`)

    // A database guard has to arrive as a sentence. Drizzle wraps the driver
    // error, so matching on `.message` alone would never see the trigger's name
    // and a stack trace is what would reach the screen.
    let crossed: { error?: string; ok?: string }
    try {
      crossed = await matchFromForm(fd({ [F.rowId]: fee.id, [F.entryId]: entry.entry.id }), 'alicio@example.test')
    } catch (e) {
      crossed = { error: `it threw instead of answering: ${errorText(e).slice(0, 50)}` }
    }
    check(crossed.error === 'That row is already fully accounted for.',
      'M44 and a guard reaches the form as a sentence, not a stack trace',
      crossed.error ?? crossed.ok ?? 'no answer')

    // That one was refused by the library before the database saw it. This one
    // is refused BY the database, which is the path where a raw "Failed query"
    // wrapper would reach the screen if the unwrapping were wrong.
    await rowsIn([['2026-09-05', -800n, 'WRONG WAY']])
    const wrongRow = await rowNamed('WRONG WAY')
    const inbound = await entryOn('2026-09-05', 800n, 'Money the other way again')
    let flipped: { error?: string; ok?: string }
    try {
      flipped = await matchFromForm(
        fd({ [F.rowId]: wrongRow.id, [F.entryId]: inbound.entry.id, [F.amount]: '800' }), 'alicio@example.test')
    } catch (e) {
      flipped = { error: `it threw instead of answering: ${errorText(e).slice(0, 50)}` }
    }
    check(flipped.error === 'That entry moved the account the other way.',
      'M44b and so does one the database refuses',
      flipped.error ?? flipped.ok ?? 'no answer')
  }

  // ---------------------------------------------------------------- screen --

  {
    // The suite fetches; the renderer renders. It cannot reach the database
    // itself — `react-dom/server` and `server-only` cannot both load.
    const live0 = await bankRows(cash.id)
    const views = []
    for (const row of live0) {
      const open = row.state === 'unmatched' || row.state === 'part'
      views.push({
        row,
        matches: row.matched_amount === 0n ? [] : await matchesFor(row.id),
        candidates: open ? await candidateEntries(row.id, 5) : [],
      })
    }
    const props = {
      ledgerId, accountId: cash.id,
      recon: await reconciliation(cash.id, '2026-12-31'),
      views,
      contraAccounts: [{ id: charges.id, code: '5000', name: 'Bank Charges' }],
    }

    const rendered = JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-reconcile.tsx',
      stringify(props)],
      { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } },
    )) as {
      states: Record<string, number>
      forms: Array<{ action: string; fields: Record<string, string>; submit: string }>
      summary: string[]
      partAmounts: string[]
      totals: string[]
    }

    const live = await bankRows(cash.id)
    const counted: Record<string, number> = {}
    for (const r of live) counted[r.state] = (counted[r.state] ?? 0) + 1
    check(JSON.stringify(rendered.states) === JSON.stringify(counted),
      'M45 the screen shows every row in the state the database says it is in',
      `${JSON.stringify(rendered.states)}`)

    // Every form carries the row it is about. A screen that renders the right
    // buttons against the wrong hidden id is the defect the tax round spent six
    // rounds on, and it is invisible to anything that only reads the source.
    const matchForms = rendered.forms.filter((f) => f.action === '/match')
    const openRows = new Set(live.filter((r) => r.state === 'unmatched' || r.state === 'part')
      .map((r) => r.id))
    check(matchForms.length > 0 && matchForms.every((f) => openRows.has(f.fields[F.rowId])),
      'M46 and every suggestion posts the row it sits under',
      `${matchForms.length} suggestions, all on open rows`)

    check(rendered.summary.some((l) => l.includes('Timing differences')),
      'M47 and the timing difference has its own line', rendered.summary.join(' | ').slice(0, 80))

    // M62 proves `reconciliation()` computes the opening position. Nothing
    // proved the screen prints it, and a figure that is computed and not shown
    // leaves the same unexplained gap it was added to explain.
    check(rendered.summary.some((l) => l.includes('Where the account started')),
      'M65 and where the account started has its own line too',
      rendered.summary.filter((l) => l.startsWith('Where') || l.startsWith('Timing')).join(' | ')
        .slice(0, 80) || rendered.summary.join(' | ').slice(0, 80))
  }

  // ------------------------------------------- unwinding a matched entry --

  {
    // The question this round could not answer by reading: what happens to a
    // match when the entry it points at is taken back?
    //
    // Before 0021: nothing. The row went on reading `matched`, settled by an
    // entry that had been unwound. Amending was worse — the match stayed on the
    // reversed original, the replacement carrying the money was claimed by
    // nothing, and the row could not be matched to it because it already read
    // as full. The correction was unreachable.
    await rowsIn([['2026-10-01', 90000n, 'TO BE REVERSED']])
    const row = await rowNamed('TO BE REVERSED')
    const entry = await entryOn('2026-10-01', 90000n, 'Booked to the wrong account')
    await matchEntry({ bankTransactionId: row.id, entryId: entry.entry.id, actor: 'alicio@example.test' })

    await expectDbError('M48 an entry that settles a bank row cannot be reversed',
      'REVERSED_STILL_MATCHED', () =>
        reverseEntry(entry.entry.id, '2026-10-02', 'wrong account', 'alicio@example.test'))

    // The pair: undo the match and the reversal goes through. Without it, a
    // guard that refused every reversal would pass the check above.
    const [link] = await matchesFor(row.id)
    await unmatch(link.id)
    await reverseEntry(entry.entry.id, '2026-10-02', 'wrong account', 'alicio@example.test')
    const [status] = await db.execute<{ s: string }>(raw`
      SELECT status AS s FROM journal_entry WHERE id = ${entry.entry.id}::uuid`)
    check(status.s === 'reversed' && (await stateOf(row.id))?.state === 'unmatched',
      'M49 and once the match is undone it can be', `${status.s}, row is ${(await stateOf(row.id))?.state}`)

    // M49b — and NEITHER half of that pair is offered against the next row.
    //
    // The reversal moves the account the OPPOSITE way from the entry it
    // cancels, so a corrected PAYMENT reads as a deposit waiting to be
    // claimed — which is why the owner's feed offered one against real
    // income (2026-09-07). Hence a payment here, reversed, and then a deposit
    // of the same size: the sign test cannot see the difference, only the
    // pair can. The reversed original is out on its status; this is the other
    // half. Neither is money that moved at the bank.
    const paidOut = await entryOn('2026-10-03', -90000n, 'Paid the wrong supplier')
    await reverseEntry(paidOut.entry.id, '2026-10-04', 'wrong supplier', 'alicio@example.test')
    const [reversal] = await db.execute<{ id: string; amount: bigint }>(raw`
      SELECT e.id::text, sum(jl.amount) AS amount
        FROM journal_entry e JOIN journal_line jl ON jl.entry_id = e.id AND jl.account_id = ${cash.id}::uuid
       WHERE e.reverses_id = ${paidOut.entry.id}::uuid GROUP BY e.id`)
    await rowsIn([['2026-10-05', 90000n, 'REAL INCOME']])
    const income = await rowNamed('REAL INCOME')
    const offered = (await candidateEntries(income.id)).map((c) => c.entry_id)
    check(BigInt(reversal.amount) === 90000n && !offered.includes(reversal.id) && !offered.includes(paidOut.entry.id),
      'M49b neither half of a correction pair is offered as a candidate',
      `the reversal moves ${reversal.amount} the same way as the row; ${offered.length} candidate(s); `
      + `it is ${offered.includes(reversal.id) ? 'OFFERED' : 'out'}; original ${offered.includes(paidOut.entry.id) ? 'OFFERED' : 'out'}`)
  }

  {
    // Amending carries the match across, because the replacement is where the
    // money is now.
    await rowsIn([['2026-10-05', 45000n, 'TO BE AMENDED']])
    const row = await rowNamed('TO BE AMENDED')
    const original = await entryOn('2026-10-05', 45000n, 'Right amount, wrong description')
    await matchEntry({ bankTransactionId: row.id, entryId: original.entry.id, actor: 'alicio@example.test' })

    // Guarded: without the carry, 0021 refuses the amendment outright, and an
    // unguarded call would end the run instead of failing this check.
    let amended: Awaited<ReturnType<typeof amendEntry>> | null = null
    try {
      amended = await amendEntry(original.entry.id, {
        entryDate: '2026-10-05', description: 'Right amount, right description', actor: 'alicio@example.test',
        lines: [{ accountId: cash.id, amount: 45000n }, { accountId: ar.id, amount: -45000n }],
      }, 'alicio@example.test')
    } catch (e) {
      fail('M50 amending an entry carries its match to the replacement',
        `it was refused: ${errorText(e).split(' | ').find((x) => x.includes('REVERSED_STILL_MATCHED'))?.slice(0, 74) ?? errorText(e).slice(0, 74)}`)
    }

    const links = await matchesFor(row.id)
    if (amended) {
      check(links.length === 1 && links[0].entry_id === amended.replacement.id,
        'M50 amending an entry carries its match to the replacement',
        `match now on ${links[0]?.entry_no}`)
    }
    check((await stateOf(row.id))?.state === 'matched',
      'M51 and the row is still accounted for, by the entry that accounts for it',
      (await stateOf(row.id))?.state ?? 'gone')

    // Amending into a shape that cannot carry the match is refused whole. The
    // alternative would be silently shrinking a reconciliation nobody asked to
    // change.
    //
    // Skipped rather than returned when the amendment above did not happen:
    // an early return would take the remaining forty checks with it, quietly,
    // which is the dying-suite habit in another costume.
    if (amended) {
      const replacement = amended.replacement.id
      await expectDbError('M52 but not into a shape that cannot carry it',
        'ENTRY_OVER_MATCHED', () =>
          amendEntry(replacement, {
            entryDate: '2026-10-05', description: 'Now for less', actor: 'alicio@example.test',
            lines: [{ accountId: cash.id, amount: 20000n }, { accountId: ar.id, amount: -20000n }],
          }, 'alicio@example.test'))
    } else {
      fail('M50g M50 produced a replacement for M52 to amend', 'it did not')
    }
  }

  // ----------------------------------------------- the books, independently --

  {
    // `books` must be the same number the rest of the system calls this
    // account's balance. It was not: it filtered on 'posted' alone while every
    // other reader uses 'posted','reversed', so after any reversal it was wrong
    // by twice the reversed amount — and the reconcile screen printed a figure
    // that disagreed with the account's own history page.
    const asOf = '2026-12-31'
    const r = await reconciliation(cash.id, asOf)
    const [canon] = await db.execute<{ b: bigint }>(raw`
      SELECT coalesce(sum(jl.amount), 0)::bigint AS b
        FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
       WHERE jl.account_id = ${cash.id}::uuid
         AND e.status IN ('posted', 'reversed') AND e.entry_date <= ${asOf}::date`)
    check(r.books === canon.b,
      'M53 the books figure is the account balance the rest of the system uses',
      `${r.books} vs ${canon.b}`)

    // And this is the identity check that can actually fail: the same figure
    // reached per entry rather than as two totals, so a wrong total on either
    // side is a disagreement rather than a cancellation.
    check(r.booksUnclaimed === r.unclaimedPerEntry,
      'M54 and what the books have unclaimed agrees, computed either way',
      `${r.booksUnclaimed} vs ${r.unclaimedPerEntry}`)

    // With a reversal in the account, so the filter above is doing work.
    const [reversals] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry
       WHERE ledger_id = ${ledgerId}::uuid AND status = 'reversed'`)
    check(Number(reversals.n) > 0, 'M55 with reversed entries in the account to make it matter',
      `${reversals.n} reversed`)
  }

  {
    // Posting the rest of a row after part of it was posted. Keyed on the row
    // alone, the second post replayed the first entry, created nothing, and the
    // screen said the row was settled.
    await rowsIn([['2026-11-25', 100000n, 'SPLIT POST']])
    const row = await rowNamed('SPLIT POST')
    const half = await entryOn('2026-11-25', 40000n, 'The half already in the books')
    await matchEntry({ bankTransactionId: row.id, entryId: half.entry.id, actor: 'alicio@example.test' })

    const first = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: charges.id, actor: 'alicio@example.test',
    })
    check(!first.replayed && (await stateOf(row.id))?.state === 'matched',
      'M56 posting the remainder settles the row', `${first.entryNo}`)

    // Now undo the OTHER match. The row is short again, but by a different
    // amount — and that is the case the key has to tell apart. Keyed on the row
    // alone it replayed the 60000 entry, the conflicting match was swallowed,
    // nothing was posted, and the screen said the row was settled.
    const [halfLink] = (await matchesFor(row.id)).filter((m) => m.entry_id === half.entry.id)
    await unmatch(halfLink.id)
    const short = await stateOf(row.id)
    check(short?.state === 'part' && short.unmatched_amount === 40000n,
      'M57 undoing a different match leaves a different remainder',
      `${short?.state}, ${short?.unmatched_amount} left`)

    const rest = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: charges.id, actor: 'alicio@example.test',
    })
    const settled = await stateOf(row.id)
    check(!rest.replayed && settled?.state === 'matched' && settled.unmatched_amount === 0n,
      'M58 and posting again posts THAT remainder rather than replaying the last one',
      `${rest.entryNo}, replayed=${rest.replayed}, row is ${settled?.state}`)
  }

  {
    const totals = await bankTotals(cash.id)
    const rows = await bankRows(cash.id)
    const outstanding = rows
      .filter((r) => r.state !== 'ignored')
      .reduce((a, r) => a + r.unmatched_amount, 0n)
    check(totals.outstanding === outstanding,
      'M36 what the statement says the books have not accounted for',
      `${totals.outstanding} over ${totals.unmatched} rows`)
  }

  // M79 — A ROW IMPORTED BY MISTAKE IS DELETED (0084). 0017 named "remove it
  //       and import again" as the fix, and no door did it. A row imported
  //       twice goes, and the trail keeps what it said, under the person; a row
  //       that settles an entry is refused and told to undo the match; a row
  //       set aside is refused and told to put it back. Everything this made is
  //       taken back after, so no later check sees it.
  {
    const fd = (pairs: Record<string, string>) => {
      const f = new FormData()
      f.set(F.ledgerId, ledgerId); f.set(F.accountId, cash.id)
      for (const [k, v] of Object.entries(pairs)) f.set(k, v)
      return f
    }
    const A = 'alicio@example.test'
    await rowsIn([['2026-03-21', 4200n, 'IMPORTED TWICE'], ['2026-03-22', -3100n, 'SETTLED ROW'], ['2026-03-23', -900n, 'SET ASIDE ROW']])
    const twice = await rowNamed('IMPORTED TWICE')
    const settled = await rowNamed('SETTLED ROW')
    const aside = await rowNamed('SET ASIDE ROW')
    const fee = await entryOn('2026-03-22', -3100n, 'Settles the row', charges.id)
    await matchEntry({ bankTransactionId: settled.id, entryId: fee.entry.id, actor: A })
    await ignoreFromForm(fd({ [F.rowId]: aside.id, [F.reason]: 'the bank reversed it' }), A)

    const gone = await deleteRowFromForm(fd({ [F.rowId]: twice.id }), A)
    const matchedSaid = await deleteRowFromForm(fd({ [F.rowId]: settled.id }), A)
    const asideSaid = await deleteRowFromForm(fd({ [F.rowId]: aside.id }), A)
    const [trail] = await db.execute<{ actor: string; before: { description?: string } }>(raw`
      SELECT actor, before FROM audit_log WHERE action = 'bank_row_delete' AND record_id = ${twice.id}`)
    const left = { twice: await stateOf(twice.id), settled: await stateOf(settled.id), aside: await stateOf(aside.id) }
    check(gone.ok?.startsWith('Deleted.') === true && left.twice === undefined
          && trail?.actor === A && trail.before?.description === 'IMPORTED TWICE'
          && matchedSaid.error === 'That row settles an entry. Undo the match first.' && left.settled?.state === 'matched'
          && asideSaid.error === 'That row was set aside on purpose. Put it back first.' && left.aside?.state === 'ignored',
      'M79 a row imported by mistake is deleted; one matched or set aside is refused and says what to undo',
      `imported twice: ${gone.ok ?? gone.error} (${left.twice ? 'STILL THERE' : 'gone'}, trail ${trail ? `${trail.actor}: ${trail.before?.description}` : 'nothing'}); `
        + `matched: ${matchedSaid.error ?? matchedSaid.ok}; set aside: ${asideSaid.error ?? asideSaid.ok}`)

    // Taken back: the match, the set-aside, the rows and the entry.
    const [link] = await matchesFor(settled.id)
    await unmatchFromForm(fd({ [F.matchId]: link.id }), A)
    await unignoreFromForm(fd({ [F.rowId]: aside.id }), A)
    await deleteRowFromForm(fd({ [F.rowId]: settled.id }), A)
    await deleteRowFromForm(fd({ [F.rowId]: aside.id }), A)
    await deleteEntry(fee.entry.id, A)
  }

  // ------------------------------------------------------------ open books --
  // M37: the owner's cascade at the entry door — deleting a matched entry
  // releases the match (the row is unreconciled again, and says so by count).
  // A bank-sourced entry now does the same, at the same door (M27b).
  {
    await rowsIn([['2026-03-20', -7700n, 'CASCADE ROW']])
    const row = await rowNamed('CASCADE ROW')
    const manual = await entryOn('2026-03-20', -7700n, 'Fee, by hand')
    await matchEntry({ bankTransactionId: row.id, entryId: manual.entry.id, actor: 'alicio@example.test' })
    const matched = await stateOf(row.id)

    let gone: Awaited<ReturnType<typeof deleteEntry>> | null = null
    try { gone = await deleteEntry(manual.entry.id, 'alicio@example.test') }
    catch (e) { fail('M37 deleting a matched manual entry releases the match', `it threw: ${(e as Error).message.slice(0, 70)}`) }
    const after = await stateOf(row.id)
    if (gone) {
      check(matched?.state === 'matched' && gone.releasedMatches === 1
            && after?.state === 'unmatched' && after.matched_amount === 0n,
        'M37 deleting a matched manual entry releases the match',
        `${gone.entryNo} gone; row back to ${after?.state}; ${gone.releasedMatches} match released`)
    }
  }

  // ------------------------------------------------------- the statement --
  // The bank's own figure. Matching row by row can never notice a row that
  // was NEVER IMPORTED — it matches nothing and disturbs nothing. The one
  // check that catches it is: prior statement's printed ending + every
  // imported row since = this statement's printed ending. Only the printed
  // figure is stored; every other line of the report is derived at read time.
  {
    const d1 = '2026-12-01'
    const d2 = '2026-12-15'
    // One row ON the first statement date — the boundary row. It belongs to
    // the FIRST period (txn_date <= d1) and must not be counted again by the
    // second (txn_date > d1); an inclusive bound on both sides double-counts
    // exactly this row and nothing else in this fixture.
    await rowsIn([['2026-12-01', 5000n, 'ON THE STATEMENT DATE']])
    await rowsIn([['2026-12-10', -3000n, 'INSIDE SECOND PERIOD']])

    // Expected sums derived from `bankRows` — a different reader than the SUM
    // inside `statementReport`, so the two can disagree. Ignored rows count:
    // set aside or not, the bank moved that money and its printed balance
    // includes it.
    const all = await bankRows(cash.id)
    const sumTo = (d: string) =>
      all.filter((r) => r.txn_date <= d).reduce((a, r) => a + r.amount, 0n)
    const typed1 = sumTo(d1)

    await saveStatement({ accountId: cash.id, statementDate: d1, endingBalance: typed1, actor: 'alicio@example.test' })
    const onFile = await statementsFor(cash.id)
    check(onFile.length === 1 && onFile[0].statement_date === d1
          && onFile[0].ending_balance === typed1,
      'M70 a statement stores only what the bank printed',
      `${onFile[0]?.statement_date} ${onFile[0]?.ending_balance}`)

    await expectError('M71 the same date twice is refused toward delete-and-re-enter',
      'STATEMENT_EXISTS',
      () => saveStatement({ accountId: cash.id, statementDate: d1, endingBalance: 1n, actor: 'alicio@example.test' }))

    const r1 = await reconcileView(cash.id, d1)
    check(r1 !== null && r1.beginningDate === null && r1.beginningBalance === 0n
          && r1.rowsInPeriod === typed1
          && r1.impliedEnding === r1.beginningBalance + r1.rowsInPeriod
          && r1.importGap === 0n && r1.recon.asOf === d1,
      'M72 the first report starts at zero and the complete import closes the gap',
      r1 ? `rows ${r1.rowsInPeriod}, implied ${r1.impliedEnding}, gap ${r1.importGap}` : 'no report')

    // The second statement's printed ending includes a $250.00 deposit the
    // bank shows and the import never got. The gap must be exactly that row.
    const typed2 = sumTo(d2) + 25000n
    await saveStatement({ accountId: cash.id, statementDate: d2, endingBalance: typed2, actor: 'alicio@example.test' })
    const r2 = await reconcileView(cash.id, d2)
    check(r2 !== null && r2.beginningDate === d1 && r2.beginningBalance === typed1
          && r2.rowsInPeriod === sumTo(d2) - sumTo(d1)
          && r2.importGap === 25000n,
      'M73 the next report chains from the last and the gap names the missing row',
      r2 ? `begins ${r2.beginningBalance} at ${r2.beginningDate}, period ${r2.rowsInPeriod}, gap ${r2.importGap}` : 'no report')

    // The screen. `statementReport` deciding the gap proves nothing about a
    // page that never prints it — the same seam M65 exists for.
    if (r2) {
      const shown = JSON.parse(execFileSync('npx',
        ['tsx', 'scripts/render-statement-report.tsx', stringify(r2)],
        { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } },
      )) as { lines: string[]; amounts: string[] }
      check(shown.amounts.includes('25000')
            && shown.lines.some((l) => l.startsWith('Import gap 250.00')),
        'M74 the report page prints the gap and says a row is missing',
        shown.lines.filter((l) => l.startsWith('Import gap')).join(' ').slice(0, 90))
      check(shown.lines.includes('Made up of'),
        'M75 and the report carries the four-part summary block',
        shown.lines.filter((l) => l.startsWith('Where the account')).join(' ').slice(0, 80))
    }
    if (r1) {
      const clean = JSON.parse(execFileSync('npx',
        ['tsx', 'scripts/render-statement-report.tsx', stringify(r1)],
        { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } },
      )) as { lines: string[] }
      // A closed gap prints NOTHING — the reference report has no prose, and
      // a sentence that says "complete" on every page is a sentence nobody reads.
      check(!clean.lines.some((l) => l.startsWith('Import gap')),
        'M74b and a closed gap prints no warning at all',
        clean.lines.find((l) => l.startsWith('Import gap')) ?? 'no gap line, as it should be')
    }

    // M77 — the PDF exit. Same statementReport, same recon-display split,
    // read back independently. The gap and the four-part summary must be ON
    // the paper — a report generated without them is the print-the-page flow
    // wearing a new name.
    if (r2) {
      const pdfBuilt = await reconciliationPdf(ledgerId, cash.id, d2)
      const pdf = pdfBuilt ? pdfText(pdfBuilt.buffer) : ''
      // The report took QuickBooks' shape (19): the gap is a sentence under
      // the Summary rather than a line of its own, and the four-part
      // explanation is appended because the difference is not zero here.
      check(pdfBuilt !== null
            && pdf.includes(`Import gap ${formatMoney(r2.importGap)}`)
            && pdf.includes('Where the account started')
            && pdf.includes('Timing differences'),
        'M77 the reconciliation PDF carries the gap and the four-part summary',
        pdf.split('\n').filter((l) => l.startsWith('Import gap') || l.startsWith('Where')).join(' | ').slice(0, 70))
    }

    const second = (await statementsFor(cash.id)).find((st) => st.statement_date === d2)
    if (second) await deleteStatement(second.id)
    check((await statementsFor(cash.id)).every((st) => st.statement_date !== d2)
          && (await reconcileView(cash.id, d2)) === null,
      'M76 a deleted statement is gone and its report with it',
      `${(await statementsFor(cash.id)).length} left on file`)
  }

  // Money received uses the same business description rule, and replay must
  // keep a retry while distinguishing a changed purpose after unmatching.
  {
    await rowsIn([['2026-12-16', 2500n, 'EFT BUSINESS PAYMENT']])
    const row = await rowNamed('EFT BUSINESS PAYMENT')
    const first = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: revenue.id, description: '   ', actor: 'alicio@example.test',
    })
    const [received] = await db.execute<{ summary: string; item: string | null; memo: string; amount: bigint }>(raw`
      SELECT e.description AS summary, jl.description AS item, b.description AS memo, jl.amount
        FROM journal_entry e JOIN bank_transaction b ON b.id = e.source_id
        JOIN journal_line jl ON jl.entry_id = e.id AND jl.account_id = ${revenue.id}::uuid
       WHERE e.id = ${first.entryId}::uuid`)
    check(received.summary === revenue.name && received.item === revenue.name
          && received.memo === 'EFT BUSINESS PAYMENT' && received.amount === -2500n,
      'M79 income defaults to the revenue category and preserves its bank source and direction',
      `${received.summary} / ${received.item}; ${received.amount}; bank: ${received.memo}`)

    await unmatch((await matchesFor(row.id))[0].id, 'alicio@example.test')
    const retry = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: revenue.id, description: ` ${revenue.name} `, actor: 'alicio@example.test',
    })
    check(retry.replayed && retry.entryId === first.entryId && (await stateOf(row.id))?.state === 'matched',
      'M80 equivalent trimmed wording reuses the original posting after unmatching',
      `replayed ${retry.replayed}; same entry ${retry.entryId === first.entryId}`)

    await unmatch((await matchesFor(row.id))[0].id, 'alicio@example.test')
    const changed = await postFromBankRow({
      bankTransactionId: row.id, contraAccountId: revenue.id, description: 'October consulting', actor: 'alicio@example.test',
    })
    const [reworded] = await db.execute<{ summary: string; item: string | null }>(raw`
      SELECT e.description AS summary, jl.description AS item
        FROM journal_entry e JOIN journal_line jl ON jl.entry_id = e.id AND jl.account_id = ${revenue.id}::uuid
       WHERE e.id = ${changed.entryId}::uuid`)
    check(!changed.replayed && changed.entryId !== first.entryId
          && reworded.summary === 'October consulting' && reworded.item === 'October consulting',
      'M81 a changed business description is not silently discarded by replay',
      `${reworded.summary} / ${reworded.item}; replayed ${changed.replayed}`)
  }
  // One bank transaction, multiple gross category allocations, one balanced entry.
  {
    const extra = await importAccounts(acme.company.id, [
      { entityId: acme.company.id, code: '5100', name: 'Office supplies', accountType: 'expense' },
      { entityId: acme.company.id, code: '4100', name: 'Other revenue', accountType: 'revenue' },
      { entityId: acme.company.id, code: '1300', name: 'GST recoverable', accountType: 'asset', roles: ['gst_hst_recoverable'] },
      { entityId: acme.company.id, code: '2100', name: 'GST payable', accountType: 'liability', roles: ['gst_hst_payable'] },
      { entityId: acme.company.id, code: '2150', name: 'PST payable', accountType: 'liability', roles: ['qst_pst_payable'] },
    ], 'alicio@example.test')
    const expense = extra.find((a) => a.code === '5100')!
    const sales = extra.find((a) => a.code === '4100')!
    const tax = extra.find((a) => a.code === '1300')!
    const linesOf = (entry: string) => db.execute<{ account_id: string; amount: bigint; description: string; party_id: string | null }>(raw`
      SELECT account_id::text, amount, description, party_id::text FROM journal_line WHERE entry_id = ${entry}::uuid`)
    await rowsIn([['2026-12-01', -120000n, 'SPLIT PURCHASE'], ['2026-12-02', 11200n, 'SPLIT SALE'], ['2026-12-03', -200000n, 'SPLIT PARTIAL'], ['2026-12-04', -11200n, 'SPLIT TAX']])
    const purchase = await rowNamed('SPLIT PURCHASE')
    const parts = [{ accountId: charges.id, amount: 70000n }, { accountId: expense.id, amount: 50000n }]
    for (const invalid of [
      [{ accountId: charges.id, amount: 70000n }, { accountId: expense.id, amount: 49999n }],
      [{ accountId: charges.id, amount: 120000n }, { accountId: expense.id, amount: 0n }],
      [{ accountId: charges.id, amount: 70000n }, { accountId: charges.id, amount: 50000n }],
      [{ accountId: charges.id, amount: 70000n }, { accountId: cash.id, amount: 50000n }],
    ]) await expectError('M82 invalid split is refused', 'BAD_SPLIT', () => postFromBankRow({ bankTransactionId: purchase.id, contraAccountId: '', splits: invalid }))
    const created = await postFromBankRow({ bankTransactionId: purchase.id, contraAccountId: '', splits: parts, partyId: partyIds[1], actor: 'alicio@example.test' })
    const lines = await linesOf(created.entryId)
    check(lines.length === 3 && lines.filter((l) => l.account_id === cash.id).length === 1
      && lines.reduce((sum, l) => sum + l.amount, 0n) === 0n
      && lines.find((l) => l.account_id === expense.id)?.amount === 50000n
      && lines.filter((l) => l.account_id !== cash.id).every((l) => l.party_id === partyIds[1])
      && (await matchesFor(purchase.id)).length === 1, 'M83 split purchase keeps one bank line and match, with parties on business lines', String(lines.length))
    await unmatch((await matchesFor(purchase.id))[0].id, 'alicio@example.test')
    const replay = await postFromBankRow({ bankTransactionId: purchase.id, contraAccountId: '', splits: [...parts].reverse(), partyId: partyIds[1], actor: 'alicio@example.test' })
    check(replay.replayed && replay.entryId === created.entryId, 'M84 reordering identical splits replays the same entry', replay.entryId)
    await unmatch((await matchesFor(purchase.id))[0].id, 'alicio@example.test')
    const changed = await postFromBankRow({ bankTransactionId: purchase.id, contraAccountId: '', splits: [{ accountId: charges.id, amount: 60000n }, { accountId: expense.id, amount: 60000n }], partyId: partyIds[1], actor: 'alicio@example.test' })
    check(!changed.replayed && changed.entryId !== created.entryId, 'M85 changing split allocations is a new request', changed.entryId)
    const partial = await rowNamed('SPLIT PARTIAL')
    const first = await entryOn('2026-12-03', -80000n, 'First part')
    await matchEntry({ bankTransactionId: partial.id, entryId: first.entry.id, amount: -80000n, actor: 'alicio@example.test' })
    const rest = await postFromBankRow({ bankTransactionId: partial.id, contraAccountId: '', splits: parts, actor: 'alicio@example.test' })
    check((await linesOf(rest.entryId)).find((l) => l.account_id === cash.id)?.amount === -120000n && (await stateOf(partial.id))?.unmatched_amount === 0n,
      'M86 split uses only the unmatched remainder', rest.entryId)
    const sale = await rowNamed('SPLIT SALE')
    const taxSale = await postFromBankRow({ bankTransactionId: sale.id, contraAccountId: '', splits: [{ accountId: revenue.id, amount: 5600n }, { accountId: sales.id, amount: 5600n }], taxCode: 'GST_PST', actor: 'alicio@example.test' })
    const saleLines = await linesOf(taxSale.entryId)
    check(saleLines.reduce((sum, l) => sum + l.amount, 0n) === 0n && saleLines.find((l) => l.account_id === revenue.id)?.amount === -5000n,
      'M87 incoming inclusive GST/PST splits balance exactly', String(saleLines.length))
    const taxBuy = await rowNamed('SPLIT TAX')
    const fd = new FormData()
    fd.set(F.ledgerId, ledgerId); fd.set(F.accountId, cash.id); fd.set(F.rowId, taxBuy.id); fd.set(F.splitMode, 'yes'); fd.set(F.taxCode, 'GST_PST')
    fd.append(F.splitAccountId, charges.id); fd.append(F.splitAccountId, expense.id)
    fd.append(F.splitAmount, '56.00'); fd.append(F.splitAmount, '56.00')
    const formPosted = await postFromRowForm(fd, 'alicio@example.test')
    const taxEntry = (await matchesFor(taxBuy.id))[0]
    const taxLines = taxEntry ? await linesOf(taxEntry.entry_id) : []
    check(formPosted.ok !== undefined && taxLines.reduce((sum, l) => sum + l.amount, 0n) === 0n
      && taxLines.find((l) => l.account_id === charges.id)?.amount === 5350n
      && taxLines.filter((l) => l.account_id === tax.id).reduce((sum, l) => sum + l.amount, 0n) === 500n,
      'M88 split form posts inclusive tax with purchase PST kept as cost', formPosted.ok ?? formPosted.error ?? '')
    const otherCo = await createCompany({ code: 'SPLITFOREIGN', name: 'Other Split Co' }, 'alicio@example.test')
    const [foreign] = await importAccounts(otherCo.company.id, [{ entityId: otherCo.company.id, code: '5000', name: 'Foreign cost', accountType: 'expense' }], 'alicio@example.test')
    await rowsIn([['2026-12-05', -120000n, 'SPLIT FOREIGN']])
    const outsider = await rowNamed('SPLIT FOREIGN')
    await expectError('M89 foreign company split is refused by the service', 'FOREIGN_ACCOUNT', () => postFromBankRow({ bankTransactionId: outsider.id, contraAccountId: '', splits: [{ accountId: charges.id, amount: 70000n }, { accountId: foreign.id, amount: 50000n }] }))
    fd.set(F.rowId, outsider.id); fd.delete(F.splitAccountId); fd.append(F.splitAccountId, charges.id); fd.append(F.splitAccountId, foreign.id)
    const noForeign = await postFromRowForm(fd, 'alicio@example.test')
    check(noForeign.error?.includes('this company') === true && (await matchesFor(outsider.id)).length === 0, 'M90 form refuses a foreign split without writing', noForeign.error ?? '')
  }

}

main()

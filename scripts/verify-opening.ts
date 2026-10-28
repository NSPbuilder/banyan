/**
 * Opening balances: where the books start.
 *   npm run db:verify-opening   (resets the database first)
 *
 * Three rules, and the third is the one that matters most:
 *
 *   one live opening balance per ledger
 *   nothing may be dated before it
 *   a difference is never absorbed quietly
 *
 * Balances carried from another system are very often out. The number is not the
 * problem — a system that swallows it is, because the books then balance and
 * nobody knows what by.
 */
import './env'
import { cleanupWith, errorText, expectCode, expectDbRefusal, reporter } from './suite'
import { byHand } from './by-hand'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts } from '../src/lib/accounts'
import {
  amendEntry, closeFiscalYear, postDraft, postEntry, reverseEntry, saveDraft,
} from '../src/lib/posting'
import { trialBalance } from '../src/lib/balances'
import { formatMoney } from '../src/lib/money'
import { parseAccountsCsv } from '../src/lib/accounts'
import { renderStatement } from '../src/lib/statements'
import {
  DIFFERENCE_DESCRIPTION, OpeningError, differenceOf, openingBalanceFor,
  openingCandidates, postOpeningBalance,
} from '../src/lib/opening'
import { OPENING_FIELDS as F, amountFor } from '../src/lib/forms'
import { linesFrom, openingFromForm } from '../src/lib/opening-forms'

/**
 * The same chart, but role-tagged. A statement template selects by role, so a
 * company built from the plain CHART renders an empty P&L — and a check reading
 * 0 from an empty statement would pass for the wrong reason.
 */
const ROLED_CHART = `1000,Cash — Operating,asset,,cash_and_cash_equivalents
3000,Share Capital,equity,,share_capital
3100,Retained Earnings,equity,,retained_earnings
4000,Consulting Revenue,revenue,,revenue_from_contracts`

const r = reporter(56)
const { fail, check } = r

const expectDbError = expectDbRefusal(r, { passSlice: 78, failSlice: 140 })

/**
 * `saying` is not decoration. A label that promises the refusal names a figure,
 * against an assertion that only compares an error code, is a check that passes
 * for a reason other than the one it claims: an empty amount reads the same to
 * the code and quite differently to whoever is trying to find the 600.00.
 */
const expectError = expectCode(r, { passSlice: 76, failText: (e) => errorText(e).slice(0, 90), sayingSlice: 76 })

const cleanup = cleanupWith(r)

const CHART: Array<[string, string, 'asset' | 'liability' | 'equity' | 'revenue' | 'expense']> = [
  ['1000', 'Cash — Operating', 'asset'],
  ['1200', 'Accounts Receivable', 'asset'],
  ['2000', 'Accounts Payable', 'liability'],
  ['3000', 'Share Capital', 'equity'],
  ['3100', 'Retained Earnings', 'equity'],
  ['3900', 'Opening Balance Difference', 'equity'],
  ['4000', 'Consulting Revenue', 'revenue'],
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

  const chart = await importAccounts(acme.company.id, CHART.map(([code, name, accountType]) =>
    ({ entityId: acme.company.id, code, name, accountType })), 'alicio@example.test')
  const at = (code: string) => chart.find((a) => a.code === code)!
  const cash = at('1000'), ar = at('1200'), ap = at('2000')
  const capital = at('3000'), retained = at('3100')

  // ----------------------------------------------------------------- pure --

  {
    const balanced = differenceOf([
      { accountId: cash.id, amount: 500000n },
      { accountId: capital.id, amount: -500000n },
    ])
    check(balanced === 0n, 'O01 figures that balance come to nothing', String(balanced))

    const out = differenceOf([
      { accountId: cash.id, amount: 500000n },
      { accountId: capital.id, amount: -450000n },
    ])
    check(out === 50000n, 'O02 and figures that do not come to the difference', String(out))
  }

  // ------------------------------------------------------------- entering --

  {
    check(await openingBalanceFor(ledgerId) === null,
      'O03 a new ledger has no opening balance', 'none')

    const result = await postOpeningBalance({
      ledgerId, entryDate: '2026-01-01', actor: 'alicio@example.test',
      lines: [
        { accountId: cash.id, amount: 1250000n },
        { accountId: ar.id, amount: 340000n },
        { accountId: ap.id, amount: -190000n },
        { accountId: capital.id, amount: -100000n },
        { accountId: retained.id, amount: -1300000n },
      ],
    })

    check(result.difference === null && result.entryNo !== null,
      'O04 balanced figures go in with no difference', `${result.entryNo}`)

    const [entry] = await db.execute<{
      status: string; source_type: string; period_id: string | null; lines: string; total: bigint
    }>(raw`
      SELECT e.status, e.source_type, e.period_id::text,
             count(jl.*)::text AS lines, coalesce(sum(jl.amount), 0)::bigint AS total
        FROM journal_entry e JOIN journal_line jl ON jl.entry_id = e.id
       WHERE e.id = ${result.entryId}::uuid
       GROUP BY e.status, e.source_type, e.period_id`)
    check(entry.status === 'posted' && entry.source_type === 'opening_balance'
      && entry.period_id !== null && entry.lines === '5' && entry.total === 0n,
      'O05 as an ordinary posted entry — numbered, in a period, balanced',
      `${entry.source_type}, ${entry.lines} lines, sum ${entry.total}`)

    // The point of all of it, checked through the reporting path rather than by
    // reading back the lines that were just written: the trial balance for the
    // period now says what the old system said.
    const [period] = await db.execute<{ id: string }>(raw`
      SELECT p.id::text FROM fiscal_period p JOIN fiscal_year y ON y.id = p.fiscal_year_id
       WHERE y.ledger_id = ${ledgerId}::uuid AND p.period_no = 1`)
    const tb = await trialBalance(ledgerId, period.id)
    const cashRow = tb.find((r) => r.code === '1000')
    const retainedRow = tb.find((r) => r.code === '3100')
    check(cashRow?.balance === '1250000' && retainedRow?.balance === '-1300000',
      'O06 and the trial balance carries the figures it was given',
      `cash ${cashRow?.balance}, retained ${retainedRow?.balance}`)
  }

  // --------------------------------------------------------- only the one --

  {
    await expectError('O07 a second opening balance is refused', 'ALREADY_OPEN', () =>
      postOpeningBalance({
        ledgerId, entryDate: '2026-01-01', actor: 'alicio@example.test',
        lines: [{ accountId: cash.id, amount: 1n }, { accountId: capital.id, amount: -1n }],
      }))

    // And the database says so too, not only the library — the library check
    // reads the same row the index constrains, so on its own it proves nothing
    // about what two callers at once would do.
    //
    // Copied off the real one rather than made up: an entry with no period is
    // refused by an older guard long before the index is consulted, and a check
    // that passed on THAT would prove nothing about this.
    await expectDbError('O08 and the database refuses it as well',
      'one_opening_balance_per_ledger', () =>
        byHand((tx) => tx.execute(raw`
          INSERT INTO journal_entry
            (ledger_id, entry_date, period_id, entry_no, posted_at, description,
             source_type, status)
          SELECT ledger_id, entry_date, period_id, 'JE-SNEAK-1', now(),
                 'Sneaking a second one in', 'opening_balance', 'posted'
            FROM journal_entry
           WHERE ledger_id = ${ledgerId}::uuid AND source_type = 'opening_balance'
             AND status <> 'reversed'`)))
  }

  // ------------------------------------------------- nothing before it --

  {
    // The shape this rule is really for. Dating the opening balance on the first
    // day of the first period makes it unreachable — nothing can be earlier,
    // because a date before the first period has no period and an older guard
    // refuses it. What CAN happen is an opening balance dated late: entries go
    // in first, then the starting position is entered after them, and every
    // statement over the gap is movement against a position that did not exist.
    const third = await createCompany({ code: 'THIRD', name: 'Third Ltd.' }, 'alicio@example.test')
    await createFiscalYear(third.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirs = await importAccounts(third.company.id, CHART.map(([code, name, accountType]) =>
      ({ entityId: third.company.id, code, name, accountType })), 'alicio@example.test')
    const theirCash = theirs.find((a) => a.code === '1000')!
    const theirCapital = theirs.find((a) => a.code === '3000')!
    const theirRevenue = theirs.find((a) => a.code === '4000')!

    await postEntry({
      ledgerId: third.ledger.id, entryDate: '2026-02-01', description: 'Trading already',
      actor: 'alicio@example.test',
      lines: [{ accountId: theirCash.id, amount: 5000n }, { accountId: theirRevenue.id, amount: -5000n }],
    })

    await expectDbError('O09 an opening balance dated after existing entries is refused',
      'BEFORE_OPENING', () =>
        postOpeningBalance({
          ledgerId: third.ledger.id, entryDate: '2026-03-01', actor: 'alicio@example.test',
          lines: [
            { accountId: theirCash.id, amount: 700000n },
            { accountId: theirCapital.id, amount: -700000n },
          ],
        }))

    // The pair: dated before them it goes in. Without it, a rule that refused
    // every opening balance would pass the check above.
    const earlier = await postOpeningBalance({
      ledgerId: third.ledger.id, entryDate: '2026-01-01', actor: 'alicio@example.test',
      lines: [
        { accountId: theirCash.id, amount: 700000n },
        { accountId: theirCapital.id, amount: -700000n },
      ],
    })
    check(earlier.entryNo !== null,
      'O10 but one dated before them goes in', `${earlier.entryNo}`)

    // Not checked here: moving an existing POSTED entry back behind the opening
    // balance. It is unreachable — a posted entry cannot be edited at all.
    //
    // What this comment used to say about the trigger's UPDATE arm was wrong on
    // both halves. It claimed the arm guards a period being redefined to cover
    // earlier dates: 0007 refuses redefining a period that holds posted entries,
    // so that is not what the arm is for. And it claimed this suite could not
    // reach the arm: posting a draft IS an UPDATE, so it reaches it easily.
    // `O32` is that check, 280 lines below. See `08` section 2.
  }

  // ------------------------------------------------------- the difference --

  {
    // A second ledger, so the rules above do not get in the way.
    const other = await createCompany({ code: 'OTHER', name: 'Other Holdings Ltd.' }, 'alicio@example.test')
    await createFiscalYear(other.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirs = await importAccounts(other.company.id, CHART.map(([code, name, accountType]) =>
      ({ entityId: other.company.id, code, name, accountType })), 'alicio@example.test')
    const theirCash = theirs.find((a) => a.code === '1000')!
    const theirCapital = theirs.find((a) => a.code === '3000')!
    const theirDiff = theirs.find((a) => a.code === '3900')!

    const outOfBalance = [
      { accountId: theirCash.id, amount: 1000000n },
      { accountId: theirCapital.id, amount: -940000n },
    ]

    await expectError('O11 figures that are out are refused, with the amount named',
      'OUT_OF_BALANCE', () =>
        postOpeningBalance({ ledgerId: other.ledger.id, entryDate: '2026-01-01',
          lines: outOfBalance, actor: 'alicio@example.test' }),
      // 1,000,000 against 940,000. "the amount named" is the whole point of the
      // refusal, so the check has to read it.
      formatMoney(differenceOf(outOfBalance)))

    // Guarded: a balancing line with the wrong sign doubles the gap instead of
    // closing it, the ledger refuses the entry, and an unguarded call would end
    // the run rather than failing this check.
    let result: Awaited<ReturnType<typeof postOpeningBalance>> | null = null
    try {
      result = await postOpeningBalance({
        ledgerId: other.ledger.id, entryDate: '2026-01-01', lines: outOfBalance,
        balancingAccountId: theirDiff.id, actor: 'alicio@example.test',
      })
    } catch (e) {
      fail('O12 and once an account is named for it, it goes in and is reported',
        `it was refused: ${errorText(e).split(' | ').pop()?.slice(0, 70)}`)
    }
    if (result) {
      check(result.difference === -60000n,
        'O12 and once an account is named for it, it goes in and is reported',
        `${result.difference}`)
    }

    // Visible in the entry itself, not only in the return value — the return
    // value is seen once, and the entry is what anyone looks at afterwards.
    const [line] = result ? await db.execute<{ amount: bigint; description: string | null }>(raw`
      SELECT jl.amount, jl.description FROM journal_line jl
       WHERE jl.entry_id = ${result.entryId}::uuid AND jl.account_id = ${theirDiff.id}::uuid`) : []
    check(line?.amount === -60000n && line?.description === DIFFERENCE_DESCRIPTION,
      'O13 as its own line, saying what it is', `${line?.amount} "${line?.description}"`)

    // The discriminating half: the difference is not folded into an existing
    // line. A version that adjusted the capital figure would balance too, and
    // nobody would ever know the conversion had not agreed.
    const [cap] = result ? await db.execute<{ amount: bigint }>(raw`
      SELECT jl.amount FROM journal_line jl
       WHERE jl.entry_id = ${result.entryId}::uuid AND jl.account_id = ${theirCapital.id}::uuid`) : []
    check(cap?.amount === -940000n,
      'O14 and the figures that were given are left exactly as given', `${cap?.amount}`)
  }

  // ------------------------------------------------------------ replacing --

  {
    const before = await openingBalanceFor(ledgerId)
    check(before !== null, 'O15 the ledger has its opening balance', before?.entry_no ?? 'none')

    await reverseEntry(before!.id, '2026-01-01', 'the retained earnings figure was wrong', 'alicio@example.test')
    check(await openingBalanceFor(ledgerId) === null,
      'O16 reversing it frees the slot', 'none')

    const again = await postOpeningBalance({
      ledgerId, entryDate: '2026-01-01', actor: 'alicio@example.test',
      description: 'Opening balances, corrected',
      lines: [
        { accountId: cash.id, amount: 1250000n },
        { accountId: capital.id, amount: -100000n },
        { accountId: retained.id, amount: -1150000n },
      ],
    })
    check(again.entryNo !== null && (await openingBalanceFor(ledgerId))?.id === again.entryId,
      'O17 and a corrected one can be entered', `${again.entryNo}`)

    // The reversal is an adjustment, not an opening balance — which is what
    // makes the slot free rather than occupied by the thing that undid it.
    const [rev] = await db.execute<{ source_type: string }>(raw`
      SELECT source_type FROM journal_entry
       WHERE ledger_id = ${ledgerId}::uuid AND description LIKE 'Reversal of%'
       ORDER BY created_at DESC LIMIT 1`)
    check(rev.source_type === 'adjustment',
      'O18 because the reversal is an adjustment, not another opening balance', rev.source_type)
  }

  // ------------------------------------------------------------------ api --

  await expectError('O19 an empty opening balance is refused', 'EMPTY', () =>
    postOpeningBalance({ ledgerId: 'x', entryDate: '2026-01-01', lines: [], actor: 'alicio@example.test' }))

  {
    const zeros = await postOpeningBalance({
      ledgerId: 'x', entryDate: '2026-01-01', actor: 'alicio@example.test',
      lines: [{ accountId: cash.id, amount: 0n }],
    }).then(() => 'accepted').catch((e) => (e as OpeningError).code)
    check(zeros === 'EMPTY', 'O20 and so is one made only of zeroes', String(zeros))
  }

  {
    const offered = await openingCandidates(acme.company.id)
    check(offered.length === CHART.length && offered[0].code === '1000',
      'O21 every postable account is offered, in code order',
      `${offered.length} accounts`)
  }

  // ----------------------------------------------------------------- form --

  {
    const fourth = await createCompany({ code: 'FOURTH', name: 'Fourth Ltd.' }, 'alicio@example.test')
    await createFiscalYear(fourth.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirs = await importAccounts(fourth.company.id, CHART.map(([code, name, accountType]) =>
      ({ entityId: fourth.company.id, code, name, accountType })), 'alicio@example.test')
    const byCode = (c: string) => theirs.find((a) => a.code === c)!
    const nameOf = (id: string) => theirs.find((a) => a.id === id)?.code ?? id

    const fd = (amounts: Record<string, string>, extra: Record<string, string> = {}) => {
      const f = new FormData()
      f.set(F.ledgerId, fourth.ledger.id)
      f.set(F.entryDate, '2026-01-01')
      f.set(F.description, 'Opening balances')
      for (const [code, v] of Object.entries(amounts)) f.set(amountFor(byCode(code).id), v)
      for (const [k, v] of Object.entries(extra)) f.set(k, v)
      return f
    }

    // Keyed by account id, and proved by scrambling the order: the figures must
    // follow their accounts, not the slots they were rendered in. A form keyed on
    // position puts a balance against whichever account is in that row next time.
    const scrambled = new FormData()
    scrambled.set(amountFor(byCode('3000').id), '-700.00')
    scrambled.set(amountFor(byCode('1000').id), '900.00')
    scrambled.set(amountFor(byCode('1200').id), '-200.00')
    const read = linesFrom(scrambled, nameOf)
    const forCode = (c: string) => read.find((l) => l.accountId === byCode(c).id)?.amount
    check(forCode('1000') === 90000n && forCode('1200') === -20000n && forCode('3000') === -70000n,
      'O22 amounts follow their account, whatever order the form was in',
      `1000=${forCode('1000')} 1200=${forCode('1200')} 3000=${forCode('3000')}`)

    check(linesFrom(fd({ '1000': '  ', '3000': '' }), nameOf).length === 0,
      'O23 and a blank is no balance rather than a zero', 'nothing read')

    let named = ''
    try { linesFrom(fd({ '1000': 'about nine hundred' }), nameOf) }
    catch (e) { named = (e as OpeningError).message }
    check(named.includes('1000') && named.includes('about nine hundred'),
      'O24 while something that is not a number is refused, naming the account',
      named.slice(0, 76))

    const outOfBalance = await openingFromForm(fd({ '1000': '900.00', '3000': '-700.00' }), nameOf, 'alicio@example.test')
    check(outOfBalance.error?.includes('out by') === true
          && outOfBalance.error?.includes('200.00') === true,
      'O25 figures that are out are refused through the form too, saying by how much',
      outOfBalance.error ?? 'no error')

    const balanced = await openingFromForm(
      fd({ '1000': '900.00', '3000': '-700.00' },
          { [F.balancingAccountId]: byCode('3900').id }), nameOf, 'alicio@example.test')
    check(balanced.ok?.includes('200.00 put to the difference') === true,
      'O26 and once an account is named, the amount is said out loud',
      balanced.ok ?? balanced.error ?? '')

    const again = await openingFromForm(fd({ '1000': '1.00', '3000': '-1.00' }), nameOf, 'alicio@example.test')
    check(again.error?.includes('already have an opening balance') === true,
      'O27 a second one through the form is refused with a sentence',
      again.error ?? 'no error')
  }

  // -------------------------------------------- what an amendment keeps --

  {
    // Amending an entry used to make the replacement 'manual', whatever the
    // original was. For an opening balance that freed the one-per-ledger slot —
    // the books could then be entered a second time, and the surviving copy no
    // longer anchored the rule that nothing may be dated before it.
    const fifth = await createCompany({ code: 'FIFTH', name: 'Fifth Ltd.' }, 'alicio@example.test')
    await createFiscalYear(fifth.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirs = await importAccounts(fifth.company.id, CHART.map(([code, name, accountType]) =>
      ({ entityId: fifth.company.id, code, name, accountType })), 'alicio@example.test')
    const theirCash = theirs.find((a) => a.code === '1000')!
    const theirCapital = theirs.find((a) => a.code === '3000')!

    const first = await postOpeningBalance({
      ledgerId: fifth.ledger.id, entryDate: '2026-01-01', actor: 'alicio@example.test',
      lines: [
        { accountId: theirCash.id, amount: 1250000n },
        { accountId: theirCapital.id, amount: -1250000n },
      ],
    })

    const amended = await amendEntry(first.entryId, {
      entryDate: '2026-01-01', description: 'Opening balances, corrected', actor: 'alicio@example.test',
      lines: [
        { accountId: theirCash.id, amount: 1100000n },
        { accountId: theirCapital.id, amount: -1100000n },
      ],
    }, 'alicio@example.test')

    const [kind] = await db.execute<{ t: string }>(raw`
      SELECT source_type AS t FROM journal_entry WHERE id = ${amended.replacement.id}::uuid`)
    check(kind.t === 'opening_balance',
      'O28 amending an opening balance leaves an opening balance', kind.t)

    const still = await openingBalanceFor(fifth.ledger.id)
    check(still?.id === amended.replacement.id,
      'O29 and it is the one the ledger has', still?.entry_no ?? 'none')

    // The consequence, which is what actually matters: the slot is still taken.
    await expectError('O30 so the books cannot be entered a second time', 'ALREADY_OPEN', () =>
      postOpeningBalance({
        ledgerId: fifth.ledger.id, entryDate: '2026-01-01', actor: 'alicio@example.test',
        lines: [
          { accountId: theirCash.id, amount: 1n },
          { accountId: theirCapital.id, amount: -1n },
        ],
      }))
  }

  // ------------------------------------------------ the folded difference --

  {
    const sixth = await createCompany({ code: 'SIXTH', name: 'Sixth Ltd.' }, 'alicio@example.test')
    await createFiscalYear(sixth.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirs = await importAccounts(sixth.company.id, CHART.map(([code, name, accountType]) =>
      ({ entityId: sixth.company.id, code, name, accountType })), 'alicio@example.test')
    const theirCash = theirs.find((a) => a.code === '1000')!
    const theirCapital = theirs.find((a) => a.code === '3000')!

    // Putting the difference against an account that was given a figure balances
    // the entry and quietly changes that figure — and looks exactly like the
    // honest version afterwards. O14 only ever used a separate account, so it
    // passed for a narrower reason than its label claimed.
    await expectError('O31 the difference cannot go against a figure that was given',
      'BALANCING_ACCOUNT_IN_USE', () =>
        postOpeningBalance({
          ledgerId: sixth.ledger.id, entryDate: '2026-01-01', actor: 'alicio@example.test',
          balancingAccountId: theirCapital.id,
          lines: [
            { accountId: theirCash.id, amount: 1000000n },
            { accountId: theirCapital.id, amount: -940000n },
          ],
        }))
  }

  {
    // The trigger's UPDATE arm, which is reachable after all. `08` said it
    // guarded a period being redefined and that this suite could not reach it —
    // both halves were wrong: 0007 refuses redefining a period that holds posted
    // entries, and what the arm actually catches is a draft dated early being
    // posted after the opening balance is already in.
    const eighth = await createCompany({ code: 'EIGHTH', name: 'Eighth Ltd.' }, 'alicio@example.test')
    await createFiscalYear(eighth.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirs = await importAccounts(eighth.company.id, CHART.map(([code, name, accountType]) =>
      ({ entityId: eighth.company.id, code, name, accountType })), 'alicio@example.test')
    const theirCash = theirs.find((a) => a.code === '1000')!
    const theirCapital = theirs.find((a) => a.code === '3000')!
    const theirRevenue = theirs.find((a) => a.code === '4000')!

    const draft = await saveDraft({
      ledgerId: eighth.ledger.id, entryDate: '2026-02-15', description: 'Written early',
      actor: 'alicio@example.test',
      lines: [{ accountId: theirCash.id, amount: 900n },
              { accountId: theirRevenue.id, amount: -900n }],
    })

    await postOpeningBalance({
      ledgerId: eighth.ledger.id, entryDate: '2026-03-01', actor: 'alicio@example.test',
      lines: [{ accountId: theirCash.id, amount: 500000n },
              { accountId: theirCapital.id, amount: -500000n }],
    })

    await expectDbError('O32 a draft dated before the opening balance is refused at posting',
      'BEFORE_OPENING', () => postDraft(draft.id, 'alicio@example.test'))
  }

  {
    // The third place an opening balance flows to, and the only one where being
    // counted is CORRECT. `08` said so without anything proving it, which is a
    // sentence and not a check: a mid-year conversion carries year-to-date
    // revenue as a balance, and the year-end close has to sweep it into
    // retained earnings like any other revenue. If it were ever excluded the
    // way the GST return and the bank candidates exclude it, revenue would sit
    // in a P&L account across a year boundary forever.
    const ninth = await createCompany({ code: 'NINTH', name: 'Ninth Ltd.' }, 'alicio@example.test')
    const year = await createFiscalYear(ninth.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirs = await importAccounts(ninth.company.id, CHART.map(([code, name, accountType]) =>
      ({ entityId: ninth.company.id, code, name, accountType })), 'alicio@example.test')
    const at9 = (code: string) => theirs.find((a) => a.code === code)!
    await db.execute(raw`
      INSERT INTO account_role (account_id, role)
      VALUES (${at9('3100').id}::uuid, 'retained_earnings')`)

    // A conversion done mid-year: cash, capital, and revenue already earned.
    await postOpeningBalance({
      ledgerId: ninth.ledger.id, entryDate: '2026-01-01', actor: 'alicio@example.test',
      lines: [
        { accountId: at9('1000').id, amount: 800000n },
        { accountId: at9('3000').id, amount: -300000n },
        { accountId: at9('4000').id, amount: -500000n },
      ],
    })

    // Ordinary revenue as well as the carried-over kind. Without it, a version
    // that excluded opening balances from the sweep would find nothing to close
    // and THROW — and a suite that dies reports a stack trace instead of a
    // failed check, which is the shape this suite has been bitten by three
    // times. With both, the wrong version closes successfully and leaves a
    // readable wrong number.
    await postEntry({
      ledgerId: ninth.ledger.id, entryDate: '2026-06-30', description: 'Consulting, June',
      actor: 'alicio@example.test',
      lines: [{ accountId: at9('1000').id, amount: 200000n },
              { accountId: at9('4000').id, amount: -200000n }],
    })

    let closeRefused = false
    try {
      await closeFiscalYear(ninth.ledger.id, year.year.id, 'alicio@example.test')
    } catch (e) {
      // Same shape as V32: this catch and the check below share O33's label,
      // so one refusal printed two FAIL lines under one id.
      closeRefused = true
      fail('O33 revenue carried in as an opening balance is swept at year end',
        `the close was refused: ${errorText(e).slice(0, 70)}`)
    }

    if (!closeRefused) {
      const [last] = await db.execute<{ id: string }>(raw`
        SELECT id::text FROM fiscal_period
         WHERE fiscal_year_id = ${year.year.id}::uuid
         ORDER BY end_date DESC LIMIT 1`)
      const tb9 = await trialBalance(ninth.ledger.id, last.id)
      const rev = tb9.find((r) => r.code === '4000')
      const ret = tb9.find((r) => r.code === '3100')
      check(rev?.balance === '0' && ret?.balance === '-700000',
        'O33 revenue carried in as an opening balance is swept at year end',
        `revenue ${rev?.balance}, retained ${ret?.balance}`)
    }
  }

  {
    // The fourth place it flows to, and the one nobody had looked at.
    //
    // `08` section 5 named three readers that need a judgment about whether to
    // count an opening balance. Adversarial review asked what else reads every
    // posted entry and found the period income statement: a P&L detail line uses
    // `period_movement` (0002 seeds `P_REV` that way), so revenue carried in at
    // a mid-year conversion lands in the conversion period's movement and is
    // reported as THAT MONTH's revenue.
    //
    // These two checks pin the behaviour as it is rather than assert it is
    // right, because whether it is right is a question about reporting and not
    // about the software: the year-to-date figure wants it counted, the month's
    // own figure does not. `08` section 7 carries the open question. What must
    // not happen is it changing without anyone noticing, which is what these
    // stop.
    const tenth = await createCompany({ code: 'TENTH', name: 'Tenth Ltd.' }, 'alicio@example.test')
    await createFiscalYear(tenth.ledger.id, '2026-12-31', 'alicio@example.test')
    const roled = await importAccounts(tenth.company.id,
      parseAccountsCsv(ROLED_CHART).map((r) => ({ ...r, entityId: tenth.company.id })), 'alicio@example.test')
    const at10 = (code: string) => roled.find((a) => a.code === code)!

    await postOpeningBalance({
      ledgerId: tenth.ledger.id, entryDate: '2026-03-01', actor: 'alicio@example.test',
      lines: [
        { accountId: at10('1000').id, amount: 800000n },
        { accountId: at10('3000').id, amount: -300000n },
        { accountId: at10('4000').id, amount: -500000n },   // earned before conversion
      ],
    })
    await postEntry({
      ledgerId: tenth.ledger.id, entryDate: '2026-04-10', description: 'Consulting, April',
      actor: 'alicio@example.test',
      lines: [{ accountId: at10('1000').id, amount: 120000n },
              { accountId: at10('4000').id, amount: -120000n }],
    })

    const periodOn = async (d: string) => {
      const [row] = await db.execute<{ id: string; name: string }>(raw`
        SELECT fp.id::text, fp.name FROM fiscal_period fp
          JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
         WHERE fy.ledger_id = ${tenth.ledger.id}::uuid AND ${d}::date BETWEEN fp.start_date AND fp.end_date`)
      return row
    }
    // Both numbers, because they are not the same number. `accounts[].amount` is
    // the signed value the arithmetic uses; `shown` is that value with the
    // line's `sign_flip` applied, and `P_REV` is seeded with sign_flip = true.
    // A check reading only the first proves the revenue is IN the period; it
    // proves nothing about the figure a person reads off the statement, which
    // is what `08` section 5 describes. So read both.
    const revenueIn = async (d: string) => {
      const st = await renderStatement(tenth.ledger.id, 'IFRS_PL_NATURE_EN', (await periodOn(d)).id)
      const line = st?.lines.find((l) => l.accounts?.some((a) => a.code === '4000'))
      return {
        value: line?.accounts?.find((a) => a.code === '4000')?.amount ?? 0n,
        shown: line?.shown ?? 0n,
        flipped: line?.signFlip ?? false,
      }
    }

    const march = await revenueIn('2026-03-15')
    // `flipped` is implied by the other two conjuncts — with value -500000 and
    // shown +500000 the flip has to be on, and no mutation can fail this term
    // while passing those. It is here to name the mechanism `08` section 5
    // describes, not as an independent guard, and should not be read as one.
    check(march.value === -500000n && march.flipped && march.shown === 500000n,
      'O34 the conversion period P&L reports the carried-in revenue as its own',
      `March: value ${march.value}, printed ${march.shown} — pinned, not endorsed; see 08 section 7`)

    // The pair. If the figure above were an artefact of the statement reading
    // every entry ever, April would show it too. It does not: April shows what
    // April earned, so the March figure really is the conversion landing in one
    // period rather than a statement that cannot tell periods apart.
    const april = await revenueIn('2026-04-15')
    check(april.value === -120000n && april.shown === 120000n,
      'O35 while the next period reports only what that period earned',
      `April: value ${april.value}, printed ${april.shown}`)
  }

  await cleanup('nothing to undo', async () => {})
}

main()

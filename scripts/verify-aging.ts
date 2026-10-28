/**
 * Aging: read from the ledger, kept nowhere.
 *   npm run db:verify-aging   (resets the database first)
 *
 * The claims this suite exists to make earned:
 *
 *   the buckets add up to the control account balance, exactly
 *   nothing is cached, so there is nothing to delete and recompute
 *   a payment that arrives later lands in a later bucket, as a negative
 *   money owed by nobody is named rather than absorbed
 *
 * The PRD's acceptance test for P3 item 3 is the first of those. The last is
 * not in the PRD and is the one that would otherwise be invisible: aging joins
 * to `party`, so a control-account line with no party on it simply vanishes
 * from the report while the account balance goes on including it.
 */
import './env'
import { reporter } from './suite'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { postEntry } from '../src/lib/posting'
import { createInvoice, postInvoice, voidInvoice } from '../src/lib/invoices'
import { applyEntryToInvoice, recordPayment } from '../src/lib/payments'
import { BUCKETS, aging, ageOf, bucketOf } from '../src/lib/aging'

const CHART = `1000,Cash,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
2000,Accounts Payable,liability,,trade_payables
3000,Share Capital,equity,,share_capital
4000,Consulting Revenue,revenue,,revenue_from_contracts
5000,Subcontractors,expense,,other_operating_expenses`

const r = reporter(56)
const { check } = r

async function main() {
  const co = await createCompany({ code: 'AGE', name: 'Aging Ltd.' }, 'alicio@example.test')
  await createFiscalYear(co.ledger.id, '2026-12-31', 'alicio@example.test')
  const accounts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const at = (code: string) => accounts.find((a) => a.code === code)!

  const early = await createParty({
    kind: 'organisation', name: 'Early Bird Ltd.',
    roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }],
    actor: 'alicio@example.test',
  })
  const late = await createParty({
    kind: 'organisation', name: 'Late Payer Ltd.',
    roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }],
    actor: 'alicio@example.test',
  })
  const supplier = await createParty({
    kind: 'organisation', name: 'Ironbark Ltd.',
    roles: [{ entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
    actor: 'alicio@example.test',
  })

  const invoice = async (party: string, on: string, amount: bigint, number: string) => {
    const inv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: party,
      controlAccountId: at('1200').id, issuedOn: on, dueOn: on, number,
      lines: [{ accountId: at('4000').id, amount: -amount }], actor: 'alicio@example.test',
    })
    return postInvoice(inv.id, 'alicio@example.test')
  }

  // ------------------------------------------------------------ the shape --

  {
    // The bucket list is one list. The SQL builds its CASEs from it and the
    // screen renders its columns from it — two lists that drifted would put a
    // figure under a heading it does not belong to, and every total would still
    // add up.
    check(BUCKETS.length === 5 && BUCKETS[0].to === -1 && BUCKETS[4].to === null,
      'A01 the buckets are one list, oldest last, the last open-ended',
      BUCKETS.map((b) => b.label).join(' | '))

    // Every age falls in exactly one bucket, including the boundaries. Ranges
    // written by hand are off by one at a boundary more often than anywhere
    // else, and a figure landing in the wrong column is invisible in the total.
    const homeless: number[] = []
    const doubled: number[] = []
    for (let age = -400; age <= 400; age++) {
      const hits = BUCKETS.filter((b) => age >= b.from && (b.to === null || age <= b.to))
      if (hits.length === 0) homeless.push(age)
      if (hits.length > 1) doubled.push(age)
    }
    check(homeless.length === 0 && doubled.length === 0,
      'A02 and every age from -400 to 400 falls in exactly one of them',
      `${homeless.length} in none, ${doubled.length} in two`)

    check(ageOf('2026-03-01', '2026-03-31') === 30 && ageOf('2026-03-01', '2026-03-01') === 0
          && bucketOf(30) === 1 && bucketOf(31) === 2 && bucketOf(-1) === 0,
      'A03 with the boundaries where the labels say they are',
      `30 -> ${bucketOf(30)}, 31 -> ${bucketOf(31)}`)
  }

  // ------------------------------------------------------- the arithmetic --

  {
    await invoice(early.id, '2026-01-15', 100000n, 'INV-A')   // old
    await invoice(late.id, '2026-05-01', 200000n, 'INV-B')    // middling
    await invoice(late.id, '2026-06-20', 50000n, 'INV-C')     // recent

    const asOf = '2026-06-30'
    const ar = await aging(co.ledger.id, 'trade_receivables', asOf)

    // THE acceptance test from the PRD: the buckets add up to the control
    // account balance. Not approximately — exactly, because every line is in
    // one bucket and the balance is the same lines.
    //
    // The balance is read WITHOUT the party join and WITHOUT the bucket
    // filters, which is what makes the comparison worth making — those are the
    // two places this report can lose money. It is not read independently of
    // everything: both queries live in `aging()` and share the ledger, the
    // status list, the as-at cut and the account-role joins, so drift in any of
    // those moves both sides together. The pinned `350000n` beside the equality
    // is what catches that, and it is there on purpose.
    const summed = ar.totals.reduce((s, b) => s + b, 0n)
    check(summed === ar.controlBalance && ar.controlBalance === 350000n,
      'A04 the buckets add up to what the control account says, exactly',
      `${summed} vs ${ar.controlBalance}`)

    // And per party, which is the figure anybody actually reads.
    const lateRow = ar.rows.find((r) => r.party_id === late.id)
    check(lateRow?.total === 250000n && ar.rows.length === 2,
      'A05 and each party owes the sum of their own rows', `${lateRow?.total}`)

    // The ages land where they belong: 2026-01-15 is 166 days before 2026-06-30
    // (over 90), 2026-05-01 is 60 (31-60), 2026-06-20 is 10 (0-30).
    const earlyRow = ar.rows.find((r) => r.party_id === early.id)!
    check(earlyRow.buckets[4] === 100000n
          && lateRow!.buckets[2] === 200000n
          && lateRow!.buckets[1] === 50000n,
      'A06 each in the bucket its own date puts it in',
      `over90 ${earlyRow.buckets[4]}, 31-60 ${lateRow!.buckets[2]}, 0-30 ${lateRow!.buckets[1]}`)
  }

  // ---------------------------------------------------------- what it is not --

  {
    // A payment arriving later lands in a LATER bucket as a negative — it does
    // not reach back and clear the invoice it pays. That is what aging by
    // transaction date means, and it is the limitation `10-aging.md` states.
    await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-06-25', description: 'Paid INV-A at last',
      actor: 'alicio@example.test',
      lines: [
        { accountId: at('1000').id, amount: 100000n },
        { accountId: at('1200').id, amount: -100000n, partyId: early.id },
      ],
    })

    const ar = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')
    const earlyRow = ar.rows.find((r) => r.party_id === early.id)

    // They owe nothing, and the row is gone — the query drops parties whose
    // total is zero, because a list of people who owe nothing is not a list
    // anybody wants.
    check(earlyRow === undefined,
      'A07 a party who owes nothing drops off the report', `${ar.rows.length} rows left`)

    // But the total still balances, which is the point: the payment did not
    // vanish, it netted.
    const summed = ar.totals.reduce((s, b) => s + b, 0n)
    check(summed === ar.controlBalance && ar.controlBalance === 250000n,
      'A08 while the totals still agree with the control account', `${summed}`)

    // The honest limitation, asserted rather than only written down: the
    // payment sits in ITS OWN bucket and does not reach back to the invoice it
    // pays. It takes a third document to SEE that — with only the invoice and
    // the payment the row nets to zero and drops off, which is why the first
    // version of this check looked for a row that could not be there.
    await invoice(early.id, '2026-06-28', 15000n, 'INV-D')

    const withBoth = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')
    const stillThere = withBoth.rows.find((r) => r.party_id === early.id)
    check(stillThere !== undefined
          && stillThere.buckets[4] === 100000n
          && stillThere.buckets[1] === -100000n + 15000n
          && stillThere.total === 15000n,
      'A09 and a later payment sits in its own bucket, not the invoice\'s',
      `over90 ${stillThere?.buckets[4]}, 0-30 ${stillThere?.buckets[1]}, total ${stillThere?.total}`)

    // Read that row as a person would: it says they owe 150.00 and that
    // 1,000.00 of theirs is over ninety days old. The second half is FALSE —
    // that invoice was paid three days ago — but the payment was never
    // APPLIED, and the report shows what is recorded, not what is likely.
    // Since open-item aging landed this limitation is about unapplied money
    // only; A19-A22 below show application curing it. This check keeps the
    // unapplied reading pinned as a fact in the suite.
    check(stillThere!.buckets[4] === 100000n && stillThere!.total === 15000n,
      'A09b which reads as over-ninety money — the payment was never applied',
      'the unapplied limitation, asserted')
  }

  // ---------------------------------------- open items: application cures it --

  {
    // The successor to A09b's limitation: the SAME shape — an old invoice, a
    // much later payment — but this time the payment is APPLIED, and the
    // over-ninety figure disappears because the debt is actually gone.
    const applied = await createParty({
      kind: 'organisation', name: 'Applies Their Payments Ltd.',
      roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    const oldInv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: applied.id,
      controlAccountId: at('1200').id, issuedOn: '2026-01-10', dueOn: '2026-01-10',
      number: 'INV-OLD',
      lines: [{ accountId: at('4000').id, amount: -80000n }], actor: 'alicio@example.test',
    })
    await postInvoice(oldInv.id, 'alicio@example.test')
    await recordPayment({
      invoiceId: oldInv.id, bankAccountId: at('1000').id, amount: 80000n,
      paidOn: '2026-06-25', actor: 'alicio@example.test',
    })
    // A third document, so the party still has a row to inspect at all.
    const freshInv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: applied.id,
      controlAccountId: at('1200').id, issuedOn: '2026-06-28', dueOn: '2026-06-28',
      number: 'INV-FRESH',
      lines: [{ accountId: at('4000').id, amount: -20000n }], actor: 'alicio@example.test',
    })
    await postInvoice(freshInv.id, 'alicio@example.test')

    const cured = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')
    const row = cured.rows.find((r) => r.party_id === applied.id)
    check(row !== undefined && row.buckets[4] === 0n && row.buckets[1] === 20000n
          && row.total === 20000n,
      'A19 an applied payment takes the old invoice off the report entirely',
      `over90 ${row?.buckets[4]}, 0-30 ${row?.buckets[1]}, total ${row?.total}`)

    const sum19 = cured.totals.reduce((a, b) => a + b, 0n)
    check(sum19 === cured.controlBalance,
      'A19b while the totals still equal the control account, exactly',
      `${sum19} vs ${cured.controlBalance}`)

    // Partial application: the REMAINDER ages in the ORIGINAL bucket. A
    // thousand-dollar January invoice with 850 applied is 150 of January
    // money — not a January thousand and a June minus-850 a reader must net.
    const partInv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: applied.id,
      controlAccountId: at('1200').id, issuedOn: '2026-02-01', dueOn: '2026-02-01',
      number: 'INV-PART',
      lines: [{ accountId: at('4000').id, amount: -100000n }], actor: 'alicio@example.test',
    })
    await postInvoice(partInv.id, 'alicio@example.test')
    await recordPayment({
      invoiceId: partInv.id, bankAccountId: at('1000').id, amount: 85000n,
      paidOn: '2026-06-26', actor: 'alicio@example.test',
    })
    const part = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')
    const partRow = part.rows.find((r) => r.party_id === applied.id)
    // 2026-02-01 -> 2026-06-30 is 149 days: the Over 90 bucket.
    check(partRow !== undefined && partRow.buckets[4] === 15000n
          && partRow.buckets[1] === 20000n,
      'A20 a partial application leaves the remainder in the original bucket',
      partRow ? partRow.buckets.map(String).join(' | ') : 'no row')

    // As-at honesty: the same report AS AT a date before the payment's entry
    // shows the invoice whole — an application whose settling entry has not
    // happened yet, as far as that date knows, counts for nothing.
    const before = await aging(co.ledger.id, 'trade_receivables', '2026-06-20')
    const beforeRow = before.rows.find((r) => r.party_id === applied.id)
    check(beforeRow !== undefined
          && beforeRow.buckets.reduce((a, b) => a + b, 0n) === 180000n,
      'A21 while a report as at a date before the payment shows the debt whole',
      beforeRow ? beforeRow.buckets.map(String).join(' | ') : 'no row')
    const sumBefore = before.totals.reduce((a, b) => a + b, 0n)
    check(sumBefore === before.controlBalance,
      'A21b and that earlier report balances to ITS control balance too',
      `${sumBefore} vs ${before.controlBalance}`)
  }

  // -------------------------------------------------- the contra settlement --

  {
    // The case a review CONSTRUCTED against the first open-item derivation:
    // one entry netting a receivable against a payable for the same party,
    // applied to both documents. Both applications are legitimate — each is
    // opposite-signed on its own control account — but the first derivation
    // keyed consumption on (entry, party) alone, so the payable-side
    // application was subtracted from the RECEIVABLES report too, and the
    // receivables side showed the party owing 100,000 where the ledger said
    // 20,000. The fix scopes applications to the aged role and keys them by
    // control account; this fixture keeps both sides' equalities pinned.
    const both = await createParty({
      kind: 'organisation', name: 'Both Sides Trading Ltd.',
      roles: [
        { entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' },
        { entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' },
      ],
      actor: 'alicio@example.test',
    })
    const sale = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: both.id,
      controlAccountId: at('1200').id, issuedOn: '2026-06-01', dueOn: '2026-06-01',
      number: 'INV-CONTRA',
      lines: [{ accountId: at('4000').id, amount: -100000n }], actor: 'alicio@example.test',
    })
    await postInvoice(sale.id, 'alicio@example.test')
    const bill = await createInvoice({
      ledgerId: co.ledger.id, direction: 'purchase', partyId: both.id,
      controlAccountId: at('2000').id, issuedOn: '2026-06-02', dueOn: '2026-07-02',
      theirRef: 'CONTRA-1',
      lines: [{ accountId: at('5000').id, amount: 80000n }], actor: 'alicio@example.test',
    })
    await postInvoice(bill.id, 'alicio@example.test')

    // One netting entry: pay the bill by forgiving part of the receivable.
    const net = await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-06-15',
      description: 'Contra: bill settled against the receivable', actor: 'alicio@example.test',
      lines: [
        { accountId: at('1200').id, amount: -80000n, partyId: both.id },
        { accountId: at('2000').id, amount: 80000n, partyId: both.id },
      ],
    })
    await applyEntryToInvoice({ invoiceId: sale.id, entryId: net.entry.id, amount: 80000n, actor: 'alicio@example.test' })
    await applyEntryToInvoice({ invoiceId: bill.id, entryId: net.entry.id, amount: 80000n, actor: 'alicio@example.test' })

    const arSide = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')
    const apSide = await aging(co.ledger.id, 'trade_payables', '2026-06-30')
    const arSum = arSide.totals.reduce((a, b) => a + b, 0n)
    const apSum = apSide.totals.reduce((a, b) => a + b, 0n)
    const row = arSide.rows.find((r) => r.party_id === both.id)

    check(arSum === arSide.controlBalance && apSum === apSide.controlBalance,
      'A22 a contra settlement leaves both sides equal to their control accounts',
      `AR ${arSum} vs ${arSide.controlBalance}; AP ${apSum} vs ${apSide.controlBalance}`)
    check(row !== undefined && row.total === 20000n
          && !apSide.rows.some((r) => r.party_id === both.id),
      'A22b and the party owes the 20,000 the ledger says, on one side only',
      `AR total ${row?.total}, AP rows with party: ${apSide.rows.filter((r) => r.party_id === both.id).length}`)
  }

  // ------------------------------------------------- money owed by nobody --

  {
    // A control-account line with no party on it is invisible to a report that
    // JOINs to party — and the account balance goes on including it. That is a
    // silent difference between two numbers that are supposed to be the same.
    await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-06-28', description: 'A receivable from nobody',
      actor: 'alicio@example.test',
      lines: [
        { accountId: at('1200').id, amount: 7000n },
        { accountId: at('4000').id, amount: -7000n },
      ],
    })

    const ar = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')
    const summed = ar.totals.reduce((s, b) => s + b, 0n)
    check(ar.unattributed === 7000n,
      'A10 a receivable with no party on it is named, not absorbed', `${ar.unattributed}`)
    check(summed + ar.unattributed === ar.controlBalance,
      'A11 and the rows plus the unattributed come to the control balance',
      `${summed} + ${ar.unattributed} = ${ar.controlBalance}`)
  }

  // ------------------------------------------------------------ payables --

  {
    const bill = await createInvoice({
      ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
      controlAccountId: at('2000').id, issuedOn: '2026-04-01', dueOn: '2026-05-01',
      number: 'BILL-A', lines: [{ accountId: at('5000').id, amount: 80000n }], actor: 'alicio@example.test',
    })
    await postInvoice(bill.id, 'alicio@example.test')

    const ap = await aging(co.ledger.id, 'trade_payables', '2026-06-30')
    const row = ap.rows.find((r) => r.party_id === supplier.id)
    // A payable is a credit, so the figures are negative — the ledger's sign,
    // not an absolute value. A report that flipped it would read the same and
    // stop agreeing with the account.
    //
    // And it says AGE, so it asserts a bucket. BILL-A is dated 2026-04-01 and
    // this is asked as at 2026-06-30 — ninety days, which is `61–90`, the
    // fourth bucket. The older version of this check asserted the total and the
    // sign only, which a report that put every payable in one bucket would have
    // satisfied exactly.
    const apBuckets = row?.buckets ?? []
    check(row?.total === -80000n && ap.controlBalance === -80000n
          && apBuckets[3] === -80000n
          && apBuckets.filter((b, i) => i !== 3 && b !== 0n).length === 0,
      'A12 payables age the same way, keeping the ledger\'s sign',
      `${row?.total} in ${BUCKETS[apBuckets.findIndex((b) => b !== 0n)]?.label ?? 'no bucket'}`)

    const summed = ap.totals.reduce((s, b) => s + b, 0n)
    check(summed === ap.controlBalance,
      'A13 and they add up too', `${summed} vs ${ap.controlBalance}`)
  }

  // ---------------------------------------------------- voided and as-at --

  {
    // Voiding reverses the entry, so both the debit and its reversal are in the
    // window and net to nothing. `status IN ('posted','reversed')` is what makes
    // that true — counting only 'posted' would drop the original and leave the
    // reversal, and the report would show a NEGATIVE receivable.
    const doomed = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: late.id,
      controlAccountId: at('1200').id, issuedOn: '2026-06-01', dueOn: '2026-06-30',
      number: 'INV-VOID', lines: [{ accountId: at('4000').id, amount: -40000n }], actor: 'alicio@example.test',
    })
    await postInvoice(doomed.id, 'alicio@example.test')
    const beforeVoid = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')

    await voidInvoice(doomed.id, { reason: 'billed twice', reversedOn: '2026-06-02', actor: 'alicio@example.test' })
    const afterVoid = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')

    check(beforeVoid.controlBalance - afterVoid.controlBalance === 40000n,
      'A14 a voided invoice leaves nothing in the aging',
      `${beforeVoid.controlBalance} -> ${afterVoid.controlBalance}`)
    const summed = afterVoid.totals.reduce((s, b) => s + b, 0n)
    check(summed + afterVoid.unattributed === afterVoid.controlBalance,
      'A15 and it still adds up afterwards', `${summed}`)

    // As-at is a real cut, not decoration: asked before the invoice existed,
    // it is not there.
    const earlierView = await aging(co.ledger.id, 'trade_receivables', '2026-02-01')
    // 100,000 from the original fixtures + INV-OLD (80,000, 01-10) + INV-PART
    // (100,000, 02-01) from the open-item section above. Pinned so a fixture
    // added inside this window has to come here and say so — which is exactly
    // how this line last changed.
    check(earlierView.controlBalance === 280000n,
      'A16 asked as at an earlier date, only what had happened by then',
      `${earlierView.controlBalance}`)
  }

  // ------------------------------------------------------- what is absent --

  {
    // The design says nothing is cached. That is a claim about what does NOT
    // exist, so it is checked by looking across every table in the schema.
    //
    // It looks at NAMES, and the label says so. A review caught the older
    // wording — "nothing anywhere stores an age or a bucket" — claiming
    // something a name scan cannot establish: a cache called
    // `receivable_snapshot(days_old)` would sail through. It also caught the
    // scan being lopsided, with `bucket` and `overdue` applied to column names
    // and not to table names, so a table called `overdue_cache` was invisible.
    // Both halves now carry all six words.
    const CACHE_WORDS = ['aging', 'ageing', 'days_late', 'overdue', 'bucket', 'snapshot']
    const anyOf = (col: string) => raw.join(
      CACHE_WORDS.map((w) => raw`${raw.raw(col)} LIKE ${'%' + w + '%'}`), raw` OR `)
    const cached = await db.execute<{ name: string }>(raw`
      SELECT table_name || '.' || column_name AS name
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((${anyOf('table_name')}) OR (${anyOf('column_name')}))
         -- Explicit immutable document/register calculation provenance.
         AND (table_name || '.' || column_name) NOT IN
           ('invoice.print_template_snapshot', 'invoice.fx_snapshot', 'journal_line.fx_snapshot', 'project_invoice_handoff.source_snapshot',
            'recurring_template.snapshot', 'recurring_occurrence.template_snapshot',
            'email_message.snapshot', 'payment_event.snapshot',
            'asset_depreciation_entry.policy_snapshot', 'asset_cca_year.calculation_snapshot', 'asset_deferred_tax_review.calculation_snapshot',
            'operations_finance_setting.opening_snapshot', 'operations_journal_event.snapshot', 'production_payroll_allocation.snapshot',
            'production_labour_period.snapshot', 'production_labour_settlement.snapshot')
           -- Authentication attempt counters have no invoice/aging amounts.
           AND table_name <> 'auth_rate_bucket'`)
    check(cached.length === 0,
      'A17 no aging-cache names outside explicit document/register snapshots',
      cached.map((c) => c.name).join(', ') || 'no such table or column')

    // And the PRD's other half: deleting a cache and recomputing changes
    // nothing, which is true for the uninteresting reason that there is nothing
    // to delete. Asserted by computing it twice and comparing.
    const once = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')
    const twice = await aging(co.ledger.id, 'trade_receivables', '2026-06-30')
    check(JSON.stringify(once, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
          === JSON.stringify(twice, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
      'A18 and computing it twice gives the same answer', 'identical')
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main()

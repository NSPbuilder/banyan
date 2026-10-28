/**
 * Payments and applications: which money settles which invoice.
 *   npm run db:verify-payments   (resets the database first)
 *
 * The claims this suite exists to make earned:
 *
 *   a payment is a journal entry through the one door, not a document
 *   the balance of an invoice is derived, always, and stored nowhere
 *   neither side of an application can promise more than it holds
 *   a credit note applies through the same table as a receipt
 *   unapplying is a delete that moves no money
 *   reversing and amending treat applications the way they treat bank matches
 */
import './env'
import { errorText as chainText, expectSaying, reporter } from './suite'
import { byHand } from './by-hand'
import { readFileSync } from 'node:fs'
import { trailNamesPeople } from './actor-trail'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { amendEntry, postEntry, reverseEntry } from '../src/lib/posting'
import { createInvoice, postInvoice, voidInvoice } from '../src/lib/invoices'
import {
  applicationsOn, applyEntryToInvoice, balanceOf, documentsWithBalances,
  deletePayment, openItemsFor, owedAmount, owedSummary, recordPayment, unapply, unappliedReceipts,
} from '../src/lib/payments'
import { partyLedger } from '../src/lib/browse'
import { PAYMENT_FIELDS as PF } from '../src/lib/forms'
import { applyCreditFromForm, deletePaymentFromForm, payInvoiceFromForm, unapplyFromForm } from '../src/lib/payment-forms'

type PaymentsPanelFunction = typeof import('../src/app/ledger/[ledgerId]/invoices/[invoiceId]/PaymentsPanel')['PaymentsPanel']
let PaymentsPanel: PaymentsPanelFunction

const CHART = `1000,Cash,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
2000,Accounts Payable,liability,,trade_payables
3000,Share Capital,equity,,share_capital
4000,Consulting Revenue,revenue,,revenue_from_contracts
5000,Subcontractors,expense,,other_operating_expenses`

const r = reporter(60)
const { fail, check } = r

const errorText = (e: unknown) => chainText(e, ' <- ')

const expectError = expectSaying(r, errorText, 84)

async function main() {
  // This server-condition test renders the panel's JSX as data. Next Link's
  // browser runtime needs React.createContext, which the server condition omits.
  // Stub only that navigation component; the panel and its form tree stay real.
  const linkPath = require.resolve('next/link')
  require.cache[linkPath] = {
    id: linkPath, filename: linkPath, loaded: true, exports: () => null,
  } as NodeModule
  // ActionForm preserves Next navigation exceptions with unstable_rethrow.
  // This suite inspects JSX as data; actual navigation is covered in-browser.
  const navigationPath=require.resolve('next/navigation')
  require.cache[navigationPath]={id:navigationPath,filename:navigationPath,loaded:true,exports:{unstable_rethrow:()=>{}}} as NodeModule
  ;({ PaymentsPanel } = await import('../src/app/ledger/[ledgerId]/invoices/[invoiceId]/PaymentsPanel'))
  const co = await createCompany({ code: 'PAY', name: 'Payments Ltd.' }, 'alicio@example.test')
  await createFiscalYear(co.ledger.id, '2026-12-31', 'alicio@example.test')
  const accounts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const at = (code: string) => accounts.find((a) => a.code === code)!

  const customer = await createParty({
    kind: 'organisation', name: 'Prompt Payer Ltd.',
    roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }],
    actor: 'alicio@example.test',
  })
  const supplier = await createParty({
    kind: 'organisation', name: 'Slow Invoice Co.',
    roles: [{ entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
    actor: 'alicio@example.test',
  })

  const salesInvoice = async (number: string, amount: bigint, on = '2026-03-01') => {
    const inv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: on, dueOn: on, number,
      lines: [{ accountId: at('4000').id, amount: -amount }], actor: 'alicio@example.test',
    })
    await postInvoice(inv.id, 'alicio@example.test')
    return inv.id
  }

  // -------------------------------------------------- a receipt, end to end --
  let invA = ''
  let payAEntry = ''
  {
    invA = await salesInvoice('INV-101', 100000n)
    const before = await balanceOf(invA)

    const paid = await recordPayment({
      invoiceId: invA, bankAccountId: at('1000').id, amount: 40000n,
      paidOn: '2026-03-15', actor: 'alicio@example.test',
    })
    payAEntry = paid.entryId

    const [entry] = await db.execute<{ source_type: string; status: string; entry_no: string }>(raw`
      SELECT source_type, status, entry_no FROM journal_entry WHERE id = ${payAEntry}::uuid`)
    check(entry.source_type === 'payment' && entry.status === 'posted'
          && entry.entry_no.startsWith('PAY-'),
      'PM01 a receipt is a posted journal entry through the one door, numbered by it',
      `${entry.source_type} ${entry.status} ${entry.entry_no}`)

    const lines = await db.execute<{ account_id: string; amount: bigint; party_id: string | null }>(raw`
      SELECT account_id::text, amount, party_id::text FROM journal_line
       WHERE entry_id = ${payAEntry}::uuid ORDER BY amount`)
    check(lines.length === 2
          && lines.some((l) => l.account_id === at('1000').id && BigInt(l.amount) === 40000n && l.party_id === null)
          && lines.some((l) => l.account_id === at('1200').id && BigInt(l.amount) === -40000n && l.party_id === customer.id),
      'PM02 bank debited, receivables credited, the party on the control line only',
      lines.map((l) => `${BigInt(l.amount)}:${l.party_id ? 'party' : 'no party'}`).join(' '))

    const after = await balanceOf(invA)
    check(before.balance === 100000n && after.balance === 60000n && after.applied === 40000n,
      'PM03 the balance is derived and comes down by exactly the payment',
      `${before.balance} -> ${after.balance}`)
  }

  // ------------------------------------------------------ nothing is stored --
  {
    // The rule 03-parties.md §3 argues: a stored balance is a second answer
    // waiting to disagree. The application table itself must not smuggle one in.
    // ANYWHERE means anywhere: the first version filtered to two tables first,
    // which made its own cache-table disjunct dead and the label a lie a review
    // had to catch. P24 scans the balance/total/party shapes; this scans the
    // settled/paid/remaining shapes, so between them a cache has no name left.
    // FIFO receipt layers keep remaining physical quantity and receipt cost.
    // Only those exact two inventory columns are allowed; the schema-wide
    // invoice balance/cache discrimination remains in force everywhere else.
    const cols = await db.execute<{ table_name: string; column_name: string }>(raw`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name ~ '(outstanding|paid_|_paid|settled|remaining)'
         AND NOT (table_name='inventory_cost_layer'
           AND column_name IN ('remaining_quantity','remaining_cost'))
         -- Immutable pay-period capacity, not a cached payment/balance amount.
         AND NOT (table_name='production_labour_period' AND column_name='paid_hours')`)
    check(cols.length === 0,
      'PM04 no column anywhere stores what an invoice still owes',
      cols.map((c) => `${c.table_name}.${c.column_name}`).join(', ') || 'none, schema-wide')
  }

  // ------------------------------------------------------------- the limits --
  {
    await expectError('PM05 paying more than the balance is refused with the numbers',
      'more than', () => recordPayment({
        invoiceId: invA, bankAccountId: at('1000').id, amount: 60001n,
        paidOn: '2026-03-16', actor: 'alicio@example.test',
      }))

    // The same limit at the DATABASE, past the library: an application row
    // that overfills the invoice is refused by the deferred trigger even when
    // the entry has capacity to spare. A FRESH entry, because re-inserting the
    // pair that already exists trips UNIQUE before any trigger speaks — the
    // first version of this check did exactly that and was green for the wrong
    // refusal.
    const spare = await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-03-16',
      description: 'a large unapplied receipt', sourceType: 'payment', actor: 'alicio@example.test',
      lines: [
        { accountId: at('1200').id, amount: -70000n, partyId: customer.id },
        { accountId: at('1000').id, amount: 70000n },
      ],
    })
    await expectError('PM05b and the database refuses it even when the library is dodged',
      'APPLICATION_OVER_INVOICE', () => byHand((tx) => tx.execute(raw`
        INSERT INTO invoice_application (invoice_id, entry_id, amount, applied_by)
        VALUES (${invA}::uuid, ${spare.entry.id}::uuid, ${70000n}, 'alicio@example.test')`)))

    // A second invoice cannot draw on money the entry has already promised:
    // the 40,000 receipt is fully applied to INV-101.
    const invB = await salesInvoice('INV-102', 50000n)
    await expectError('PM06 an entry cannot settle more than it moved',
      'APPLICATION_OVER_ENTRY', () => applyEntryToInvoice({
        invoiceId: invB, entryId: payAEntry, amount: 1n, actor: 'alicio@example.test',
      }))

    // An entry that moves the control account the WRONG way — another
    // invoice's own entry — settles nothing, whatever its size.
    const [invAEntry] = await db.execute<{ entry_id: string }>(raw`
      SELECT entry_id::text FROM invoice WHERE id = ${invA}::uuid`)
    await expectError('PM07 an entry pointing the same way as the debt settles nothing',
      'APPLICATION_WRONG_WAY', () => applyEntryToInvoice({
        invoiceId: invB, entryId: invAEntry.entry_id, amount: 1000n, actor: 'alicio@example.test',
      }))

    // A draft is not yet a debt.
    const draft = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-03-01', dueOn: '2026-03-01',
      number: 'INV-DRAFT',
      lines: [{ accountId: at('4000').id, amount: -10000n }], actor: 'alicio@example.test',
    })
    await expectError('PM08 a draft invoice cannot take an application',
      'APPLICATION_INVOICE_NOT_POSTED', () => applyEntryToInvoice({
        invoiceId: draft.id, entryId: payAEntry, amount: 1n, actor: 'alicio@example.test',
      }))
  }

  // ------------------------------------------- a credit note, same doorway --
  {
    const cn = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', kind: 'credit_note',
      partyId: customer.id, controlAccountId: at('1200').id,
      issuedOn: '2026-03-20', dueOn: '2026-03-20', number: 'CN-101',
      lines: [{ accountId: at('4000').id, amount: 15000n }], actor: 'alicio@example.test',
    })
    await postInvoice(cn.id, 'alicio@example.test')
    const [cnRow] = await db.execute<{ entry_id: string }>(raw`
      SELECT entry_id::text FROM invoice WHERE id = ${cn.id}::uuid`)

    const before = await balanceOf(invA)
    await applyEntryToInvoice({
      invoiceId: invA, entryId: cnRow.entry_id, amount: 15000n, actor: 'alicio@example.test',
    })
    const after = await balanceOf(invA)
    const cnAfter = await balanceOf(cn.id)

    check(before.balance - after.balance === 15000n && cnAfter.applied === 15000n
          && cnAfter.balance === 0n,
      'PM09 a credit note settles an invoice through the same table',
      `invoice ${before.balance} -> ${after.balance}, note has ${cnAfter.balance} left`)

    await expectError('PM09b while paying a credit note is refused by name',
      'credit note', () => recordPayment({
        invoiceId: cn.id, bankAccountId: at('1000').id, amount: 1000n,
        paidOn: '2026-03-21', actor: 'alicio@example.test',
      }))
  }

  // ---------------------------------- what an unspent credit note is worth --
  // `balance` is a size on both kinds of document; the party page adds them
  // into "They owe us" and "We owe them", where a credit note counts the other
  // way. Its own company, so no count elsewhere in this suite moves.
  {
    const owe = await createCompany({ code: 'OWE', name: 'Owed Both Ways Ltd.' }, 'alicio@example.test')
    await createFiscalYear(owe.ledger.id, '2026-12-31', 'alicio@example.test')
    const chart = await importAccounts(owe.company.id,
      parseAccountsCsv(CHART).map((row) => ({ ...row, entityId: owe.company.id })), 'alicio@example.test')
    const acct = (code: string) => chart.find((a) => a.code === code)!
    const both = await createParty({
      kind: 'organisation', name: 'Both Sides Ltd.',
      roles: [{ entityId: owe.company.id, role: 'customer', heldFrom: '2026-01-01' },
              { entityId: owe.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    const doc = async (direction: 'sales' | 'purchase', kind: 'invoice' | 'credit_note', number: string, amount: bigint) => {
      const d = await createInvoice({
        ledgerId: owe.ledger.id, direction, kind, partyId: both.id,
        controlAccountId: acct(direction === 'sales' ? '1200' : '2000').id,
        issuedOn: '2026-04-01', dueOn: '2026-04-30', number,
        lines: [{ accountId: acct(direction === 'sales' ? '4000' : '5000').id, amount }], actor: 'alicio@example.test',
      })
      await postInvoice(d.id, 'alicio@example.test')
    }
    await doc('sales', 'invoice', 'INV-OWE', -100000n)
    await doc('sales', 'credit_note', 'CN-OWE', 15000n)
    await doc('purchase', 'invoice', 'BILL-OWE', 40000n)
    await doc('purchase', 'credit_note', 'DN-OWE', -5000n)

    const open = (await openItemsFor(owe.ledger.id)).filter((i) => i.party_id === both.id)
    const side = (d: string) => open.filter((i) => i.direction === d)
    const sizes = (d: string) => side(d).reduce((t, i) => t + i.balance, 0n)
    const owed = (d: string) => side(d).reduce((t, i) => t + owedAmount(i), 0n)
    check(open.length === 4 && sizes('sales') === 115000n && sizes('purchase') === 45000n
          && owed('sales') === 85000n && owed('purchase') === 35000n,
      'PM48 an unspent credit note reduces what is owed on either side, where adding balances counted it as more',
      `sales: sizes ${sizes('sales')}, owed ${owed('sales')}; purchase: sizes ${sizes('purchase')}, owed ${owed('purchase')}; ${open.length} open`)

    const page = readFileSync('src/app/ledger/[ledgerId]/parties/[partyId]/PartyBody.tsx', 'utf8')
    const throughOwed = (page.match(/\.reduce\(\(t, i\) => t \+ owedAmount\(i\), 0n\)/g) ?? []).length
    const rawSums = (page.match(/t \+ i\.balance/g) ?? []).length
    check(throughOwed === 2 && rawSums === 0 && page.includes('{formatMoney(owedAmount(i))}'),
      'PM48b the party page totals and prints each document through owedAmount, so each direction\'s rows add up to its total',
      `sums through owedAmount ${throughOwed}; raw balance sums ${rawSums}; rows printed through it ${page.includes('{formatMoney(owedAmount(i))}')}`)

    // The income and expense pages read the same size through `partyLedger`,
    // and their Unpaid subtotal adds it per party.
    const unpaidOn = async (direction: 'in' | 'out') => (await partyLedger(owe.ledger.id, direction, '2026-04-01', '2026-04-30'))
      .filter((row) => row.party_id === both.id).reduce((t, row) => t + BigInt(row.unpaid ?? 0), 0n)
    const incomeUnpaid = await unpaidOn('in')
    const expenseUnpaid = await unpaidOn('out')
    check(incomeUnpaid === 85000n && expenseUnpaid === 35000n,
      'PM48c the income and expense pages\' Unpaid subtotal for one party nets its unspent credit note',
      `income page ${incomeUnpaid}; expense page ${expenseUnpaid}`)

    const credit = owedSummary('sales', -15000n)
    const debt = owedSummary('purchase', 35000n)
    const theirs = owedSummary('purchase', -5000n)
    check(credit.label === 'They have credit with us' && credit.amount === 15000n
          && debt.label === 'We owe them' && debt.amount === 35000n
          && theirs.label === 'We have credit with them' && theirs.amount === 5000n
          && page.includes('owedSummary(side, t)'),
      'PM48d a party whose credit notes outweigh its documents reads as credit held, not as a negative debt',
      `${credit.label} ${credit.amount}; ${debt.label} ${debt.amount}; ${theirs.label} ${theirs.amount}; page words it through owedSummary ${page.includes('owedSummary(side, t)')}`)
  }

  // ------------------------------------- one value, two ways to spend it --
  {
    // The defect a review CONSTRUCTED against 0034: a credit note paid down as
    // a target and spent as a source, each side under its own cap, the two
    // together at twice its value. 0036 makes the trigger enforce the balance
    // derivation's own identity, on both documents of every application.
    const cn2 = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', kind: 'credit_note',
      partyId: customer.id, controlAccountId: at('1200').id,
      issuedOn: '2026-05-01', dueOn: '2026-05-01', number: 'CN-201',
      lines: [{ accountId: at('4000').id, amount: 12000n }], actor: 'alicio@example.test',
    })
    await postInvoice(cn2.id, 'alicio@example.test')
    const [cn2Row] = await db.execute<{ entry_id: string }>(raw`
      SELECT entry_id::text FROM invoice WHERE id = ${cn2.id}::uuid`)

    // Spend it: the note's entry settles an invoice, in full.
    const invE = await salesInvoice('INV-105', 12000n, '2026-05-02')
    await applyEntryToInvoice({
      invoiceId: invE, entryId: cn2Row.entry_id, amount: 12000n, actor: 'alicio@example.test',
    })

    // Now try to ALSO pay it down as a target: a refund entry moves AR the
    // settling way for a credit note. Before 0036 this committed and the note's
    // balance went to −12,000.
    const refund = await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-05-03',
      description: 'refund paid to the customer', sourceType: 'payment', actor: 'alicio@example.test',
      lines: [
        { accountId: at('1200').id, amount: 12000n, partyId: customer.id },
        { accountId: at('1000').id, amount: -12000n },
      ],
    })
    await expectError('PM21 a note spent as a source cannot also be paid as a target',
      'APPLICATION_OVER', () => applyEntryToInvoice({
        invoiceId: cn2.id, entryId: refund.entry.id, amount: 12000n, actor: 'alicio@example.test',
      }))

    const cn2After = await balanceOf(cn2.id)
    check(cn2After.balance === 0n,
      'PM21b and the note ends spent exactly once, not twice', `${cn2After.balance}`)

    // Capacity is NET movement. An entry that puts +N and −N on the same party
    // has moved nothing; its gross negative leg is not settle capacity.
    const wash = await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-05-04',
      description: 'a wash on the control account', sourceType: 'manual', actor: 'alicio@example.test',
      lines: [
        { accountId: at('1200').id, amount: 5000n, partyId: customer.id },
        { accountId: at('1200').id, amount: -5000n, partyId: customer.id },
      ],
    })
    const invF = await salesInvoice('INV-106', 5000n, '2026-05-05')
    await expectError('PM22 an entry that nets to nothing settles nothing',
      'APPLICATION_WRONG_WAY', () => applyEntryToInvoice({
        invoiceId: invF, entryId: wash.entry.id, amount: 5000n, actor: 'alicio@example.test',
      }))
  }

  // ---------------------------------------------------------- undo is delete --
  {
    const before = await balanceOf(invA)
    const apps = await applicationsOn(invA)
    const cnApp = apps.find((a) => BigInt(a.amount) === 15000n)!
    const [{ n: entriesBefore }] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry`)

    await unapply(cnApp.id)

    const after = await balanceOf(invA)
    const [{ n: entriesAfter }] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry`)
    check(after.balance - before.balance === 15000n && entriesBefore === entriesAfter,
      'PM10 unapplying restores the balance and moves no money',
      `${before.balance} -> ${after.balance}, entries ${entriesBefore} -> ${entriesAfter}`)

    const audit = await db.execute<{ action: string }>(raw`
      SELECT action FROM audit_log
       WHERE table_name = 'invoice_application' AND record_id = ${cnApp.id}
       ORDER BY occurred_at`)
    check(audit.map((a) => a.action).join(',') === 'apply_to_invoice,unapply_from_invoice',
      'PM10b and both halves left their audit rows',
      audit.map((a) => a.action).join(','))
  }

  // ------------------------------------------------------- void needs clean --
  {
    await expectError('PM11 an invoice with applications cannot be voided',
      'APPLIED_CANNOT_VOID', () => voidInvoice(invA, { reason: 'trying anyway', actor: 'alicio@example.test' }))

    // Its pair: unapply first and the same void goes through — on a THROWAWAY
    // invoice, so the rest of the suite keeps its fixture.
    const invC = await salesInvoice('INV-103', 20000n)
    const paidC = await recordPayment({
      invoiceId: invC, bankAccountId: at('1000').id, amount: 20000n,
      paidOn: '2026-03-22', actor: 'alicio@example.test',
    })
    const appsC = await applicationsOn(invC)
    await unapply(appsC[0].id)
    await reverseEntry(paidC.entryId, '2026-03-23', 'paid the wrong invoice', 'alicio@example.test')
    await voidInvoice(invC, { reason: 'cancelled by agreement', actor: 'alicio@example.test' })
    const [vc] = await db.execute<{ status: string }>(raw`
      SELECT status FROM invoice WHERE id = ${invC}::uuid`)
    check(vc.status === 'void',
      'PM11b while an unapplied one voids the ordinary way', vc.status)
  }

  // --------------------------------------------- reversal refuses, amend carries --
  {
    const invD = await salesInvoice('INV-104', 30000n)
    const paidD = await recordPayment({
      invoiceId: invD, bankAccountId: at('1000').id, amount: 30000n,
      paidOn: '2026-04-01', actor: 'alicio@example.test',
    })

    await expectError('PM12 a reversed entry cannot still be paying invoices',
      'REVERSED_STILL_APPLIED', () =>
        reverseEntry(paidD.entryId, '2026-04-02', 'fat finger', 'alicio@example.test'))

    // Amend the payment (right money, wrong date) — the application must ride
    // to the replacement, the way a bank match does, and the balance must not
    // flicker.
    const before = await balanceOf(invD)
    const amended = await amendEntry(paidD.entryId, {
      entryDate: '2026-04-03', description: 'Payment received — INV-104, dated right',
      actor: 'alicio@example.test',
      lines: [
        { accountId: at('1200').id, amount: -30000n, partyId: customer.id },
        { accountId: at('1000').id, amount: 30000n },
      ],
    })
    const after = await balanceOf(invD)
    const apps = await applicationsOn(invD)
    check(before.balance === 0n && after.balance === 0n
          && apps.length === 1 && apps[0].entry_id === amended.replacement.id,
      'PM13 amending a payment carries its application to the replacement',
      `balance ${before.balance} -> ${after.balance}, now on ${apps[0]?.entry_no}`)

    // And an amendment that walks away from the debt — no line on the control
    // account — cannot carry the application, so the whole amendment fails.
    await expectError('PM14 an amendment that abandons the debt is refused whole',
      'APPLICATION_WRONG_WAY', () => amendEntry(amended.replacement.id, {
        entryDate: '2026-04-04', description: 'suddenly about something else',
        actor: 'alicio@example.test',
        lines: [
          { accountId: at('5000').id, amount: 30000n },
          { accountId: at('1000').id, amount: -30000n },
        ],
      }))
  }

  // -------------------------------------------------------- rows do not edit --
  {
    const apps = await applicationsOn(invA)
    await expectError('PM15 an application cannot be edited, only unapplied',
      'APPLICATION_IMMUTABLE', () => byHand((tx) => tx.execute(raw`
        UPDATE invoice_application SET amount = ${1n} WHERE id = ${apps[0].id}::uuid`)))
  }

  // ------------------------------------------------------ the purchase side --
  {
    const bill = await createInvoice({
      ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
      controlAccountId: at('2000').id, issuedOn: '2026-04-10', dueOn: '2026-05-10',
      theirRef: 'SI-778',
      lines: [{ accountId: at('5000').id, amount: 25000n }], actor: 'alicio@example.test',
    })
    await postInvoice(bill.id, 'alicio@example.test')

    const paid = await recordPayment({
      invoiceId: bill.id, bankAccountId: at('1000').id, amount: 25000n,
      paidOn: '2026-04-20', actor: 'alicio@example.test',
    })
    const lines = await db.execute<{ account_id: string; amount: bigint; party_id: string | null }>(raw`
      SELECT account_id::text, amount, party_id::text FROM journal_line
       WHERE entry_id = ${paid.entryId}::uuid ORDER BY amount`)
    const after = await balanceOf(bill.id)
    check(after.balance === 0n
          && lines.some((l) => l.account_id === at('2000').id && BigInt(l.amount) === 25000n && l.party_id === supplier.id)
          && lines.some((l) => l.account_id === at('1000').id && BigInt(l.amount) === -25000n && l.party_id === null),
      'PM16 the purchase side mirrors: payables debited, bank credited',
      `balance ${after.balance}`)
  }

  // ------------------------------------------------------------- open items --
  {
    const open = await openItemsFor(co.ledger.id)
    const all = await documentsWithBalances(co.ledger.id)
    const openNumbers = open.map((i) => i.number).sort().join(',')
    check(!open.some((i) => i.balance === 0n)
          && all.some((i) => i.balance === 0n)
          && open.every((i) => all.some((a) => a.invoice_id === i.invoice_id)),
      'PM17 open items are the documents still carrying a balance',
      `open: ${openNumbers}`)
  }

  // ------------------------------------------- the panel, called as a function --
  // Local copy of verify-invoices' walker, because importing from that script
  // would run its whole suite at import time — its main() fires at top level.
  type ElementProps = Record<string, unknown> & { children?: unknown }
  type RenderedElement = { type: unknown; props: ElementProps }

  function* elements(node: unknown): Generator<RenderedElement> {
    if (node == null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const n of node) yield* elements(n); return }
    const el = node as { type?: unknown; props?: ElementProps }
    if (!el.props) return
    yield el as RenderedElement
    yield* elements(el.props.children)
  }
  const hidden = (tree: unknown, name: string) =>
    [...elements(tree)].find((e) => e.props.type === 'hidden' && e.props.name === name)
  // PM46 — a receipt recorded against no invoice is OFFERED to an invoice.
  //        `applyEntryToInvoice` took any entry since 0034; an invoice's page
  //        offered only new money, so a customer's deposit or an over-payment
  //        sat unapplied for ever. The read lists the party's payment entries
  //        that belong to no invoice, move the receivable the settling way,
  //        and have more on them than their applications; a fully applied one
  //        and a refund (moving the other way) are not offered.
  {
    const depositor = await createParty({ kind: 'organisation', name: 'Deposits Ltd.',
      roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }], actor: 'alicio@example.test' })
    const inv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: depositor.id, controlAccountId: at('1200').id,
      issuedOn: '2026-04-01', dueOn: '2026-05-01', number: 'INV-DEP',
      lines: [{ accountId: at('4000').id, amount: -50000n }], actor: 'alicio@example.test',
    })
    await postInvoice(inv.id, 'alicio@example.test')
    const deposit = await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-03-20', description: 'Deposit received on account',
      sourceType: 'payment', actor: 'alicio@example.test',
      lines: [
        { accountId: at('1200').id, amount: -70000n, partyId: depositor.id },
        { accountId: at('1000').id, amount: 70000n },
      ],
    })
    const refund = await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-03-21', description: 'Refund paid back',
      sourceType: 'payment', actor: 'alicio@example.test',
      lines: [
        { accountId: at('1200').id, amount: 5000n, partyId: depositor.id },
        { accountId: at('1000').id, amount: -5000n },
      ],
    })
    const paidInFull = await recordPayment({
      invoiceId: inv.id, bankAccountId: at('1000').id, amount: 10000n, paidOn: '2026-04-02', actor: 'alicio@example.test',
    })
    // One receipt split across two customers (600 + 400): each is offered its
    // own share, and what the OTHER customer's invoice has drawn on the entry
    // does not come off it — the trigger caps applications per party (0036),
    // and the first version subtracted every application the entry had made
    // (critic, 2026-09-13).
    const neighbour = await createParty({ kind: 'organisation', name: 'Next Door Inc.',
      roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }], actor: 'alicio@example.test' })
    const neighbourInv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: neighbour.id, controlAccountId: at('1200').id,
      issuedOn: '2026-04-01', dueOn: '2026-05-01', number: 'INV-NXT',
      lines: [{ accountId: at('4000').id, amount: -40000n }], actor: 'alicio@example.test',
    })
    await postInvoice(neighbourInv.id, 'alicio@example.test')
    const shared = await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-03-22', description: 'One cheque for two customers',
      sourceType: 'payment', actor: 'alicio@example.test',
      lines: [
        { accountId: at('1200').id, amount: -60000n, partyId: depositor.id },
        { accountId: at('1200').id, amount: -40000n, partyId: neighbour.id },
        { accountId: at('1000').id, amount: 100000n },
      ],
    })
    await applyEntryToInvoice({ invoiceId: neighbourInv.id, entryId: shared.entry.id, amount: 40000n, actor: 'alicio@example.test' })
    const before = await unappliedReceipts(co.ledger.id, depositor.id, 'sales')
    await applyEntryToInvoice({ invoiceId: inv.id, entryId: deposit.entry.id, amount: 30000n, actor: 'alicio@example.test' })
    const after = await unappliedReceipts(co.ledger.id, depositor.id, 'sales')
    const dep = (rs: typeof before) => rs.find((r) => r.entry_id === deposit.entry.id)
    const share = (rs: typeof before) => rs.find((r) => r.entry_id === shared.entry.id)
    check(before.length === 2 && dep(before)?.unapplied === 70000n && dep(before)?.amount === 70000n
      && share(before)?.amount === 60000n && share(before)?.unapplied === 60000n
      && after.length === 2 && dep(after)?.unapplied === 40000n
      && !before.some((r) => r.entry_id === refund.entry.id) && !before.some((r) => r.entry_id === paidInFull.entryId),
      'PM46 a receipt on account is offered to the invoice with what is still unapplied — its own share of a shared one — and a refund or a spent receipt is not',
      `before: ${before.length} offered, deposit ${dep(before)?.unapplied ?? 'absent'} of ${dep(before)?.amount ?? '—'} unapplied, `
        + `the shared cheque ${share(before)?.unapplied ?? 'absent'} of ${share(before)?.amount ?? '—'} (the neighbour's 400.00 already spent); `
        + `after applying 300.00: ${dep(after)?.unapplied ?? 'absent'}; refund offered ${before.some((r) => r.entry_id === refund.entry.id)}, `
        + `spent receipt offered ${before.some((r) => r.entry_id === paidInFull.entryId)}`)
  }

  {
    const noop = async () => ({})
    const panelActions = { pay: noop, apply: noop, unapply: noop, deletePayment: noop }

    const invoicePanel = PaymentsPanel({
      ledgerId: 'L1', invoiceId: 'INV-ID', kind: 'invoice',
      balance: 60000n, applied: 40000n, debt: 100000n, today: '2026-08-31',
      applications: [{ id: 'APP-1', entry_id: 'ENTRY-1', source_type: 'payment', entry_no: 'JE-1', entry_date: '2026-03-15',
        description: 'Payment received', amount: 40000n }],
      bankAccounts: [{ id: 'BANK-1', label: '1000 — Cash' }],
      openInvoices: [], entryId: null, actions: panelActions,
    })
    check(hidden(invoicePanel, PF.invoiceId)?.props.value === 'INV-ID'
          && hidden(invoicePanel, PF.applicationId)?.props.value === 'APP-1',
      'PM18 the pay form names this invoice and the unapply form its application',
      `${hidden(invoicePanel, PF.invoiceId)?.props.value} / ${hidden(invoicePanel, PF.applicationId)?.props.value}`)

    const shown = [...elements(invoicePanel)]
      .find((e) => e.props['data-balance-due'] !== undefined)
    check(shown?.props['data-balance-due'] === '60000',
      'PM19 and the balance it shows is the balance it was given',
      String(shown?.props['data-balance-due']))

    const notePanel = PaymentsPanel({
      ledgerId: 'L1', invoiceId: 'CN-ID', kind: 'credit_note',
      balance: 15000n, applied: 0n, debt: 15000n, today: '2026-08-31',
      applications: [], bankAccounts: [],
      openInvoices: [{ id: 'INV-ID', label: 'INV-101 — 600.00 open' }],
      entryId: 'CN-ENTRY', actions: panelActions,
    })
    // The field the first draft of this form did not have: a comment said the
    // entry does the settling, and nothing carried it. The form would have
    // POSTed an application with no entry in it.
    check(hidden(notePanel, PF.entryId)?.props.value === 'CN-ENTRY'
          && hidden(notePanel, PF.invoiceId) === undefined,
      "PM20 the apply form carries the note's own entry, the target comes from the select",
      String(hidden(notePanel, PF.entryId)?.props.value))

    // PM47 — and the INVOICE side offers the party's credit notes and
    //        unapplied receipts, by entry, to be applied without new money.
    //        The page hands the panel `credits`; the panel is rendered here
    //        with one, and the page is read from source for the hand-off a
    //        render of the panel alone cannot show.
    const withCredits = PaymentsPanel({
      ledgerId: 'L1', invoiceId: 'INV-ID', kind: 'invoice',
      balance: 60000n, applied: 40000n, debt: 100000n, today: '2026-08-31',
      applications: [], bankAccounts: [{ id: 'BANK-1', label: '1000 — Cash' }],
      openInvoices: [], credits: [{ id: 'RCPT-ENTRY', label: 'Receipt JE-9 2026-03-20 — 700.00 unapplied' }],
      entryId: null, actions: panelActions,
    })
    // A PICKER named for the entry — the unapply forms carry the entry as a hidden field.
    const pickerIn = (node: unknown) => [...elements(node)].find((e) => e.props.name === PF.entryId && e.props.options !== undefined)
    const picker = pickerIn(withCredits)
    const options = (picker?.props.options ?? []) as Array<{ id: string; label: string }>
    const detailSource = readFileSync('src/app/ledger/[ledgerId]/invoices/[invoiceId]/DetailBody.tsx', 'utf8')
    check(picker !== undefined && options.some((o) => o.id === 'RCPT-ENTRY' && o.label.includes('700.00 unapplied'))
      && pickerIn(invoicePanel) === undefined
      && detailSource.includes('unappliedReceipts(') && detailSource.includes('credits={paymentsData.credits}'),
      'PM47 an invoice offers the party\'s credit notes and unapplied receipts, by entry; none when there are none',
      `picker ${picker ? 'present' : 'absent'} with ${options.length} option(s); without credits ${pickerIn(invoicePanel) ? 'a picker still shows' : 'no picker'}; `
        + `the page reads unappliedReceipts ${detailSource.includes('unappliedReceipts(')} and hands credits over ${detailSource.includes('credits={paymentsData.credits}')}`)
  }

  // ------------------------------------------------------------ open books --
  // PM40+: deleting a payment takes its applications with it — the owner's
  // cascade rule. The debt it settled is owed again; the audit log keeps the
  // lines; a non-payment entry is turned away by name.
  {
    const inv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-05-02', dueOn: '2026-05-22',
      number: 'INV-PMOB', lines: [{ accountId: at('4000').id, amount: -40000n }],
      actor: 'alicio@example.test',
    })
    await postInvoice(inv.id, 'alicio@example.test')
    const paid = await recordPayment({
      invoiceId: inv.id, bankAccountId: at('1000').id, amount: 40000n,
      paidOn: '2026-05-10', actor: 'alicio@example.test',
    })
    const settled = await balanceOf(inv.id)

    let del: Awaited<ReturnType<typeof deletePayment>> | null = null
    try { del = await deletePayment(paid.entryId, 'alicio@example.test') }
    catch (e) { fail('PM40 deleting a payment releases what it settled', `it threw: ${(e as Error).message.slice(0, 70)}`) }
    const owedAgain = await balanceOf(inv.id)
    const [entryGone] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry WHERE id = ${paid.entryId}::uuid`)
    if (del) {
      check(settled.balance === 0n && del.releasedApplications === 1
            && owedAgain.balance === 40000n && entryGone.n === '0'
            && del.entryNo?.startsWith('PAY-') === true,
        'PM40 deleting a payment releases what it settled',
        `${del.entryNo} gone; 400.00 owed again; ${del.releasedApplications} application released`)
    }
    const drift = await db.execute(raw`SELECT * FROM check_balance_integrity(${co.ledger.id}::uuid)`)
    check(drift.length === 0, 'PM40b and the cache moved with it', `${drift.length} disagreements`)

    // PM41 — only payments come through this door.
    const [invEntry] = await db.execute<{ id: string }>(raw`
      SELECT entry_id::text AS id FROM invoice WHERE id = ${inv.id}::uuid`)
    await expectError('PM41 a non-payment entry is turned away by name', 'is not a payment', () =>
      deletePayment(invEntry.id, 'alicio@example.test'))

    // PM42 — the owner's cascade at the ENTRY door: a manual on-account
    //        entry applied to an invoice is deleted in one action; the
    //        application is released, counted, and the debt is owed again.
    const inv2 = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-05-03', dueOn: '2026-05-23',
      number: 'INV-PMOB2', lines: [{ accountId: at('4000').id, amount: -20000n }],
      actor: 'alicio@example.test',
    })
    await postInvoice(inv2.id, 'alicio@example.test')
    const onAccount = await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-05-12', description: 'On account, by hand',
      actor: 'alicio@example.test',
      lines: [
        { accountId: at('1000').id, amount: 20000n },
        { accountId: at('1200').id, amount: -20000n, partyId: customer.id },
      ],
    })
    await applyEntryToInvoice({
      invoiceId: inv2.id, entryId: onAccount.entry.id, amount: 20000n, actor: 'alicio@example.test',
    })
    const settled2 = await balanceOf(inv2.id)
    const { deleteEntry } = await import('../src/lib/posting')
    let goneManual: Awaited<ReturnType<typeof deleteEntry>> | null = null
    try { goneManual = await deleteEntry(onAccount.entry.id, 'alicio@example.test') }
    catch (e) { fail('PM42 deleting an applied manual entry releases the application', `it threw: ${(e as Error).message.slice(0, 70)}`) }
    const owed2 = await balanceOf(inv2.id)
    if (goneManual) {
      check(settled2.balance === 0n && goneManual.releasedApplications === 1
            && owed2.balance === 20000n,
        'PM42 deleting an applied manual entry releases the application',
        `${goneManual.entryNo} gone; ${goneManual.releasedApplications} released; 200.00 owed again`)
    }

    await import('../src/lib/invoices').then((m) => m.deleteInvoice(inv.id, 'alicio@example.test'))
    await import('../src/lib/invoices').then((m) => m.deleteInvoice(inv2.id, 'alicio@example.test'))
  }

  // PM44 — THE ID BESIDE THE LEDGER, at the four payment doors: pay, apply,
  //        unapply, delete. Each read its ids out of the form and judged only
  //        the ledger; each now asks `ours()` first (audit, 2026-09-13).
  {
    const theirs = await createCompany({ code: 'THEIRS', name: 'Somebody Else Ltd.' }, 'alicio@example.test')
    await createFiscalYear(theirs.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirAccts = await importAccounts(theirs.company.id,
      parseAccountsCsv('code,name,type,parent,roles\n1000,Their cash,asset,,cash_and_cash_equivalents\n1200,Their receivables,asset,,trade_receivables\n4000,Their revenue,revenue,,revenue_from_contracts')
        .map((r) => ({ ...r, entityId: theirs.company.id })), 'alicio@example.test')
    const tid = Object.fromEntries(theirAccts.map((a) => [a.code, a.id]))
    const theirCustomer = await createParty({
      kind: 'organisation', name: 'Their Customer Ltd.',
      roles: [{ entityId: theirs.company.id, role: 'customer', heldFrom: '2026-01-01' }], actor: 'alicio@example.test',
    })
    const theirInv = await createInvoice({
      ledgerId: theirs.ledger.id, direction: 'sales', partyId: theirCustomer.id,
      controlAccountId: tid['1200']!, issuedOn: '2026-03-05', dueOn: '2026-04-05',
      lines: [{ accountId: tid['4000']!, amount: -30000n }], actor: 'alicio@example.test',
    })
    await postInvoice(theirInv.id, 'alicio@example.test')
    const theirPaid = await recordPayment({
      invoiceId: theirInv.id, bankAccountId: tid['1000']!, amount: 10000n, paidOn: '2026-03-15', actor: 'alicio@example.test',
    })
    const [theirApp] = await applicationsOn(theirInv.id)
    const withA = (fields: Record<string, string>) => {
      const fd = new FormData()
      fd.set(PF.ledgerId, co.ledger.id)                        // company A's ledger, always
      for (const [k, v] of Object.entries(fields)) fd.set(k, v)
      return fd
    }
    const REFUSED = "not in this company's books"
    const cases: Array<[string, () => Promise<{ error?: string; ok?: string }>]> = [
      ['pay', () => payInvoiceFromForm(withA({ [PF.invoiceId]: theirInv.id, [PF.bankAccountId]: at('1000').id, [PF.paidOn]: '2026-03-16', [PF.amount]: '100.00' }), 'alicio@example.test')],
      ['apply', () => applyCreditFromForm(withA({ [PF.invoiceId]: theirInv.id, [PF.entryId]: theirPaid.entryId, [PF.amount]: '1.00' }), 'alicio@example.test')],
      ['unapply', () => unapplyFromForm(withA({ [PF.applicationId]: theirApp!.id }), 'alicio@example.test')],
      ['delete', () => deletePaymentFromForm(withA({ [PF.entryId]: theirPaid.entryId }), 'alicio@example.test')],
    ]
    const wrong: string[] = []
    for (const [label, fn] of cases) {
      const r = await fn()
      if (!r.error || !r.error.includes(REFUSED)) wrong.push(`${label}: ${r.error ?? r.ok ?? 'nothing said'}`)
    }
    const stillApplied = (await applicationsOn(theirInv.id)).length
    const [stillPaid] = await db.execute<{ status: string }>(raw`SELECT status FROM journal_entry WHERE id = ${theirPaid.entryId}::uuid`)
    check(wrong.length === 0 && stillApplied === 1 && stillPaid?.status === 'posted',
      "PM44 paying, applying, unapplying or deleting a payment on another company's invoice under this ledger is refused before anything happens",
      wrong.length ? wrong.join('; ') : `four doors refused; their application still there (${stillApplied}), their payment still ${stillPaid?.status}`)
  }

  await trailNamesPeople(check, 'PM43 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  fail('the suite threw before it finished', errorText(e).slice(0, 110))
  console.log(`\n=== ${r.failures} CHECK(S) FAILED ===`)
  await conn.end()
  process.exit(1)
})

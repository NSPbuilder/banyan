/**
 * THE RICHEST COMPANY THIS SYSTEM KNOWS HOW TO BUILD, as a function.
 *
 * It was the body of `seed-example.ts`, which makes a company for the owner
 * to explore. It is a function now because the backup suite needs the same
 * thing for a different reason: a round trip tested against a company with
 * three entries and no invoice PASSES, and then a real restore dies on the
 * first posted invoice it meets. Two of those reached the owner (2026-09-07).
 *
 * Everything still goes through the application's own doors — never raw SQL —
 * so what is built is what the guards allow, and a suite that restores it is
 * restoring the shapes those guards produce.
 *
 * No env import: the caller decides which database this is. `seed-example.ts`
 * points at the real books on purpose; a suite points at the test one.
 */
import { sql as raw } from 'drizzle-orm'
import { db } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { registerTax } from '../src/lib/registrations'
import { postOpeningBalance } from '../src/lib/opening'
import { createParty, setAddress } from '../src/lib/parties'
import { saveEmployee } from '../src/lib/payroll/employees'
import { runPayroll } from '../src/lib/payroll/runs'
import { saveStatement } from '../src/lib/bank'
import { waiveReceipt } from '../src/lib/attachments'
import { createInvoiceFromForm } from '../src/lib/invoice-forms'
import { invoicesFor } from '../src/lib/invoices'
import { recordPayment, applyEntryToInvoice } from '../src/lib/payments'
import { quickEntryFromForm } from '../src/lib/quick-forms'
import { postEntry, reverseEntry } from '../src/lib/posting'
import { importBankRows, matchEntry, postFromBankRow, ignoreBankRow } from '../src/lib/bank'
import { closePeriod } from '../src/lib/periods'
import {
  saveProfile, setOffice, appointDirector, createShareClass, issueShares,
  addMinuteBookEntry, recordSignificantIndividual, transferShares, cancelShares,
} from '../src/lib/records'
import { INVOICE_FIELDS as IF, QUICK_FIELDS as QF, lineAccount, lineAmount, lineDescription } from '../src/lib/forms'
import {
  addEvidence as addSredEvidence, allocatableLines, allocate as allocateSred,
  createSredProject, logSredTime, openClaim as openSredClaim, saveClaim as saveSredClaim,
  setSredAccountCategory,
} from '../src/lib/sred'
import { parseMoney } from '../src/lib/money'


const CHART = `1000,Cash — Operating,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
1500,Equipment,asset,,property_plant_equipment
1510,Accumulated Depreciation,asset,,accumulated_depreciation_ppe,contra
2000,Accounts Payable,liability,,trade_payables
2400,Accrued Liabilities,liability,,other_current_liabilities
2500,Payroll Liabilities,liability,,payroll_liabilities
3000,Share Capital,equity,,share_capital
3100,Retained Earnings,equity,,retained_earnings
4000,Consulting Revenue,revenue,,revenue_from_contracts
4100,Interest Income,revenue,,finance_income
5000,Salaries and Benefits,expense,,employee_benefits_expense fn_administrative_expenses
5100,Rent,expense,,other_operating_expenses fn_administrative_expenses
5200,Office and Supplies,expense,,other_operating_expenses fn_administrative_expenses
5300,Professional Fees,expense,,professional_fees fn_administrative_expenses
5400,Bank Charges,expense,,finance_costs`


export async function buildExampleCompany(opts: { code: string; name: string; actor?: string }) {
  const ACTOR = opts.actor ?? 'seed-example'
  const co = await createCompanyWithYear({
    code: opts.code, name: opts.name, province: 'BC',
    businessNumber: '712345678',
  }, ACTOR)
  const L = co.ledger.id
  const E = co.company.id

  // Chart, then the tax registrations create their own role-tagged accounts.
  const accts = await importAccounts(E,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: E })), ACTOR)
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  await registerTax({ entityId: E, tax: 'GST_HST', number: '712345678RT0001',
                      registeredOn: '2026-01-01', actor: ACTOR })
  await registerTax({ entityId: E, tax: 'PST', number: 'PST-1234-5678',
                      registeredOn: '2026-01-01', actor: ACTOR })

  // Opening balances, Jan 1 — a converted company arrives mid-story.
  await postOpeningBalance({
    ledgerId: L, entryDate: '2026-01-01', actor: ACTOR,
    description: 'Opening balances at conversion',
    lines: [
      { accountId: id['1000'], amount: parseMoney('25000.00') },
      { accountId: id['1500'], amount: parseMoney('12000.00') },
      { accountId: id['1510'], amount: -parseMoney('2000.00') },
      { accountId: id['3000'], amount: -parseMoney('20000.00') },
      { accountId: id['3100'], amount: -parseMoney('15000.00') },
    ],
  })

  // Parties — every role the system knows, one address shared where it should be.
  const northern = await createParty({ kind: 'organisation', name: 'Northern Lights Media Inc.',
    taxNumber: '765432189RT0001',
    roles: [{ entityId: E, role: 'customer', heldFrom: '2026-01-01' }], actor: ACTOR })
  const harbour = await createParty({ kind: 'organisation', name: 'Harbour View Ventures Ltd.',
    roles: [{ entityId: E, role: 'customer', heldFrom: '2026-01-15' }], actor: ACTOR })
  const coastal = await createParty({ kind: 'organisation', name: 'Coastal Office Supply Co.',
    roles: [{ entityId: E, role: 'supplier', heldFrom: '2026-01-01' }], actor: ACTOR })
  const summit = await createParty({ kind: 'organisation', name: 'Summit Legal LLP',
    roles: [{ entityId: E, role: 'supplier', heldFrom: '2026-01-01' }], actor: ACTOR })
  const dana = await createParty({ kind: 'person', name: 'Dana Whitfield',
    roles: [
      { entityId: E, role: 'director', heldFrom: '2026-01-01' },
      { entityId: E, role: 'shareholder', heldFrom: '2026-01-01' },
      { entityId: E, role: 'employee', heldFrom: '2026-02-01' },
    ], actor: ACTOR })
  await setAddress({ partyId: northern.id, purpose: 'mailing',
    line1: '400 - 1055 Georgia St W', city: 'Vancouver', region: 'BC', postalCode: 'V6E 3P3' })
  await setAddress({ partyId: dana.id, purpose: 'mailing',
    line1: '2210 Cypress St', city: 'Vancouver', region: 'BC', postalCode: 'V6J 3M7' })

  // Sales, through the same form reader the screen runs. Amounts are typed
  // as what the line adds; the tags compute the taxes.
  const nameOf = (aid: string) => accts.find((a) => a.id === aid)?.code ?? aid
  const salesForm = (over: Record<string, string>) => {
    const f = new FormData()
    f.set(IF.ledgerId, L); f.set(IF.direction, 'sales'); f.set(IF.kind, 'invoice')
    f.set(IF.partyId, northern.id); f.set(IF.controlAccountId, id['1200'])
    for (const [k, v] of Object.entries(over)) f.set(k, v)
    return f
  }
  const mustOk = async (what: string, r: { ok?: string; error?: string }) => {
    if (!r.ok) { console.error(`${what}: ${r.error}`); process.exit(1) }
  }

  await mustOk('INV-1001', await createInvoiceFromForm(salesForm({
    [IF.issuedOn]: '2026-02-03', [IF.dueOn]: '2026-03-05', [IF.number]: 'INV-1001',
    [lineAccount(0)]: id['4000'], [lineDescription(0)]: 'Strategy retainer — February',
    [lineAmount(0)]: '4500.00', ['line.0.taxCode']: 'GST_PST',
  }), nameOf, ACTOR))
  await mustOk('INV-1002', await createInvoiceFromForm(salesForm({
    [IF.partyId]: harbour.id,
    [IF.issuedOn]: '2026-03-10', [IF.dueOn]: '2026-04-09', [IF.number]: 'INV-1002',
    [lineAccount(0)]: id['4000'], [lineDescription(0)]: 'Market study',
    [lineAmount(0)]: '6200.00', ['line.0.taxCode']: 'GST',
    [lineAccount(1)]: id['4000'], [lineDescription(1)]: 'Workshop day',
    [lineAmount(1)]: '800.00', ['line.1.taxCode']: 'GST',
  }), nameOf, ACTOR))
  // A credit note: the workshop day was cancelled.
  await mustOk('CN-1001', await createInvoiceFromForm(salesForm({
    [IF.partyId]: harbour.id, [IF.kind]: 'credit_note',
    [IF.issuedOn]: '2026-03-20', [IF.dueOn]: '2026-03-20', [IF.number]: 'CN-1001',
    [IF.note]: 'Workshop day cancelled',
    [lineAccount(0)]: id['4000'], [lineDescription(0)]: 'Workshop day — cancelled',
    [lineAmount(0)]: '800.00', ['line.0.taxCode']: 'GST',
  }), nameOf, ACTOR))

  // Purchases.
  const billForm = (over: Record<string, string>) => {
    const f = new FormData()
    f.set(IF.ledgerId, L); f.set(IF.direction, 'purchase'); f.set(IF.kind, 'invoice')
    f.set(IF.partyId, coastal.id); f.set(IF.controlAccountId, id['2000'])
    for (const [k, v] of Object.entries(over)) f.set(k, v)
    return f
  }
  await mustOk('office bill', await createInvoiceFromForm(billForm({
    [IF.issuedOn]: '2026-02-10', [IF.dueOn]: '2026-03-12', [IF.theirRef]: 'CO-8841',
    [lineAccount(0)]: id['5200'], [lineDescription(0)]: 'Desks and chairs',
    [lineAmount(0)]: '1400.00', ['line.0.taxCode']: 'GST_PST',
  }), nameOf, ACTOR))
  await mustOk('legal bill', await createInvoiceFromForm(billForm({
    [IF.partyId]: summit.id,
    [IF.issuedOn]: '2026-04-02', [IF.dueOn]: '2026-05-02', [IF.theirRef]: 'SL-2026-77',
    [lineAccount(0)]: id['5300'], [lineDescription(0)]: 'Shareholder agreement review',
    [lineAmount(0)]: '2500.00', ['line.0.taxCode']: 'GST',
  }), nameOf, ACTOR))

  // Settlements: full, partial, credit-note application, and a bill paid.
  const sales = await invoicesFor(L, 'sales')
  const bills = await invoicesFor(L, 'purchase')
  const inv1001 = sales.find((i) => i.number === 'INV-1001')!
  const inv1002 = sales.find((i) => i.number === 'INV-1002')!
  const cn1001 = sales.find((i) => i.number === 'CN-1001')!
  const officeBill = bills.find((i) => i.their_ref === 'CO-8841')!

  const receipt = await recordPayment({
    invoiceId: inv1001.id, bankAccountId: id['1000'],
    amount: parseMoney('5040.00'), paidOn: '2026-02-27',
    reference: 'e-transfer', actor: ACTOR,
  })
  await recordPayment({
    invoiceId: inv1002.id, bankAccountId: id['1000'],
    amount: parseMoney('3000.00'), paidOn: '2026-04-15', actor: ACTOR,
  })
  const [cnEntry] = await db.execute<{ entry_id: string }>(raw`
    SELECT entry_id::text FROM invoice WHERE id = ${cn1001.id}::uuid`)
  await applyEntryToInvoice({
    invoiceId: inv1002.id, entryId: cnEntry.entry_id,
    amount: parseMoney('840.00'), actor: ACTOR,
  })
  await recordPayment({
    invoiceId: officeBill.id, bankAccountId: id['1000'],
    amount: parseMoney('1568.00'), paidOn: '2026-03-05', actor: ACTOR,
  })

  // Quick entries — the tags at work, inclusive included.
  const quick = (kind: string, over: Record<string, string>) => {
    const f = new FormData()
    f.set(QF.ledgerId, L); f.set(QF.kind, kind)
    for (const [k, v] of Object.entries(over)) f.set(k, v)
    return f
  }
  await mustOk('coffee receipt', await quickEntryFromForm(quick('expense', {
    [QF.entryDate]: '2026-05-06', [QF.description]: 'Client coffee — till receipt',
    [QF.accountId]: id['5200'], [QF.bankAccountId]: id['1000'],
    [QF.amount]: '44.80', [QF.taxCode]: 'GST_PST', [QF.amounts]: 'inclusive',
  }), ACTOR))
  await mustOk('interest', await quickEntryFromForm(quick('income', {
    [QF.entryDate]: '2026-06-30', [QF.description]: 'Interest on operating account',
    [QF.accountId]: id['4100'], [QF.bankAccountId]: id['1000'],
    [QF.amount]: '18.35', [QF.taxCode]: 'OUT_OF_SCOPE',
  }), ACTOR))

  // A manual journal (month-end rent accrual) and a corrected mistake — the
  // reversal pair that shows what ADJ numbers are for.
  await postEntry({
    ledgerId: L, entryDate: '2026-06-30', description: 'June rent accrual',
    actor: ACTOR,
    lines: [
      { accountId: id['5100'], amount: parseMoney('1900.00') },
      { accountId: id['2400'], amount: -parseMoney('1900.00') },
    ],
  })
  const oops = await postEntry({
    ledgerId: L, entryDate: '2026-07-08', description: 'Salary run — keyed to the wrong month',
    actor: ACTOR,
    lines: [
      { accountId: id['5000'], amount: parseMoney('5200.00') },
      { accountId: id['1000'], amount: -parseMoney('5200.00') },
    ],
  })
  await reverseEntry(oops.entry.id, '2026-07-08', 'keyed to the wrong month', ACTOR)
  await postEntry({
    ledgerId: L, entryDate: '2026-07-31', description: 'July salary run',
    actor: ACTOR,
    lines: [
      { accountId: id['5000'], amount: parseMoney('5200.00') },
      { accountId: id['1000'], amount: -parseMoney('5200.00') },
    ],
  })

  // The bank statement: one row the receipt explains, one fee posted straight
  // from the row, one bank error ignored with a reason, one left to work.
  const imported = await importBankRows({
    accountId: id['1000'], sourceFile: 'demo-operating-2026-02.csv', actor: ACTOR,
    rows: [
      { date: '2026-02-27', amount: parseMoney('5040.00'), description: 'E-TRANSFER NORTHERN LIGHTS' },
      { date: '2026-02-28', amount: -parseMoney('12.50'), description: 'MONTHLY ACCOUNT FEE' },
      { date: '2026-02-28', amount: -parseMoney('12.50'), description: 'MONTHLY ACCOUNT FEE' },
      { date: '2026-02-28', amount: parseMoney('12.50'), description: 'FEE REVERSAL — BANK ERROR' },
    ],
  })
  console.log(`bank rows: ${imported.inserted} in`)
  const rows = await db.execute<{ id: string; description: string; amount: string; occurrence: number }>(raw`
    SELECT id::text, description, amount::text, occurrence FROM bank_transaction
     WHERE account_id = ${id['1000']}::uuid ORDER BY txn_date, occurrence`)
  const rowOf = (desc: string, occ = 1) =>
    rows.find((r) => r.description === desc && r.occurrence === occ)!
  await matchEntry({
    bankTransactionId: rowOf('E-TRANSFER NORTHERN LIGHTS').id,
    entryId: receipt.entryId, actor: ACTOR,
  })
  await postFromBankRow({
    bankTransactionId: rowOf('MONTHLY ACCOUNT FEE').id,
    contraAccountId: id['5400'], actor: ACTOR,
  })
  await ignoreBankRow(rowOf('FEE REVERSAL — BANK ERROR').id,
    "The bank reversed its own fee error; the second fee row's reversal, not our money.", ACTOR)

  // Corporate records.
  await saveProfile({ entityId: E, incorporationNumber: 'BC1234567',
    businessNumber: '712345678', recognitionDate: '2025-11-14',
    companyType: 'limited', actor: ACTOR })
  await setOffice({ entityId: E, office: 'registered',
    deliveryAddress: '900 - 885 Georgia St W', deliveryCity: 'Vancouver',
    deliveryPostal: 'V6C 3H1', effectiveFrom: '2025-11-14', actor: ACTOR })
  await appointDirector({ entityId: E, partyId: dana.id,
    appointedOn: '2026-01-01', actor: ACTOR })
  const common = await createShareClass({ entityId: E, name: 'Common', actor: ACTOR })
  await issueShares({ shareClassId: common, partyId: dana.id, onDate: '2026-01-01',
    quantity: 100n, details: 'Incorporation — 100 common at $200 each', actor: ACTOR })
  // A TRANSFER and a BUY-BACK. A transfer is two rows that have to agree —
  // one class, one day, one group — and its trigger says so
  // (`TRANSFER_MIXED`), which is what the owner's fifth restore met.
  await issueShares({ shareClassId: common, partyId: northern.id, onDate: '2026-02-01',
    quantity: 20n, details: '20 common at $10 each', actor: ACTOR })
  await transferShares({ shareClassId: common, fromPartyId: northern.id, toPartyId: dana.id,
    onDate: '2026-03-01', quantity: 5n, details: '5 common transferred', consideration: '$50',
    actor: ACTOR })
  await cancelShares({ shareClassId: common, partyId: northern.id, onDate: '2026-04-01',
    quantity: 5n, details: 'Bought back', actor: ACTOR })

  // ------------------------------------------------------------- payroll --
  //
  // Dana is on the payroll as well as being the director and the shareholder,
  // which is what one-person companies look like. The employee ROLE is
  // granted above, when the party is made; this is the payroll RECORD, which
  // the role has to exist for — its trigger says so in words, and a restore
  // that put the record back before the role met that same sentence (owner,
  // 2026-09-07).
  const employee = await saveEmployee({
    ledgerId: L, partyId: dana.id, frequency: 'semi_monthly',
    sin: '046454286', occupation: 'Consultant', hiredOn: '2026-02-01', actor: ACTOR,
  })
  await runPayroll({
    ledgerId: L, payDate: '2026-07-15', periodStart: '2026-07-01', periodEnd: '2026-07-15',
    bankAccountId: id['1000'], actor: ACTOR,
    idempotencyKey: 'demo-payday-2026-07-15',
    lines: [{ employeeId: employee.id, gross: parseMoney('3000.00'), hours: 7500n }],
  })

  // --------------------------------------------------------------- SR&ED --
  //
  // One project with a claim on it, because a backup that carries five SR&ED
  // tables and is only ever tested against a company with none proves
  // nothing about them (`BK0`). It is also the shape of a real claim: a
  // narrative, a time log written the same week, two kinds of evidence, and
  // money attributed by a stated basis rather than a round number.
  const [fy] = await db.execute<{ id: string; start_date: string; end_date: string }>(raw`
    SELECT id::text, start_date::text, end_date::text FROM fiscal_year
     WHERE ledger_id = ${L}::uuid ORDER BY end_date LIMIT 1`)
  const project = await createSredProject({
    entityId: E, code: 'SR-2026-01',
    title: 'Reconciling a bank feed against entries nobody keyed the same way twice',
    fieldOfScience: 'Computer science — software engineering',
    startedOn: '2026-02-01', actor: ACTOR,
  })
  const claim = await openSredClaim({ projectId: project.id, fiscalYearId: fy.id, actor: ACTOR })
  await saveSredClaim({
    claimId: claim.id, method: 'proxy',
    uncertainty:
      'Whether a bank row can be matched to an entry it does not agree with — different date, '
      + 'different total, a description written by a machine — without asking a person, and '
      + 'without the false matches that make a person stop trusting the suggestions. Standard '
      + 'string similarity fails on both halves of that: it matches too much, and it cannot say '
      + 'why it matched.',
    workDone:
      'Built a scoring function over date distance, amount distance and description overlap and '
      + 'ran it against a year of statements with the answers known. Recorded precision and '
      + 'recall for each weighting. The first design matched on description first and was wrong '
      + 'often enough to be useless; the second matched on amount and used description only to '
      + 'break ties, and was right more often but silently. Added the requirement that a '
      + 'suggestion state its own reason, which ruled out two of the three designs.',
    advancement:
      'A suggestion that can name the reason it was made is a different problem from a '
      + 'suggestion that is merely likely, and the second cannot be turned into the first by '
      + 'tuning. That is knowledge we did not have in February, and it is why the screen offers '
      + 'one match or a list rather than a ranked guess.',
    assistanceNote: 'None: no grant, no IRAP, and nobody paid us for this work.',
    assistanceAnswered: true, actor: ACTOR,
  })
  await logSredTime({ projectId: project.id, employeeId: employee.id, onDate: '2026-07-06',
    hours: '6.5', activity: 'Ran the third weighting against the February statement; recall 0.91, precision 0.62.',
    actor: ACTOR })
  await logSredTime({ projectId: project.id, employeeId: employee.id, onDate: '2026-07-07',
    hours: '4.0', activity: 'Wrote up why description-first cannot be repaired by weighting.',
    actor: ACTOR })
  await addSredEvidence({ projectId: project.id, kind: 'hypothesis',
    title: 'Scoring design and what would count as failure', onDate: '2026-02-05', actor: ACTOR })
  await addSredEvidence({ projectId: project.id, kind: 'trial_record',
    title: 'Third weighting — precision and recall by month', onDate: '2026-07-07', actor: ACTOR })
  // GUARDED, because a mutation block takes the payroll out of this fixture on
  // purpose (to prove `BK0` notices an empty table), and an unguarded `stub.id`
  // turned that mutant into a crashed suite instead of a red check — which
  // proves nothing, and cost a 50-minute evidence run to find (2026-09-11).
  const [stub] = await db.execute<{ id: string }>(raw`
    SELECT ps.id::text FROM pay_stub ps JOIN pay_run pr ON pr.id = ps.pay_run_id
     WHERE pr.ledger_id = ${L}::uuid ORDER BY pr.pay_date LIMIT 1`)
  if (stub) {
    await allocateSred({
      claimId: claim.id, sourceKind: 'pay_stub', sourceId: stub.id, category: 'salary',
      percent: '60', basis: '10.5 of the 17.5 hours logged in that period were on this project',
      actor: ACTOR,
    })
  }
  // Rent tagged as overhead on the SR&ED screen, so the company carries a row
  // in sred_account_category for the round trip to compare (`BK0`).
  await setSredAccountCategory({ accountId: id['5100'], category: 'overhead', actor: ACTOR })
  const spendable = await allocatableLines(L, fy.start_date, fy.end_date)
  const overhead = spendable.find((a) => /rent/i.test(a.what)) ?? spendable[0]
  if (overhead) {
    await allocateSred({
      claimId: claim.id, sourceKind: 'journal_line', sourceId: overhead.source_id,
      category: 'overhead', percent: '25',
      basis: 'one of four desks, and the trials ran on the machine at it',
      actor: ACTOR,
    })
  }

  // ------------------------------------------- the rest of the paperwork --
  //
  // A statement to reconcile against, a receipt waived rather than chased,
  // and the two corporate registers the seed did not reach.
  await saveStatement({ accountId: id['1000'], statementDate: '2026-07-31',
    endingBalance: parseMoney('0.00'), actor: ACTOR })
  const [chased] = await db.execute<{ id: string }>(raw`
    SELECT je.id::text FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${L}::uuid AND a.account_type = 'expense' AND je.status = 'posted'
     ORDER BY je.entry_date DESC LIMIT 1`)
  if (chased) await waiveReceipt(L, chased.id, ACTOR)
  await addMinuteBookEntry({ entityId: E, recordKind: 'directors_resolution',
    onDate: '2026-01-02', title: 'Banking resolution', keptAt: 'Records office', actor: ACTOR })
  await recordSignificantIndividual({ entityId: E, partyId: dana.id,
    becameOn: '2026-01-01', howControl: 'registered owner of 100% of the common shares',
    actor: ACTOR })

  // The freeze, demonstrated: January is closed. Everything dated there now
  // refuses edits and deletes with the period's own sentence.
  const [jan] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM fiscal_period WHERE ledger_id = ${L}::uuid AND period_no = 1`)
  await closePeriod(L, jan.id, { actor: ACTOR })


  return { ledgerId: L, entityId: E, accounts: id }
}

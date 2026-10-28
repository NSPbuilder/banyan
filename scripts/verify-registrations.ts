/**
 * Sales tax registration.
 *   npm run db:verify-registrations   (resets the TEST database first)
 *
 * Being registered is not a preference — it decides whether a return exists at
 * all, whether tax on an invoice was legitimate, and which accounts the chart
 * needs. The checks here are mostly about the two ways this goes quietly wrong:
 * a return of zeroes that reads as "no tax this quarter" when the company was
 * never registered, and a false alarm loud enough to teach the owner to ignore
 * the real one.
 */
import './env'
import { reporter } from './suite'
import { trailNamesPeople } from './actor-trail'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv, setAccountRoles } from '../src/lib/accounts'
import { postEntry } from '../src/lib/posting'
import { createInvoice, postInvoice } from '../src/lib/invoices'
import { createParty } from '../src/lib/parties'
import { gstHstReturn } from '../src/lib/tax'
import { parseMoney } from '../src/lib/money'
import { WEB_ACTOR } from '../src/lib/actor'
import { dayIn, partsOf } from '../src/lib/today'
import { TAX_FIELDS } from '../src/lib/forms'
import {
  ceaseTaxFromForm, correctRegistrationFromForm, deleteRegistrationFromForm, registerTaxFromForm,
} from '../src/lib/tax-forms'
import {
  ceaseTax, coverageOf, proposedAccounts, registerTax, registeredOn, registrationsFor,
  openProposals, registrationView, taxesFor, type Registration,
} from '../src/lib/registrations'

const r = reporter(54)
const { pass, fail } = r

/**
 * The actor for every `ceaseTax` call here, chosen so it cannot be the database
 * role.
 *
 * R25 used to pass 'alicio@example.test' — which is also the Postgres role on this machine,
 * so `COALESCE(NEW.ceased_by, current_user)` and a bare `current_user` produce
 * the same string, and the check passed with 0016's whole fix reverted. A check
 * whose two sides are spelled the same is not a check.
 */
const CEASER = 'alicio (browser)'

/** Runs `fn` and returns the error code it threw, or null if it did not throw. */
async function refused(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null } catch (e) { return (e as { code?: string }).code ?? String(e) }
}

const CHART = `1000,Cash,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
2000,Payables,liability,,trade_payables
3000,Share Capital,equity,,share_capital
3100,Retained Earnings,equity,,retained_earnings
4000,Sales,revenue,,revenue_from_contracts
5000,Supplies,expense,,office_and_administrative fn_administrative_expenses`

async function company(code: string, name: string, province: string) {
  const co = await createCompanyWithYear({ code, name, province }, 'alicio@example.test')
  const accts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  return { ...co, id: Object.fromEntries(accts.map((a) => [a.code, a.id])) }
}

async function main() {
  // ---------- which taxes a province has ----------

  const on = taxesFor('ON')
  on.length === 1 && on[0].tax === 'GST_HST' && on[0].label === 'HST'
    ? pass('R1 Ontario has one tax, called HST', 'one registration, one return')
    : fail('R1 Ontario has one tax, called HST', JSON.stringify(on))

  const bc = taxesFor('BC')
  const bcPst = bc.find((t) => t.tax === 'PST')
  bc.length === 2 && bcPst !== undefined && bcPst.recoverable === false
    ? pass('R2 BC has GST and PST, and PST is not recoverable', 'PST paid is a cost, not an ITC')
    : fail('R2 BC has GST and PST, and PST is not recoverable', JSON.stringify(bc))

  const qc = taxesFor('QC')
  qc.length === 2 && qc.every((t) => t.recoverable) && qc.some((t) => t.tax === 'QST')
    ? pass('R3 Quebec has GST and QST, both recoverable', 'QST has its own number and return')
    : fail('R3 Quebec has GST and QST, both recoverable', JSON.stringify(qc))

  const ab = taxesFor('AB')
  ab.length === 1 && ab[0].label === 'GST'
    ? pass('R4 Alberta has GST alone', 'no provincial sales tax')
    : fail('R4 Alberta has GST alone', JSON.stringify(ab))

  // ---------- registering creates the accounts ----------

  const acme = await company('ACME', 'Acme Consulting Inc.', 'ON')
  const yr = Number(acme.year.endDate.slice(0, 4))

  const reg = await registerTax({
    entityId: acme.company.id, tax: 'GST_HST',
    number: '123456789RT0001', registeredOn: `${yr}-03-01`, actor: 'alicio@example.test',
  })

  const made = await db.execute<{ code: string; name: string; account_type: string; role: string }>(raw`
    SELECT a.code, a.name, a.account_type, ar.role
      FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${acme.company.id}
       AND ar.role IN ('gst_hst_payable','gst_hst_recoverable')
     ORDER BY a.code`)
  const payable = made.find((m) => m.role === 'gst_hst_payable')
  const recoverable = made.find((m) => m.role === 'gst_hst_recoverable')
  made.length === 2
    && payable?.account_type === 'liability' && recoverable?.account_type === 'asset'
    ? pass('R5 registering creates both accounts, tagged and typed',
           `${recoverable!.code} ${recoverable!.name} / ${payable!.code} ${payable!.name}`)
    : fail('R5 registering creates both accounts, tagged and typed', JSON.stringify(made))

  reg.created.length === 2
    ? pass('R6 it says which accounts it made', reg.created.join(', '))
    : fail('R6 it says which accounts it made', JSON.stringify(reg))

  // ---------- BC: no recoverable account for PST ----------

  const van = await company('VAN', 'Vancouver Trading Ltd.', 'BC')
  const vanYr = Number(van.year.endDate.slice(0, 4))
  const pstProposal = await proposedAccounts(van.company.id, 'PST')
  pstProposal.length === 1 && pstProposal[0].role === 'qst_pst_payable'
    ? pass('R7 BC PST proposes a payable and nothing to reclaim', pstProposal[0].name)
    : fail('R7 BC PST proposes a payable and nothing to reclaim', JSON.stringify(pstProposal))

  const qcCo = await company('QCC', 'Montreal Services Inc.', 'QC')
  const qstProposal = await proposedAccounts(qcCo.company.id, 'QST')
  qstProposal.length === 2
    ? pass('R8 Quebec QST proposes both, because QST is recoverable', qstProposal.map((p) => p.code).join(' '))
    : fail('R8 Quebec QST proposes both, because QST is recoverable', JSON.stringify(qstProposal))

  // ---------- refusals ----------

  const ontarioPst = await refused(() => registerTax({
    entityId: acme.company.id, tax: 'PST', number: 'X', registeredOn: `${yr}-01-01` }))
  ontarioPst === 'NOT_APPLICABLE'
    ? pass('R9 a province without PST cannot register for it', 'Ontario has no PST')
    : fail('R9 a province without PST cannot register for it', String(ontarioPst))

  const noNumber = await refused(() => registerTax({
    entityId: van.company.id, tax: 'GST_HST', number: '   ', registeredOn: `${vanYr}-01-01` }))
  noNumber === 'NO_NUMBER'
    ? pass('R10 a registration without a number is refused', 'the number goes on every invoice')
    : fail('R10 a registration without a number is refused', String(noNumber))

  const twice = await refused(() => registerTax({
    entityId: acme.company.id, tax: 'GST_HST',
    number: '987654321RT0001', registeredOn: `${yr}-06-01` }))
  twice === 'ALREADY'
    ? pass('R11 registering twice over the same days is refused', 'one number at a time')
    : fail('R11 registering twice over the same days is refused', String(twice))

  // ---------- an existing account is reused, not duplicated ----------

  const before = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM account WHERE entity_id = ${qcCo.company.id}`)
  await registerTax({
    entityId: qcCo.company.id, tax: 'GST_HST',
    number: '111222333RT0001', registeredOn: `${yr}-01-01`, actor: 'alicio@example.test' })
  await ceaseTax(
    (await registrationsFor(qcCo.company.id))[0].id, `${yr}-06-30`, CEASER)
  const again = await registerTax({
    entityId: qcCo.company.id, tax: 'GST_HST',
    number: '111222333RT0002', registeredOn: `${yr}-07-01`, actor: 'alicio@example.test' })
  const after = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM account WHERE entity_id = ${qcCo.company.id}`)
  again.created.length === 0 && Number(after[0].n) === Number(before[0].n) + 2
    ? pass('R12 registering again after a gap reuses the accounts',
           `${after[0].n} accounts, not ${Number(before[0].n) + 4}`)
    : fail('R12 registering again after a gap reuses the accounts',
           `${before[0].n} -> ${after[0].n}, created ${JSON.stringify(again.created)}`)

  // ---------- a failed registration leaves nothing behind ----------

  const clash = await refused(() => registerTax({
    entityId: van.company.id, tax: 'GST_HST', number: '555666777RT0001',
    registeredOn: `${vanYr}-01-01`,
    accounts: [{ code: '2000', name: 'GST Payable' }, { code: '1000', name: 'GST Recoverable' }],
  }))
  const vanAccounts = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM account WHERE entity_id = ${van.company.id}`)
  const vanRegs = await registrationsFor(van.company.id)
  clash === 'DUPLICATE' && Number(vanAccounts[0].n) === 7 && vanRegs.length === 0
    ? pass('R13 a registration that fails writes neither half',
           'no accounts, no registration')
    : fail('R13 a registration that fails writes neither half',
           `${clash}, ${vanAccounts[0].n} accounts, ${vanRegs.length} registrations`)

  // ---------- the return respects registration ----------

  const plain = await company('NIL', 'Unregistered Co.', 'AB')
  const plainYr = Number(plain.year.endDate.slice(0, 4))
  await importAccounts(plain.company.id, [
    { entityId: plain.company.id, code: '2100', name: 'GST Payable',
      accountType: 'liability', roles: ['gst_hst_payable'] }], 'alicio@example.test')
  const nilReturn = (await gstHstReturn(plain.ledger.id, `${plainYr}-01-01`, `${plainYr}-03-31`))!
  nilReturn.registration === null
    && nilReturn.review.some((r) => r.what.includes('not registered'))
    ? pass('R14 an unregistered company gets "no return", not zeroes',
           'a zero return reads as "no tax this quarter"')
    : fail('R14 an unregistered company gets "no return", not zeroes',
           JSON.stringify(nilReturn.review.map((r) => r.what)))

  // R15 is R14's pair: the same books, once registered, DO produce a return.
  await registerTax({ entityId: plain.company.id, tax: 'GST_HST',
    number: '444555666RT0001', registeredOn: `${plainYr}-01-01`, actor: 'alicio@example.test' })
  const nowFiling = (await gstHstReturn(plain.ledger.id, `${plainYr}-01-01`, `${plainYr}-03-31`))!
  nowFiling.registration?.number === '444555666RT0001'
    && nowFiling.businessNumber === '444555666RT0001'
    && !nowFiling.review.some((r) => r.what.includes('not registered'))
    ? pass('R15 once registered, the same books do produce a return',
           'and it carries the registration number')
    : fail('R15 once registered, the same books do produce a return',
           JSON.stringify({ reg: nowFiling.registration, review: nowFiling.review.map((r) => r.what) }))

  // ---------- tax charged outside the registered days ----------

  const early = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM account WHERE entity_id = ${acme.company.id}
       AND code = ${payable!.code}`)
  await postEntry({
    ledgerId: acme.ledger.id, entryDate: `${yr}-02-15`, description: 'Invoice before registering',
    actor: 'alicio@example.test',
    lines: [
      { accountId: acme.id['1200'], amount: parseMoney('1130.00') },
      { accountId: acme.id['4000'], amount: -parseMoney('1000.00') },
      { accountId: early[0].id, amount: -parseMoney('130.00') },
    ],
  })
  const q1 = (await gstHstReturn(acme.ledger.id, `${yr}-01-01`, `${yr}-03-31`))!
  const flagged = q1.review.find((r) => r.what.includes('outside the registered period'))
  flagged?.entries?.length === 1
    ? pass('R16 tax charged before registering is reported',
           `${flagged.what} — registered ${yr}-03-01`)
    : fail('R16 tax charged before registering is reported',
           JSON.stringify(q1.review.map((r) => r.what)))

  q1.review.some((r) => r.what.includes('starts before the company was registered'))
    ? pass('R17 a period starting before the registration date is named',
           'the return covers only from the registration date')
    : fail('R17 a period starting before the registration date is named',
           JSON.stringify(q1.review.map((r) => r.what)))

  // R18 is R16's pair: the same invoice dated INSIDE the registered days is
  // silent. A check that fires on everything is a check nobody reads.
  await postEntry({
    ledgerId: acme.ledger.id, entryDate: `${yr}-04-15`, description: 'Invoice after registering',
    actor: 'alicio@example.test',
    lines: [
      { accountId: acme.id['1200'], amount: parseMoney('1130.00') },
      { accountId: acme.id['4000'], amount: -parseMoney('1000.00') },
      { accountId: early[0].id, amount: -parseMoney('130.00') },
    ],
  })
  const q2 = (await gstHstReturn(acme.ledger.id, `${yr}-04-01`, `${yr}-06-30`))!
  !q2.review.some((r) => r.what.includes('outside the registered period'))
    ? pass('R18 tax charged while registered is not reported', 'the check discriminates')
    : fail('R18 tax charged while registered is not reported',
           JSON.stringify(q2.review.map((r) => r.what)))

  // ---------- PST is not mistaken for QST ----------
  //
  // Both provincial taxes share one role, `qst_pst_payable`, because a chart of
  // accounts does not care which province wrote the rules. Reading the role
  // name to decide which registration to look for made every BC PST entry a
  // false alarm.

  await registerTax({ entityId: van.company.id, tax: 'GST_HST',
    number: '555666777RT0001', registeredOn: `${vanYr}-01-01`, actor: 'alicio@example.test' })
  const pstReg = await registerTax({ entityId: van.company.id, tax: 'PST',
    number: 'PST-1234-5678', registeredOn: `${vanYr}-01-01`, actor: 'alicio@example.test' })
  const [pstAccount] = await db.execute<{ id: string; code: string }>(raw`
    SELECT a.id::text, a.code FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${van.company.id} AND ar.role = 'qst_pst_payable'`)
  await postEntry({
    ledgerId: van.ledger.id, entryDate: `${vanYr}-05-10`, description: 'BC sale with PST',
    actor: 'alicio@example.test',
    lines: [
      { accountId: van.id['1200'], amount: parseMoney('1120.00') },
      { accountId: van.id['4000'], amount: -parseMoney('1000.00') },
      { accountId: pstAccount.id, amount: -parseMoney('70.00') },
      { accountId: van.id['2000'], amount: -parseMoney('50.00') },
    ],
  })
  const outside = await db.execute<{ entry_no: string }>(raw`
    SELECT entry_no FROM check_tax_outside_registration(${van.ledger.id}::uuid)`)
  outside.length === 0
    ? pass('R19 PST from a PST-registered company is not a false alarm',
           'one role, two provincial taxes')
    : fail('R19 PST from a PST-registered company is not a false alarm',
           JSON.stringify(outside))

  // R20 is R19's pair: once the PST registration ends, the same entry IS
  // reported. Silence must be earned, not structural.
  await ceaseTax(pstReg.id, `${vanYr}-04-30`, CEASER)
  const nowOutside = await db.execute<{ entry_no: string; tax: string }>(raw`
    SELECT entry_no, tax FROM check_tax_outside_registration(${van.ledger.id}::uuid)`)
  nowOutside.length === 1 && nowOutside[0].tax === 'QST/PST'
    ? pass('R20 the same entry after deregistering IS reported', nowOutside[0].entry_no)
    : fail('R20 the same entry after deregistering IS reported', JSON.stringify(nowOutside))

  // ---------- deregistering keeps the accounts ----------

  const kept = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${van.company.id} AND ar.role = 'qst_pst_payable'`)
  Number(kept[0].n) === 1
    ? pass('R21 deregistering does not remove the account',
           'the returns already filed still need it')
    : fail('R21 deregistering does not remove the account', kept[0].n)

  const backwards = await refused(() => ceaseTax(pstReg.id, `${vanYr - 1}-01-01`, CEASER))
  backwards === 'BAD_DATE'
    ? pass('R22 a registration cannot end before it started', 'refused')
    : fail('R22 a registration cannot end before it started', String(backwards))

  // ---------- who was registered when ----------

  const onDay = await registeredOn(van.company.id, 'PST', `${vanYr}-03-01`)
  const afterDay = await registeredOn(van.company.id, 'PST', `${vanYr}-05-01`)
  onDay?.number === 'PST-1234-5678' && afterDay === null
    ? pass('R23 registration is a date range, not a switch', `ceased ${vanYr}-04-30`)
    : fail('R23 registration is a date range, not a switch',
           JSON.stringify({ onDay, afterDay }))

  const audit = await db.execute<{ action: string; actor: string }>(raw`
    SELECT action, actor FROM audit_log WHERE table_name = 'entity_tax_registration' ORDER BY id`)
  const ceased = audit.filter((a) => a.action === 'cease_tax_registration')
  audit.some((a) => a.action === 'register_tax') && ceased.length > 0
    ? pass('R24 registering and ceasing are both in the audit log',
           `${audit.length} rows`)
    : fail('R24 registering and ceasing are both in the audit log', JSON.stringify(audit))

  // R25 — the person, not the database role.
  //
  // Asserting a name is not enough. It now asserts the recorded actor is what
  // the caller passed AND is not what the database would have supplied on its
  // own, so the two sides cannot coincide however the role is named.
  const [{ role }] = await db.execute<{ role: string }>(raw`SELECT current_user AS role`)
  ceased.length > 0 && ceased.every((a) => a.actor === CEASER && a.actor !== role)
    ? pass('R25 the audit names who ended a registration',
           `${ceased[0].actor}, not the database role "${role}"`)
    : fail('R25 the audit names who ended a registration',
           `role "${role}", actors ${ceased.map((a) => a.actor).join(' ')}`)

  // ---------- the proposed codes fit the chart in front of them ----------

  const crowded = await company('FULL', 'Crowded Chart Ltd.', 'ON')
  await importAccounts(crowded.company.id, [
    { entityId: crowded.company.id, code: '2680', name: 'Deposits held', accountType: 'liability' },
    { entityId: crowded.company.id, code: '1066', name: 'Prepaid rent', accountType: 'asset' },
  ], 'alicio@example.test')
  const proposal = await proposedAccounts(crowded.company.id, 'GST_HST')
  proposal.every((p) => !['2680', '1066'].includes(p.code))
    ? pass('R26 proposed codes step around the ones in use',
           proposal.map((p) => `${p.code} ${p.name}`).join(', '))
    : fail('R26 proposed codes step around the ones in use', JSON.stringify(proposal))

  // R26b — and on an uncrowded chart the proposals ARE the GIFI items the
  //        starter chart uses: 2680 payable, 1066 recoverable (owner,
  //        2026-09-02). A drift back to the pre-GIFI 2100/1300 vocabulary
  //        would quietly split new books from the template.
  const fresh = await company('GIFI', 'Fresh Books Ltd.', 'BC')
  const freshProposal = await proposedAccounts(fresh.company.id, 'GST_HST')
  const freshCodes = freshProposal.map((p) => p.code).sort()
  freshCodes.join(' ') === '1066 2680'
    ? pass('R26b a fresh chart is offered the GIFI codes', freshCodes.join(', '))
    : fail('R26b a fresh chart is offered the GIFI codes', JSON.stringify(freshProposal))

  // ---------- an untagged account is still reported ----------
  //
  // Registering creates the accounts, but nothing stops someone clearing the
  // role afterwards, and then the return goes quiet again.

  const [acmePayable] = await db.execute<{ id: string }>(raw`
    SELECT a.id::text FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${acme.company.id} AND ar.role = 'gst_hst_payable'`)
  await setAccountRoles(acmePayable.id, [], 'alicio@example.test')
  const untagged = (await gstHstReturn(acme.ledger.id, `${yr}-04-01`, `${yr}-06-30`))!
  untagged.lines.collected.amount === 0n
    && untagged.review.some((r) => r.what.includes('No account carries the "GST/HST payable" role'))
    ? pass('R27 registered but untagged still says why it is zero',
           'not "no tax was collected"')
    : fail('R27 registered but untagged still says why it is zero',
           JSON.stringify(untagged.review.map((r) => r.what)))

  // ---------- a registration that lives inside the filing period ----------
  //
  // Asking about the two ends of the range is not the same question. A company
  // registered for the whole of February was registered on neither 1 January
  // nor 31 March, and reading only the endpoints called it never registered
  // while its February tax sat in the books.

  const feb = await company('FEB', 'February Only Ltd.', 'ON')
  const febYr = Number(feb.year.endDate.slice(0, 4))
  const febReg = await registerTax({ entityId: feb.company.id, tax: 'GST_HST',
    number: '777888999RT0001', registeredOn: `${febYr}-02-01`, actor: 'alicio@example.test' })
  await ceaseTax(febReg.id, `${febYr}-02-28`, CEASER)
  const [febTax] = await db.execute<{ id: string }>(raw`
    SELECT a.id::text FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${feb.company.id} AND ar.role = 'gst_hst_payable'`)

  for (const [date, desc] of [[`${febYr}-02-10`, 'Sale while registered'],
                              [`${febYr}-03-15`, 'Sale after ceasing']] as const) {
    await postEntry({
      ledgerId: feb.ledger.id, entryDate: date, description: desc, actor: 'alicio@example.test',
      lines: [
        { accountId: feb.id['1200'], amount: parseMoney('1130.00') },
        { accountId: feb.id['4000'], amount: -parseMoney('1000.00') },
        { accountId: febTax.id, amount: -parseMoney('130.00') },
      ],
    })
  }

  const febQ1 = (await gstHstReturn(feb.ledger.id, `${febYr}-01-01`, `${febYr}-03-31`))!
  febQ1.coverage === 'part' && febQ1.registration?.number === '777888999RT0001'
    && febQ1.review.some((r) => r.what.includes('only part of this period'))
    ? pass('R28 a registration inside the period is not "never registered"',
           `registered ${febYr}-02-01 to ${febYr}-02-28, coverage ${febQ1.coverage}`)
    : fail('R28 a registration inside the period is not "never registered"',
           JSON.stringify({ coverage: febQ1.coverage, reg: febQ1.registration,
                            review: febQ1.review.map((r) => r.what) }))

  // R29 — and the March sale, charged after the registration ended, is named
  const febOutside = febQ1.review.find((r) => r.what.includes('outside the registered period'))
  febOutside?.entries?.length === 1
    && febOutside.entries[0].description === 'Sale after ceasing'
    ? pass('R29 tax charged after ceasing is named', febOutside.entries[0].entryDate)
    : fail('R29 tax charged after ceasing is named',
           JSON.stringify(febQ1.review.map((r) => r.what)))

  // ---------- tax in the books of a company that never registered ----------
  //
  // This is the case the outside-registration check exists for, and it was the
  // one case it never ran on: it sat inside the branch for registered
  // companies, so "not registered" silenced the very listing that mattered.

  const never = await company('NVR', 'Never Registered Ltd.', 'AB')
  const nvrYr = Number(never.year.endDate.slice(0, 4))
  const [nvrTax] = await importAccounts(never.company.id, [
    { entityId: never.company.id, code: '2100', name: 'GST Payable',
      accountType: 'liability', roles: ['gst_hst_payable'] }], 'alicio@example.test')
  await postEntry({
    ledgerId: never.ledger.id, entryDate: `${nvrYr}-02-10`, description: 'Tax it had no right to charge',
    actor: 'alicio@example.test',
    lines: [
      { accountId: never.id['1200'], amount: parseMoney('1130.00') },
      { accountId: never.id['4000'], amount: -parseMoney('1000.00') },
      { accountId: nvrTax.id, amount: -parseMoney('130.00') },
    ],
  })
  const nvrQ1 = (await gstHstReturn(never.ledger.id, `${nvrYr}-01-01`, `${nvrYr}-03-31`))!
  const nvrOutside = nvrQ1.review.find((r) => r.what.includes('outside the registered period'))
  nvrQ1.coverage === 'none' && nvrOutside?.entries?.length === 1
    ? pass('R30 an unregistered company with tax in the books is told',
           `${nvrOutside.entries[0].entryNo} — 130.00 collected with no registration`)
    : fail('R30 an unregistered company with tax in the books is told',
           JSON.stringify(nvrQ1.review.map((r) => r.what)))

  // R31 is R30's pair: an unregistered company with NO tax posted stays quiet.
  const quiet = await company('QUI', 'Quiet Ltd.', 'AB')
  const quietYr = Number(quiet.year.endDate.slice(0, 4))
  const quietQ1 = (await gstHstReturn(quiet.ledger.id, `${quietYr}-01-01`, `${quietYr}-03-31`))!
  !quietQ1.review.some((r) => r.what.includes('outside the registered period'))
    ? pass('R31 an unregistered company with no tax is not scolded', 'the check discriminates')
    : fail('R31 an unregistered company with no tax is not scolded',
           JSON.stringify(quietQ1.review.map((r) => r.what)))

  // ---------- refusals that used to escape as database errors ----------

  const earlier = await refused(() => registerTax({
    entityId: feb.company.id, tax: 'GST_HST', number: 'X',
    registeredOn: `${febYr}-01-01` }))
  earlier === 'ALREADY'
    ? pass('R32 a date before a later registration is refused',
           'not an EXCLUDE constraint error page')
    : fail('R32 a date before a later registration is refused', String(earlier))

  const impossible = await refused(() => registerTax({
    entityId: quiet.company.id, tax: 'GST_HST', number: 'Y',
    registeredOn: `${quietYr}-02-30` }))
  const quietAccounts = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM account WHERE entity_id = ${quiet.company.id}`)
  impossible === 'BAD_DATE' && Number(quietAccounts[0].n) === 7
    ? pass('R33 30 February is refused before anything is written',
           'the format test alone accepted it')
    : fail('R33 30 February is refused before anything is written',
           `${impossible}, ${quietAccounts[0].n} accounts`)

  // ---------- the transaction boundary, actually exercised ----------
  //
  // R13 proves nothing about it: its fixture fails validation, which happens
  // before the first INSERT. This one lets the ACCOUNTS be written and then
  // makes the REGISTRATION fail, by holding a conflicting row in an uncommitted
  // transaction on a second connection until the insert has blocked on it.

  const race = await company('RAC', 'Race Condition Ltd.', 'AB')
  const raceYr = Number(race.year.endDate.slice(0, 4))
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const holder = conn.begin(async (tx) => {
    // This deliberately uncommitted constraint fixture must not acquire the
    // new company audit head before the real registration has written accounts.
    // EXCLUDE constraints remain active; the attempt uses normal trigger mode.
    await tx`SET LOCAL session_replication_role='replica'`
    await tx`
      INSERT INTO entity_tax_registration (entity_id, tax, number, registered_on, created_by)
      VALUES (${race.company.id}::uuid, 'GST_HST', 'RACE-0001', ${`${raceYr}-01-01`}::date, 'other session')`
    await gate
  })
  await new Promise((r) => setTimeout(r, 100))

  // Its pre-check cannot see an uncommitted row, so it proceeds, creates the
  // accounts, and blocks on the EXCLUDE constraint at the registration insert.
  const attempt = registerTax({
    entityId: race.company.id, tax: 'GST_HST',
    number: '000111222RT0001', registeredOn: `${raceYr}-06-01`, actor: 'alicio@example.test',
  }).then(() => null).catch((e) => e as { code?: string })

  // Wait for the insert to ACTUALLY block, rather than for a length of time.
  //
  // A fixed sleep made this check pass without testing anything: put an 800ms
  // delay inside registerTax and the holder commits first, the pre-check sees
  // the committed row, and it refuses before writing a single account — every
  // assertion below still true, the transaction boundary never touched. Waiting
  // on the observed lock cannot degrade that way; if it never blocks, the wait
  // times out and the check goes red.
  let blocked = false
  for (let i = 0; i < 100 && !blocked; i++) {
    const [w] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND query ILIKE '%entity_tax_registration%'`)
    blocked = Number(w.n) > 0
    if (!blocked) await new Promise((r) => setTimeout(r, 50))
  }
  release()
  await holder
  const raced = await attempt

  const raceAccounts = await db.execute<{ n: string; roles: string }>(raw`
    SELECT count(*)::text AS n,
           (SELECT count(*)::text FROM account a JOIN account_role ar ON ar.account_id = a.id
             WHERE a.entity_id = ${race.company.id}
               AND ar.role IN ('gst_hst_payable','gst_hst_recoverable')) AS roles
      FROM account WHERE entity_id = ${race.company.id}`)

  // `RACE` and not `ALREADY`: the guard refusing before any write would satisfy
  // every other assertion here while proving nothing. Only the constraint can
  // produce RACE, and it can only produce it after the accounts were written.
  blocked && raced?.code === 'RACE'
    && Number(raceAccounts[0].n) === 7 && raceAccounts[0].roles === '0'
    ? pass('R34 a registration that fails AFTER writing accounts writes neither half',
           'the insert blocked, then failed; 7 accounts, no tax accounts left behind')
    : fail('R34 a registration that fails AFTER writing accounts writes neither half',
           `${blocked ? 'blocked' : 'NEVER BLOCKED — the boundary was not reached'}, ` +
           `${raced === null ? 'it succeeded' : raced.code}, ${raceAccounts[0].n} accounts, ` +
           `${raceAccounts[0].roles} tagged`)

  // R35 — and the loser is told something a person can act on, not a driver error
  raced !== null && raced.code === 'RACE' && /Nothing was saved/.test(String(raced))
    ? pass('R35 the losing side of the race gets an answer',
           'a RegistrationError saying nothing was saved, not DrizzleQueryError')
    : fail('R35 the losing side of the race gets an answer',
           raced === null ? 'it succeeded' : `${raced.code} ${String(raced)}`)

  // ---------- coverage at the edges ----------
  //
  // The whole "not registered / partly registered / registered" distinction
  // rests on this one function, and a day either way changes the answer. Dates
  // are inclusive at both ends, so a registration ending on the last day of the
  // period covers the period, and one ending the day before does not.

  const span = (registeredOn: string, ceasedOn: string | null) =>
    ({ id: '', tax: 'GST_HST' as const, number: '', registeredOn, ceasedOn, active: true })

  const cases: Array<[string, Registration[], string, string, 'none' | 'part' | 'all']> = [
    ['nothing at all',                 [],                                              '2026-01-01', '2026-03-31', 'none'],
    ['open-ended from before',         [span('2025-06-01', null)],                       '2026-01-01', '2026-03-31', 'all'],
    ['starts exactly on the first day',[span('2026-01-01', null)],                       '2026-01-01', '2026-03-31', 'all'],
    ['starts one day late',            [span('2026-01-02', null)],                       '2026-01-01', '2026-03-31', 'part'],
    ['ends exactly on the last day',   [span('2025-06-01', '2026-03-31')],               '2026-01-01', '2026-03-31', 'all'],
    ['ends one day early',             [span('2025-06-01', '2026-03-30')],               '2026-01-01', '2026-03-31', 'part'],
    ['two adjacent, no gap',           [span('2025-06-01','2026-02-28'), span('2026-03-01', null)], '2026-01-01', '2026-03-31', 'all'],
    ['two with a one-day gap',         [span('2025-06-01','2026-02-28'), span('2026-03-02', null)], '2026-01-01', '2026-03-31', 'part'],
    ['handed to it out of order',      [span('2026-03-01', null), span('2025-06-01','2026-02-28')], '2026-01-01', '2026-03-31', 'all'],
    ['entirely inside the period',     [span('2026-02-01','2026-02-28')],                '2026-01-01', '2026-03-31', 'part'],
    ['a single day, covered',          [span('2026-01-15','2026-01-15')],                '2026-01-15', '2026-01-15', 'all'],
    ['a single day, ended the day before', [span('2026-01-01','2026-01-14')],            '2026-01-15', '2026-01-15', 'none'],
    ['ended before the range began',   [span('2025-01-01','2025-06-30')],               '2026-01-01', '2026-03-31', 'none'],
    ['starts after the range ends',    [span('2027-01-01', null)],                      '2026-01-01', '2026-03-31', 'none'],
    ['one covering, one from another year', [span('2024-01-01','2024-12-31'), span('2025-06-01', null)], '2026-01-01', '2026-03-31', 'all'],
    ['crossing a year end',            [span('2025-12-31', null)],                       '2026-01-01', '2026-03-31', 'all'],
    ['ending on a leap day',           [span('2023-01-01','2024-02-29'), span('2024-03-01', null)], '2024-01-01', '2024-12-31', 'all'],
  ]
  const wrong = cases.filter(([, rs, f, t, want]) => coverageOf(rs, f, t) !== want)
  wrong.length === 0
    ? pass('R36 coverage is exact at the edges', `${cases.length} cases, inclusive both ends`)
    : fail('R36 coverage is exact at the edges',
           wrong.map(([name, rs, f, t, want]) => `${name}: wanted ${want}, got ${coverageOf(rs, f, t)}`).join('; '))

  // ---------- ending a registration has the same guards as starting one ----------

  const twoSpans = await company('TWO', 'Two Registrations Ltd.', 'ON')
  const twoYr = Number(twoSpans.year.endDate.slice(0, 4))
  const firstReg = await registerTax({ entityId: twoSpans.company.id, tax: 'GST_HST',
    number: '121212121RT0001', registeredOn: `${twoYr}-01-01`, actor: 'alicio@example.test' })
  await ceaseTax(firstReg.id, `${twoYr}-02-28`, CEASER)
  await registerTax({ entityId: twoSpans.company.id, tax: 'GST_HST',
    number: '121212121RT0002', registeredOn: `${twoYr}-03-01`, actor: 'alicio@example.test' })

  const intoNext = await refused(() => ceaseTax(firstReg.id, `${twoYr}-06-30`, CEASER))
  intoNext === 'OVERLAP'
    ? pass('R37 an end date running into the next registration is refused',
           'not a DrizzleQueryError')
    : fail('R37 an end date running into the next registration is refused', String(intoNext))

  // R38 is R37's pair: a legal end date is accepted AND actually written.
  //
  // Its first version re-ceased to the date the row already held, so the
  // assertion could not fail — with the UPDATE turned into a no-op, all 38
  // checks stayed green. Correcting a mistyped end date is the reason
  // re-ceasing is allowed at all, so it has to be the thing tested: this moves
  // the date, and reads it back.
  const upToIt = await refused(() => ceaseTax(firstReg.id, `${twoYr}-02-27`, CEASER))
  const [reCeased] = await db.execute<{ ceased_on: string }>(raw`
    SELECT ceased_on::text FROM entity_tax_registration WHERE id = ${firstReg.id}`)
  upToIt === null && reCeased.ceased_on === `${twoYr}-02-27`
    ? pass('R38 a corrected end date is accepted and written',
           `${twoYr}-02-28 -> ${reCeased.ceased_on}`)
    : fail('R38 a corrected end date is accepted and written',
           `${upToIt}, ceased ${reCeased.ceased_on}`)

  // R39 — and the correction is in the audit log, which is the other half of
  //       why re-ceasing is allowed. The trigger only fires on a CHANGED date,
  //       so the check that re-ceased to the same date proved nothing here
  //       either.
  const ceaseTrail = await db.execute<{ actor: string; before: unknown; after: unknown }>(raw`
    SELECT actor, before, after FROM audit_log
     WHERE table_name = 'entity_tax_registration' AND record_id = ${firstReg.id}
       AND action = 'cease_tax_registration' ORDER BY id`)
  ceaseTrail.length === 2
    && ceaseTrail.every((c) => c.actor === CEASER)
    && JSON.stringify(ceaseTrail[1].before).includes(`${twoYr}-02-28`)
    && JSON.stringify(ceaseTrail[1].after).includes(`${twoYr}-02-27`)
    ? pass('R39 correcting an end date leaves a trail',
           `${ceaseTrail.length} entries, the second ${twoYr}-02-28 -> ${twoYr}-02-27`)
    : fail('R39 correcting an end date leaves a trail',
           JSON.stringify(ceaseTrail))

  // ---------- what the path a person actually uses records ----------
  //
  // R25 exercises `ceaseTax` directly with a string no shipped path produces.
  // That proves the actor flows through, and proves nothing about the browser,
  // which is the only way the owner will ever end a registration. There is no
  // login here, so `actor` names the SURFACE — and the value that surface
  // passes has to be checked where it is written, not where it is convenient.

  const handlerSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'tax-forms.ts'), 'utf8')
  const actionsSrc = readFileSync(join(process.cwd(), 'src', 'app', 'actions.ts'), 'utf8')
  /** The body of one exported function, so a match cannot come from its neighbour. */
  const bodyOf = (src: string, name: string) => {
    const start = src.indexOf(`export async function ${name}`)
    if (start < 0) return ''
    const next = src.indexOf('\nexport ', start + 1)
    return src.slice(start, next < 0 ? undefined : next)
  }
  // What this asserts CHANGED with 0053. It used to require both handlers to
  // pass the named constant `WEB_ACTOR`, because the audit could record only
  // which SURFACE a change came through. Now they must pass the actor they were
  // GIVEN — the signed-in person, from `currentActor()` — and must not go back
  // to any hardcoded string, whether 'web' or anything else.
  const handlers = ['registerTaxFromForm', 'ceaseTaxFromForm'].map((n) => bodyOf(handlerSrc, n))
  const missing = handlers.filter((b) => !/\bactor\b/.test(b)).length
  const loose = handlerSrc.includes(`'${WEB_ACTOR}'`) || actionsSrc.includes(`'${WEB_ACTOR}'`)
    || /actor:\s*'[^']+'/.test(handlerSrc)
  const carried = actionsSrc.includes('currentActor()')
  missing === 0 && !loose && carried
    ? pass('R40 the web layer passes the person it was given, not a literal',
           'both tax handlers take an actor and pass it; the actions supply currentActor()')
    : fail('R40 the web layer passes the person it was given, not a literal',
           missing > 0 ? `${missing} handler(s) do not`
             : !carried ? 'the actions no longer supply the signed-in person'
             : 'a hardcoded actor remains')

  // R41 — what lands in the audit is the actor the caller passed, and it is
  //       distinguishable from the database role. That second half is what 0016
  //       bought: `current_user` is the same string for the web app and for
  //       every script, so it could not tell them apart. 0053 went further —
  //       the actor is now a PERSON, so the check passes an identity that is
  //       obviously neither the role nor the old placeholder.
  const surface = await company('SUR', 'Surface Ltd.', 'AB')
  const surYr = Number(surface.year.endDate.slice(0, 4))
  const WHO = 'bookkeeper@example.test'
  const surReg = await registerTax({ entityId: surface.company.id, tax: 'GST_HST',
    number: '999888777RT0001', registeredOn: `${surYr}-01-01`, actor: WHO })
  await ceaseTax(surReg.id, `${surYr}-06-30`, WHO)
  const [surRow] = await db.execute<{ actor: string }>(raw`
    SELECT actor FROM audit_log
     WHERE record_id = ${surReg.id} AND action = 'cease_tax_registration'`)
  surRow.actor === WHO && surRow.actor !== role && String(WHO) !== String(WEB_ACTOR)
    ? pass('R41 the audit records the person the caller named',
           `"${surRow.actor}" — not the database role "${role}", and not the old "${WEB_ACTOR}"`)
    : fail('R41 the audit records the person the caller named',
           `${surRow?.actor} against role ${role}`)

  // ---------- the form the owner actually fills in ----------
  //
  // R40 reads the source of the action and R41 calls the library. Neither one
  // travels the path between them, and it showed: renaming `name="ceasedOn"` in
  // the component broke every cease from the browser — the action read a field
  // that no longer existed and refused with BAD_DATE — while all 41 checks and
  // `tsc` stayed green.
  //
  // These build a FormData from the SAME `TAX_FIELDS` the component renders and
  // drive the real handler. The spelling now lives in one place, so it cannot
  // be right on one side and wrong on the other.

  const form = await company('FRM', 'Form Path Ltd.', 'ON')
  const formYr = Number(form.year.endDate.slice(0, 4))

  const reg1 = new FormData()
  reg1.set(TAX_FIELDS.ledgerId, form.ledger.id)
  reg1.set(TAX_FIELDS.entityId, form.company.id)
  reg1.set(TAX_FIELDS.tax, 'GST_HST')
  reg1.set(TAX_FIELDS.number, '246813579RT0001')
  reg1.set(TAX_FIELDS.registeredOn, `${formYr}-01-01`)
  reg1.set(TAX_FIELDS.code(0), '2150')
  reg1.set(TAX_FIELDS.name(0), 'HST Collected')
  reg1.set(TAX_FIELDS.code(1), '1350')
  reg1.set(TAX_FIELDS.name(1), 'HST Paid')
  const registered = await registerTaxFromForm(reg1, 'alicio@example.test')

  const formAccounts = await db.execute<{ code: string; name: string; role: string }>(raw`
    SELECT a.code, a.name, ar.role FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${form.company.id}
       AND ar.role IN ('gst_hst_payable','gst_hst_recoverable') ORDER BY a.code`)
  registered.error === undefined && formAccounts.length === 2
    && formAccounts.some((m) => m.code === '2150' && m.name === 'HST Collected')
    && formAccounts.some((m) => m.code === '1350' && m.name === 'HST Paid')
    ? pass('R42 the register form creates the accounts it was given',
           formAccounts.map((m) => `${m.code} ${m.name}`).join(', '))
    : fail('R42 the register form creates the accounts it was given',
           `${registered.error ?? 'ok'}, ${JSON.stringify(formAccounts)}`)

  const [regRow] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM entity_tax_registration WHERE entity_id = ${form.company.id}`)
  const cease = new FormData()
  cease.set(TAX_FIELDS.ledgerId, form.ledger.id)
  cease.set(TAX_FIELDS.registrationId, regRow.id)
  cease.set(TAX_FIELDS.ceasedOn, `${formYr}-09-30`)
  // The form is driven with a real identity, because that is what the action
  // supplies now — `currentActor()`, the signed-in person's email (0053).
  const CEASED_BY = 'alicio@example.test'
  const ceased2 = await ceaseTaxFromForm(cease, CEASED_BY)

  const [ceasedRow] = await db.execute<{ ceased_on: string | null; ceased_by: string | null }>(raw`
    SELECT ceased_on::text, ceased_by FROM entity_tax_registration WHERE id = ${regRow.id}`)
  ceased2.error === undefined && ceasedRow.ceased_on === `${formYr}-09-30`
    && ceasedRow.ceased_by === CEASED_BY
    ? pass('R43 the cease form ends the registration it names',
           `${ceasedRow.ceased_on} by ${ceasedRow.ceased_by}`)
    : fail('R43 the cease form ends the registration it names',
           `${ceased2.error ?? 'ok'}, ceased ${ceasedRow.ceased_on} by ${ceasedRow.ceased_by}`)

  // R44 — the form's own field names, not a copy of them. If the component ever
  //       spells one itself, the two sides can drift again and R42/R43 would go
  //       on passing against their own private spelling.
  // EVERY file that renders an input, not just the biggest one. `AccountRow.tsx`
  // renders three of the eleven — including the hidden `role<i>` this round's
  // whole argument rests on — and was unscanned while the check was described
  // as covering the form's spelling.
  const inputFiles = ['TaxFormFields.tsx', 'AccountRow.tsx', 'AccountRows.tsx']
  const formSrc = inputFiles
    .map((f) => readFileSync(join(process.cwd(), 'src', 'app', 'ledger',
      '[ledgerId]', 'tax', 'registration', f), 'utf8'))
    .join('\n')
  // Any spelling of its own, quoted however. The first version tested for
  // double-quoted literals only, which `name={'ceasedOn'}` and
  // `` name={`code${i + 1}`} `` both slip past.
  const ownName = formSrc.match(/name=(?:"[^"]*"|'[^']*'|\{(?:'[^']*'|"[^"]*"|`[^`]*`)\})/g) ?? []
  ownName.length === 0 && formSrc.includes('TAX_FIELDS')
    ? pass('R44 the form spells no field name of its own', 'one name, one place')
    : fail('R44 the form spells no field name of its own',
           ownName.join(' ') || 'TAX_FIELDS not imported')

  // R46 — a row goes to the account it was posted against, and a row that did
  //       not arrive leaves that account as proposed.
  //
  // The first version of this compacted the list, so a form posting only the
  // SECOND row put its code and name on the FIRST account: the person's
  // recoverable code landed on their payable, and the registration reported
  // success. Position in the form is which account, not how many arrived.
  const sparse = await company('SPR', 'Sparse Row Ltd.', 'ON')
  const sparseProposal = await proposedAccounts(sparse.company.id, 'GST_HST')
  const sparseForm = new FormData()
  sparseForm.set(TAX_FIELDS.ledgerId, sparse.ledger.id)
  sparseForm.set(TAX_FIELDS.entityId, sparse.company.id)
  sparseForm.set(TAX_FIELDS.tax, 'GST_HST')
  sparseForm.set(TAX_FIELDS.number, '112233445RT0001')
  sparseForm.set(TAX_FIELDS.registeredOn, `${Number(sparse.year.endDate.slice(0, 4))}-01-01`)
  // Only the SECOND row, and no count field at all.
  sparseForm.set(TAX_FIELDS.code(1), '1999')
  sparseForm.set(TAX_FIELDS.name(1), 'Reclaimable Tax')
  const sparseResult = await registerTaxFromForm(sparseForm, 'alicio@example.test')

  const sparseMade = await db.execute<{ code: string; name: string; role: string }>(raw`
    SELECT a.code, a.name, ar.role FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${sparse.company.id}
       AND ar.role IN ('gst_hst_payable','gst_hst_recoverable') ORDER BY ar.role`)
  const sparsePayable = sparseMade.find((m) => m.role === 'gst_hst_payable')
  const sparseRecoverable = sparseMade.find((m) => m.role === 'gst_hst_recoverable')
  sparseResult.error === undefined
    && sparsePayable?.code === sparseProposal[0].code && sparsePayable.name === sparseProposal[0].name
    && sparseRecoverable?.code === '1999' && sparseRecoverable.name === 'Reclaimable Tax'
    ? pass('R46 a row configures the account it was posted against',
           `payable left as proposed ${sparsePayable.code}, recoverable ${sparseRecoverable.code}`)
    : fail('R46 a row configures the account it was posted against',
           `${sparseResult.error ?? 'ok'}, ${JSON.stringify(sparseMade)}`)

  // ---------- which day it is here ----------
  //
  // `active`, the "ended" badge and the cease form's wording all turn on
  // today's date. Using the UTC day instead of the local one, this machine
  // being in Vancouver, made a registration ended effective today read as
  // already ended — every evening from 17:00 until midnight, and never in the
  // morning. Checked against `new Date()` alone, a check would pass all day and
  // the bug would be waiting each night, so the instant is chosen instead.

  const offsetMinutes = -new Date('2026-08-23T12:00:00Z').getTimezoneOffset()
  if (offsetMinutes === 0) {
    pass('R45 the day is the local day, not the UTC day',
         'skipped: this machine runs on UTC, where the two never differ')
  } else {
    // An instant that falls on a different calendar day here than in UTC.
    const instant = offsetMinutes < 0
      ? new Date('2026-08-23T00:30:00Z')   // west: still yesterday here
      : new Date('2026-08-22T23:30:00Z')   // east: already tomorrow here
    const here = dayIn(instant)
    const utc = instant.toISOString().slice(0, 10)
    // Both halves matter. "Not the UTC day" alone passed with the formatter
    // switched to en-US, which returns 8/22/2026 — a string that is not the
    // UTC day and is not a date any column here can be compared against
    // either, so `active` inverts and every default date is refused.
    const shaped = /^\d{4}-\d{2}-\d{2}$/.test(here)
    shaped && here !== utc
      ? pass('R45 the day is the local day, not the UTC day',
             `${instant.toISOString()} is ${here} here, ${utc} in UTC`)
      : fail('R45 the day is the local day, not the UTC day',
             !shaped ? `"${here}" is not a YYYY-MM-DD date`
                     : `both say ${here} at an instant chosen to separate them`)
  }

  // R50 — `partsOf` reads the same clock `dayIn` does.
  //
  // R47 cannot see this one and never could: it looks for the current moment
  // being read through UTC, and `partsOf(at: Date)` takes its instant as an
  // argument. Reverting its three accessors to `getUTC…` put `filingPeriods`
  // and `currentYearEnd` back on the UTC clock with every suite green, because
  // the helper both of them now depend on had no check of its own.
  if (offsetMinutes !== 0) {
    const probe = offsetMinutes < 0
      ? new Date('2026-08-23T00:30:00Z')
      : new Date('2026-08-22T23:30:00Z')
    const parts = partsOf(probe)
    const asDay = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
    asDay === dayIn(probe) && asDay !== probe.toISOString().slice(0, 10)
      ? pass('R50 the calendar parts are the local ones', `${probe.toISOString()} -> ${asDay}`)
      : fail('R50 the calendar parts are the local ones',
             `partsOf says ${asDay}, dayIn says ${dayIn(probe)}, UTC says ${probe.toISOString().slice(0, 10)}`)
  } else {
    pass('R50 the calendar parts are the local ones',
         'skipped: this machine runs on UTC, where the two never differ')
  }

  // R47 — and no OTHER file asks the UTC day what today is.
  //
  // R45 watches the helper. The bug shipped in the callers, and it shipped
  // twice: the registration page, and the new-entry date default in a feature
  // built weeks earlier, which was still wrong when critic found it. A helper
  // nobody is required to use is a suggestion.
  // The rule: a file that takes the current moment (`new Date()` with no
  // argument, or a `= new Date()` default) must not then read it through UTC.
  //
  // Scanning for one idiom was not enough. `filingPeriods` and `currentYearEnd`
  // both spelled it `getUTCFullYear()` on a `today = new Date()` parameter, and
  // on the evening of 31 December that listed the quarters of a year that had
  // not started and gave a new company a fiscal year a year out. UTC arithmetic
  // on a date parsed from a string is fine and common here — `nextDay`, the
  // fiscal calendar — so the trigger is the pair, not the accessor.
  //
  // Two shapes, because the bug appeared in both:
  //   `new Date().toISOString()`        — read the moment through UTC on the spot
  //   `(today = new Date())` … `today.getUTCFullYear()` — through a parameter
  //
  // Anything applied to a date PARSED from a string is left alone. The fiscal
  // calendar in setup.ts is built entirely from UTC arithmetic on parsed dates
  // and is correct; a rule that flagged the file rather than the value called it
  // a defect too, which is how a check gets switched off.
  const utcToday: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.tsx?$/.test(entry.name)) continue
      if (full.endsWith(join('lib', 'today.ts'))) continue   // where it is explained
      let src = readFileSync(full, 'utf8')
      const here = full.replace(process.cwd() + '/', '')

      // A restore event needs the exact UTC instant for audit provenance.
      // It is never used as a calendar day or a default business date.
      if (here === 'src/lib/backup.ts') {
        src = src.replace('const restoredAt = new Date().toISOString()', '')
      }

      // Export provenance is an instant, never a default accounting date.
      if (here === 'src/lib/project-export.ts') {
        src = src.replace("['Generated at',new Date().toISOString()]", '')
      }
      // Mail approval provenance is an exact instant; sending dates use companyClock.
      if (here === 'src/lib/mail.ts') {
        src = src.replace('generatedAt:new Date().toISOString()', '')
      }
      // Canonical checkpoint creation is an exact audit instant, not a business day.
      if (here === 'src/lib/audit-chain.ts') {
        src = src.replaceAll('createdAt:new Date().toISOString()', '')
      }
      // The saved pay-period forecast records its calculation instant, never a business date.
      if (here === 'src/lib/production-labour-accrual.ts') {
        src = src.replace('calculatedAt:new Date().toISOString()', '')
      }
      if (/new Date\(\)\s*\.\s*(getUTC[A-Z]|toISOString)/.test(src)) {
        utcToday.push(`${here} (on the spot)`)
        continue
      }
      // A parameter defaulted to the current moment, then read through UTC.
      for (const m of src.matchAll(/(\w+)\s*=\s*new Date\(\)/g)) {
        const name = m[1]
        if (new RegExp(`\\b${name}\\s*\\.\\s*(getUTC[A-Z]|toISOString)`).test(src)) {
          utcToday.push(`${here} (via ${name})`)
          break
        }
      }
    }
  }
  walk(join(process.cwd(), 'src'))
  utcToday.length === 0
    ? pass('R47 nothing reads the current moment through UTC', 'the local clock everywhere')
    : fail('R47 nothing reads the current moment through UTC', utcToday.join(' '))

  // ---------- what the account inputs actually post ----------
  //
  // Sharing the names stopped the two sides SPELLING a field differently. It
  // did not stop one input carrying the other's field: changing the code box's
  // `name` to the name box's — one token — posts `name0` twice and no `code0`,
  // so every code typed is discarded and `registerTax` falls back to its
  // proposed defaults. Registration succeeds and says so. All 47 checks passed.
  //
  // This renders the row and reads back what it emits, then posts exactly that
  // and checks the values arrive where the labels said they would.

  /**
   * Render the real row list and read back what it posts.
   *
   * The whole list, because the index each row is given is half the contract:
   * rendering one row at a time let this choose the index itself, and
   * `index={i + 1}` in the caller went unnoticed while it put one account's
   * code and name onto another.
   */
  type RenderedForm = { action: string; submit: string; fields: Record<string, string> }

  /**
   * Render the page's whole body and read back every form it contains.
   *
   * The whole page, because the defect that survived six rounds of narrower
   * checks was a whole value of the right type substituted at a call site —
   * `row={view.rows[0]}` makes every cease form end the FIRST registration,
   * whichever card it sits under, with nothing unpacked and every type
   * agreeing. No check over the source can see that. What the forms say can.
   */
  const renderPage = (input: {
    today?: string
    view: { open: unknown[]; rows: unknown[] }
    proposals: unknown[]
  }): RenderedForm[] =>
    JSON.parse(execFileSync('npx',
      ['tsx', 'scripts/render-tax-fields.tsx', JSON.stringify(input)],
      // Without clearing NODE_OPTIONS the child inherits --conditions=react-server,
      // where react-dom/server refuses to load. The suite needs that condition;
      // rendering a component is exactly the thing it forbids.
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }))

  /** One register form for a proposal, on a page with no registrations. */
  const renderForm = (
    which: 'register' | 'cease',
    rows: Array<{ code: string; name: string; role: string }> = [],
  ): Record<string, string> => {
    const proposal = {
      tax: 'GST_HST', label: 'HST',
      rows: rows.map((r) => ({ ...r, accountType: 'liability', why: '' })),
    }
    const reg = {
      registration: { id: 'R', tax: 'GST_HST', number: 'N',
                      registeredOn: '2026-01-01', ceasedOn: null, active: true },
      badge: null, mode: 'end', defaultDate: '2026-06-30',
    }
    const forms = renderPage(which === 'register'
      ? { view: { open: [], rows: [] }, proposals: [proposal] }
      : { view: { open: [], rows: [reg] }, proposals: [] })
    return forms[0]?.fields ?? {}
  }

  const emitted = renderForm('register', [
    { code: 'RC0', name: 'RN0', role: 'gst_hst_payable' },
    { code: 'RC1', name: 'RN1', role: 'gst_hst_recoverable' }])
  emitted[TAX_FIELDS.code(0)] === 'RC0' && emitted[TAX_FIELDS.name(0)] === 'RN0'
    && emitted[TAX_FIELDS.code(1)] === 'RC1' && emitted[TAX_FIELDS.name(1)] === 'RN1'
    ? pass('R48 each box posts under its own field, at its own row',
           Object.keys(emitted).join(' '))
    : fail('R48 each box posts under its own field, at its own row',
           `rendered ${JSON.stringify(emitted)}`)

  // R54 — reordering the rows anywhere between the proposal and the handler
  //        changes nothing, because each row says what it is.
  //
  // Five rounds found this same defect at five different hops: the row's index,
  // the list's array, the array handed to the form, the array handed by the
  // page. Each fix moved the seam one step outward. A row that carries its role
  // cannot be misplaced by anything that carries it, so there is no hop left
  // for the sixth.
  const reordered = await company('REO', 'Reordered Ltd.', 'ON')
  const reoProposal = await proposedAccounts(reordered.company.id, 'GST_HST')
  const reoTyped = reoProposal.map((row, i) => ({
    code: i === 0 ? '2888' : '1888',
    name: i === 0 ? 'What I Owe' : 'What I Reclaim',
    role: row.role,
  }))
  const reoForm = new FormData()
  // Rendered from the proposal REVERSED — as a mislaid `.reverse()` anywhere in
  // the chain would produce.
  for (const [k, v] of Object.entries(renderForm('register', [...reoTyped].reverse()))) {
    reoForm.set(k, v)
  }
  reoForm.set(TAX_FIELDS.ledgerId, reordered.ledger.id)
  reoForm.set(TAX_FIELDS.entityId, reordered.company.id)
  reoForm.set(TAX_FIELDS.number, '555000555RT0001')
  reoForm.set(TAX_FIELDS.registeredOn, `${Number(reordered.year.endDate.slice(0, 4))}-01-01`)
  const reoResult = await registerTaxFromForm(reoForm, 'alicio@example.test')

  const reoMade = await db.execute<{ code: string; name: string; role: string }>(raw`
    SELECT a.code, a.name, ar.role FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${reordered.company.id}
       AND ar.role IN ('gst_hst_payable','gst_hst_recoverable') ORDER BY ar.role`)
  const reoPayable = reoMade.find((m) => m.role === 'gst_hst_payable')
  const reoRecoverable = reoMade.find((m) => m.role === 'gst_hst_recoverable')
  reoResult.error === undefined
    && reoPayable?.code === '2888' && reoPayable.name === 'What I Owe'
    && reoRecoverable?.code === '1888' && reoRecoverable.name === 'What I Reclaim'
    ? pass('R54 rows reordered on the way still reach the right accounts',
           `payable ${reoPayable.code}, recoverable ${reoRecoverable.code}`)
    : fail('R54 rows reordered on the way still reach the right accounts',
           `${reoResult.error ?? 'ok'}, ${JSON.stringify(reoMade)}`)

  // R51 — every field the handler reads is inside the form that submits it.
  //
  // The reverse direction, and the one that kept escaping. Each round extracted
  // a smaller renderable piece and the seam moved out one step: the row, then
  // the row list, then the array passed to it and where the list SAT — moving
  // `<AccountRows/>` outside the `<form>` submitted no account fields at all,
  // created every account from the system defaults, and reported success, with
  // fifty checks green. Only what the form element contains is submitted, so
  // that is what is read back here.
  // The list is READ OFF the handlers, not written here. Hand-written, it was
  // wrong in both directions within a round: it demanded `ledgerId`, which
  // neither handler reads, and omitted `code1`/`name1`, which `accountRowsFrom`
  // does. A list nobody derives is a list nobody maintains.
  const formsSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'tax-forms.ts'), 'utf8')
  const actionsFileSrc = readFileSync(join(process.cwd(), 'src', 'app', 'actions.ts'), 'utf8')

  /** One function's body, bounded within its own file. */
  const bodyIn = (src: string, name: string) => {
    const at = src.indexOf(`export async function ${name}`)
    if (at < 0) return ''
    const next = src.indexOf('\nexport ', at + 1)
    return src.slice(at, next < 0 ? undefined : next)
  }

  const readBy = (...bodies: string[]) => {
    const names = new Set<string>()
    for (const b of bodies) {
      for (const m of b.matchAll(/formData\.get\((?:F|TAX_FIELDS)\.(\w+)\)/g)) names.add(m[1])
    }
    return names
  }

  const registerReads = readBy(bodyIn(formsSrc, 'registerTaxFromForm'),
                               bodyIn(actionsFileSrc, 'registerTaxAction'))
  const ceaseReads = readBy(bodyIn(formsSrc, 'ceaseTaxFromForm'),
                            bodyIn(actionsFileSrc, 'ceaseTaxAction'))

  const registerFields = new Set(Object.keys(emitted))
  const ceaseFields = new Set(Object.keys(renderForm('cease')))
  const absent = [
    ...[...registerReads].filter((f) => !registerFields.has(f)).map((f) => `register.${f}`),
    ...[...ceaseReads].filter((f) => !ceaseFields.has(f)).map((f) => `cease.${f}`),
    // `accountRowsFrom` reads the indexed rows, which no `formData.get` names.
    ...[TAX_FIELDS.code(0), TAX_FIELDS.name(0)].filter((f) => !registerFields.has(f))
        .map((f) => `register.${f}`),
  ]
  // EVERY body must contribute. Per-side minimums were still too coarse: the
  // cease side needs only 1 to pass, so losing `ceaseTaxFromForm` entirely
  // leaves `ledgerId` from the action and the check goes green having dropped
  // the only two fields the cease form exists to carry. A body that yields
  // nothing is a body the scan did not find.
  const perBody = {
    registerTaxFromForm: readBy(bodyIn(formsSrc, 'registerTaxFromForm')).size,
    ceaseTaxFromForm: readBy(bodyIn(formsSrc, 'ceaseTaxFromForm')).size,
    registerTaxAction: readBy(bodyIn(actionsFileSrc, 'registerTaxAction')).size,
    ceaseTaxAction: readBy(bodyIn(actionsFileSrc, 'ceaseTaxAction')).size,
  }
  const silent = Object.entries(perBody).filter(([, n]) => n === 0).map(([n]) => n)
  const enough = silent.length === 0
  absent.length === 0 && enough
    ? pass('R51 every field the handlers read is inside the form',
           `${registerReads.size} register + ${ceaseReads.size} cease field reads, all present`)
    : fail('R51 every field the handlers read is inside the form',
           !enough ? `the scan found no field reads in ${silent.join(', ')}`
                   : absent.join(' '))

  // R49 — and driving the handler with exactly what the component renders
  //       creates the accounts those boxes described.
  const wired = await company('WIR', 'Wired Up Ltd.', 'ON')
  const wiredYr = Number(wired.year.endDate.slice(0, 4))
  const typed = [{ code: '2777', name: 'Tax I Owe', role: 'gst_hst_payable' },
                 { code: '1777', name: 'Tax I Reclaim', role: 'gst_hst_recoverable' }]

  // Start from what the form actually renders — every field, at the names it
  // gives them — then fill in the boxes a person types into and the ids this
  // company really has. What is NOT overridden is the account rows, which is
  // the part under test.
  const wiredForm = new FormData()
  for (const [k, v] of Object.entries(renderForm('register', typed))) wiredForm.set(k, v)
  wiredForm.set(TAX_FIELDS.ledgerId, wired.ledger.id)
  wiredForm.set(TAX_FIELDS.entityId, wired.company.id)
  wiredForm.set(TAX_FIELDS.number, '864208642RT0001')
  wiredForm.set(TAX_FIELDS.registeredOn, `${wiredYr}-01-01`)
  const wiredResult = await registerTaxFromForm(wiredForm, 'alicio@example.test')
  const wiredMade = await db.execute<{ code: string; name: string; role: string }>(raw`
    SELECT a.code, a.name, ar.role FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${wired.company.id}
       AND ar.role IN ('gst_hst_payable','gst_hst_recoverable') ORDER BY a.code`)
  wiredResult.error === undefined
    && wiredMade.some((m) => m.code === '2777' && m.name === 'Tax I Owe' && m.role === 'gst_hst_payable')
    && wiredMade.some((m) => m.code === '1777' && m.name === 'Tax I Reclaim' && m.role === 'gst_hst_recoverable')
    ? pass('R49 what the form renders is what the handler creates',
           wiredMade.map((m) => `${m.code} ${m.name}`).join(', '))
    : fail('R49 what the form renders is what the handler creates',
           `${wiredResult.error ?? 'ok'}, ${JSON.stringify(wiredMade)}`)

  // ---------- what the page decides ----------
  //
  // Which forms appear at all, what each one says, and what date it starts on
  // were decided inside the page component, which nothing renders. Dropping
  // `.active` from one filter meant a company that had ever ceased a
  // registration could never register again — the form vanished and the page
  // announced it was registered for everything. Defaulting the date to today
  // gave a not-yet-started registration a value its own guard refuses. Both
  // passed every check.

  const span2 = (registeredOn: string, ceasedOn: string | null, active: boolean) =>
    ({ id: registeredOn, tax: 'GST_HST' as const, number: 'N', registeredOn, ceasedOn, active })
  const bcTaxes = taxesFor('BC')          // GST + PST
  const TODAY = '2026-06-15'

  const viewCases: Array<[string, Registration[], (v: ReturnType<typeof registrationView>) => boolean, string]> = [
    ['nothing registered offers both taxes', [],
     (v) => v.open.length === 2, 'GST and PST'],
    ['a live registration closes its own form',
     [span2('2026-01-01', null, true)],
     (v) => v.open.length === 1 && v.open[0].tax === 'PST', 'PST still open'],
    ['a ceased registration re-opens the form',
     [span2('2025-01-01', '2025-12-31', false)],
     (v) => v.open.length === 2, 'it can be picked up again'],
    ['a live one is offered no badge and an end form',
     [span2('2026-01-01', null, true)],
     (v) => v.rows[0].badge === null && v.rows[0].mode === 'end' && v.rows[0].defaultDate === TODAY, ''],
    ['an ended one is badged and offers a correction',
     [span2('2025-01-01', '2025-12-31', false)],
     (v) => v.rows[0].badge === 'ended' && v.rows[0].mode === 'correct'
            && v.rows[0].defaultDate === '2025-12-31', ''],
    ['one ending later is live and offers a change',
     [span2('2026-01-01', '2026-12-31', true)],
     (v) => v.rows[0].badge === null && v.rows[0].mode === 'change'
            && v.rows[0].defaultDate === '2026-12-31', ''],
    ['one not started yet is badged and defaults to its start date',
     [span2('2026-09-01', null, false)],
     (v) => v.rows[0].badge === 'starts later' && v.rows[0].mode === 'end'
            && v.rows[0].defaultDate === '2026-09-01', 'a date ceaseTax will accept'],
  ]
  const wrongView = viewCases.filter(([, regs, ok]) => !ok(registrationView(bcTaxes, regs, TODAY)))
  wrongView.length === 0
    ? pass('R52 the page shows the form each registration needs',
           `${viewCases.length} cases`)
    : fail('R52 the page shows the form each registration needs',
           wrongView.map(([name]) => name).join('; '))

  // R53 — and the page hands those decisions straight through rather than
  //       making its own. A default date the page recomputed is a default date
  //       that can disagree with the one that was checked.
  const pageSrc = readFileSync(join(process.cwd(), 'src', 'app', 'ledger',
    '[ledgerId]', 'tax', 'registration', 'page.tsx'), 'utf8')
  const recomputed = ['r.ceasedOn ?? (', "=== null ? 'end'", "r.active ? null"]
    .filter((frag) => pageSrc.includes(frag))
  // Named for what it does. "The page decides nothing of its own" was too
  // strong: a page that calls `registrationView` and then ignores every value
  // it returns satisfies this, and one did — `defaultDate={today}` at the call
  // site passed while the page still called the function.
  pageSrc.includes('registrationView(') && recomputed.length === 0
    ? pass('R53 the page calls registrationView and repeats none of its logic',
           'a source check, not a rendering one')
    : fail('R53 the page calls registrationView and repeats none of its logic',
           recomputed.length ? `still computes: ${recomputed.join(' ')}` : 'registrationView not used')

  // R55 — the page binds each form to its own action, and renders the body.
  //
  // This check used to scan `page.tsx` for unpacked props. The markup moved to
  // `RegistrationSections.tsx` and it went inert: asserting the absence of six
  // patterns from a file that could no longer contain any of them. It stayed
  // green when the whole `<RegistrationSections/>` element was deleted.
  //
  // What is left in `page.tsx` that nothing else can see is which action each
  // form is bound to. Swapping them — one identifier each — leaves every button
  // submitting fields its handler does not read, so registering and ceasing both
  // become impossible. All sixty checks passed.
  const sectionsSrc = readFileSync(join(process.cwd(), 'src', 'app', 'ledger',
    '[ledgerId]', 'tax', 'registration', 'RegistrationSections.tsx'), 'utf8')

  // Each needle must be followed by a delimiter. A plain substring test passed
  // when the element was renamed to `<RegistrationSectionsREMOVED` — which
  // contains `<RegistrationSections` — so the block that deletes the entire page
  // body recorded no failure at all. A check whose matching is looser than the
  // thing it is checking is the whole subject of this loop, and it turned up
  // one more time in the check written to close it.
  const bindings: Array<[string, string]> = [
    ['<RegistrationSections\n', 'the page renders the body at all'],
    ['registerAction={registerTaxAction}', 'the register forms post to registerTaxAction'],
    ['ceaseAction={ceaseTaxAction}', 'the cease forms post to ceaseTaxAction'],
    ['view={view}', 'the decided view is what is rendered'],
    ['proposals={proposals}', 'the paired proposals are what is rendered'],
    ['entityId={head.entity_id}', 'the company registering is this company'],
    ['today={today}', "the day is the page's one day"],
  ]
  const unbound = bindings.filter(([needle]) => !pageSrc.includes(needle))

  // And the markup must still hand each decided value through whole, wherever
  // it now lives.
  const unpacked: Array<[RegExp, string]> = [
    [/defaultDate=\{(?!row)/, 'defaultDate passed separately'],
    [/registrationId=\{/, 'registrationId passed separately'],
    [/proposed=\{/, 'proposed passed separately'],
    [/row=\{\s*\{/, 'row rebuilt at the call site'],
    [/proposal=\{\s*\{/, 'proposal rebuilt at the call site'],
  ]
  const taken = unpacked.filter(([re]) => re.test(sectionsSrc)).map(([, why]) => why)

  unbound.length === 0 && taken.length === 0
    ? pass('R55 each form is bound to its own action, and the body is rendered',
           `${bindings.length} bindings present, no value taken apart`)
    : fail('R55 each form is bound to its own action, and the body is rendered',
           [...unbound.map(([, why]) => `missing: ${why}`), ...taken].join('; '))

  // R56 — a row whose role belongs to another form is refused, not guessed at.
  //
  // Matching on identity is only worth something if failing to match is an
  // error. Falling back to position made a mismatch silent: rendering the GST
  // proposal inside the PST form created an account coded 2100 and named
  // "GST Payable" tagged `qst_pst_payable`, and said "Registered."
  const wrongForm = await company('WRF', 'Wrong Form Ltd.', 'BC')
  const wrongFd = new FormData()
  wrongFd.set(TAX_FIELDS.ledgerId, wrongForm.ledger.id)
  wrongFd.set(TAX_FIELDS.entityId, wrongForm.company.id)
  wrongFd.set(TAX_FIELDS.tax, 'PST')
  wrongFd.set(TAX_FIELDS.number, 'PST-9999')
  wrongFd.set(TAX_FIELDS.registeredOn, `${Number(wrongForm.year.endDate.slice(0, 4))}-01-01`)
  wrongFd.set(TAX_FIELDS.role(0), 'gst_hst_payable')   // the other form's row
  wrongFd.set(TAX_FIELDS.code(0), '2100')
  wrongFd.set(TAX_FIELDS.name(0), 'GST Payable')
  const wrongResult = await registerTaxFromForm(wrongFd, 'alicio@example.test')
  const wrongMade = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM account WHERE entity_id = ${wrongForm.company.id}`)
  // The mirror: a provincial row posted into the GST form. Only one direction
  // was exercised, and the other interpolated the raw enum into the message.
  const mirrorFd = new FormData()
  mirrorFd.set(TAX_FIELDS.ledgerId, wrongForm.ledger.id)
  mirrorFd.set(TAX_FIELDS.entityId, wrongForm.company.id)
  mirrorFd.set(TAX_FIELDS.tax, 'GST_HST')
  mirrorFd.set(TAX_FIELDS.number, '999RT0001')
  mirrorFd.set(TAX_FIELDS.registeredOn, `${Number(wrongForm.year.endDate.slice(0, 4))}-01-01`)
  mirrorFd.set(TAX_FIELDS.role(0), 'qst_pst_payable')
  mirrorFd.set(TAX_FIELDS.code(0), '2200')
  mirrorFd.set(TAX_FIELDS.name(0), 'PST Payable')
  const mirrorResult = await registerTaxFromForm(mirrorFd, 'alicio@example.test')

  wrongResult.error !== undefined && /not PST/.test(wrongResult.error)
    && mirrorResult.error !== undefined && /not GST\/HST/.test(mirrorResult.error)
    && Number(wrongMade[0].n) === 7
    ? pass('R56 a row from another form is refused, not guessed at',
           'both directions, named by the tax a person would recognise')
    : fail('R56 a row from another form is refused, not guessed at',
           `${wrongResult.error ?? 'gst→pst succeeded'} / ${mirrorResult.error ?? 'pst→gst succeeded'}`)

  // ---------- every form on the page, at once ----------
  //
  // Six rounds found the same defect one hop further out each time, and the
  // seventh was beyond any check over the source: substituting a whole value
  // of the right type. `row={view.rows[0]}` makes every cease form end the
  // FIRST registration whatever card it sits under; `proposal={proposals[0]}`
  // makes the PST form register GST. Nothing is rebuilt, nothing unpacked, the
  // types agree — and 56 checks stayed green.
  //
  // This renders the page's body and reads what each form would actually
  // submit, which is the only thing that can tell those apart.

  // The fixture has to be able to TELL the forms apart. A page with one
  // proposal cannot notice `proposals[0]`, and two rows with different labels
  // cannot notice a label taken from the wrong row — both of those substitutions
  // walked past the first version of these checks.
  const pageInput = {
    today: '2026-06-15',
    view: {
      open: [],
      rows: [
        { registration: { id: 'REG-GST', tax: 'GST_HST', number: '11RT',
                          registeredOn: '2026-01-01', ceasedOn: null, active: true },
          badge: null, mode: 'end', defaultDate: '2026-06-15' },
        // Same mode as the first, different tax: the label must come from THIS row.
        { registration: { id: 'REG-PST', tax: 'PST', number: 'PST-2',
                          registeredOn: '2026-02-01', ceasedOn: null, active: true },
          badge: null, mode: 'end', defaultDate: '2026-06-15' },
        { registration: { id: 'REG-QST', tax: 'QST', number: 'QST-3',
                          registeredOn: '2025-01-01', ceasedOn: '2025-12-31', active: false },
          badge: 'ended', mode: 'correct', defaultDate: '2025-12-31' },
      ],
    },
    // Two proposals, so a form rendering the FIRST one is visible.
    proposals: [
      { tax: 'GST_HST', label: 'GST',
        rows: [{ code: '2100', name: 'GST Payable', role: 'gst_hst_payable',
                 accountType: 'liability', why: '' }] },
      { tax: 'PST', label: 'PST',
        rows: [{ code: '2200', name: 'PST Payable', role: 'qst_pst_payable',
                 accountType: 'liability', why: '' }] },
    ],
  }
  const rendered = renderPage(pageInput)
  const ceaseForms = rendered.filter((f) => f.action === '/cease')
  const registerForms = rendered.filter((f) => f.action === '/register')

  // R57 — each cease form ends the registration on ITS OWN card.
  const wantCease = [['REG-GST', '2026-06-15'], ['REG-PST', '2026-06-15'],
                     ['REG-QST', '2025-12-31']]
  ceaseForms.length === 3
    && wantCease.every(([id, date], i) =>
         ceaseForms[i].fields[TAX_FIELDS.registrationId] === id
         && ceaseForms[i].fields[TAX_FIELDS.ceasedOn] === date)
    ? pass('R57 each cease form ends the registration on its own card',
           ceaseForms.map((f) => f.fields[TAX_FIELDS.registrationId]).join(' '))
    : fail('R57 each cease form ends the registration on its own card',
           JSON.stringify(ceaseForms.map((f) => f.fields)))

  // R58 — and is labelled for that registration. The first two rows share a
  //       mode and differ only in tax, so a label taken from the wrong row shows.
  const wantLabels = ['End the GST/HST registration', 'End the PST registration',
                      'Save the corrected date']
  ceaseForms.length === 3 && wantLabels.every((l, i) => ceaseForms[i].submit === l)
    ? pass('R58 each cease form is labelled for its own registration',
           ceaseForms.map((f) => f.submit).join(' | '))
    : fail('R58 each cease form is labelled for its own registration',
           JSON.stringify(ceaseForms.map((f) => f.submit)))

  // R59 — each register form posts the tax it is headed with, and rows whose
  //       roles belong to that tax. The two Copy forms also retain their own
  //       registration numbers; the ordinary add forms remain blank.
  const wantRegister = [['GST_HST', 'gst_hst_payable'], ['PST', 'qst_pst_payable'],
                        ['GST_HST', 'gst_hst_payable'], ['PST', 'qst_pst_payable']]
  registerForms.length === 4
    && wantRegister.every(([tax, role], i) =>
         registerForms[i].fields[TAX_FIELDS.tax] === tax
         && registerForms[i].fields[TAX_FIELDS.role(0)] === role)
    && registerForms[0].fields[TAX_FIELDS.number] === '11RT'
    && registerForms[1].fields[TAX_FIELDS.number] === 'PST-2'
    && registerForms[2].fields[TAX_FIELDS.number] === ''
    && registerForms[3].fields[TAX_FIELDS.number] === ''
    ? pass('R59 each register form posts the tax it is headed with',
           registerForms.map((f) => `${f.fields[TAX_FIELDS.tax]}:${f.fields[TAX_FIELDS.role(0)]}`).join(' '))
    : fail('R59 each register form posts the tax it is headed with',
           JSON.stringify(registerForms.map((f) => f.fields)))

  // R60 — each open tax is paired with ITS OWN accounts.
  //
  // R59 checks the markup given correct data; this checks the data. Asking for
  // one tax's accounts while heading the form with another produced "Register
  // for PST" carrying an account named "GST Payable" — which `registerTax` now
  // refuses, so provincial registration became impossible rather than wrong.
  // Refusing forever is not working.
  const paired = await company('PAI', 'Paired Ltd.', 'BC')
  const openTaxes = taxesFor('BC')
  const pairs = await openProposals(paired.company.id, openTaxes)
  const wrongPair = pairs.filter((pr) =>
    pr.rows.some((r) => (pr.tax === 'GST_HST') !== r.role.startsWith('gst')))
  pairs.length === 2 && wrongPair.length === 0
    ? pass('R60 each open tax is offered its own accounts',
           pairs.map((pr) => `${pr.tax}:${pr.rows.map((r) => r.role).join('+')}`).join(' '))
    : fail('R60 each open tax is offered its own accounts',
           JSON.stringify(pairs.map((pr) => ({ tax: pr.tax, roles: pr.rows.map((r) => r.role) }))))

  // R61 — an account that will be reused is shown, not offered for editing.
  //
  // Registering again after a gap reuses the account already carrying the role;
  // two payables would split every future return down the middle. The form was
  // still offering an editable code and name for it, and `registerTax` threw
  // away whatever was typed — observed end to end by critic: the box offered
  // 2210, the submission created no account, and the message did not mention it.
  const reused = await company('REU', 'Reused Ltd.', 'BC')
  const reusedYr = Number(reused.year.endDate.slice(0, 4))
  const reusedReg = await registerTax({ entityId: reused.company.id, tax: 'PST',
    number: 'PST-REU-1', registeredOn: `${reusedYr}-01-01`, actor: CEASER })
  await ceaseTax(reusedReg.id, `${reusedYr}-06-30`, CEASER)

  const second = await proposedAccounts(reused.company.id, 'PST')
  const marked = second.every((r) => r.existing !== undefined)
  const rendered2 = renderPage({
    today: `${reusedYr}-07-01`,
    view: { open: [], rows: [] },
    proposals: [{ tax: 'PST', label: 'PST', rows: second }],
  })
  const boxes = Object.keys(rendered2[0]?.fields ?? {})
    .filter((k) => /^(code|name)\d+$/.test(k))
  marked && boxes.length === 0
    ? pass('R61 an account that will be reused is shown, not offered for editing',
           second.map((r) => `${r.existing!.code} ${r.existing!.name}`).join(', '))
    : fail('R61 an account that will be reused is shown, not offered for editing',
           `existing marked: ${marked}; editable boxes rendered: ${boxes.join(' ') || 'none'}`)

  // R63 — THE ID BESIDE THE LEDGER. `registerTaxFromForm` took the entity
  //       out of the form and `ceaseTaxFromForm` the registration id; both
  //       were judged only by the ledger beside them (audit, 2026-09-13).
  {
    const theirs = await createCompanyWithYear({ code: 'THEIRS', name: 'Somebody Else Ltd.', province: 'BC' }, 'alicio@example.test')
    await registerTax({
      entityId: theirs.company.id, tax: 'GST_HST', number: '987654321RT0001', registeredOn: `${yr}-01-01`, actor: 'alicio@example.test',
    })
    const [theirReg] = await db.execute<{ id: string }>(raw`
      SELECT id::text FROM entity_tax_registration WHERE entity_id = ${theirs.company.id}::uuid`)
    const withOurs = (fields: Record<string, string>) => {
      const fd = new FormData()
      fd.set(TAX_FIELDS.ledgerId, acme.ledger.id)                // this company's ledger, always
      for (const [k, v] of Object.entries(fields)) fd.set(k, v)
      return fd
    }
    const REFUSED = "not in this company's books"
    const cases: Array<[string, () => Promise<{ error?: string; ok?: string }>]> = [
      ['register for theirs', () => registerTaxFromForm(withOurs({ [TAX_FIELDS.entityId]: theirs.company.id, [TAX_FIELDS.tax]: 'PST', [TAX_FIELDS.number]: 'PST-1234-5678', [TAX_FIELDS.registeredOn]: `${yr}-02-01` }), 'alicio@example.test')],
      ['cease theirs', () => ceaseTaxFromForm(withOurs({ [TAX_FIELDS.registrationId]: theirReg!.id, [TAX_FIELDS.ceasedOn]: `${yr}-06-30` }), 'alicio@example.test')],
      ['correct theirs', () => correctRegistrationFromForm(withOurs({ [TAX_FIELDS.registrationId]: theirReg!.id, [TAX_FIELDS.number]: 'MINE', [TAX_FIELDS.registeredOn]: `${yr}-01-01`, [TAX_FIELDS.ceasedOn]: `${yr}-06-30` }), 'alicio@example.test')],
      ['delete theirs', () => deleteRegistrationFromForm(withOurs({ [TAX_FIELDS.registrationId]: theirReg!.id }), 'alicio@example.test')],
    ]
    const wrong: string[] = []
    for (const [label, fn] of cases) {
      const r = await fn()
      if (!r.error || !r.error.includes(REFUSED)) wrong.push(`${label}: ${r.error ?? r.ok ?? 'nothing said'}`)
    }
    const [still] = await db.execute<{ n: string; ceased: string | null }>(raw`
      SELECT (SELECT count(*) FROM entity_tax_registration WHERE entity_id = ${theirs.company.id}::uuid)::text AS n,
             (SELECT ceased_on::text FROM entity_tax_registration WHERE id = ${theirReg!.id}::uuid) AS ceased`)
    ;(wrong.length === 0 && still?.n === '1' && still?.ceased === null ? pass : fail)(
      "R63 registering, ceasing, correcting or deleting a tax for another company under this ledger is refused before anything happens",
      wrong.length ? wrong.join('; ') : `all four refused; their one registration still open`)
  }

  // R64 — A REGISTRATION ENTERED WRONG IS PUT RIGHT, OR DELETED (0084). The
  //       owner (2026-09-16): 「所有的紀錄儘量都可以編輯刪除」. A company with an
  //       ended registration and a later one typed with the wrong number: the
  //       number and start are corrected; a start that would run into the
  //       earlier one is refused and names it; un-ending the earlier one is
  //       refused for the same reason; its end is moved; it is deleted while
  //       its accounts stay; the trail keeps both. And the page offers both
  //       doors for the registration each sits under.
  {
    const A = 'alicio@example.test'
    const co = await company('FIXT', 'Fix Tax Ltd.', 'BC')
    const fd = (fields: Record<string, string>) => {
      const d = new FormData()
      d.set(TAX_FIELDS.ledgerId, co.ledger.id)
      for (const [k, v] of Object.entries(fields)) d.set(k, v)
      return d
    }
    const early = await registerTax({ entityId: co.company.id, tax: 'GST_HST', number: '111111111RT0001', registeredOn: '2023-01-01', actor: A })
    await ceaseTax(early.id, '2023-12-31', A)
    const later = await registerTax({ entityId: co.company.id, tax: 'GST_HST', number: 'WRONG1', registeredOn: '2024-03-01', actor: A })
    const read = async (id: string) => (await db.execute<{ number: string; registered_on: string; ceased_on: string | null }>(raw`
      SELECT number, registered_on::text, ceased_on::text FROM entity_tax_registration WHERE id = ${id}::uuid`))[0]
    const fix = (id: string, number: string, from: string, to: string) => correctRegistrationFromForm(fd({
      [TAX_FIELDS.registrationId]: id, [TAX_FIELDS.number]: number, [TAX_FIELDS.registeredOn]: from, [TAX_FIELDS.ceasedOn]: to }), A)
    const corrected = await fix(later.id, '123456789RT0001', '2024-02-01', '')
    const l = await read(later.id)
    const intoEarly = await fix(later.id, '123456789RT0001', '2023-06-01', '')
    const unEnded = await fix(early.id, '111111111RT0001', '2023-01-01', '')
    const moved = await fix(early.id, '111111111RT0001', '2023-01-01', '2023-11-30')
    const e = await read(early.id)
    const accountsBefore = (await db.execute<{ n: number }>(raw`
      SELECT count(*)::int AS n FROM account WHERE entity_id = ${co.company.id}::uuid`))[0].n
    const removed = await deleteRegistrationFromForm(fd({ [TAX_FIELDS.registrationId]: early.id }), A)
    const gone = await read(early.id)
    const accountsAfter = (await db.execute<{ n: number }>(raw`
      SELECT count(*)::int AS n FROM account WHERE entity_id = ${co.company.id}::uuid`))[0].n
    const trail = await db.execute<{ action: string; actor: string; before: { number?: string } | null }>(raw`
      SELECT action, actor, before FROM audit_log
       WHERE table_name = 'entity_tax_registration' AND record_id IN (${early.id}, ${later.id})
         AND action IN ('correct_tax_registration', 'delete_tax_registration') ORDER BY id`)
    // AND WHAT ALREADY RESTS ON A REGISTRATION HOLDS IT (critic, 2026-09-16):
    // GST charged on a sale this year, under the later registration. Deleting
    // it is refused; moving its start past the sale is refused; its number can
    // still be corrected, and the sentence says what that does to documents.
    const yr = Number(co.year.endDate.slice(0, 4))
    const [payable] = await db.execute<{ id: string }>(raw`
      SELECT a.id::text FROM account a JOIN account_role ar ON ar.account_id = a.id
       WHERE a.entity_id = ${co.company.id}::uuid AND ar.role = 'gst_hst_payable'`)
    await postEntry({ ledgerId: co.ledger.id, entryDate: `${yr}-03-15`, description: 'A sale with GST', actor: A,
      lines: [{ accountId: co.id['1200'], amount: 10500n }, { accountId: co.id['4000'], amount: -10000n },
              { accountId: payable.id, amount: -500n }] })
    const deleteUnder = await deleteRegistrationFromForm(fd({ [TAX_FIELDS.registrationId]: later.id }), A)
    const pastTheSale = await fix(later.id, '123456789RT0001', `${yr}-04-01`, '')
    const renumbered = await fix(later.id, '123456789RT0002', '2024-02-01', '')
    const stillThere = await read(later.id)
    // Every door says the same thing about an end before the sale (critic
    // rounds 2 and 3): it is saved — tax after a real deregistration is what the
    // return exists to report (R20) — and the sentence says the sale now falls
    // outside it, whether the registration was open, already ended, or cleared
    // through Edit first. An end after the sale says nothing.
    const cease = (on: string) => ceaseTaxFromForm(fd({ [TAX_FIELDS.registrationId]: later.id, [TAX_FIELDS.ceasedOn]: on }), A)
    const endedBefore = await cease(`${yr}-03-01`)
    const endedLater = await cease(`${yr}-12-31`)
    const correctedBack = await cease(`${yr}-03-01`)
    const endNow = (await read(later.id))?.ceased_on
    const cleared = await fix(later.id, '123456789RT0002', '2024-02-01', '')
    const twoStep = await cease(`${yr}-03-01`)
    const endAfterTwoStep = (await read(later.id))?.ceased_on
    // And a posted invoice that carries no tax line — zero-rated — still
    // prints the number, so it holds the registration on its own.
    const zr = await company('ZERO', 'Zero Rated Ltd.', 'BC')
    const zrReg = await registerTax({ entityId: zr.company.id, tax: 'GST_HST', number: '222222222RT0001', registeredOn: `${yr}-01-01`, actor: A })
    const buyer = await createParty({ kind: 'organisation', name: 'Export Buyer Inc.',
      roles: [{ entityId: zr.company.id, role: 'customer', heldFrom: `${yr}-01-01` }], actor: A })
    const zrInvoice = await createInvoice({ ledgerId: zr.ledger.id, direction: 'sales', partyId: buyer.id,
      controlAccountId: zr.id['1200'], issuedOn: `${yr}-05-10`, dueOn: `${yr}-06-10`, number: 'ZR-1',
      lines: [{ accountId: zr.id['4000'], amount: -80000n }], actor: A })
    await postInvoice(zrInvoice.id, A)
    const zfd = new FormData()
    zfd.set(TAX_FIELDS.ledgerId, zr.ledger.id); zfd.set(TAX_FIELDS.registrationId, zrReg.id)
    const zeroRatedHolds = await deleteRegistrationFromForm(zfd, A)
    // A supplier's bill prints the supplier's number, not ours: it holds nothing.
    const bl = await company('BILLS', 'Bill Only Ltd.', 'BC')
    const blReg = await registerTax({ entityId: bl.company.id, tax: 'GST_HST', number: '333333333RT0001', registeredOn: `${yr}-01-01`, actor: A })
    const seller = await createParty({ kind: 'organisation', name: 'Paper Supplier Inc.',
      roles: [{ entityId: bl.company.id, role: 'supplier', heldFrom: `${yr}-01-01` }], actor: A })
    const bill = await createInvoice({ ledgerId: bl.ledger.id, direction: 'purchase', partyId: seller.id,
      controlAccountId: bl.id['2000'], issuedOn: `${yr}-05-10`, dueOn: `${yr}-06-10`, theirRef: 'S-77',
      lines: [{ accountId: bl.id['5000'], amount: 40000n }], actor: A })
    await postInvoice(bill.id, A)
    const bfd = new FormData()
    bfd.set(TAX_FIELDS.ledgerId, bl.ledger.id); bfd.set(TAX_FIELDS.registrationId, blReg.id)
    const billDoesNotHold = await deleteRegistrationFromForm(bfd, A)
    // And a sales invoice left after an end says it will print without the number.
    const zfdEnd = new FormData()
    zfdEnd.set(TAX_FIELDS.ledgerId, zr.ledger.id); zfdEnd.set(TAX_FIELDS.registrationId, zrReg.id); zfdEnd.set(TAX_FIELDS.ceasedOn, `${yr}-04-30`)
    const invoiceAfterEnd = await ceaseTaxFromForm(zfdEnd, A)
    const SAYS_OUTSIDE = '1 posted tax line now falls outside it — the return will list it as outside the registration'
    const holds = deleteUnder.error?.includes('1 posted tax line') === true && deleteUnder.error.includes('it stays')
      && endedBefore.ok?.includes(SAYS_OUTSIDE) === true
      && endedLater.ok !== undefined && !endedLater.ok.includes('outside')
      && correctedBack.ok?.includes(SAYS_OUTSIDE) === true && endNow === `${yr}-03-01`
      && cleared.ok !== undefined && !cleared.ok.includes('outside')
      && twoStep.ok?.includes(SAYS_OUTSIDE) === true && endAfterTwoStep === `${yr}-03-01`
      && zeroRatedHolds.error?.includes('1 posted sales invoice') === true
      && invoiceAfterEnd.ok?.includes('1 posted sales invoice dated outside it will print without the number') === true
      && billDoesNotHold.ok !== undefined
      && pastTheSale.ok?.includes(SAYS_OUTSIDE) === true
      && renumbered.ok?.includes('Documents printed from now on carry the new number') === true
      && stillThere?.registered_on === '2024-02-01' && stillThere.number === '123456789RT0002'
    const trailed = trail.length === 2 && trail[0].action === 'correct_tax_registration' && trail[0].before?.number === 'WRONG1'
      && trail[1].action === 'delete_tax_registration' && trail.every((t) => t.actor === A)
    const forms = renderPage({ view: { open: [], rows: [{
      registration: { id: 'R1', tax: 'GST_HST', number: 'N1', registeredOn: '2024-01-01', ceasedOn: '2024-06-30', active: false },
      badge: 'ended', mode: 'correct', defaultDate: '2024-06-30' }] }, proposals: [] })
    const correctForm = forms.find((f) => f.action === '/correct')
    const deleteForm = forms.find((f) => f.action === '/delete')
    const offered = correctForm?.fields[TAX_FIELDS.registrationId] === 'R1' && correctForm.fields[TAX_FIELDS.number] === 'N1'
      && correctForm.fields[TAX_FIELDS.registeredOn] === '2024-01-01' && correctForm.fields[TAX_FIELDS.ceasedOn] === '2024-06-30'
      && deleteForm?.fields[TAX_FIELDS.registrationId] === 'R1'
    const ok = corrected.ok !== undefined && l?.number === '123456789RT0001' && l.registered_on === '2024-02-01'
      && intoEarly.error?.includes('Registration 111111111RT0001 runs from 2023-01-01 to 2023-12-31') === true
      && unEnded.error?.includes('Registration 123456789RT0001 runs from 2024-02-01') === true
      && moved.ok !== undefined && e?.ceased_on === '2023-11-30'
      && removed.ok !== undefined && gone === undefined && accountsAfter === accountsBefore && trailed && offered && holds
    ;(ok ? pass : fail)('R64 a registration entered wrong is corrected or deleted, never into another, and the trail keeps it',
      `corrected: ${corrected.ok ?? corrected.error} → ${l?.number} from ${l?.registered_on}; into the earlier one: ${intoEarly.error ?? 'SAVED'}; `
        + `un-ending the earlier one: ${unEnded.error ?? 'SAVED'}; its end moved: ${e?.ceased_on}; deleted: ${removed.ok ?? removed.error} `
        + `(${gone === undefined ? 'gone' : 'STILL THERE'}, accounts ${accountsBefore} → ${accountsAfter}); `
        + `trail ${trail.map((t) => t.action).join(', ') || 'nothing'}; the page ${offered ? 'offers both doors for its own registration' : 'does NOT offer them right'}; `
        + `with a sale posted under it — delete: ${(deleteUnder.error ?? 'DELETED').slice(0, 60)}; start past the sale: `
        + `${(pastTheSale.ok ?? pastTheSale.error ?? '').slice(-90)}; renumbered: ${(renumbered.ok ?? renumbered.error ?? '').slice(0, 60)}; `
        + `End before the sale: ${(endedBefore.ok ?? endedBefore.error ?? '').slice(-90)}; after it: ${(endedLater.ok ?? endedLater.error ?? '').slice(0, 60)}; `
        + `corrected back before it: ${(correctedBack.ok ?? correctedBack.error ?? '').slice(-60)} (ends ${endNow}); cleared then ended before it: `
        + `${(twoStep.ok ?? twoStep.error ?? '').slice(-60)} (ends ${endAfterTwoStep ?? 'never'}); a zero-rated invoice: `
        + `${(zeroRatedHolds.error ?? 'DELETED').slice(0, 50)}; ended before it: ${(invoiceAfterEnd.ok ?? invoiceAfterEnd.error ?? '').slice(-70)}; `
        + `a supplier's bill alone: ${billDoesNotHold.ok ? 'deleted' : billDoesNotHold.error}`)
  }

  await trailNamesPeople((ok, l, d) => (ok ? pass(l, d) : fail(l, d)), 'R62 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

/**
 * Chart of accounts: creation, import, role tagging, and the guards that stop a
 * chart from silently rewriting reports.
 *   npm run db:verify-accounts   (resets the database first)
 */
import './env'
import { expectCode, expectDbRefusal, reporter } from './suite'
import { existsSync, readFileSync } from 'fs'
import { byHand } from './by-hand'
import { trailNamesPeople } from './actor-trail'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import {
  AccountError, availableRoles, chartOfAccounts, createAccount, deactivateAccount, deleteAccount, importAccounts, setAccountActive,
  parseAccountsCsv, setAccountRoles, untaggedAccounts, updateAccount,
} from '../src/lib/accounts'
import { postEntry } from '../src/lib/posting'
import { companyFromFormData, editableRoles, requiredInt, rolesFromFormData } from '../src/lib/forms'
import { chartTree, descendantCodes, withAncestors } from '../src/lib/chart-tree'
import { missingRoles } from '../src/lib/needed-roles'
import { CAPABILITIES, NEEDED_ROLES } from '../src/lib/roles'
import { renderStatement } from '../src/lib/statements'
import { renderCashFlow } from '../src/lib/cash-flow'
import { parseMoney } from '../src/lib/money'
import { STARTER_CHART } from '../src/lib/starter-chart'
import { proposedAccounts } from '../src/lib/registrations'

const r = reporter(66)
const { pass, fail } = r

const expectError = expectCode(r)
/**
 * Drizzle wraps a driver error as "Failed query: ..." and keeps the message
 * Postgres actually raised on `cause`. Reading only `.message` here made four
 * of these look like failures when the guards were in fact firing.
 */
const expectDbError = expectDbRefusal(r, { passSlice: 84, failSlice: 160, allowed: 'expected the database to refuse it' })

const CHART = `code,name,type,parent,roles
1000,Cash — Operating,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
1210,"Allowance for credit losses",asset,,allowance_for_credit_losses,contra
1300,GST/HST Recoverable,asset,,gst_hst_recoverable
2000,Accounts Payable,liability,,trade_payables
2100,GST/HST Payable,liability,,gst_hst_payable
3000,Share Capital,equity,,share_capital
3100,Retained Earnings,equity,,retained_earnings
4000,Consulting Revenue,revenue,,revenue_from_contracts
5000,Salaries and Benefits,expense,,employee_benefits_expense fn_administrative_expenses
5100,Professional Fees,expense,,professional_fees fn_administrative_expenses
5200,Software,expense,,technology_and_software`

/**
 * EVERY FIGURE A PERSON CAN READ OFF A REPORT FOR THIS LEDGER, as one string.
 *
 * A31's whole claim is that the tree cannot change one of these, so this reads
 * the real renderers rather than a sum the suite works out for itself — the
 * three seeded templates and the derived cash flow, over the ledger's last
 * period. A statement figure the suite computed independently would prove only
 * that the suite's arithmetic is stable.
 */
async function statementFigures(ledgerId: string): Promise<string> {
  const [period] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM fiscal_period WHERE ledger_id = ${ledgerId}::uuid
     ORDER BY end_date DESC LIMIT 1`)
  if (!period) return 'no period'

  const out: string[] = []
  for (const code of ['IFRS_SFP_EN', 'IFRS_PL_NATURE_EN', 'IFRS_PL_FUNCTION_EN']) {
    const st = await renderStatement(ledgerId, code, period.id)
    for (const l of st?.lines ?? []) out.push(`${code}/${l.label}=${l.raw}`)
  }
  // The cash flow is derived rather than templated, and it reads MOVEMENTS of
  // every non-cash account — a different path through the same chart, so it is
  // the one most likely to notice if the tree ever grew a meaning.
  const cf = await renderCashFlow(ledgerId, period.id)
  for (const l of cf?.lines ?? []) out.push(`CF/${l.label}=${l.raw}`)
  return out.join('|')
}

async function main() {
  const acme = await createCompany({ code: 'ACME', name: 'Acme Consulting Inc.', province: 'ON' }, 'alicio@example.test')
  await createFiscalYear(acme.ledger.id, '2026-12-31', 'alicio@example.test')

  // A1 — a pasted chart, header row and quoted cell included
  const parsed = parseAccountsCsv(CHART)
  parsed.length === 12 && parsed[2].name === 'Allowance for credit losses'
    && parsed[9].roles?.length === 2
    ? pass('A1 parses a pasted chart', `${parsed.length} accounts, quotes and multi-role handled`)
    : fail('A1 parses a pasted chart', JSON.stringify(parsed.slice(0, 3)))

  const created = await importAccounts(acme.company.id, parsed.map((p) => ({ ...p, entityId: acme.company.id })), 'alicio@example.test')
  created.length === 12
    ? pass('A2 imports the whole chart', `${created.length} accounts`)
    : fail('A2 imports the whole chart', `${created.length}`)

  // A3 — normal balance is derived per type unless overridden
  const chart = await chartOfAccounts(acme.company.id)
  const cash = chart.find((a) => a.code === '1000')!
  const ap = chart.find((a) => a.code === '2000')!
  // 1210 is a contra asset. Before the balance column existed, import stored it
  // as a debit, and 0008 freezes that the moment the account is posted to.
  const allowance = chart.find((a) => a.code === '1210')!
  cash.normal_balance === 'debit' && ap.normal_balance === 'credit'
    && allowance.normal_balance === 'credit' && allowance.account_type === 'asset'
    ? pass('A3 normal balance, contra included', '1000 debit, 2000 credit, 1210 contra asset = credit')
    : fail('A3 normal balance, contra included',
           `${cash.normal_balance}/${ap.normal_balance}/${allowance.normal_balance}`)

  // A4 — an import must be all or nothing
  const before = (await chartOfAccounts(acme.company.id)).length
  await expectError('A4 a bad row rejects the whole import', 'ROLE_MISMATCH', () =>
    importAccounts(acme.company.id, [
      { entityId: acme.company.id, code: '6000', name: 'Fine', accountType: 'expense' },
      { entityId: acme.company.id, code: '6100', name: 'Wrong role', accountType: 'expense',
        roles: ['trade_receivables'] },
    ], 'alicio@example.test'))
  const after = (await chartOfAccounts(acme.company.id)).length
  before === after
    ? pass('A5 nothing was written by the failed import', `${after} accounts, unchanged`)
    : fail('A5 nothing was written by the failed import', `${before} -> ${after}`)

  await expectError('A6 rejects a duplicate code', 'DUPLICATE', () =>
    importAccounts(acme.company.id, [{ entityId: acme.company.id, code: '1000', name: 'Again', accountType: 'asset' }]))
  await expectError('A7 rejects an unknown role', 'NO_ROLE', () =>
    importAccounts(acme.company.id, [{ entityId: acme.company.id, code: '9000', name: 'X',
      accountType: 'asset', roles: ['not_a_role'] }]))
  await expectError('A8 rejects two roles from one family', 'ROLE_FAMILY', () =>
    importAccounts(acme.company.id, [{ entityId: acme.company.id, code: '9100', name: 'X',
      accountType: 'asset', roles: ['cash_and_cash_equivalents', 'trade_receivables'] }]))

  // A9 — the database refuses the same mistake, not just the library
  const cashId = chart.find((a) => a.code === '1000')!.id
  await expectDbError('A9 the database refuses a mismatched role', 'is for liability accounts',
    () => db.execute(raw`INSERT INTO account_role (account_id, role) VALUES (${cashId}::uuid, 'trade_payables')`))
  await expectDbError('A10 the database refuses a second role per family', 'at most one per family',
    () => db.execute(raw`INSERT INTO account_role (account_id, role) VALUES (${cashId}::uuid, 'restricted_cash')`))

  // A11 — untagged accounts must be visible, because reports stay silent
  await createAccount({ entityId: acme.company.id, code: '5300', name: 'Meals (untagged)', accountType: 'expense' }, 'alicio@example.test')
  const untagged = await untaggedAccounts(acme.company.id)
  untagged.length === 1 && untagged[0].code === '5300'
    ? pass('A11 untagged accounts are reported', `${untagged[0].code} ${untagged[0].name}`)
    : fail('A11 untagged accounts are reported', JSON.stringify(untagged))

  // A12 — post to an account, then try to change what it means
  const ids = Object.fromEntries(chart.map((a) => [a.code, a.id]))
  await postEntry({
    ledgerId: acme.ledger.id, entryDate: '2026-03-10', description: 'Opening capital',
    sourceType: 'opening_balance', actor: 'alicio@example.test',
    lines: [
      { accountId: ids['1000'], amount: parseMoney('25000.00') },
      { accountId: ids['3000'], amount: -parseMoney('25000.00') },
    ],
  })
  await expectDbError('A12 a posted account cannot change type', 'its type cannot change',
    () => byHand((tx) => tx.execute(raw`UPDATE account SET account_type='expense' WHERE id = ${ids['1000']}::uuid`)))
  await expectDbError('A13 a posted account cannot be deleted', 'cannot be deleted',
    () => byHand((tx) => tx.execute(raw`DELETE FROM account WHERE id = ${ids['1000']}::uuid`)))
  await expectDbError('A14 an account cannot move to another company', 'cannot be moved',
    () => byHand((tx) => tx.execute(raw`UPDATE account SET entity_id = gen_random_uuid() WHERE id = ${ids['1000']}::uuid`)))

  // A15 — an unposted account may still be corrected
  const meals = (await chartOfAccounts(acme.company.id)).find((a) => a.code === '5300')!
  await byHand((tx) => tx.execute(raw`UPDATE account SET account_type='asset', normal_balance='debit' WHERE id = ${meals.id}::uuid`))
  const fixed = (await chartOfAccounts(acme.company.id)).find((a) => a.code === '5300')!
  fixed.account_type === 'asset'
    ? pass('A15 an unposted account can still be corrected', 'type changed while it had no entries')
    : fail('A15 an unposted account can still be corrected', fixed.account_type)
  await byHand((tx) => tx.execute(raw`UPDATE account SET account_type='expense' WHERE id = ${meals.id}::uuid`))

  // A16 — retagging replaces wholesale and is audited
  await setAccountRoles(meals.id, ['travel_and_entertainment', 'fn_administrative_expenses'], 'alicio@example.test')
  const retagged = (await chartOfAccounts(acme.company.id)).find((a) => a.code === '5300')!
  const [audited] = await db.execute<{ n: string }>(
    raw`SELECT count(*)::text AS n FROM audit_log WHERE action='set_account_roles'`)
  retagged.roles?.length === 2 && audited.n === '1'
    ? pass('A16 roles can be replaced, and it is audited', retagged.roles!.join(' + '))
    : fail('A16 roles can be replaced, and it is audited', JSON.stringify({ roles: retagged.roles, audited }))

  // A17 — every account change leaves a trail
  // Counting both actions together let this pass with zero update rows, so
  // deleting the whole update branch of the trigger would have left it green.
  const trail = await db.execute<{ action: string; n: string }>(raw`
    SELECT action, count(*)::text AS n FROM audit_log
     WHERE action IN ('create_account','update_account') GROUP BY action ORDER BY action`)
  const counts = Object.fromEntries(trail.map((r) => [r.action, Number(r.n)]))
  // The trigger writes the type under the key 'type'. Reading 'account_type'
  // gave null on both sides and the check still passed — the same shape it was
  // rewritten to escape.
  const edits = await db.execute<{ code: string; before: string | null; after: string | null }>(raw`
    SELECT after->>'code' AS code, before->>'type' AS before, after->>'type' AS after
      FROM audit_log WHERE action='update_account' ORDER BY occurred_at`)
  const typeChange = edits.find((e) => e.before !== e.after)
  counts.create_account === 13 && counts.update_account >= 2
    && typeChange !== undefined && typeChange.before !== null && typeChange.after !== null
    ? pass('A17 creations and edits are audited separately',
           `${counts.create_account} created, ${counts.update_account} edited, ` +
           `${typeChange.code}: ${typeChange.before} -> ${typeChange.after}`)
    : fail('A17 creations and edits are audited separately', JSON.stringify({ counts, edits }))

  // A18 — an account whose ONLY roles are the cash flow statement's reaches
  //       that statement and no other, and used to satisfy the untagged check
  //       simply by holding a role. The four cash-flow roles are carried by
  //       zero statement LINES (the cash flow is derived, not templated), so
  //       0009 called them "roles that no statement uses" — true until the
  //       statement was built; 0075 says what is true now.
  const cfOnly = await createAccount({ entityId: acme.company.id, code: '5400',
    name: 'Bank charges (cash-flow role only)', accountType: 'expense', roles: ['cf_operating'] }, 'alicio@example.test')
  const reported = await untaggedAccounts(acme.company.id)
  const hit = reported.find((r) => r.code === '5400')
  hit?.reason === 'reaches only the cash flow statement — no balance sheet or income statement line carries it'
    ? pass('A18 an account only the cash flow statement reaches is reported, and says so', `5400 — ${hit.reason}`)
    : fail('A18 an account only the cash flow statement reaches is reported, and says so',
           JSON.stringify(reported.map((r) => `${r.code}:${r.reason}`)))

  // A18b — and giving it a role a statement DOES use clears it
  await setAccountRoles(cfOnly.id, ['bank_charges', 'cf_operating'], 'alicio@example.test')
  const cleared = await untaggedAccounts(acme.company.id)
  !cleared.some((r) => r.code === '5400')
    ? pass('A18b adding a statement role clears the report', '5400 now reaches Other expenses')
    : fail('A18b adding a statement role clears the report', JSON.stringify(cleared))

  // A18c — the editor must render EVERY family it is capable of deleting.
  //        Saving replaces roles wholesale, so a family the form omits is a
  //        family the form destroys. This used to be an inline filter in the
  //        component, where no test could see it, and it dropped cash_flow.
  const catalogue = (await availableRoles()).map((r) => ({
    code: r.code, label: r.label, family: r.family, category: r.category, isCore: r.isCore,
  }))
  const gaps: string[] = []
  for (const type of ['asset', 'liability', 'equity', 'revenue', 'expense']) {
    const { eligible, families } = editableRoles(catalogue, type)
    const deletable = [...new Set(eligible.map((r) => r.family))]
    for (const f of deletable) if (!families.includes(f)) gaps.push(`${type}/${f}`)
  }
  const expenseFamilies = editableRoles(catalogue, 'expense').families
  gaps.length === 0 && expenseFamilies.includes('cash_flow')
    ? pass('A18c the editor renders every family it can delete',
           `expense: ${expenseFamilies.join(', ')}`)
    : fail('A18c the editor renders every family it can delete',
           `gaps: ${gaps.join(', ')}; expense families: ${expenseFamilies.join(', ')}`)

  // A19-A22 — the layer between the form and the library. Round 6 found an
  //            action silently coercing bad input with nothing testing it.
  const fd = new FormData()
  fd.set('role_nature', 'insurance_expense')            // one radio group per family
  fd.set('role_function', 'fn_administrative_expenses')
  fd.set('role_classification', '')                     // the "none" option
  const picked = rolesFromFormData(fd)
  picked.length === 2 && picked.includes('insurance_expense') && !picked.includes('')
    ? pass('A19 role radios become a role list', picked.join(' + '))
    : fail('A19 role radios become a role list', JSON.stringify(picked))

  const meals2 = (await chartOfAccounts(acme.company.id)).find((a) => a.code === '5300')!
  await setAccountRoles(meals2.id, picked, 'web')
  const after19 = (await chartOfAccounts(acme.company.id)).find((a) => a.code === '5300')!
  after19.roles?.length === 2
    ? pass('A20 those roles reach the database', after19.role_labels!.join(' + '))
    : fail('A20 those roles reach the database', JSON.stringify(after19.roles))

  const yearEnd = new FormData()
  yearEnd.set('code', 'X'); yearEnd.set('name', 'X')
  yearEnd.set('fiscalYearEndMonth', 'abc'); yearEnd.set('fiscalYearEndDay', '0')
  try {
    companyFromFormData(yearEnd)
    fail('A21 a non-numeric year end is refused, not defaulted', 'it was accepted')
  } catch (e) {
    (e as AccountError).message.includes('whole number')
      ? pass('A21 a non-numeric year end is refused, not defaulted', (e as Error).message)
      : fail('A21 a non-numeric year end is refused, not defaulted', (e as Error).message)
  }

  try {
    requiredInt(new FormData(), 'missing', 'Year-end month')
    fail('A22 a missing field is refused', 'it was accepted')
  } catch (e) {
    const m = (e as Error).message
    m.includes('whole number') && m.includes('Year-end month')
      ? pass('A22 a missing field is refused', m)
      : fail('A22 a missing field is refused', `wrong error: ${m}`)
  }

  // A23-A25 — parser cases the previous version got wrong
  const withBlank = parseAccountsCsv('\n# my chart\ncode,name,type\n7000,Foo,asset')
  withBlank.length === 1 && withBlank[0].code === '7000'
    ? pass('A23 a header after a blank or comment is still a header', 'leading blank line is a paste artefact')
    : fail('A23 a header after a blank or comment is still a header', JSON.stringify(withBlank))

  try {
    await importAccounts(acme.company.id, [{ entityId: acme.company.id, code: '7100',
      name: 'Its own parent', accountType: 'asset', parentCode: '7100' }])
    fail('A24 a row cannot be its own parent', 'it was accepted')
  } catch (e) {
    (e as AccountError).code === 'SELF_PARENT'
      ? pass('A24 a row cannot be its own parent', (e as Error).message)
      : fail('A24 a row cannot be its own parent', (e as Error).message)
  }

  try {
    parseAccountsCsv('7200,Bad balance,asset,,,sideways')
    fail('A25 an unknown balance is refused', 'it was accepted')
  } catch (e) {
    (e as AccountError).code === 'BAD_BALANCE'
      ? pass('A25 an unknown balance is refused', (e as Error).message)
      : fail('A25 an unknown balance is refused', (e as Error).message)
  }

  // ---------------------------------------------------- the starter chart --

  // A26 — the GIFI starter chart imports whole into a fresh company: every
  //       row lands, and the contra rows carry their contra balance. The
  //       prefill IS the default template (owner, 2026-09-02); a template
  //       that no longer parses is a first-run that fails at hello.
  const gifiCo = await createCompany({ code: 'GIFI', name: 'GIFI Starter Ltd.' }, 'alicio@example.test')
  const starterRows = parseAccountsCsv(STARTER_CHART)
  await importAccounts(gifiCo.company.id,
    starterRows.map((r) => ({ ...r, entityId: gifiCo.company.id })), 'alicio@example.test')
  const gifiChart = await chartOfAccounts(gifiCo.company.id)
  const contraCodes = gifiChart.filter((a) => a.normal_balance === 'credit' && a.account_type === 'asset')
    .map((a) => a.code).sort()
  // The sentinel codes are the template's whole point: CRA GIFI items,
  //  verified against RC4088 Rev.21 — cash 1001, GST/HST 1066/2680, the
  //  director's own 2783, retained earnings 3600 (3620 is a TOTAL, not an
  //  account), salaries 9060. A drift back to the pre-GIFI vocabulary
  //  (1000/2100/3100...) turns tax season back into a mapping exercise.
  const anchors = ['1001', '1066', '2680', '2783', '3600', '9060']
  const missingAnchors = anchors.filter((c) => !gifiChart.some((a) => a.code === c))
  starterRows.length >= 45 && gifiChart.length === starterRows.length
    && contraCodes.join(' ') === '1061 1741 1775 1788'
    && missingAnchors.length === 0
    ? pass('A26 the GIFI starter chart imports whole',
           `${gifiChart.length} accounts, contras ${contraCodes.join('/')}, anchors present`)
    : fail('A26 the GIFI starter chart imports whole',
           `${starterRows.length} rows -> ${gifiChart.length} accounts, contras ${contraCodes.join('/')}, missing anchors: ${missingAnchors.join(',') || 'none'}`)

  // A26b — every role the template names exists AND reaches a statement line.
  //        A role that reaches no line is the silent-absence defect: the
  //        account imports cleanly and its money is simply on no statement.
  const usedRoles = [...new Set(starterRows.flatMap((r) => r.roles ?? []))]
  const reachable = new Set((await db.execute<{ role: string }>(raw`
    SELECT DISTINCT unnest(sl.roles) AS role FROM statement_line sl`)).map((r) => r.role))
  const defined = new Set((await db.execute<{ code: string }>(raw`
    SELECT code FROM role_definition`)).map((r) => r.code))
  const unknown = usedRoles.filter((r) => !defined.has(r))
  const unreachable = usedRoles.filter((r) => !reachable.has(r))
  // And no row may arrive roleless: an untagged import is legal for a person
  // building their own chart, but a TEMPLATE that ships an untagged account
  // ships money that reaches no statement, silently.
  const roleless = starterRows.filter((r) => !r.roles || r.roles.length === 0)
  unknown.length === 0 && unreachable.length === 0 && usedRoles.length > 20
    && roleless.length === 0
    ? pass('A26b every starter role exists and reaches a statement line',
           `${usedRoles.length} roles, all land somewhere, no roleless rows`)
    : fail('A26b every starter role exists and reaches a statement line',
           `unknown: ${unknown.join(',') || 'none'}; reaching no line: ${unreachable.join(',') || 'none'}; roleless: ${roleless.map((r) => r.code).join(',') || 'none'}`)

  // A26c — registering for GST/HST on the starter chart proposes NOTHING new:
  //        2680 and 1066 already carry the roles, so the door reuses them
  //        instead of inventing a second pair beside the template's.
  const gifiProposal = await proposedAccounts(gifiCo.company.id, 'GST_HST') as Array<{
    code: string; name: string; existing?: { code: string; name: string } }>
  const reusedCodes = gifiProposal.map((p) => p.existing?.code).sort()
  gifiProposal.length === 2 && reusedCodes.join(' ') === '1066 2680'
    ? pass('A26c tax registration reuses the starter accounts',
           gifiProposal.map((p) => `${p.existing!.code} ${p.existing!.name}`).join(', '))
    : fail('A26c tax registration reuses the starter accounts',
           JSON.stringify(gifiProposal))

  // A28 — the screen's two doors on an existing account. The account trigger
  //       writes the row; 0060 makes it name the person the transaction named,
  //       not the Postgres role. Nothing in this suite called either door
  //       before, so the block that took `acting()` out of updateAccount turned
  //       nothing red (toothless, 2026-09-06).
  {
    const sundry = await createAccount(
      { entityId: acme.company.id, code: '5999', name: 'Sundry', accountType: 'expense' }, 'pat@x.test')
    await updateAccount(sundry.id, { name: 'Sundry expenses' }, 'pat@x.test')
    await deactivateAccount(sundry.id, 'pat@x.test')
    const rows = await db.execute<{ action: string; actor: string; after: { name: string; is_active: boolean } }>(raw`
      SELECT action, actor, after FROM audit_log
       WHERE table_name = 'account' AND record_id = ${sundry.id}
       ORDER BY id`)
    const actions = rows.map((r) => r.action).join(' ')
    const actors = [...new Set(rows.map((r) => r.actor))].join(' ')
    actions === 'create_account update_account update_account deactivate_account' && actors === 'pat@x.test'
      && rows[1].after.name === 'Sundry expenses' && rows[2].after.is_active === false
      ? pass('A28 creating, renaming and retiring an account are trailed under the person who did it',
             `${actions}; actor ${actors}`)
      : fail('A28 creating, renaming and retiring an account are trailed under the person who did it',
             `${actions || 'no rows'}; actor(s) ${actors || 'none'}`)
  }

  // A29 — AND A SCREEN OPENS THAT DOOR. `AccountForm` has taken an `existing`
  //       account since it was written — it switches to `updateAccountAction`
  //       and freezes only the type — and NOTHING EVER PASSED IT, so an
  //       account's name was final from the moment it was made (owner,
  //       2026-09-07). A door with no handle is a door nobody has.
  {
    const form = readFileSync('src/app/ledger/[ledgerId]/accounts/AccountForm.tsx', 'utf8')
    const openers = ['src/app/ledger/[ledgerId]/accounts/[accountId]/EditAccount.tsx']
    const opens = openers.filter((f) => existsSync(f) && /existing=\{/.test(readFileSync(f, 'utf8')))
    const page = existsSync('src/app/ledger/[ledgerId]/accounts/[accountId]/page.tsx')
      ? readFileSync('src/app/ledger/[ledgerId]/accounts/[accountId]/page.tsx', 'utf8') : ''
    const label = 'A29 the form that renames an account is opened by a screen, not only written'
    const reachable = /existing\?:/.test(form) && opens.length > 0 && /<EditAccount/.test(page)
    reachable
      ? pass(label, `${opens.length} opener, rendered on the account page`)
      : fail(label, 'the edit form is reachable from nowhere')
  }

  // A30 — THE ID BESIDE THE LEDGER. `requireLedger` judges the ledger a form
  //       was posted from; the account id beside it was judged by nothing, so a
  //       person holding the Accounts seat on company A could rename or RETAG
  //       company B's account — and a tag decides which statement line the
  //       account feeds (audit, 2026-09-13). The doors now take the ledger and
  //       ask `ours()` first. Both doors, with the other company's id and this
  //       company's ledger; then the other company's account, untouched.
  {
    const theirs = await createCompany({ code: 'THEIRS', name: 'Somebody Else Ltd.' }, 'alicio@example.test')
    const [theirCash] = await importAccounts(theirs.company.id,
      parseAccountsCsv('code,name,type,parent,roles\n1000,Their cash,asset,,cash_and_cash_equivalents')
        .map((r) => ({ ...r, entityId: theirs.company.id })), 'alicio@example.test')
    const said = (e: unknown) => (e instanceof AccountError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e))
    const wrong: string[] = []
    const doors: Array<[string, () => Promise<unknown>]> = [
      ['rename', () => updateAccount(theirCash.id, { name: 'Ours now' }, 'alicio@example.test', acme.ledger.id)],
      ['retag', () => setAccountRoles(theirCash.id, ['trade_receivables'], 'alicio@example.test', acme.ledger.id)],
    ]
    for (const [label, fn] of doors) {
      try { await fn(); wrong.push(`${label} went through`) }
      catch (e) { if (!(e instanceof AccountError) || e.code !== 'NOT_OURS') wrong.push(`${label}: ${said(e)}`) }
    }
    const [after] = await db.execute<{ name: string; roles: number }>(raw`
      SELECT a.name, (SELECT count(*) FROM account_role ar WHERE ar.account_id = a.id)::int AS roles
        FROM account a WHERE a.id = ${theirCash.id}::uuid`)
    // And with THEIR ledger in hand the same door opens — the check is about
    // whose books, not about the door.
    let own = ''
    try { await updateAccount(theirCash.id, { name: 'Their cash' }, 'alicio@example.test', theirs.ledger.id) } catch (e) { own = said(e) }
    ;(wrong.length === 0 && after?.name === 'Their cash' && after?.roles === 1 && own === '' ? pass : fail)(
      "A30 renaming or retagging another company's account under this ledger is refused before anything happens",
      wrong.length ? wrong.join('; ') : `both refused as NOT_OURS; their account still "${after?.name}" with ${after?.roles} tag(s)`
        + (own ? `; but with their own ledger: ${own}` : '; and their own ledger still opens it'))
  }

  // ------------------------------------------------------- sub-accounts (0078) --
  //
  // The column has been there since 0001 and nothing could set it but a pasted
  // chart, nothing could change it at all, and no screen drew it (owner,
  // 2026-09-15: 「COA没有subaccount功能」). What follows is the rule the feature
  // rests on: THE TREE GROUPS THE CHART AND MOVES NO MONEY. A31 is that rule
  // stated as a figure; the rest are the guards that keep it true.
  {
    const E = acme.company.id
    const chartOf = async () => chartOfAccounts(E)
    const find = async (code: string) =>
      (await chartOf()).find((a) => a.code === code)!

    // A31 — an account moved under another changes NO figure on any statement.
    //       Read before and after the move, from the same query the statements
    //       are built from. If this ever fails, the tree has grown a meaning.
    const beforeMove = await statementFigures(acme.ledger.id)
    await importAccounts(E, [
      { entityId: E, code: '5600', name: 'Vehicle expenses', accountType: 'expense',
        isPostable: false, roles: ['other_operating_expenses'] },
      { entityId: E, code: '5610', name: 'Fuel', accountType: 'expense',
        parentCode: '5600', roles: ['other_operating_expenses'] },
    ], 'alicio@example.test')
    const software = await find('5200')
    await updateAccount(software.id, { parentCode: '5600' }, 'alicio@example.test', acme.ledger.id)
    const afterMove = await statementFigures(acme.ledger.id)
    beforeMove === afterMove
      ? pass('A31 moving an account under another changes no figure on any statement',
             'the tree groups the chart; roles build the statements')
      : fail('A31 moving an account under another changes no figure on any statement',
             `before ${beforeMove} / after ${afterMove}`)

    // A32 — and it is genuinely there afterwards, by code, through the query
    //       the chart screen reads.
    const moved = await find('5200')
    moved.parent_code === '5600'
      ? pass('A32 an account can be moved under another after it is created', '5200 now sits under 5600')
      : fail('A32 an account can be moved under another after it is created', `parent is ${moved.parent_code}`)

    // A33 — and lifted back out. '' is a real answer, not a missing one.
    await updateAccount(moved.id, { parentCode: '' }, 'alicio@example.test', acme.ledger.id)
    const lifted = await find('5200')
    lifted.parent_code === null
      ? pass('A33 an account can be lifted back to the top level', 'an empty parent clears it')
      : fail('A33 an account can be lifted back to the top level', `parent is ${lifted.parent_code}`)

    // A34 — a sub-account is the same kind of thing as its parent. Tagging an
    //       expense under an asset would draw a grouping on the chart that no
    //       statement could ever produce.
    const cash = await find('1000')
    await expectError('A34 an account cannot sit under one of another type', 'PARENT_TYPE',
      () => updateAccount(cash.id, { parentCode: '5600' }, 'alicio@example.test', acme.ledger.id))

    // A35 — itself.
    await expectError('A35 an account cannot sit under itself', 'SELF_PARENT',
      () => updateAccount(cash.id, { parentCode: '1000' }, 'alicio@example.test', acme.ledger.id))

    // A36 — nor under its own sub-account. A cycle cannot be undone through a
    //       screen, because every screen renders the chart first.
    const heading = await find('5600')
    await expectError('A36 an account cannot sit under its own sub-account', 'PARENT_CYCLE',
      () => updateAccount(heading.id, { parentCode: '5610' }, 'alicio@example.test', acme.ledger.id))

    // A37 — a parent that is not in this company at all.
    await expectError('A37 a parent that does not exist is refused by name', 'NO_PARENT',
      () => updateAccount(cash.id, { parentCode: '9999' }, 'alicio@example.test', acme.ledger.id),
      '9999')

    // A38 — the import refuses the same mismatch, with the line number.
    await expectError('A38 a pasted row cannot sit under an account of another type', 'PARENT_TYPE',
      () => importAccounts(E, [{ entityId: E, code: '5620', name: 'Wrong kind',
        accountType: 'asset', parentCode: '5600' }], 'alicio@example.test'))

    // A39 — re-typing a parent is the one way past A34, because the children
    //       are not the row being written. Refused at the other end instead.
    await expectError('A39 an account with sub-accounts cannot change its own type', 'HAS_CHILDREN',
      () => updateAccount(heading.id, { accountType: 'asset' }, 'alicio@example.test', acme.ledger.id),
      '5610')

    // A40 — THE DATABASE REFUSES IT TOO, not only the library. Four doors open
    //       onto this column — the paste, the form, a restore and psql — and
    //       three of them do not run the checks above.
    await expectDbError('A40 the database refuses a cycle written straight past the library',
      'one of its own sub-accounts',
      () => db.execute(raw`UPDATE account SET parent_id =
        (SELECT id FROM account WHERE entity_id = ${E}::uuid AND code = '5610')
        WHERE entity_id = ${E}::uuid AND code = '5600'`))

    // A41 — and a parent belonging to another company, which is the shape 0008
    //       already refuses for entity_id itself.
    const other = await createCompany({ code: 'NBR', name: 'Neighbour Ltd.' }, 'alicio@example.test')
    await importAccounts(other.company.id, [{ entityId: other.company.id, code: '5600',
      name: 'Their heading', accountType: 'expense' }], 'alicio@example.test')
    await expectDbError("A41 the database refuses a parent in another company's chart",
      'belongs to another company',
      () => db.execute(raw`UPDATE account SET parent_id =
        (SELECT id FROM account WHERE entity_id = ${other.company.id}::uuid AND code = '5600')
        WHERE entity_id = ${E}::uuid AND code = '5200'`))

    // A42 — the drawing rules, which live in a pure file precisely so a check
    //       can reach them. RoleEditor's dropped role family was a `.filter()`
    //       inside a component, and nothing could catch it for a week.
    const rows = [
      { id: 'a', code: '5600', parent_code: null },
      { id: 'b', code: '5610', parent_code: '5600' },
      { id: 'c', code: '5611', parent_code: '5610' },
      { id: 'd', code: '1000', parent_code: null },
      { id: 'e', code: '9000', parent_code: 'gone' },
    ]
    const drawn = chartTree(rows)
    const shape = drawn.map((t) => `${t.row.code}@${t.depth}`).join(' ')
    // 1000 first (codes sort as text), then the 5600 branch depth-first, and
    // 9000 — whose parent is not in the list — at the top rather than dropped.
    shape === '1000@0 5600@0 5610@1 5611@2 9000@0' && drawn.length === rows.length
      ? pass('A42 the chart draws as a tree, and every row is drawn exactly once', shape)
      : fail('A42 the chart draws as a tree, and every row is drawn exactly once', shape)

    // A43 — searching a leaf shows where it lives; the ancestors come with it.
    const kept = withAncestors(rows, [rows[2]]).map((x) => x.code).join(' ')
    kept === '5600 5610 5611'
      ? pass('A43 a search keeps the ancestors of what it matched', `"5611" draws ${kept}`)
      : fail('A43 a search keeps the ancestors of what it matched', kept)

    // A44 — and the form never offers a choice the guards would refuse.
    const below = descendantCodes(rows, '5600').join(' ')
    below === '5610 5611'
      ? pass('A44 the parent list leaves out everything already below the account', below)
      : fail('A44 the parent list leaves out everything already below the account', below)
  }

  // ---------------------------- what the chart cannot yet do (2026-09-16) --
  //
  // The owner asked whether some accounts should be REQUIRED —「因为很多功能
  // 都基于一些特定account」. They are, and each capability already refused at
  // the moment of use; what was missing was being told early. needed-roles.ts
  // is where a capability declares its need, and these hold that declaration
  // honest from both ends.
  {
    // A45 — every role a capability names is a REAL role. A registry that can
    //       invent one would state a requirement no chart could ever satisfy,
    //       and the overview would nag about it forever.
    const known = new Set((await availableRoles()).map((r) => r.code))
    const invented = NEEDED_ROLES.filter((r) => !known.has(r))
    ;(invented.length === 0 ? pass : fail)(
      'A45 every role a capability declares is one the books have',
      invented.length === 0
        ? `${NEEDED_ROLES.length} roles across ${CAPABILITIES.length} capabilities, all in role_definition`
        : `no such role: ${invented.join(', ')}`)

    // A46 — and the reading is TRUE of a real company, from both sides: the
    //       GIFI starter chart carries the core roles, and a company whose
    //       chart has none of them is told about every one.
    const bare = await createCompany({ code: 'BARE', name: 'Bare Books Ltd.' }, 'alicio@example.test')
    const bareMissing = await missingRoles(bare.ledger.id)
    const gifiMissing = await missingRoles(gifiCo.ledger.id)
    const coreLeft = gifiMissing.filter((m) => m.stops.some((c) => c.weight === 'core'))
    ;(bareMissing.length === NEEDED_ROLES.length && coreLeft.length === 0 ? pass : fail)(
      'A46 an empty chart is told everything, and the starter chart can do the core',
      `empty company: ${bareMissing.length} of ${NEEDED_ROLES.length} missing; `
        + `GIFI starter: ${gifiMissing.length} missing, of which core ${coreLeft.length}`
        + (coreLeft.length ? ` (${coreLeft.map((m) => m.role).join(', ')})` : ''))
  }

  // A47 — AN ACCOUNT IS RETIRED OR BROUGHT BACK, AND ONE NOTHING USED IS
  //       DELETED (0084). 0008's refusal told people to "Deactivate it instead"
  //       and no button did. Acme's cash account, posted to, is refused a
  //       delete that names its lines; a parent is refused for its sub-account;
  //       an account typed by mistake goes, roles and all; cash is deactivated
  //       and reactivated; another company's account is not ours; each writes
  //       its audit row.
  {
    const A = 'alicio@example.test'
    const said = (e: unknown) => (e instanceof AccountError ? `${e.code}: ${e.message}` : String(e))
    const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok' } catch (e) { return said(e) } }
    const typo = await createAccount({ entityId: acme.company.id, code: '6999', name: 'Offce supplies', accountType: 'expense', roles: [] }, A)
    const parent = await createAccount({ entityId: acme.company.id, code: '6990', name: 'Grouping', accountType: 'expense', roles: [] }, A)
    await createAccount({ entityId: acme.company.id, code: '6991', name: 'Under it', accountType: 'expense', parentCode: '6990', roles: [] }, A)
    const usedRefused = await attempt(() => deleteAccount(ids['1000'], A, acme.ledger.id))
    const parentRefused = await attempt(() => deleteAccount(parent.id, A, acme.ledger.id))
    const typoGone = await attempt(() => deleteAccount(typo.id, A, acme.ledger.id))
    const [left] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM account WHERE id = ${typo.id}::uuid`)
    const off = await attempt(() => setAccountActive(ids['1000'], false, A, acme.ledger.id))
    const [inactive] = await db.execute<{ is_active: boolean }>(raw`SELECT is_active FROM account WHERE id = ${ids['1000']}::uuid`)
    const on = await attempt(() => setAccountActive(ids['1000'], true, A, acme.ledger.id))
    const [active] = await db.execute<{ is_active: boolean }>(raw`SELECT is_active FROM account WHERE id = ${ids['1000']}::uuid`)
    const theirs = await createCompany({ code: 'OTHERS', name: 'Other Books Ltd.' }, A)
    const theirAccount = await createAccount({ entityId: theirs.company.id, code: '6000', name: 'Theirs', accountType: 'expense', roles: [] }, A)
    const notOurs = await attempt(() => deleteAccount(theirAccount.id, A, acme.ledger.id))
    const trail = await db.execute<{ action: string }>(raw`
      SELECT action FROM audit_log WHERE table_name = 'account' AND record_id IN (${typo.id}, ${ids['1000']})
         AND action IN ('delete_account', 'deactivate_account', 'reactivate_account') ORDER BY id`)
    const ok = usedRefused.startsWith('IN_USE') && usedRefused.includes('journal line') && usedRefused.includes('Deactivate it instead')
      && parentRefused.includes('1 sub-account') && typoGone === 'ok' && left.n === 0
      && off === 'ok' && inactive.is_active === false && on === 'ok' && active.is_active === true
      && notOurs.startsWith('NOT_OURS')
      && trail.map((t) => t.action).join(',') === 'delete_account,deactivate_account,reactivate_account'
    ;(ok ? pass : fail)('A47 an account is deactivated and reactivated, and deleted only while nothing uses it',
      `cash: ${usedRefused.slice(0, 80)}; parent: ${parentRefused.slice(0, 60)}; typo: ${typoGone} (${left.n} left); `
        + `deactivate ${off} → active ${inactive.is_active}, reactivate ${on} → ${active.is_active}; theirs: ${notOurs.slice(0, 40)}; `
        + `trail ${trail.map((t) => t.action).join(', ')}`)
  }

  await trailNamesPeople((ok, l, d) => (ok ? pass(l, d) : fail(l, d)), 'A27 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

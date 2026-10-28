/**
 * Closing and reopening periods — the control that protects a filed figure.
 *   npm run db:verify-periods   (resets the TEST database first)
 */
import './env'
import { expectCode, reporter } from './suite'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { byHand } from './by-hand'
import { APP_NAME, ledgerTitle } from '../src/lib/app-name'
import { trailNamesPeople } from './actor-trail'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv, setAccountRoles } from '../src/lib/accounts'
import {
  closeFiscalYear, postEntry, reopenFiscalYear, reverseEntry, saveDraft, unclosedYears,
} from '../src/lib/posting'
import {
  closePeriod, periodHistory, periodOverview, periodReadiness, reopenPeriod,
} from '../src/lib/periods'
import { parseMoney } from '../src/lib/money'

const r = reporter(52)
const { pass, fail } = r

const expectError = expectCode(r, { passSlice: 76 })

/**
 * Run something with the posted-entry immutability trigger off, and put it back
 * whatever happens. Some states are unreachable through the application by
 * design; constructing them to test a detector means stepping around a guard,
 * and a guard left off is worse than the test is worth.
 */
async function withoutGuards(triggers: string[], fn: () => Promise<void>) {
  for (const t of triggers) {
    await db.execute(raw`ALTER TABLE journal_entry DISABLE TRIGGER ${raw.raw(t)}`)
  }
  try { await fn() }
  finally {
    for (const t of triggers) {
      await db.execute(raw`ALTER TABLE journal_entry ENABLE TRIGGER ${raw.raw(t)}`)
    }
  }
}
const withoutImmutability = (fn: () => Promise<void>) =>
  withoutGuards(['trg_entry_immutable'], fn)

const CHART = `1000,Cash,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
3000,Share Capital,equity,,share_capital
3100,Retained Earnings,equity,,retained_earnings
4000,Revenue,revenue,,revenue_from_contracts
5000,Expenses,expense,,other_operating_expenses fn_administrative_expenses`

async function main() {
  const co = await createCompanyWithYear({ code: 'ACME', name: 'Acme Consulting Inc.' }, 'alicio@example.test')
  const L = co.ledger.id
  const accts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  const yr = Number(co.year.endDate.slice(0, 4))

  const periods = await periodOverview(L)
  const jan = periods.find((p) => p.name.endsWith('-01'))!
  const feb = periods.find((p) => p.name.endsWith('-02'))!
  const mar = periods.find((p) => p.name.endsWith('-03'))!

  await postEntry({
    ledgerId: L, entryDate: `${yr}-01-15`, description: 'Opening capital', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1000'], amount: parseMoney('10000.00') },
      { accountId: id['3000'], amount: -parseMoney('10000.00') },
    ],
  })

  // P1 — a clean period reports nothing to worry about
  const clean = await periodReadiness(L, jan.id)
  clean.length === 0
    ? pass('P1 a clean period is ready to close', 'nothing to report')
    : fail('P1 a clean period is ready to close', JSON.stringify(clean.map((c) => c.what)))

  // P2 — closing it, and the ledger refusing entries afterwards
  const closed = await closePeriod(L, jan.id, { actor: 'alicio@example.test' })
  await expectError('P2 a closed period refuses new entries', 'PERIOD_CLOSED', () =>
    postEntry({
      ledgerId: L, entryDate: `${yr}-01-20`, description: 'Too late', actor: 'alicio@example.test',
      lines: [
        { accountId: id['5000'], amount: parseMoney('50.00') },
        { accountId: id['1000'], amount: -parseMoney('50.00') },
      ],
    }))
  closed.status === 'closed'
    ? pass('P3 closing records who and when', `${closed.name} closed by alicio`)
    : fail('P3 closing records who and when', JSON.stringify(closed))

  // P4 — reopening demands a reason, because it unfreezes filed figures
  await expectError('P4 reopening without a reason is refused', 'NO_REASON', () =>
    reopenPeriod(L, jan.id, '   ', 'alicio@example.test'))

  // P5 — with one, it reopens and the entry now posts
  await reopenPeriod(L, jan.id, 'Invoice arrived after the month was closed', 'alicio@example.test')
  const late = await postEntry({
    ledgerId: L, entryDate: `${yr}-01-20`, description: 'Late invoice', actor: 'alicio@example.test',
    lines: [
      { accountId: id['5000'], amount: parseMoney('50.00') },
      { accountId: id['1000'], amount: -parseMoney('50.00') },
    ],
  })
  late.entry.entryNo
    ? pass('P5 reopening lets the entry through', `${late.entry.entryNo} posted into a reopened period`)
    : fail('P5 reopening lets the entry through', 'the entry did not post')

  // P6 — and the whole sequence is on the record, with the reason
  const history = await periodHistory(jan.id)
  const closes = history.filter((h) => h.action === 'close_period')
  const reopens = history.filter((h) => h.action === 'reopen_period')
  const reasons = history.filter((h) => h.action === 'reopen_period_reason' && h.reason)
  closes.length === 1 && reopens.length === 1 && reasons.length === 1
    && reasons[0].reason!.startsWith('Invoice arrived')
    ? pass('P6 close and reopen are on the record, with the reason',
           `${history.length} rows, reason kept`)
    : fail('P6 close and reopen are on the record, with the reason',
           JSON.stringify(history.map((h) => `${h.action}:${h.reason ?? ''}`)))

  // P7 — a draft in the period is a warning, not a refusal. The accountant may
  //      know it is going nowhere; arguing with them is worse than saying so.
  await saveDraft({
    ledgerId: L, entryDate: `${yr}-02-14`, description: 'Half-written', actor: 'alicio@example.test',
    lines: [{ accountId: id['5000'], amount: parseMoney('20.00') }],
  })
  const withDraft = await periodReadiness(L, feb.id)
  const draftWarning = withDraft.find((r) => r.what.includes('draft'))
  draftWarning?.severity === 'warning'
    ? pass('P7 a draft is a warning, not a refusal', draftWarning.what)
    : fail('P7 a draft is a warning, not a refusal', JSON.stringify(withDraft))
  await closePeriod(L, feb.id, { actor: 'alicio@example.test' })
  const [febStatus] = await db.execute<{ status: string }>(raw`
    SELECT status FROM fiscal_period WHERE id = ${feb.id}`)
  febStatus.status === 'closed'
    ? pass('P8 it closes anyway', 'the warning did not block it')
    : fail('P8 it closes anyway', febStatus.status)

  // P9 — a stale balance cache is BLOCKING: the figures being frozen would not
  //      be the ledger's.
  await db.execute(raw`
    UPDATE period_balance SET closing_balance = closing_balance + 12345
     WHERE ledger_id = ${L} AND account_id = ${id['1000']}::uuid AND period_id = ${mar.id}::uuid`)
  const drifted = await periodReadiness(L, mar.id)
  const cacheProblem = drifted.find((r) => r.what.includes('balance cache'))
  cacheProblem?.severity === 'blocking'
    ? pass('P9 a stale cache is blocking', cacheProblem.what)
    : fail('P9 a stale cache is blocking', JSON.stringify(drifted.map((d) => d.what)))
  await db.execute(raw`SELECT rebuild_period_balances(${L}::uuid)`)

  // P10 — an account reaching no statement is reported here too, because a
  //        period closed with one is a period whose statements are incomplete.
  const orphan = await importAccounts(co.company.id, [{
    entityId: co.company.id, code: '1900', name: 'Suspense', accountType: 'asset',
  }], 'alicio@example.test')
  const withOrphan = await periodReadiness(L, mar.id)
  withOrphan.some((r) => r.what.includes('reach no balance sheet or income statement line'))
    ? pass('P10 an account reaching no statement is reported', 'statements would balance without it')
    : fail('P10 an account reaching no statement is reported', JSON.stringify(withOrphan.map((r) => r.what)))
  await setAccountRoles(orphan[0].id, ['other_receivables'], 'alicio@example.test')

  // P11 — check_period_assignments had no caller until now (RISKS item 5). The
  //        state it detects is unreachable through the app: the immutability
  //        trigger refuses to move a posted entry's date, and 0007 freezes a
  //        period's boundaries once it holds entries. It is an after-the-fact
  //        detector for damage done another way — psql, a restored backup, a
  //        future bug — so constructing that state means stepping around the
  //        guard, and putting it back.
  const beforeGuard = await periodReadiness(L, mar.id)
  // finally, always: an exception between the disable and the enable would
  // leave the guard committed as off, on whatever database this ran against.
  await withoutImmutability(async () => {
    await byHand((tx) => tx.execute(raw`
      UPDATE journal_entry SET entry_date = ${`${yr}-06-15`}::date WHERE id = ${late.entry.id}`))
  })

  const misfiled = await periodReadiness(L, mar.id)
  const caught = misfiled.find((r) => r.what.includes('wrong period'))
  caught?.severity === 'blocking' && !beforeGuard.some((r) => r.what.includes('wrong period'))
    ? pass('P11 an entry filed under the wrong period is caught',
           `${caught.detail.slice(0, 58)} — the 0007 detector finally has a caller`)
    : fail('P11 an entry filed under the wrong period is caught',
           JSON.stringify({ before: beforeGuard.map((r) => r.what), after: misfiled.map((r) => r.what) }))

  await withoutImmutability(async () => {
    await byHand((tx) => tx.execute(raw`
      UPDATE journal_entry SET entry_date = ${`${yr}-01-20`}::date WHERE id = ${late.entry.id}`))
  })

  // P11b — and the guard that makes it unreachable is still on
  try {
    await byHand((tx) => tx.execute(raw`
      UPDATE journal_entry SET entry_date = ${`${yr}-07-01`}::date WHERE id = ${late.entry.id}`))
    fail('P11b a posted entry\'s date is still immutable', 'the date changed')
  } catch {
    pass('P11b a posted entry\'s date is still immutable', 'the trigger was put back')
  }

  // P12 — closing out of order is allowed but said out loud
  const may = periods.find((p) => p.name.endsWith('-05'))!
  const outOfOrder = await periodReadiness(L, may.id)
  outOfOrder.some((r) => r.what.includes('still open') && r.severity === 'warning')
    ? pass('P12 closing out of order is allowed but noted', 'earlier periods still open')
    : fail('P12 closing out of order is allowed but noted', JSON.stringify(outOfOrder.map((r) => r.what)))

  // P13 — locking is stronger than closing, for figures that have been filed
  await closePeriod(L, mar.id, { lock: true, actor: 'alicio@example.test' })
  await expectError('P13 a locked period refuses entries', 'PERIOD_CLOSED', () =>
    postEntry({
      ledgerId: L, entryDate: `${yr}-03-15`, description: 'Into a locked period', actor: 'alicio@example.test',
      lines: [
        { accountId: id['5000'], amount: parseMoney('10.00') },
        { accountId: id['1000'], amount: -parseMoney('10.00') },
      ],
    }))
  await expectError('P14 a locked period cannot simply be closed again', 'LOCKED', () =>
    closePeriod(L, mar.id, { actor: 'alicio@example.test' }))

  // P15 — but it can be reopened, with a reason, because a filing can be amended
  await reopenPeriod(L, mar.id, 'GST/HST return amended', 'alicio@example.test')
  const [marStatus] = await db.execute<{ status: string }>(raw`
    SELECT status FROM fiscal_period WHERE id = ${mar.id}`)
  marStatus.status === 'open'
    ? pass('P15 a locked period can be reopened to amend a filing', 'with the reason on the record')
    : fail('P15 a locked period can be reopened to amend a filing', marStatus.status)

  // P16 — closing twice is refused rather than silently doing nothing
  await closePeriod(L, mar.id, { actor: 'alicio@example.test' })
  await expectError('P16 closing an already-closed period is refused', 'ALREADY', () =>
    closePeriod(L, mar.id, { actor: 'alicio@example.test' }))
  await expectError('P17 reopening an open period is refused', 'ALREADY', () =>
    reopenPeriod(L, jan.id, 'no need', 'alicio@example.test'))

  // P18 — the overview carries what is in each period
  const overview = await periodOverview(L)
  const janRow = overview.find((p) => p.id === jan.id)!
  const febRow = overview.find((p) => p.id === feb.id)!
  Number(janRow.entries) === 2 && janRow.status === 'open'
    && febRow.status === 'closed' && Number(febRow.drafts) === 1
    ? pass('P18 the overview shows what each period holds',
           `Jan ${janRow.entries} entries open; Feb closed with ${febRow.drafts} draft`)
    : fail('P18 the overview shows what each period holds',
           JSON.stringify({ jan: janRow, feb: febRow }))

  // P19 — after all of it the ledger still reconciles
  const [drift] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM check_balance_integrity(${L}::uuid)`)
  drift.n === '0'
    ? pass('P19 the ledger reconciles after closing and reopening', 'no drift')
    : fail('P19 the ledger reconciles after closing and reopening', drift.n)

  // P20 — BLOCKING must block. It did not: closePeriod never consulted the
  //        checklist, so a period with a stale cache closed exactly as easily
  //        as a clean one, freezing figures known not to be the ledger's.
  const jun = periods.find((p) => p.name.endsWith('-06'))!
  await db.execute(raw`
    UPDATE period_balance SET closing_balance = closing_balance + 4200
     WHERE ledger_id = ${L} AND account_id = ${id['1000']}::uuid AND period_id = ${jun.id}::uuid`)
  await expectError('P20 a blocking condition refuses the close', 'NOT_READY', () =>
    closePeriod(L, jun.id, { actor: 'alicio@example.test' }))
  const [junStill] = await db.execute<{ status: string }>(raw`
    SELECT status FROM fiscal_period WHERE id = ${jun.id}`)
  junStill.status === 'open'
    ? pass('P21 and the period is still open', 'the refusal was not cosmetic')
    : fail('P21 and the period is still open', junStill.status)

  // P22 — but it can be overridden deliberately, and the override is recorded
  const forced = await closePeriod(L, jun.id, { actor: 'alicio@example.test', overrideReason: 'known, fixing next week' })
  const [override] = await db.execute<{ reason: string; blocking: string }>(raw`
    SELECT context->>'reason' AS reason, before->>'blocking' AS blocking
      FROM audit_log WHERE action = 'close_period_override' ORDER BY occurred_at DESC LIMIT 1`)
  forced.overrode.length > 0 && override?.reason === 'known, fixing next week'
    ? pass('P22 an override is possible and recorded', `overrode: ${forced.overrode.join('; ')}`)
    : fail('P22 an override is possible and recorded', JSON.stringify({ forced, override }))
  await db.execute(raw`SELECT rebuild_period_balances(${L}::uuid)`)

  // P23 — a break-even year could not be closed at all: the retained-earnings
  //       line would have been zero, and journal_line forbids that.
  const even = await createCompanyWithYear({ code: 'EVEN', name: 'Break Even Inc.' }, 'alicio@example.test')
  const evenAccts = await importAccounts(even.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: even.company.id })), 'alicio@example.test')
  const evenId = Object.fromEntries(evenAccts.map((a) => [a.code, a.id]))
  const evenYr = Number(even.year.endDate.slice(0, 4))
  await postEntry({
    ledgerId: even.ledger.id, entryDate: `${evenYr}-03-01`, description: 'Revenue', actor: 'alicio@example.test',
    lines: [
      { accountId: evenId['1000'], amount: parseMoney('1000.00') },
      { accountId: evenId['4000'], amount: -parseMoney('1000.00') },
    ],
  })
  await postEntry({
    ledgerId: even.ledger.id, entryDate: `${evenYr}-03-02`, description: 'Expenses', actor: 'alicio@example.test',
    lines: [
      { accountId: evenId['5000'], amount: parseMoney('1000.00') },
      { accountId: evenId['1000'], amount: -parseMoney('1000.00') },
    ],
  })
  // P40 — a break-even year is OFFERED. The company page lists unclosedYears,
  //       and the old rule — a nonzero total — skipped a year whose revenue
  //       and expenses net to zero, so such a year could be closed by the
  //       library (P23, below) and never from the page.
  const offered = await unclosedYears(even.ledger.id)
  const evenOffered = offered.find((y) => y.id === even.year.id)
  evenOffered !== undefined && evenOffered.result === '0'
    ? pass('P40 a break-even year is offered for closing', `${evenOffered.name}, result ${evenOffered.result}`)
    : fail('P40 a break-even year is offered for closing',
           evenOffered ? `listed with result ${evenOffered.result}` : `not listed (${offered.length} year(s) listed)`)

  const evenClose = await closeFiscalYear(even.ledger.id, even.year.id, 'alicio@example.test')
  const [evenPl] = await db.execute<{ n: string }>(raw`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS n
      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${even.ledger.id} AND je.status IN ('posted','reversed')
       AND a.account_type IN ('revenue','expense')`)
  evenClose.result === 0n && evenPl.n === '0'
    ? pass('P23 a break-even year closes', `${evenClose.entry.entryNo}, no retained-earnings line needed`)
    : fail('P23 a break-even year closes', JSON.stringify({ result: evenClose.result.toString(), pl: evenPl.n }))

  // P24 — closing a year now marks it closed, so 0006's year gate is live and
  //       reopenPeriod's "reopen the year first" names a real operation
  const [evenYear] = await db.execute<{ status: string }>(raw`
    SELECT status FROM fiscal_year WHERE id = ${even.year.id}`)
  evenYear.status === 'closed'
    ? pass('P24 closing a year marks the year closed', 'the year-status gate is no longer inert')
    : fail('P24 closing a year marks the year closed', evenYear.status)

  await expectError('P25 a closed year refuses postings', 'PERIOD_CLOSED', () =>
    postEntry({
      ledgerId: even.ledger.id, entryDate: `${evenYr}-03-15`, description: 'Too late', actor: 'alicio@example.test',
      lines: [
        { accountId: evenId['5000'], amount: parseMoney('5.00') },
        { accountId: evenId['1000'], amount: -parseMoney('5.00') },
      ],
    }))

  // P26 — and reopening the year is a real operation, by reversing its close
  await expectError('P26 reopening a year without a reason is refused', 'NO_REASON', () =>
    reopenFiscalYear(even.ledger.id, even.year.id, '  ', 'alicio@example.test'))
  const reopenedYear = await reopenFiscalYear(even.ledger.id, even.year.id, 'figures restated', 'alicio@example.test')
  const [afterReopen] = await db.execute<{ status: string }>(raw`
    SELECT status FROM fiscal_year WHERE id = ${even.year.id}`)
  const [restoredPl] = await db.execute<{ n: string }>(raw`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS n
      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${even.ledger.id} AND je.status IN ('posted','reversed')
       AND a.account_type IN ('revenue','expense')`)
  afterReopen.status === 'open' && restoredPl.n === '0'
    ? pass('P26b reopening a year reverses its close',
           `${reopenedYear.reversal.entryNo} put the balances back`)
    : fail('P26b reopening a year reverses its close',
           JSON.stringify({ status: afterReopen.status, pl: restoredPl.n }))

  // P27 — an entry stranded in a closed period is reported. This is the state
  //       the close/post race produced, which no detector caught before.
  const [strandedPeriod] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM fiscal_period WHERE ledger_id = ${L} AND period_no = 2`)
  // The period gate refuses this, which is the point — so constructing the
  // state a race would produce means stepping around that gate too.
  await withoutGuards(['trg_entry_immutable', 'trg_period_open', 'trg_entry_balanced'], async () => {
    await byHand((tx) => tx.execute(raw`
      INSERT INTO journal_entry (id, ledger_id, entry_no, entry_date, period_id, description,
                                 status, total_debit, total_credit, posted_at, posted_by)
      VALUES (gen_random_uuid(), ${L}, 'STRANDED-1', ${`${yr}-02-10`}::date, ${strandedPeriod.id}::uuid,
              'Slipped past a close', 'posted', 0, 0, now(), 'racer')`))
  })
  const strandedCheck = await periodReadiness(L, jan.id)
  const strandedItem = strandedCheck.find((r) => r.what.includes('period that is not open'))
  strandedItem?.severity === 'blocking'
    ? pass('P27 an entry stranded in a closed period is reported', strandedItem.detail.slice(0, 58))
    : fail('P27 an entry stranded in a closed period is reported',
           JSON.stringify(strandedCheck.map((r) => r.what)))
  // The immutability guard refuses to delete a posted entry, correctly. Clean
  // up through the same door that let it in.
  await withoutGuards(['trg_entry_immutable'], async () => {
    await byHand((tx) => tx.execute(raw`DELETE FROM journal_entry WHERE entry_no = 'STRANDED-1'`))
  })

  // P28 — every trigger is back on, whatever the tests did
  const [triggers] = await db.execute<{ off: string }>(raw`
    SELECT count(*)::text AS off FROM pg_trigger
     WHERE tgrelid = 'journal_entry'::regclass AND NOT tgisinternal AND tgenabled <> 'O'`)
  triggers.off === '0'
    ? pass('P28 no trigger was left disabled', 'every guard on journal_entry is on')
    : fail('P28 no trigger was left disabled', `${triggers.off} disabled`)

  // P30 — ONE press. The screen chooses the period in the URL (`?period=`,
  //       so the readiness checks that read the whole ledger run for one row
  //       rather than twelve); the panel then used to start collapsed on top
  //       of that, so a person pressed "Close…", got a button saying "Close
  //       January", and had to press THAT before anything appeared (owner,
  //       2026-09-07). What this proves is that the panel renders its form,
  //       its readiness and its buttons with no press of its own — not that a
  //       browser behaves, which no check here can say (RISKS §16).
  // P41 — a reversed pair is left out of the total. `entries` is everything
  //       on the record, `total` only what stands (a posted entry that is not
  //       itself a reversal), and `outside` the rest — the reversed originals
  //       and the reversals. Both halves of a reversed pair used to be summed,
  //       so a period with one correction in it looked twice as busy as it
  //       was. And the year rides on every row, so the periods page can name
  //       it and offer to reopen it.
  {
    const rent = await postEntry({
      ledgerId: even.ledger.id, entryDate: `${evenYr}-03-05`, description: 'Rent', actor: 'alicio@example.test',
      lines: [
        { accountId: evenId['5000'], amount: parseMoney('200.00') },
        { accountId: evenId['1000'], amount: -parseMoney('200.00') },
      ],
    })
    await reverseEntry(rent.entry.id, `${evenYr}-03-06`, 'posted twice', 'alicio@example.test')
    const rows = await periodOverview(even.ledger.id)
    const march = rows.find((p) => p.start_date === `${evenYr}-03-01`)!
    Number(march.entries) === 4 && Number(march.outside) === 2 && march.total === '200000'
      && march.year_id === even.year.id && march.year_status === 'open'
      ? pass('P41 a reversed pair is left out of the period total, and the overview carries the year',
             `March: ${march.entries} entries, ${march.outside} reversed or reversing, ${(Number(march.total) / 100).toFixed(2)} stands; year ${march.year_status}`)
      : fail('P41 a reversed pair is left out of the period total, and the overview carries the year',
             JSON.stringify({ entries: march.entries, outside: march.outside, total: march.total, year: march.year_status }))
  }

  // P43 — a year is reopened only from its own ledger. The first screen for
  //       this door was gated on the ledger alone and posted whatever year id
  //       it held (critic, 2026-09-13); the door now asks the year beside the
  //       ledger before anything else, so the wrong ledger is told so even for
  //       a year that is open.
  await expectError('P43 a year is reopened only from its own ledger', 'NOT_OURS', () =>
    reopenFiscalYear(L, even.year.id, 'from the wrong ledger', 'alicio@example.test'))

  {
    const render = (input: unknown) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-period-actions.tsx', JSON.stringify(input),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const clean = render({ which: 'close', periodName: 'January 2026', status: 'open', readiness: [] })
    const blocked = render({ which: 'close', periodName: 'January 2026', status: 'open', readiness: [
      { severity: 'blocking', scope: 'ledger', what: 'A draft entry', detail: 'JE-00003 is still a draft.' },
      { severity: 'warning', scope: 'period', what: 'No statement', detail: 'The bank was never reconciled.' },
    ] })
    const reopen = render({ which: 'reopen', periodName: 'January 2026', status: 'locked', readiness: [] })
    const noButtonFirst = (html: string) => !/<button[^>]*>\s*(Close|Reopen) January 2026\s*<\/button>/.test(html)
    const ok = (c: boolean, l: string, d: string) => (c ? pass(l, d) : fail(l, d))
    ok(clean.includes('<form') && clean.includes('name="periodId"') && clean.includes('name="lock"')
      && clean.includes('Nothing outstanding') && noButtonFirst(clean)
      && blocked.includes('cannot be closed as things stand') && blocked.includes('JE-00003 is still a draft')
      && blocked.includes('name="overrideReason"') && blocked.includes('The bank was never reconciled')
      && blocked.includes('Close with the reason above')
      && reopen.includes('<form') && reopen.includes('name="reason"') && reopen.includes('its figures were filed')
      && noButtonFirst(reopen)
      && clean.includes('/periods"') && reopen.includes('/periods"'),
      'P30 the close and reopen panels are open on arrival — no press of their own before the options',
      `clean: form ${clean.includes('<form')}, nothing outstanding ${clean.includes('Nothing outstanding')}; `
      + `blocked: reason box ${blocked.includes('name="overrideReason"')}; reopen: reason ${reopen.includes('name="reason"')}`)

    // P42 — a closed YEAR can be reopened from the periods page. The library
    //       had reopenFiscalYear since 0006 and four refusals said "reopen the
    //       year" while no screen could. The control is rendered here; the page
    //       is read from source for the two facts a render of one component
    //       cannot show — that the page mounts the control, and only for a
    //       closed year.
    const reopenYear = render({ which: 'reopen-year', yearName: 'FY2026', periodName: '', status: '', readiness: [] })
    const pageSource = readFileSync('src/app/ledger/[ledgerId]/periods/page.tsx', 'utf8')
    ok(reopenYear.includes('<form') && reopenYear.includes('name="fiscalYearId"') && reopenYear.includes('name="reason"')
      && reopenYear.includes('reverses the closing entry') && /Reopen FY2026<\/button>/.test(reopenYear)
      && pageSource.includes('<ReopenYearControls') && pageSource.includes("fy.year_status === 'closed' && openedYearId === fy.year_id"),
      'P42 a closed year can be reopened from the periods page, with a reason on the record',
      `control: form ${reopenYear.includes('<form')}, year id ${reopenYear.includes('name="fiscalYearId"')}, reason ${reopenYear.includes('name="reason"')}; `
      + `page mounts it ${pageSource.includes('<ReopenYearControls')}, for a closed year only ${pageSource.includes("fy.year_status === 'closed' && openedYearId === fy.year_id")}`)
  }

  // P31 — the browser tab. It said "Create Next App" until 2026-09-07, which
  //       is what the Next.js scaffold writes; the owner asked for a name.
  //
  //       The ledger shell's `generateMetadata` is CALLED here rather than
  //       grepped, so what is checked is the title a browser would get. The
  //       first version read three files back for strings the same change had
  //       written, which is the shape this project already replaced once
  //       under review (US33; critic, 2026-09-07). The root template is still
  //       read from source — Next composes it, and there is no runtime here
  //       to compose it with — and this says so rather than implying more.
  {
    const root = readFileSync('src/app/layout.tsx', 'utf8')
    const resolved = { title: await ledgerTitle(L) }
    const unknown = { title: await ledgerTitle('00000000-0000-0000-0000-000000000000') }
    const shell = readFileSync('src/app/ledger/[ledgerId]/layout.tsx', 'utf8')
    const ok = (c: boolean, l: string, d: string) => (c ? pass(l, d) : fail(l, d))
    // Widened to string, so this reads the constant rather than being folded
    // away by the compiler as a comparison of two literals.
    const declared: string = APP_NAME
    ok(declared.length > 0 && declared !== 'Create Next App'
      && resolved.title === 'Acme Consulting Inc.' && unknown.title === 'Company'
      && !root.includes('Create Next App') && !root.includes('Generated by create next app')
      && root.includes('APP_NAME') && root.includes('template:')
      && shell.includes('title: await ledgerTitle(ledgerId)'),
      'P31 the tab is named, and the ledger resolves its company as the title',
      `named "${declared}"; the ledger's title resolves to "${resolved.title}"; `
      + `an unknown one to "${unknown.title}"; the scaffold text is gone: ${!root.includes('Create Next App')}`)
  }

  // P39 — AND THE PICTURE BESIDE THE NAME.
  //
  //       The tab was named on 2026-09-07 and went on wearing the scaffold's
  //       icon until 2026-09-12: `favicon.ico` was the one `create-next-app`
  //       writes, and `public/` still held Vercel's and Next's own marks. A
  //       name and a picture are the two halves of what a person picks a tab
  //       out by, and only one of them had been done.
  //
  //       Read off the FILES rather than the markup, because Next emits the
  //       link itself from what is in `app/` — there is no line of ours to
  //       read — and the two things that can go wrong are both facts about
  //       files: ours is missing, or the scaffold's is still there.
  {
    const ok = (c: boolean, l: string, d: string) => (c ? pass(l, d) : fail(l, d))
    const icon = existsSync('src/app/icon.png') ? readFileSync('src/app/icon.png') : Buffer.alloc(0)
    const brand = existsSync('public/banyan-icon.png') ? readFileSync('public/banyan-icon.png') : Buffer.alloc(0)
    const scaffold = ['src/app/favicon.ico', 'src/app/icon.svg', 'public/next.svg', 'public/vercel.svg',
                      'public/file.svg', 'public/globe.svg', 'public/window.svg']
      .filter((f) => existsSync(f))
    const png = icon.length > 24 && icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const width = png ? icon.readUInt32BE(16) : 0
    const height = png ? icon.readUInt32BE(20) : 0
    const sameMark = icon.length > 0 && icon.equals(brand)
    const deskMark = readFileSync('src/components/Desk.tsx', 'utf8').includes('src="/banyan-icon.png"')
    const rail = readFileSync('src/components/NavRail.tsx', 'utf8')
    const railUnbranded = !rail.includes('src="/banyan-icon.png"')
      && !rail.includes('className="nav-brand')
    // AND THE BROWSER CAN ACTUALLY GET IT. The file being right was never the
    // question: the gate's matcher excluded `favicon.ico` and not the icon,
    // so renaming the mark sent every tab request to the login screen and the
    // tab sat blank — on the login page itself, which is the first thing
    // anybody sees. So the PATTERN is compiled and run, not read for a
    // substring: what can be wrong here is which paths it gates.
    const matcher = /matcher: \['([^']+)'\]/.exec(readFileSync('src/proxy.ts', 'utf8'))?.[1] ?? ''
    const gates = (path: string) => matcher !== '' && new RegExp(`^${matcher}$`).test(path)
    const gating: Array<[string, boolean]> = [
      ['/icon.png', gates('/icon.png')],
      ['/banyan-icon.png', gates('/banyan-icon.png')],
      ['/favicon.ico', gates('/favicon.ico')],
      ['/_next/static/x.js', gates('/_next/static/x.js')],
      ['/login', gates('/login')],
      ['/ledger/abc/entries', gates('/ledger/abc/entries')],
    ]
    // SKIPPED, not "allowed": the matcher decides whether the middleware RUNS
    // on a path, and the middleware is what lets a login page through. The
    // three the tab and Next fetch must be skipped; the two that carry a person
    // must reach it, because a pattern that skips everything is the other way
    // to get this wrong.
    const gateRight = !gating[0]![1] && !gating[1]![1] && !gating[2]![1] && !gating[3]![1]
      && gating[4]![1] && gating[5]![1]
    ok(png && width >= 128 && width === height && sameMark && deskMark && railUnbranded
      && scaffold.length === 0 && gateRight,
      'P39 the tab wears our own mark, and the browser is allowed to fetch it',
      `${png ? `icon.png is ${width}×${height}, ${icon.length} bytes` : 'there is NO valid icon.png'}; `
        + `brand copy ${sameMark ? 'matches' : 'DIFFERS'}, desk ${deskMark}, no duplicate rail mark ${railUnbranded}; `
        + `${scaffold.length === 0 ? 'no scaffold art left'
             : `still shipping ${scaffold.join(', ')}`}; the gate `
        + `${gating.map(([path, run]) => `${run ? 'runs on' : 'skips'} ${path}`).join(', ')}`)
  }

  await trailNamesPeople((ok, l, d) => (ok ? pass(l, d) : fail(l, d)), 'P29 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

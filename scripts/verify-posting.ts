/**
 * Exercises postEntry() end to end against a real database.
 * Run with: npm run db:verify   (resets the database first)
 */
import './env'
import { expectCode, reporter } from './suite'
import { byHand } from './by-hand'
import { trailNamesPeople } from './actor-trail'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { account, entity, fiscalPeriod, fiscalYear, ledger } from '../src/db/schema'
import { amendEntry, deleteEntry, editEntry, postEntry, reverseEntry } from '../src/lib/posting'
import { parseMoney, formatMoney } from '../src/lib/money'
import { rebuildLedgerBalances } from '../src/lib/balances'

const r = reporter(46)
const { pass, fail } = r

const expectError = expectCode(r, { succeeded: (code) => `expected ${code} but it succeeded` })

async function countEntries() {
  const [row] = await db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM journal_entry`)
  return Number(row.n)
}

async function main() {
  // ---------------------------------------------------------------- fixtures
  const [acme] = await db.insert(entity).values({ code: 'ACME', name: 'Acme Consulting Inc.', province: 'ON' }).returning()
  const [led] = await db.insert(ledger).values({ entityId: acme.id, code: 'PRIMARY', name: 'Acme — Primary' }).returning()
  const [fy] = await db.insert(fiscalYear).values({
    ledgerId: led.id, name: 'FY2026', startDate: '2026-01-01', endDate: '2026-12-31',
  }).returning()

  for (let n = 1; n <= 12; n++) {
    const start = `2026-${String(n).padStart(2, '0')}-01`
    const end = new Date(Date.UTC(2026, n, 0)).toISOString().slice(0, 10)
    await db.insert(fiscalPeriod).values({
      fiscalYearId: fy.id, ledgerId: led.id, periodNo: n,
      name: `2026-${String(n).padStart(2, '0')}`, startDate: start, endDate: end,
    })
  }

  const mk = async (code: string, name: string, type: 'asset'|'liability'|'equity'|'revenue'|'expense', nb: 'debit'|'credit', postable = true) =>
    (await byHand((tx) => tx.insert(account).values({
      entityId: acme.id, code, name, accountType: type, normalBalance: nb, isPostable: postable,
    }).returning()))[0]

  const cash = await mk('1000', 'Cash — Operating', 'asset', 'debit')
  const ar = await mk('1200', 'Accounts Receivable', 'asset', 'debit')
  const hst = await mk('2100', 'GST/HST Payable', 'liability', 'credit')
  const capital = await mk('3000', 'Share Capital', 'equity', 'credit')
  const revenue = await mk('4000', 'Service Revenue', 'revenue', 'credit')
  const header = await mk('1999', 'TOTAL ASSETS', 'asset', 'debit', false)

  // ------------------------------------------------------------------ tests
  const r1 = await postEntry({
    ledgerId: led.id, entryDate: '2026-01-15', description: 'Initial share capital',
    sourceType: 'opening_balance', idempotencyKey: 'seed:capital', actor: 'alicio@example.test',
    lines: [
      { accountId: cash.id, amount: parseMoney('10000.00') },
      { accountId: capital.id, amount: -parseMoney('10000.00') },
    ],
  })
  // OPN, not JE: the prefix names the door the entry came through, and this
  // one came through the opening-balance door. No year in the number — the
  // date carries it, and one continuous sequence per source never repeats.
  r1.entry.entryNo === 'OPN-00001'
    ? pass('V1 posts and numbers the entry by its source', r1.entry.entryNo!)
    : fail('V1 posts and numbers the entry by its source', `got ${r1.entry.entryNo}`)

  const r2 = await postEntry({
    ledgerId: led.id, entryDate: '2026-01-15', description: 'Initial share capital',
    sourceType: 'opening_balance', idempotencyKey: 'seed:capital',
    lines: [
      { accountId: cash.id, amount: parseMoney('10000.00') },
      { accountId: capital.id, amount: -parseMoney('10000.00') },
    ],
  })
  r2.replayed && r2.entry.id === r1.entry.id
    ? pass('V2 replay of an idempotency key is a no-op', 'same entry returned')
    : fail('V2 replay of an idempotency key is a no-op')

  await expectError('V3 rejects an unbalanced entry', 'OUT_OF_BALANCE', () => postEntry({
    ledgerId: led.id, entryDate: '2026-02-01', description: 'Lopsided',
    lines: [
      { accountId: cash.id, amount: parseMoney('100.00') },
      { accountId: revenue.id, amount: -parseMoney('90.00') },
    ],
  }))

  await expectError('V4 rejects a single-line entry', 'TOO_FEW_LINES', () => postEntry({
    ledgerId: led.id, entryDate: '2026-02-01', description: 'One-sided',
    lines: [{ accountId: cash.id, amount: parseMoney('100.00') }],
  }))

  await expectError('V5 rejects a heading account', 'HEADER_ACCOUNT', () => postEntry({
    ledgerId: led.id, entryDate: '2026-02-01', description: 'Into a heading',
    lines: [
      { accountId: header.id, amount: parseMoney('100.00') },
      { accountId: revenue.id, amount: -parseMoney('100.00') },
    ],
  }))

  await expectError('V6 rejects a date with no fiscal period', 'NO_PERIOD', () => postEntry({
    ledgerId: led.id, entryDate: '2025-06-01', description: 'Before the first year',
    lines: [
      { accountId: cash.id, amount: parseMoney('100.00') },
      { accountId: revenue.id, amount: -parseMoney('100.00') },
    ],
  }))

  // A real invoice, so there is something to reverse and report on.
  const inv = await postEntry({
    ledgerId: led.id, entryDate: '2026-02-10', description: 'Invoice 1001 — consulting',
    actor: 'alicio@example.test',
    lines: [
      { accountId: ar.id, amount: parseMoney('5650.00'), description: 'A/R — Client X' },
      { accountId: revenue.id, amount: -parseMoney('5000.00'), description: 'Consulting fees' },
      { accountId: hst.id, amount: -parseMoney('650.00'), description: 'HST 13%' },
    ],
  })

  // V7 — numbering stays gapless across the four rejected attempts above, and
  //      the manual door has its own sequence: this is JE number one although
  //      an OPN entry already exists.
  inv.entry.entryNo === 'JE-00001'
    ? pass('V7 numbering stays gapless after failures', inv.entry.entryNo!)
    : fail('V7 numbering stays gapless after failures', `got ${inv.entry.entryNo}, expected JE-00001`)

  // V8 — closing a period blocks posting into it.
  await byHand((tx) => tx.update(fiscalPeriod).set({ status: 'closed' })
    .where(raw`${fiscalPeriod.ledgerId} = ${led.id} AND ${fiscalPeriod.periodNo} = 1`))
  await expectError('V8 rejects posting into a closed period', 'PERIOD_CLOSED', () => postEntry({
    ledgerId: led.id, entryDate: '2026-01-20', description: 'Backdated',
    lines: [
      { accountId: cash.id, amount: parseMoney('100.00') },
      { accountId: revenue.id, amount: -parseMoney('100.00') },
    ],
  }))

  // V9 — reversal leaves an audit trail and keeps the ledger balanced.
  const rev = await reverseEntry(inv.entry.id, '2026-03-01', 'wrong client', 'alicio@example.test')
  const [{ status }] = await db.execute<{ status: string }>(
    raw`SELECT status FROM journal_entry WHERE id = ${inv.entry.id}`)
  // A reversal is an adjustment and says so in its number.
  status === 'reversed' && rev.reversal.entryNo === 'ADJ-00001'
    ? pass('V9 reversal links both entries', `${inv.entry.entryNo} -> ${rev.reversal.entryNo}`)
    : fail('V9 reversal links both entries', `status=${status} no=${rev.reversal.entryNo}`)

  const [{ net }] = await db.execute<{ net: string }>(
    raw`SELECT COALESCE(SUM(jl.amount),0)::text AS net FROM journal_line jl
          JOIN journal_entry je ON je.id = jl.entry_id WHERE je.status IN ('posted','reversed')`)
  net === '0' ? pass('V10 ledger nets to zero', 'SUM(amount) = 0') : fail('V10 ledger nets to zero', `net = ${net}`)

  // V13..V15 — amendEntry is the mechanism the whole immutability model rests on.
  const toAmend = await postEntry({
    ledgerId: led.id, entryDate: '2026-04-05', description: 'Office supplies — wrong amount',
    actor: 'alicio@example.test',
    lines: [
      { accountId: revenue.id, amount: -parseMoney('300.00') },
      { accountId: cash.id, amount: parseMoney('300.00') },
    ],
  })

  const amended = await amendEntry(toAmend.entry.id, {
    entryDate: '2026-04-05', description: 'Office supplies — corrected',
    lines: [
      { accountId: revenue.id, amount: -parseMoney('350.00') },
      { accountId: cash.id, amount: parseMoney('350.00') },
    ],
  }, 'alicio@example.test')

  const [amendedRow] = await db.execute<{ status: string; reversed_by: string | null }>(
    raw`SELECT status, reversed_by_id::text AS reversed_by FROM journal_entry WHERE id = ${toAmend.entry.id}`)
  const [replacementRow] = await db.execute<{ replaces: string | null }>(
    raw`SELECT replaces_id::text AS replaces FROM journal_entry WHERE id = ${amended.replacement.id}`)

  amendedRow.status === 'reversed' && amendedRow.reversed_by === amended.reversal.id
    && replacementRow.replaces === toAmend.entry.id
    ? pass('V13 amend reverses and links three ways', `${toAmend.entry.entryNo} -> ${amended.replacement.entryNo}`)
    : fail('V13 amend reverses and links three ways', JSON.stringify({ amendedRow, replacementRow }))

  // V14 — the one that matters: a replacement that cannot post must take the
  //       reversal down with it. Otherwise the books keep a reversed entry
  //       with nothing standing in its place.
  const good = await postEntry({
    ledgerId: led.id, entryDate: '2026-05-05', description: 'Consulting — to be amended badly',
    lines: [
      { accountId: revenue.id, amount: -parseMoney('900.00') },
      { accountId: cash.id, amount: parseMoney('900.00') },
    ],
  })
  const entriesBefore = await countEntries()

  try {
    await amendEntry(good.entry.id, {
      entryDate: '2026-05-05', description: 'Unbalanced replacement',
      lines: [
        { accountId: revenue.id, amount: -parseMoney('900.00') },
        { accountId: cash.id, amount: parseMoney('800.00') },   // deliberately out of balance
      ],
    }, 'alicio@example.test')
    fail('V14 failed amend rolls the reversal back', 'the bad amend was accepted')
  } catch {
    const [row] = await db.execute<{ status: string }>(
      raw`SELECT status FROM journal_entry WHERE id = ${good.entry.id}`)
    const entriesAfter = await countEntries()
    row.status === 'posted' && entriesAfter === entriesBefore
      ? pass('V14 failed amend rolls the reversal back', `still posted, still ${entriesAfter} entries`)
      : fail('V14 failed amend rolls the reversal back',
             `status=${row.status}, entries ${entriesBefore} -> ${entriesAfter}`)
  }

  // V15 — closing a period is a control action and must leave a trail.
  await byHand((tx) => tx.update(fiscalPeriod).set({ status: 'closed', closedBy: 'alicio@example.test' })
    .where(raw`${fiscalPeriod.ledgerId} = ${led.id} AND ${fiscalPeriod.periodNo} = 2`))
  await byHand((tx) => tx.update(fiscalPeriod).set({ status: 'open' })
    .where(raw`${fiscalPeriod.ledgerId} = ${led.id} AND ${fiscalPeriod.periodNo} = 2`))

  const trail = await db.execute<{ action: string; actor: string }>(raw`
    SELECT action, actor FROM audit_log
     WHERE table_name = 'fiscal_period' ORDER BY occurred_at`)
  trail.some((r) => r.action === 'close_period') && trail.some((r) => r.action === 'reopen_period')
    ? pass('V15 period close/reopen is audited', trail.map((r) => r.action).join(' -> '))
    : fail('V15 period close/reopen is audited', `found: ${JSON.stringify(trail)}`)

  // V16 — the integrity check must come back empty on a healthy ledger.
  const integrity = await db.execute<{ check_name: string; account_code: string; period_name: string }>(
    raw`SELECT check_name, account_code, period_name FROM check_balance_integrity(${led.id}::uuid)`)
  integrity.length === 0
    // One label on both branches. It used to say "is quiet when healthy" when
    // it passed and "reports no drift" when it failed, so the two runs of one
    // check printed two check names and nothing reading a run could pair them.
    ? pass('V16 the integrity check reports no drift', '0 findings')
    : fail('V16 the integrity check reports no drift', JSON.stringify(integrity.slice(0, 5)))

  // V11 — THE important one: the incrementally maintained cache must equal
  //       what a full rebuild from journal_line produces.
  const snapshot = raw`
    SELECT ledger_id::text, period_id::text, account_id::text,
           opening_balance::text, period_debit::text, period_credit::text, closing_balance::text
      FROM period_balance ORDER BY period_id, account_id`
  const before = await db.execute(snapshot)
  await db.execute(raw`SELECT rebuild_period_balances(${led.id}::uuid)`)
  const after = await db.execute(snapshot)

  JSON.stringify(before) === JSON.stringify(after)
    ? pass('V11 incremental balances == full rebuild', `${before.length} rows identical`)
    : fail('V11 incremental balances == full rebuild',
           `\n  incremental: ${JSON.stringify(before.slice(0, 3))}\n  rebuilt:     ${JSON.stringify(after.slice(0, 3))}`)

  // V12 — every period balances, not only the ones with activity.
  const drift = await db.execute<{ period: string }>(raw`
    SELECT fp.name AS period FROM period_balance pb JOIN fiscal_period fp ON fp.id = pb.period_id
     GROUP BY fp.name HAVING SUM(pb.closing_balance) <> 0`)
  drift.length === 0
    ? pass('V12 every period balances', 'all 12 periods sum to 0')
    : fail('V12 every period balances', `off in: ${drift.map((d) => d.period).join(', ')}`)

  // V17 — the integrity check must be able to FAIL, and the rebuild the ledger
  //       page offers must actually clear what it finds. Asserting "no drift"
  //       alone would also pass against a function that returned nothing.
  const [cashAcct] = await db.execute<{ id: string }>(
    raw`SELECT id::text FROM account WHERE code='1000' AND entity_id = ${acme.id}`)
  const [p2] = await db.execute<{ id: string }>(
    raw`SELECT id::text FROM fiscal_period WHERE ledger_id = ${led.id} AND period_no = 2`)

  await db.execute(raw`
    UPDATE period_balance SET closing_balance = closing_balance + 4200
     WHERE ledger_id = ${led.id} AND account_id = ${cashAcct.id}::uuid AND period_id = ${p2.id}::uuid`)

  const [corrupted] = await db.execute<{ n: string }>(
    raw`SELECT count(*)::text AS n FROM check_balance_integrity(${led.id}::uuid)`)
  Number(corrupted.n) > 0
    ? pass('V17 integrity check detects tampering', `${corrupted.n} finding(s)`)
    : fail('V17 integrity check detects tampering', 'corruption went unnoticed')

  const rebuilt = await rebuildLedgerBalances(led.id, 'verify')
  const [audited] = await db.execute<{ n: string }>(
    raw`SELECT count(*)::text AS n FROM audit_log WHERE action = 'rebuild_balances'`)
  rebuilt.findingsBefore > 0 && rebuilt.findingsAfter === 0 && Number(audited.n) === 1
    ? pass('V18 rebuild clears drift and is audited', `${rebuilt.findingsBefore} -> ${rebuilt.findingsAfter}`)
    : fail('V18 rebuild clears drift and is audited', JSON.stringify({ rebuilt, audited }))

  // ---------------------------------------------------------------- report
  console.log('\n--- TRIAL BALANCE, Acme, 2026-03 ---')
  const tb = await db.execute<{ code: string; name: string; balance: string }>(raw`
    SELECT a.code, a.name, pb.closing_balance::text AS balance
      FROM period_balance pb JOIN account a ON a.id = pb.account_id
      JOIN fiscal_period fp ON fp.id = pb.period_id
     WHERE fp.period_no = 3 ORDER BY a.code`)
  for (const r of tb) {
    console.log(`  ${r.code}  ${r.name.padEnd(24)} ${formatMoney(BigInt(r.balance), { sign: 'accounting' }).padStart(14)}`)
  }
  console.log(`  ${''.padEnd(30)} ${formatMoney(tb.reduce((s, r) => s + BigInt(r.balance), 0n)).padStart(14)}  <- must be 0.00`)

  // ============================================================ open books ==
  // E1-E8: the 14-open-books contract. An entry in an OPEN period is edited
  // and deleted through the same door that posted it; the closed period is
  // the only wall; raw SQL still bounces off it.

  const live = await postEntry({
    ledgerId: led.id, entryDate: '2026-05-10', description: 'Rent — typo in the amount',
    actor: 'alicio@example.test',
    lines: [
      { accountId: revenue.id, amount: -parseMoney('900.00') },
      { accountId: cash.id, amount: parseMoney('900.00') },
    ],
  })

  // E1 — the edit lands: new date, new figures, same number.
  const edited = await editEntry(live.entry.id, {
    entryDate: '2026-05-12', description: 'Rent — corrected',
    lines: [
      { accountId: revenue.id, amount: -parseMoney('950.00') },
      { accountId: cash.id, amount: parseMoney('950.00') },
    ],
  }, 'alicio@example.test')
  const [afterEdit] = await db.execute<{ entry_date: string; description: string; total_debit: string }>(
    raw`SELECT entry_date::text, description, total_debit::text FROM journal_entry WHERE id = ${live.entry.id}`)
  edited.entry.entryNo === live.entry.entryNo
    && afterEdit.entry_date === '2026-05-12' && afterEdit.total_debit === '95000'
    ? pass('E1 an open-period edit lands, keeping the number',
           `${edited.entry.entryNo} now ${afterEdit.description}, 950.00`)
    : fail('E1 an open-period edit lands, keeping the number', JSON.stringify(afterEdit))

  // E1b — the edit audit says WHAT changed, not just that something did: the
  //       before holds the old date and both old lines, the after the new.
  //       An audit row with empty hands is a gap wearing a timestamp.
  const [editAudit] = await db.execute<{
    before: { entryDate: string; lines: unknown[] }
    after: { entryDate: string; description: string; lines: unknown[] }
  }>(raw`
    SELECT before, after FROM audit_log
     WHERE action = 'edit' AND table_name = 'journal_entry' AND record_id = ${live.entry.id}
     ORDER BY id DESC LIMIT 1`)
  editAudit?.before?.entryDate === '2026-05-10'
    && (editAudit.before.lines as unknown[]).length === 2
    && editAudit.after?.entryDate === '2026-05-12'
    && editAudit.after.description === 'Rent — corrected'
    && (editAudit.after.lines as unknown[]).length === 2
    ? pass('E1b and the edit audit holds both sides, lines included',
           `before ${editAudit.before.entryDate}, after ${editAudit.after.entryDate}`)
    : fail('E1b and the edit audit holds both sides, lines included',
           JSON.stringify(editAudit ?? 'no row'))

  // E2 — the balance cache moved WITH the edit. This is the whole reason the
  //      door exists: an edit that skipped the deltas would leave every
  //      report reading a cache the journal no longer backs.
  const drift1 = await db.execute(raw`SELECT * FROM check_balance_integrity(${led.id}::uuid)`)
  drift1.length === 0
    ? pass('E2 the balance cache moved with the edit', 'no drift on any check')
    : fail('E2 the balance cache moved with the edit', `${drift1.length} disagreements`)

  // E3 — raw SQL is still refused: the flag marks "rebalanced and audited",
  //      and psql has neither.
  try {
    await byHand((tx) => tx.execute(raw`UPDATE journal_entry SET entry_date = '2026-05-13' WHERE id = ${live.entry.id}`))
    fail('E3 raw SQL still bounces off the wall', 'a bare UPDATE went through')
  } catch (e) {
    String((e as Error).cause ?? e).includes('through the application')
      ? pass('E3 raw SQL still bounces off the wall', 'editEntry rebalances and audits; raw SQL does neither')
      : fail('E3 raw SQL still bounces off the wall', String((e as Error).cause ?? e).slice(0, 80))
  }

  // E4 — the closed period is the wall, with its own sentence.
  await byHand((tx) => tx.update(fiscalPeriod).set({ status: 'closed' })
    .where(raw`${fiscalPeriod.ledgerId} = ${led.id} AND ${fiscalPeriod.periodNo} = 5`))
  await expectError('E4 a closed period refuses the edit', 'PERIOD_CLOSED', () =>
    editEntry(live.entry.id, {
      entryDate: '2026-05-12', description: 'x',
      lines: [
        { accountId: revenue.id, amount: -parseMoney('1.00') },
        { accountId: cash.id, amount: parseMoney('1.00') },
      ],
    }))
  await expectError('E4b and refuses the delete', 'PERIOD_CLOSED', () => deleteEntry(live.entry.id))
  await byHand((tx) => tx.update(fiscalPeriod).set({ status: 'open' })
    .where(raw`${fiscalPeriod.ledgerId} = ${led.id} AND ${fiscalPeriod.periodNo} = 5`))

  // E5 — a delete removes the entry, rebalances, leaves the number gap, and
  //      writes the whole text of what died into the audit log.
  const doomed = await postEntry({
    ledgerId: led.id, entryDate: '2026-05-20', description: 'Duplicate rent, delete me',
    actor: 'alicio@example.test',
    lines: [
      { accountId: revenue.id, amount: -parseMoney('77.00') },
      { accountId: cash.id, amount: parseMoney('77.00') },
    ],
  })
  const gone = await deleteEntry(doomed.entry.id, 'alicio@example.test')
  const [{ still }] = await db.execute<{ still: string }>(
    raw`SELECT count(*)::text AS still FROM journal_entry WHERE id = ${doomed.entry.id}`)
  const [auditRow] = await db.execute<{ before: { entryNo: string; lines: unknown[] } }>(
    raw`SELECT before FROM audit_log WHERE action = 'delete' AND record_id = ${doomed.entry.id} LIMIT 1`)
  const next = await postEntry({
    ledgerId: led.id, entryDate: '2026-05-21', description: 'After the gap',
    actor: 'alicio@example.test',
    lines: [
      { accountId: revenue.id, amount: -parseMoney('1.00') },
      { accountId: cash.id, amount: parseMoney('1.00') },
    ],
  })
  const gapNo = Number(gone.entryNo!.split('-')[1])
  still === '0'
    && auditRow?.before?.entryNo === gone.entryNo
    && (auditRow.before.lines as unknown[]).length === 2
    && Number(next.entry.entryNo!.split('-')[1]) === gapNo + 1
    ? pass('E5 a delete leaves the gap and the audit tells the whole story',
           `${gone.entryNo} gone; next is ${next.entry.entryNo}; audit holds both lines`)
    : fail('E5 a delete leaves the gap and the audit tells the whole story',
           JSON.stringify({ still, next: next.entry.entryNo, audit: auditRow?.before?.entryNo }))
  const drift2 = await db.execute(raw`SELECT * FROM check_balance_integrity(${led.id}::uuid)`)
  drift2.length === 0
    ? pass('E5b and the cache moved with the delete', 'no drift')
    : fail('E5b and the cache moved with the delete', `${drift2.length} disagreements`)

  // E9 — an edit that crosses the month boundary: the old month gives the
  //       figures up, the new month takes them, later months' openings shift
  //       once, and the drift guard stays silent. This is the path date
  //       edits exist for, and the propagation arms are only exercised here.
  const crosser = await postEntry({
    ledgerId: led.id, entryDate: '2026-05-25', description: 'Dated in the wrong month',
    actor: 'alicio@example.test',
    lines: [
      { accountId: revenue.id, amount: -parseMoney('40.00') },
      { accountId: cash.id, amount: parseMoney('40.00') },
    ],
  })
  await editEntry(crosser.entry.id, {
    entryDate: '2026-06-03', description: 'Dated in the right month',
    lines: [
      { accountId: revenue.id, amount: -parseMoney('40.00') },
      { accountId: cash.id, amount: parseMoney('40.00') },
    ],
  }, 'alicio@example.test')
  const [moved] = await db.execute<{ may: string; june: string }>(raw`
    SELECT (SELECT COALESCE(SUM(pb.period_credit), 0) FROM period_balance pb
             JOIN fiscal_period fp ON fp.id = pb.period_id
            WHERE pb.ledger_id = ${led.id} AND pb.account_id = ${revenue.id} AND fp.period_no = 5)::text AS may,
           (SELECT COALESCE(SUM(pb.period_credit), 0) FROM period_balance pb
             JOIN fiscal_period fp ON fp.id = pb.period_id
            WHERE pb.ledger_id = ${led.id} AND pb.account_id = ${revenue.id} AND fp.period_no = 6)::text AS june`)
  const driftX = await db.execute(raw`SELECT * FROM check_balance_integrity(${led.id}::uuid)`)
  const [entryMoved] = await db.execute<{ n: string }>(raw`
    SELECT fp.period_no::text AS n FROM journal_entry je
      JOIN fiscal_period fp ON fp.id = je.period_id WHERE je.id = ${crosser.entry.id}`)
  entryMoved.n === '6' && moved.june === '4000' && driftX.length === 0
    ? pass('E9 a cross-month edit moves the figures with the date',
           `June credit ${moved.june}, May left with ${moved.may}, no drift`)
    : fail('E9 a cross-month edit moves the figures with the date',
           JSON.stringify({ ...moved, period: entryMoved.n, drift: driftX.length }))
  await deleteEntry(crosser.entry.id, 'alicio@example.test')

  // E6 — a source with its own door is named, not edited.
  await expectError('E6 an entry from another door names that door', 'WRONG_DOOR', () =>
    deleteEntry(r1.entry.id))

  // E7 — a correction pair moves together; neither half is editable.
  await expectError('E7 a reversed entry is half of a pair', 'CORRECTION_PAIR', () =>
    editEntry(inv.entry.id, {
      entryDate: '2026-02-10', description: 'x',
      lines: [
        { accountId: revenue.id, amount: -parseMoney('1.00') },
        { accountId: cash.id, amount: parseMoney('1.00') },
      ],
    }))

  await trailNamesPeople((ok, l, d) => (ok ? pass(l, d) : fail(l, d)), 'V19 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

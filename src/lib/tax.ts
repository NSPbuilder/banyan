import 'server-only'
import { pstCommission } from './tax-rates'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { coverageOf, registrationsOverlapping } from './registrations'
import { partsOf } from './today'
import { gstAdjustmentFor } from './gst-adjustments'
import { GST_EDITABLE_LINES, type GstAdjustment } from './gst-adjustment-fields'

/**
 * The GST/HST return.
 *
 * CRA's form is short — four figures that matter — but every one of them has to
 * be defensible line by line at a desk, so each carries the entries that make
 * it up. A total nobody can trace is no use when someone asks where it came
 * from.
 *
 *   Line 101  Sales and other revenue           (excluding the tax itself)
 *   Line 105  GST/HST collected or collectible
 *   Line 108  Input tax credits (ITCs)
 *   Line 109  Net tax = 105 − 108
 *
 * Figures come from the JOURNAL, not from period_balance: a filing period is a
 * date range that need not line up with fiscal periods, and the cache is
 * organised by period. It is also the number that has to survive a CRA question.
 */

export type TaxLineEntry = {
  entryNo: string
  entryDate: string
  description: string
  accountCode: string
  accountName: string
  /** For linking to the entry. Absent on rows read from a check function,
   *  which returns entry numbers only. */
  entryId?: string
  /** Signed cents as the ledger holds them: debit positive, credit negative. */
  amount: string
  /**
   * What this entry ADDS TO ITS LINE, in the direction the return reads.
   *
   * Not the same as `amount`, and the difference matters: a reversal on a tax
   * account is a debit, so it REDUCES the tax collected. Showing its magnitude
   * made a corrected invoice's drill-down read 1,300 + 650 + 650 + 1,040 =
   * 3,640 against a line of 2,340 — three of those four entries looked like
   * additions and one of them is not. A column that does not visibly add up to
   * its total is not a trace, whatever the total says.
   */
  contribution: bigint
}

export type TaxLine = {
  /** Journal subtotal and the separate working-copy override, when reviewed. */
  bookAmount?: bigint
  adjustment?: bigint
  adjustmentReason?: string
  /** The CRA line number, for copying onto the return. */
  line: string
  label: string
  /** What to put on the return: positive, in cents. */
  amount: bigint
  entries: TaxLineEntry[]
}

export type TaxReturn = {
  adjustment?: GstAdjustment | null
  from: string
  to: string
  currency: string
  entity: string
  businessNumber: string | null
  /**
   * Null when the company was registered for no part of this range.
   *
   * A return of all zeroes reads as "no tax this quarter". For an unregistered
   * company the truth is that there is no return to file at all, and those need
   * different answers.
   *
   * When more than one registration touches the range this is the first of
   * them; `registrations` has them all.
   */
  registration: { number: string; registeredOn: string; ceasedOn: string | null } | null
  registrations: Array<{ number: string; registeredOn: string; ceasedOn: string | null }>
  /**
   * How much of the range the company was registered for.
   *
   * `part` is its own answer. Reading only the two ends of the range reported a
   * company registered for the whole of February as never registered, because
   * it was registered on neither 1 January nor 31 March.
   */
  coverage: 'none' | 'part' | 'all'
  lines: { sales: TaxLine; collected: TaxLine; itcs: TaxLine; net: TaxLine }
  /** Things the system cannot decide, put in front of the person who can. */
  review: Array<{ what: string; detail: string; entries?: TaxLineEntry[] }>
}

/** An opening balance is a position carried over, not this period's trading. */
const IS_OPENING = sql`je.source_type = 'opening_balance'`

type ReturnHead = { entity: string; currency: string; business_number: string | null; entity_id: string }

async function returnHead(ledgerId: string): Promise<ReturnHead | null> {
  const [head] = await db.execute<ReturnHead>(sql`
    SELECT e.name AS entity, l.currency, e.business_number, e.id::text AS entity_id
      FROM ledger l JOIN entity e ON e.id = l.entity_id WHERE l.id = ${ledgerId}::uuid`)
  return head ?? null
}

/**
 * Every posted line in the window whose account carries this role — except the
 * opening balance.
 *
 * A conversion done mid-year carries the tax already collected and the revenue
 * already invoiced under the old system, as balances. Counting them here files
 * them a second time: revenue that was reported and tax that was remitted, on
 * a return that says they happened this quarter. What the opening balance
 * carries is the position, and it is named in `review` instead so it is not
 * silently absent either.
 *
 * Shared by the GST/HST and PST returns since 2026-09-04 — one spelling of
 * "the tax lines in the window", the way `remittanceOf` is one spelling of
 * "what goes to CRA".
 */
const linesFor = (ledgerId: string, from: string, to: string, role: string) =>
  db.execute<TaxLineEntry>(sql`
    SELECT je.id::text AS "entryId", je.entry_no AS "entryNo", je.entry_date::text AS "entryDate",
           je.description, a.code AS "accountCode", a.name AS "accountName",
           jl.amount::text AS amount
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted','reversed')
       AND NOT ${IS_OPENING}  -- the tax lines
       AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       AND EXISTS (SELECT 1 FROM account_role ar
                    WHERE ar.account_id = a.id AND ar.role = ${role})
     ORDER BY je.entry_date, je.entry_no`)

/** Revenue in the window, which excludes the tax by construction. */
const salesLinesFor = (ledgerId: string, from: string, to: string) =>
  db.execute<TaxLineEntry>(sql`
    SELECT je.id::text AS "entryId", je.entry_no AS "entryNo", je.entry_date::text AS "entryDate",
           je.description, a.code AS "accountCode", a.name AS "accountName",
           jl.amount::text AS amount
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted','reversed')
       AND NOT ${IS_OPENING}  -- sales
       AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       AND a.account_type = 'revenue'
     ORDER BY je.entry_date, je.entry_no`)

// Revenue and tax collected are credits, so they are negative in the ledger;
// input tax credits are debits. Give every entry the sign its own line reads
// in, and the total is then simply the sum of the column shown.
const withContribution = (rows: TaxLineEntry[], flip: boolean) =>
  rows.map((r) => ({ ...r, contribution: flip ? -BigInt(r.amount) : BigInt(r.amount) }))
const sumOf = (rows: TaxLineEntry[]) => rows.reduce((s, r) => s + r.contribution, 0n)

/** The opening-balance lines in the window on revenue or on these roles — left off, and said. */
const openingLinesFor = (ledgerId: string, from: string, to: string, roles: string[]) =>
  db.execute<TaxLineEntry>(sql`
    SELECT je.entry_no AS "entryNo", je.entry_date::text AS "entryDate",
           je.description, a.code AS "accountCode", a.name AS "accountName",
           jl.amount::text AS amount
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted','reversed')
       AND ${IS_OPENING}
       AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       AND (a.account_type = 'revenue'
            OR EXISTS (SELECT 1 FROM account_role ar
                        WHERE ar.account_id = a.id
                          AND ar.role IN ${sql.raw('(' + roles.map((r) => `'${r}'`).join(',') + ')')}))
     ORDER BY a.code`)

/**
 * The review items every return shares: whether the company was registered
 * for this tax over this range, the opening balance falling inside it, and
 * periods still open. Each names the tax it is about.
 */
async function sharedReview(
  ledgerId: string, head: ReturnHead, from: string, to: string,
  tax: 'GST_HST' | 'PST', label: string, roles: string[],
  registrations: Awaited<ReturnType<typeof registrationsOverlapping>>,
  coverage: 'none' | 'part' | 'all',
): Promise<{ registration: TaxReturn['review']; opening: TaxReturn['review']; open: TaxReturn['review']; remitted: TaxReturn['review'] }> {
  // By KIND, so a caller places each where its return reads best without
  // matching prose — the first version filtered by substring and would have
  // dropped, silently, any item whose wording drifted (critic, 2026-09-04).
  const registration: TaxReturn['review'] = []
  const opening: TaxReturn['review'] = []
  const open: TaxReturn['review'] = []
  const remitted: TaxReturn['review'] = []
  const registeredDays = registrations
    .map((r) => `${r.registeredOn} to ${r.ceasedOn ?? 'now'}`)
    .join(', ')

  if (coverage === 'none') {
    registration.push({
      what: `This company is not registered for ${label} for this period`,
      detail: 'So there is no return to file. If it should be registered, record it under '
            + 'Sales tax registration — that also creates the accounts the tax needs.',
    })
  } else if (coverage === 'part') {
    // The ordinary case — registered partway through and still registered — is
    // worth naming precisely, because the person is usually filing their first
    // return and wants to know where it starts.
    const first = registrations[0]!
    const stillRegistered = registrations.length === 1 && first.ceasedOn === null
    registration.push(stillRegistered
      ? {
          what: 'This period starts before the company was registered',
          detail: `Registered on ${first.registeredOn}. Sales before that date should carry `
                + `no ${label}, and the return covers only from the registration date.`,
        }
      : {
          what: 'The company was registered for only part of this period',
          detail: `Registered ${registeredDays}. The return covers the registered days; `
                + `sales outside them should carry no ${label}.`,
        })
  }

  const openingHere = await openingLinesFor(ledgerId, from, to, roles)
  if (openingHere.length > 0) {
    opening.push({
      what: 'The opening balance falls in this period and is deliberately not on this return',
      detail: 'Revenue and tax carried over from another system are balances, not things that '
        + 'happened this period — they were reported and remitted wherever the books were kept '
        + 'before. Worth confirming that they were.',
      entries: openingHere,
    })
  }

  // A period still open can change after the return is filed.
  const [openPeriods] = await db.execute<{ n: string; names: string | null }>(sql`
    SELECT count(*)::text AS n, string_agg(name, ', ' ORDER BY start_date) AS names
      FROM fiscal_period
     WHERE ledger_id = ${ledgerId}::uuid AND status = 'open'
       AND start_date <= ${to}::date AND end_date >= ${from}::date`)
  if (Number(openPeriods.n) > 0) {
    open.push({
      what: `${openPeriods.n} period${openPeriods.n === '1' ? ' is' : 's are'} still open in this range`,
      detail: `${openPeriods.names} — entries can still be posted into ${
        openPeriods.n === '1' ? 'it' : 'them'}, so these figures can still change. `
            + 'Close the periods once the return is filed.',
    })
  }

  // A remittance PAID inside the window is a debit to the payable account,
  // and the collected line is that account's net movement — so last quarter's
  // payment, posted this quarter, quietly lowers this quarter's "collected"
  // by the amount paid (critic, 2026-09-04). The system cannot tell a
  // remittance from a credit note by the line alone; what it can see is the
  // OTHER side. An entry that debits the payable and moves a bank account is
  // a payment to the government, and is named here with its amount, so the
  // person files the collected line higher by that much.
  const remittances = await db.execute<TaxLineEntry>(sql`
    SELECT je.id::text AS "entryId", je.entry_no AS "entryNo", je.entry_date::text AS "entryDate",
           je.description, a.code AS "accountCode", a.name AS "accountName",
           jl.amount::text AS amount
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted','reversed')
       AND NOT ${IS_OPENING}
       AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       AND jl.amount > 0
       AND EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = a.id AND ar.role = ${roles[0]})
       AND EXISTS (SELECT 1 FROM journal_line b JOIN account_role br ON br.account_id = b.account_id
                    WHERE b.entry_id = je.id AND br.role = 'cash_and_cash_equivalents')
     ORDER BY je.entry_date`)
  if (remittances.length > 0) {
    const paid = remittances.reduce((t, r) => t + BigInt(r.amount), 0n)
    remitted.push({
      what: `${remittances.length} payment${remittances.length === 1 ? '' : 's'} to the government fall inside this period`,
      detail: `They debit the ${label} payable account and move the bank, so they lower the collected `
            + `book movement by ${(Number(paid) / 100).toFixed(2)} — a remittance is not a reduction of `
            + 'what was collected. Review the final return figure and any saved adjustment against these payments, '
            + 'or use a separate remittance clearing account.',
      entries: remittances.map((r) => ({ ...r, contribution: BigInt(r.amount) })),
    })
  }
  void head
  return { registration, opening, open, remitted }
}

export async function gstHstReturn(
  ledgerId: string, from: string, to: string,
): Promise<TaxReturn | null> {
  const head = await returnHead(ledgerId)
  if (!head) return null

  const [salesLines, collectedLines, itcLines] = await Promise.all([
    salesLinesFor(ledgerId, from, to),
    linesFor(ledgerId, from, to, 'gst_hst_payable'),
    linesFor(ledgerId, from, to, 'gst_hst_recoverable'),
  ])

  // Every registration touching the range, not the two endpoints: a company
  // registered for the whole of February is registered for none of 1 January
  // and none of 31 March.
  const registrations = await registrationsOverlapping(head.entity_id, 'GST_HST', from, to)
  const coverage = coverageOf(registrations, from, to)
  const registration = registrations[0] ?? null

  const sales_ = withContribution(salesLines, true)
  const collected_ = withContribution(collectedLines, true)
  const itcs_ = withContribution(itcLines, false)
  const sales = sumOf(sales_), collected = sumOf(collected_), itcs = sumOf(itcs_)

  const review: TaxReturn['review'] = []
  const registeredDays = registrations
    .map((r) => `${r.registeredOn} to ${r.ceasedOn ?? 'now'}`)
    .join(', ')

  // Tax charged before registering, or after ceasing, has a real deadline
  // attached and nothing else in the system would notice it. This runs whatever
  // the coverage is — an unregistered company with tax sitting in its books is
  // the case the check exists for, and hiding it behind "not registered" was
  // silence on exactly the books that needed the noise.
  const outside = await db.execute<TaxLineEntry>(sql`
    SELECT entry_no AS "entryNo", entry_date::text AS "entryDate", description,
           tax AS "accountCode", ''::text AS "accountName", amount::text AS amount
      FROM check_tax_outside_registration(${ledgerId}::uuid)
     WHERE entry_date BETWEEN ${from}::date AND ${to}::date`)

  const shared = await sharedReview(ledgerId, head, from, to, 'GST_HST', 'GST/HST',
    ['gst_hst_payable', 'gst_hst_recoverable'], registrations, coverage)
  // The registration items first, as they always were; the rest after the
  // GST-specific ones.
  review.push(...shared.registration)

  if (outside.length > 0) {
    review.push({
      what: `${outside.length} entr${outside.length === 1 ? 'y carries' : 'ies carry'} tax from outside the registered period`,
      detail: (registrations.length === 0
        ? 'The company has no GST/HST registration covering these dates at all. '
        : `Registered ${registeredDays}. `)
        + 'Tax charged outside those dates has to be dealt with, not just reported.',
      entries: outside.map((o) => ({ ...o, contribution: -BigInt(o.amount) })),
    })
  }

  // Nothing tagged means the figures are zero for a reason the person needs to
  // know, rather than because there was no tax.
  const [tagged] = await db.execute<{ collected: string; itcs: string }>(sql`
    SELECT
      (SELECT count(*)::text FROM account a JOIN account_role ar ON ar.account_id = a.id
        WHERE a.entity_id = ${head.entity_id}::uuid AND ar.role = 'gst_hst_payable')     AS collected,
      (SELECT count(*)::text FROM account a JOIN account_role ar ON ar.account_id = a.id
        WHERE a.entity_id = ${head.entity_id}::uuid AND ar.role = 'gst_hst_recoverable') AS itcs`)

  if (coverage !== 'none' && tagged.collected === '0') {
    review.push({
      what: 'No account carries the "GST/HST payable" role',
      detail: 'Line 105 is zero because nothing is tagged, not because no tax was collected. '
            + 'Tag the account on the chart of accounts.',
    })
  }
  if (coverage !== 'none' && tagged.itcs === '0') {
    review.push({
      what: 'No account carries the "GST/HST recoverable" role',
      detail: 'Line 108 is zero because nothing is tagged. If you pay GST/HST on purchases, '
            + 'you are entitled to claim it — tag the account.',
    })
  }

  // Revenue posted with no tax on the same entry. This is perfectly normal for
  // zero-rated or exempt sales, and it is also what a forgotten tax line looks
  // like. The system cannot tell them apart, so it says so rather than guessing.
  const untaxed = await db.execute<TaxLineEntry>(sql`
    SELECT je.entry_no AS "entryNo", je.entry_date::text AS "entryDate",
           je.description, a.code AS "accountCode", a.name AS "accountName",
           jl.amount::text AS amount
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted','reversed')
       AND NOT ${IS_OPENING}  -- untaxed revenue
       AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       AND a.account_type = 'revenue'
       AND NOT EXISTS (
         SELECT 1 FROM journal_line t
           JOIN account_role ar ON ar.account_id = t.account_id
          WHERE t.entry_id = je.id AND ar.role = 'gst_hst_payable')
     ORDER BY je.entry_date`)

  review.push(...shared.opening)

  const untaxedWithSign = untaxed.map((r) => ({ ...r, contribution: -BigInt(r.amount) }))
  if (coverage !== 'none' && untaxed.length > 0) {
    review.push({
      what: `${untaxed.length} sale${untaxed.length === 1 ? '' : 's'} recorded with no GST/HST`,
      detail: 'Correct for a zero-rated or exempt sale, and also what a forgotten tax line looks '
            + 'like. Only you can tell which. Check these before filing.',
      entries: untaxedWithSign,
    })
  }

  review.push(...shared.remitted, ...shared.open)

  const ret: TaxReturn = {
    from, to, currency: head.currency, entity: head.entity,
    // The registration number is what belongs on a return; the entity's
    // business number is a broader thing that may not be the same.
    businessNumber: registration?.number ?? head.business_number,
    registration: registration
      ? { number: registration.number, registeredOn: registration.registeredOn,
          ceasedOn: registration.ceasedOn }
      : null,
    registrations: registrations.map((r) => ({
      number: r.number, registeredOn: r.registeredOn, ceasedOn: r.ceasedOn })),
    coverage,
    lines: {
      sales:     { line: '101', label: 'Sales and other revenue',          amount: sales,     entries: sales_ },
      collected: { line: '105', label: 'GST/HST and adjustments',          amount: collected, entries: collected_ },
      itcs:      { line: '108', label: 'ITCs and adjustments',             amount: itcs,      entries: itcs_ },
      net:       { line: '109', label: 'Net tax',                      amount: collected - itcs,    entries: [] },
    },
    review,
  }
  const adjustment = await gstAdjustmentFor(ledgerId, from, to)
  ret.adjustment = adjustment
  if (adjustment && GST_EDITABLE_LINES.some(({ key }) => adjustment[key] !== null)) {
    for (const { key } of GST_EDITABLE_LINES) {
      const line = ret.lines[key]
      if (adjustment[key] === null) continue
      line.bookAmount = line.amount
      line.amount = BigInt(adjustment[key])
      line.adjustment = line.amount - line.bookAmount
      line.adjustmentReason = adjustment.reason
    }
    const net = ret.lines.net
    net.bookAmount = net.amount
    net.amount = ret.lines.collected.amount - ret.lines.itcs.amount
    net.adjustment = net.amount - net.bookAmount
    if (GST_EDITABLE_LINES.some(({ key }) => adjustment[key] !== null)) {
      review.push({ what: 'Manually reviewed return figures', detail:
        `Final amounts override the books for this exact date range. ${adjustment.reason} `
        + `Saved by ${adjustment.updated_by} at ${adjustment.updated_at}. Journal entries are unchanged.` })
    }
  }
  return ret
}

// ---------------------------------------------------------------- PST ----

/**
 * BC's PST return (FIN 400), the same way: the boxes, and the entries behind
 * each. Same head, same registration coverage, same window, same exclusion of
 * the opening balance — and the role is `qst_pst_payable`, which QST and PST
 * share (RISKS 14).
 *
 * No "sales with no PST" review: most of what a consulting company sells is
 * PST-exempt, so that list would be every sale, every quarter.
 *
 * The commission is BC's rule for a return filed on time (tax-rates.ts); the
 * worksheet shows it and says when it does not apply.
 */
export type PstReturn = Omit<TaxReturn, 'lines'> & {
  lines: { sales: TaxLine; collected: TaxLine; commission: TaxLine; net: TaxLine }
}

export async function pstReturn(
  ledgerId: string, from: string, to: string, opts: { late?: boolean } = {},
): Promise<PstReturn | null> {
  const head = await returnHead(ledgerId)
  if (!head) return null

  const [salesLines, collectedLines] = await Promise.all([
    salesLinesFor(ledgerId, from, to),
    linesFor(ledgerId, from, to, 'qst_pst_payable'),
  ])
  const registrations = await registrationsOverlapping(head.entity_id, 'PST', from, to)
  const coverage = coverageOf(registrations, from, to)
  const registration = registrations[0] ?? null

  const sales_ = withContribution(salesLines, true)
  const collected_ = withContribution(collectedLines, true)
  const sales = sumOf(sales_), collected = sumOf(collected_)
  // BC allows the commission only on a return filed and paid on time. The
  // worksheet cannot know that; the person says so, and then box C is zero
  // and box D is box B in full.
  // The scale in force at the END of the period being filed, not today's.
  const commission = opts.late ? 0n : pstCommission(collected, to)

  const shared = await sharedReview(ledgerId, head, from, to, 'PST', 'PST',
    ['qst_pst_payable'], registrations, coverage)
  const review: TaxReturn['review'] = [...shared.registration, ...shared.opening, ...shared.remitted, ...shared.open]

  const [tagged] = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM account a JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${head.entity_id}::uuid AND ar.role = 'qst_pst_payable'`)
  if (coverage !== 'none' && tagged.n === '0') {
    review.unshift({
      what: 'No account carries the "QST/PST payable" role',
      detail: 'Box B is zero because nothing is tagged, not because no PST was collected. '
            + 'Tag the account on the chart of accounts.',
    })
  }
  if (coverage !== 'none' && commission > 0n) {
    review.push({
      what: `The commission of ${(Number(commission) / 100).toFixed(2)} assumes the return is filed and paid on time`,
      detail: 'BC allows it only then. Filing late? Mark the return late above and box C becomes zero.',
    })
  }
  if (opts.late) {
    review.push({
      what: 'Marked as filed late',
      detail: 'No commission: box C is zero and box D is box B in full.',
    })
  }

  return {
    from, to, currency: head.currency, entity: head.entity,
    businessNumber: registration?.number ?? head.business_number,
    registration: registration
      ? { number: registration.number, registeredOn: registration.registeredOn,
          ceasedOn: registration.ceasedOn }
      : null,
    registrations: registrations.map((r) => ({
      number: r.number, registeredOn: r.registeredOn, ceasedOn: r.ceasedOn })),
    coverage,
    lines: {
      sales:      { line: 'A', label: 'Total sales and leases',            amount: sales,      entries: sales_ },
      collected:  { line: 'B', label: 'PST collectable',                   amount: collected,  entries: collected_ },
      commission: { line: 'C', label: opts.late ? 'Commission (none — filed late)' : 'Commission (return filed on time)', amount: commission, entries: [] },
      net:        { line: 'D', label: 'Net PST due',                       amount: collected - commission, entries: [] },
    },
    review,
  }
}

/** The quarters and the year a person is likely to be filing for. */
export function filingPeriods(today = new Date()) {
  // The local year, not the UTC one: on the evening of 31 December those differ
  // and this would list the quarters of a year that has not begun, without the
  // one being filed.
  const year = partsOf(today).year
  const quarters = [
    ['Q1', `${year}-01-01`, `${year}-03-31`],
    ['Q2', `${year}-04-01`, `${year}-06-30`],
    ['Q3', `${year}-07-01`, `${year}-09-30`],
    ['Q4', `${year}-10-01`, `${year}-12-31`],
  ] as const

  // Last year's quarters as well: Q4 is filed in January, and a return for a
  // quarter of the year just ended is the ordinary case, not a custom range.
  const last = year - 1
  return [
    ...quarters.map(([name, from, to]) => ({ name: `${name} ${year}`, from, to })),
    { name: `${year}`, from: `${year}-01-01`, to: `${year}-12-31` },
    { name: `${last}`, from: `${last}-01-01`, to: `${last}-12-31` },
    ...quarters.map(([name, from, to]) => ({
      name: `${name} ${last}`, from: from.replace(`${year}`, `${last}`), to: to.replace(`${year}`, `${last}`),
    })),
  ]
}

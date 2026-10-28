import 'server-only'
import { accountMovements, isPl, spanPeriod, total, type AccountMovement } from './movements'
import { driftProblem } from './drift'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * Statement of Cash Flows, indirect method, derived from the ledger's
 * movements (IAS 7). Not a template: the linear statement_line model reads a
 * balance or a movement per line, and a cash flow statement is neither — it
 * is every non-cash account's movement, with its sign turned round, sorted
 * into three activities and reconciled to what the cash accounts did.
 *
 * The arithmetic is one identity. Debits equal credits, so over any span
 *
 *   Σ movement(cash accounts) = − Σ movement(every other account)
 *                             = profit + Σ (− movement of each non-cash balance-sheet account)
 *
 * where profit is − Σ movement of the revenue and expense accounts. Turning a
 * balance-sheet movement round is the whole of the indirect method: a bigger
 * receivable (debit) used cash, a bigger payable (credit) provided it, a
 * credit to accumulated depreciation is the depreciation added back. There is
 * no separate "add back depreciation" arithmetic to get wrong — the contra
 * account's movement IS the add-back, which is why the four `cf_*` roles are
 * read on balance-sheet accounts and ignored on revenue and expense ones.
 *
 * Which activity an account belongs to: an explicit `cf_*` role on the
 * account wins; otherwise its classification role's default in `CF_DEFAULT`;
 * an account with neither is shown under "Not classified" and named in
 * `problems`, so the statement still foots and the reader is told what has
 * not been decided. Cash itself is `cash_and_cash_equivalents` and
 * `bank_indebtedness` (IAS 7.8: an overdraft repayable on demand is a
 * component of cash), whatever else those accounts carry.
 *
 * Two kinds of entry are not flows and are kept out of `movement` by
 * `accountMovements`: the year-end closing entry (a shuffle inside equity)
 * and opening-balance entries, whose cash goes into "Cash at beginning"
 * instead — the books' starting position, not something the span received.
 *
 * The last line is what the cash accounts actually hold at the end of the
 * span — the ledger's figure, not the statement's arithmetic — and the
 * proof is that beginning cash plus the net change above reaches it. When it
 * does not, the figure stands and a problem line names the shortfall.
 *
 * Whole non-cash investing/financing entries are removed from activity
 * movements and disclosed separately. Profit stays the journal's profit;
 * any P&L effect of an excluded entry receives an explicit add-back.
 * Mixed cash/non-cash journals and later settlement classification need
 * review rather than an invented allocation between their counterparties.
 */

export type CfSection = 'operating' | 'non_cash' | 'investing' | 'financing'

/** The explicit tags. `cash_flow` family, seeded in 0002. */
export const CF_ROLE: Record<string, CfSection> = {
  cf_operating: 'operating',
  cf_non_cash_adjustment: 'non_cash',
  cf_investing: 'investing',
  cf_financing: 'financing',
}

/** Roles whose accounts ARE cash. */
export const CASH_ROLES = ['cash_and_cash_equivalents', 'bank_indebtedness'] as const

/**
 * Where a balance-sheet classification role's movement belongs when the
 * account carries no `cf_*` tag. IAS 7 leaves some of these to judgment
 * (restricted cash, short-term investments); the defaults below are the
 * common reading, and a tag on the account overrides any of them.
 */
export const CF_DEFAULT: Record<string, CfSection> = {
  // working capital — operating
  trade_receivables: 'operating', other_receivables: 'operating', related_party_receivables: 'operating',
  contract_assets: 'operating', inventories: 'operating', prepaid_expenses: 'operating',
  gst_hst_recoverable: 'operating', qst_pst_recoverable: 'operating', income_tax_receivable: 'operating',
  trade_payables: 'operating', accrued_liabilities: 'operating', related_party_payables: 'operating',
  contract_liabilities: 'operating', gst_hst_payable: 'operating', qst_pst_payable: 'operating',
  payroll_liabilities: 'operating', income_tax_payable: 'operating',
  provisions_current: 'operating', provisions_non_current: 'operating',
  other_current_liabilities: 'operating', other_non_current_liabilities: 'operating',
  // non-cash: contra and deferred accounts whose movement is an expense that paid nobody
  allowance_for_credit_losses: 'non_cash',
  accumulated_depreciation_ppe: 'non_cash', accumulated_depreciation_rou: 'non_cash',
  accumulated_amortization_intangibles: 'non_cash',
  deferred_tax_assets: 'non_cash', deferred_tax_liabilities: 'non_cash',
  accumulated_oci: 'non_cash',
  // a direct posting to retained earnings is a prior-period adjustment, not a flow
  retained_earnings: 'non_cash',
  // investing
  restricted_cash: 'investing', short_term_investments: 'investing',
  property_plant_equipment: 'investing', right_of_use_assets: 'investing', investment_property: 'investing',
  intangible_assets: 'investing', goodwill: 'investing', long_term_investments: 'investing',
  investments_in_subsidiaries_and_associates: 'investing', other_non_current_assets: 'investing',
  // financing
  current_portion_of_borrowings: 'financing', borrowings_non_current: 'financing',
  lease_liabilities_current: 'financing', lease_liabilities_non_current: 'financing',
  dividends_payable: 'financing', due_to_shareholder: 'financing',
  share_capital: 'financing', contributed_surplus: 'financing', dividends_declared: 'financing',
}

export type CashFlowLine = {
  /** Exact contributing journals after non-cash exclusions. */
  entries?: CashFlowEntry[]
  code: string | null
  label: string
  lineType: 'header' | 'detail' | 'total' | 'spacer'
  indent: number
  /** Cash effect: an inflow positive, an outflow negative. */
  raw: bigint
  /** Accounts behind a detail line, with the movement each contributed (cash effect). */
  accounts?: Array<{ id: string; code: string; name: string; amount: bigint }>
  /**
   * For a TOTAL: the indices, in this same render, of the lines it adds.
   *
   * A template statement's total carries a `formula` over other lines' codes,
   * and the breakdown re-tokenises it. A cash flow total is arithmetic in this
   * file instead, so the recipe has to be recorded as it is built or the
   * breakdown would have to guess it — and a guess that drifts from the
   * arithmetic above is a trace whose column does not add up.
   */
  sums?: number[]
}
export type CashFlowEntry = { id: string; entryNo: string; date: string; description: string; amount: bigint }

export type CashFlow = {
  period: { id: string; name: string; startDate: string; endDate: string; yearName: string }
  lines: CashFlowLine[]
  /** Empty when the statement is sound. */
  problems: string[]
  beginning: bigint
  netChange: bigint
  ending: bigint
}

const isCash = (m: AccountMovement) => m.roles.some((r) => (CASH_ROLES as readonly string[]).includes(r))

/** The activity an account's movement belongs to, and how it was decided. */
export function sectionOf(m: AccountMovement): { section: CfSection | null; by: 'tag' | 'default' | 'none' } {
  const tagged = m.roles.map((r) => CF_ROLE[r]).filter((s): s is CfSection => s !== undefined)
  if (tagged.length > 0) return { section: tagged[0], by: 'tag' }
  const defaulted = m.roles.map((r) => CF_DEFAULT[r]).filter((s): s is CfSection => s !== undefined)
  if (defaulted.length > 0) return { section: defaulted[0], by: 'default' }
  return { section: null, by: 'none' }
}

export async function renderCashFlow(
  ledgerId: string, periodId: string, fromPeriodId: string = periodId,
): Promise<CashFlow | null> {
  const period = await spanPeriod(ledgerId, fromPeriodId, periodId)
  if (!period) return null
  const all = await accountMovements(ledgerId, fromPeriodId, periodId)
  const problems: string[] = []
  // The same question the balance sheet asks first: is the cache these
  // figures come from still the journal's?
  const drift = await driftProblem(ledgerId)
  if (drift) problems.push(drift)

  // Read complete journals, using the same reversal-root classification as
  // accountMovements. Opening/closing roots and their reversals stay excluded.
  const rows = await db.execute<{ id: string; entry_no: string; entry_date: string; description: string; account_id: string; amount: string }>(sql`
    WITH RECURSIVE root AS (
      SELECT id,source_type AS source,0 AS depth FROM journal_entry WHERE ledger_id=${ledgerId}::uuid AND reverses_id IS NULL
      UNION ALL SELECT j.id,r.source,r.depth+1 FROM journal_entry j JOIN root r ON j.reverses_id=r.id
        WHERE j.ledger_id=${ledgerId}::uuid AND r.depth<32
    )
    SELECT j.id::text,j.entry_no,j.entry_date::text,j.description,l.account_id::text,l.amount::text
      FROM journal_entry j JOIN journal_line l ON l.entry_id=j.id LEFT JOIN root r ON r.id=j.id
      WHERE j.ledger_id=${ledgerId}::uuid AND j.status IN ('posted','reversed')
        AND j.entry_date BETWEEN ${period.startDate}::date AND ${period.endDate}::date
        AND coalesce(r.source,j.source_type) NOT IN ('opening_balance','period_close')
      ORDER BY j.entry_date,j.entry_no,l.line_no`)
  const accountsById = new Map(all.map(m => [m.id,m]))
  const journals = new Map<string, Array<typeof rows[number]>>()
  for (const row of rows) {
    const journal=journals.get(row.id)
    if (journal) journal.push(row)
    else journals.set(row.id,[row])
  }
  const excluded = new Set<string>()
  const excludedMovement = new Map<string,bigint>()
  const profitAdjustments: CashFlowEntry[] = []
  const disclosures: Array<{id:string;label:string;accounts:NonNullable<CashFlowLine['accounts']>}> = []
  for (const [id, journal] of journals) {
    const active = journal.filter(r => BigInt(r.amount) !== 0n)
    const cashUsed = active.some(r => isCash(accountsById.get(r.account_id)!))
    const activities = active.map(r => accountsById.get(r.account_id)!).filter(m => !isCash(m) && !isPl(m)).map(m => sectionOf(m).section)
    const investment = activities.includes('investing'), financing = activities.includes('financing')
    if (cashUsed) {
      if (investment && financing) problems.push(`Review mixed cash and non-cash components in ${journal[0].entry_no}: investing and financing share one journal. Split the actual cash and non-cash components at their source before relying on activity totals.`)
      continue
    }
    if (!investment && !financing) continue
    if (activities.includes(null)) continue // keep unclassified amounts visible
    excluded.add(id)
    let plAmount = 0n
    const detail = new Map<string,bigint>()
    for (const r of active) {
      const amount = BigInt(r.amount), account = accountsById.get(r.account_id)!
      if (isPl(account)) plAmount += amount
      else excludedMovement.set(account.id,(excludedMovement.get(account.id) ?? 0n)+amount)
      detail.set(account.id,(detail.get(account.id) ?? 0n)+amount)
    }
    const head = journal[0]
    if (plAmount) profitAdjustments.push({id,entryNo:head.entry_no,date:head.entry_date,description:head.description,amount:plAmount})
    disclosures.push({id,label:`${head.entry_date} · ${head.entry_no} · ${head.description}`,accounts:[...detail].map(([accountId,amount]) => {
      const a=accountsById.get(accountId)!
      return {id:a.id,code:a.code,name:a.name,amount}
    })})
    if (active.some(r => accountsById.get(r.account_id)!.roles.some(role => ['trade_payables','trade_receivables'].includes(role))))
      problems.push(`${head.entry_no} is a non-cash investing/financing transaction through receivables or payables. Review the activity classification of its later cash settlement; this report does not infer it from the control-account balance.`)
  }
  const sources = (accountIds: string[], includeExcluded=false, flip=true): CashFlowEntry[] => {
    const ids = new Set(accountIds), found = new Map<string,CashFlowEntry>()
    for (const r of rows) {
      if (!ids.has(r.account_id) || (!includeExcluded && excluded.has(r.id))) continue
      const amount=BigInt(r.amount)*(flip?-1n:1n), before=found.get(r.id)
      found.set(r.id,{id:r.id,entryNo:r.entry_no,date:r.entry_date,description:r.description,amount:(before?.amount??0n)+amount})
    }
    return [...found.values()].filter(e=>e.amount!==0n)
  }

  const cash = all.filter(isCash)
  const pl = all.filter((m) => !isCash(m) && isPl(m))
  const sheet = all.filter((m) => !isCash(m) && !isPl(m))
    .map(m => ({...m,movement:m.movement-(excludedMovement.get(m.id)??0n)}))

  // A cf_* tag on a revenue or expense account does nothing here, and a
  // reader who tagged one expects it to. Say so rather than leave it silent.
  const taggedPl = pl.filter((m) => m.roles.some((r) => CF_ROLE[r] !== undefined))
  if (taggedPl.length > 0) {
    problems.push(
      `${taggedPl.map((m) => `${m.code} ${m.name}`).join(', ')} ${taggedPl.length === 1 ? 'carries' : 'carry'} a cash-flow ` +
      `role that this statement ignores: the add-back for a non-cash expense is read from the balance-sheet ` +
      `account it credits (accumulated depreciation, an allowance), not from the expense.`)
  }

  const effect = (m: AccountMovement) => -m.movement
  const detail = (m: AccountMovement, indent: number): CashFlowLine => ({
    code: null, label: m.name, lineType: 'detail', indent, raw: effect(m),
    accounts: [{ id: m.id, code: m.code, name: m.name, amount: effect(m) }],
    entries: sources([m.id]),
  })
  const moved = (ms: AccountMovement[]) => ms.filter((m) => m.movement !== 0n)

  const bySection: Record<CfSection | 'none', AccountMovement[]> = {
    operating: [], non_cash: [], investing: [], financing: [], none: [],
  }
  for (const m of sheet) bySection[sectionOf(m).section ?? 'none'].push(m)

  const unclassified = moved(bySection.none)
  if (unclassified.length > 0) {
    problems.push(
      `${unclassified.length} account${unclassified.length === 1 ? '' : 's'} moved money in the range and ` +
      `belong${unclassified.length === 1 ? 's' : ''} to no activity — tag ${unclassified.length === 1 ? 'it' : 'each'} with ` +
      `cf_operating, cf_investing, cf_financing or cf_non_cash_adjustment: ` +
      unclassified.map((m) => `${m.code} ${m.name}`).join(', '))
  }

  const profit = -total(pl, (m) => m.movement)
  const lines: CashFlowLine[] = []
  /** Returns WHERE the line landed, which is how a total records what it adds. */
  const push = (l: CashFlowLine) => lines.push(l) - 1
  const sectionTotal = (ms: AccountMovement[]) => total(ms, effect)

  // Each total records the lines it adds AS IT IS BUILT (`sums`), so the
  // breakdown re-reads this render's own arithmetic rather than restating it.
  push({ code: null, label: 'Operating activities', lineType: 'header', indent: 0, raw: 0n })
  const inOperating: number[] = []
  inOperating.push(push({
    code: 'CF_NI', label: 'Profit for the period', lineType: 'detail', indent: 1, raw: profit,
    accounts: moved(pl).map((m) => ({ id: m.id, code: m.code, name: m.name, amount: -m.movement })),
    entries: sources(pl.map(m=>m.id),true),
  }))
  const excludedProfit = profitAdjustments.reduce((sum,e)=>sum+e.amount,0n)
  if (profitAdjustments.length) inOperating.push(push({code:'CF_NONCASH_PL',
    label:'Profit effects of non-cash investing and financing',lineType:'detail',indent:1,
    raw:excludedProfit,entries:profitAdjustments}))
  const nonCash = moved(bySection.non_cash)
  if (nonCash.length > 0) {
    push({ code: null, label: 'Adjustments for non-cash items', lineType: 'header', indent: 1, raw: 0n })
    for (const m of nonCash) inOperating.push(push(detail(m, 2)))
  }
  const working = moved(bySection.operating)
  if (working.length > 0) {
    push({ code: null, label: 'Changes in working capital', lineType: 'header', indent: 1, raw: 0n })
    for (const m of working) inOperating.push(push(detail(m, 2)))
  }
  const operating = profit + excludedProfit + sectionTotal(nonCash) + sectionTotal(working)
  const atOperating = push({
    code: 'CF_OPER', label: 'Cash from operating activities', lineType: 'total', indent: 0,
    raw: operating, sums: inOperating,
  })

  const activity = (code: string, title: string, totalLabel: string, ms: AccountMovement[]) => {
    push({ code: null, label: '', lineType: 'spacer', indent: 0, raw: 0n })
    push({ code: null, label: title, lineType: 'header', indent: 0, raw: 0n })
    const inside = ms.map((m) => push(detail(m, 1)))
    const t = sectionTotal(ms)
    const at = push({ code, label: totalLabel, lineType: 'total', indent: 0, raw: t, sums: inside })
    return { total: t, at }
  }
  const inv = activity('CF_INV', 'Investing activities', 'Cash from investing activities', moved(bySection.investing))
  const fin = activity('CF_FIN', 'Financing activities', 'Cash from financing activities', moved(bySection.financing))
  const unc = unclassified.length > 0
    ? activity('CF_UNCLASSIFIED', 'Not classified', 'Cash from unclassified accounts', unclassified)
    : null
  const investing = inv.total
  const financing = fin.total
  const other = unc?.total ?? 0n

  const netChange = operating + investing + financing + other
  const beginning = total(cash, (m) => m.opening + m.openingEntries)
  const ending = total(cash, (m) => m.closing)

  push({ code: null, label: '', lineType: 'spacer', indent: 0, raw: 0n })
  push({
    code: 'CF_NET', label: 'Net change in cash', lineType: 'total', indent: 0, raw: netChange,
    sums: [atOperating, inv.at, fin.at, ...(unc ? [unc.at] : [])],
  })
  push({
    code: 'CF_BEGIN', label: 'Cash at beginning of period', lineType: 'detail', indent: 0, raw: beginning,
    accounts: cash.filter((m) => m.opening + m.openingEntries !== 0n)
      .map((m) => ({ id: m.id, code: m.code, name: m.name, amount: m.opening + m.openingEntries })),
  })
  push({
    code: 'CF_END', label: 'Cash at end of period', lineType: 'total', indent: 0, raw: ending,
    accounts: cash.filter((m) => m.closing !== 0n)
      .map((m) => ({ id: m.id, code: m.code, name: m.name, amount: m.closing })),
  })

  // The proof. Beginning plus the statement's own net change must be what the
  // cash accounts hold. A mismatch means a line in this span landed in only
  // one place — a journal the balance checks would already have refused —
  // or that the closing entry touched something outside equity.
  if (beginning + netChange !== ending) {
    const off = ending - (beginning + netChange)
    problems.push(
      `The statement does not reconcile to the cash accounts: they hold ` +
      `${(Number(off < 0n ? -off : off) / 100).toFixed(2)} ${off > 0n ? 'more' : 'less'} at the end of the ` +
      `range than beginning cash plus the net change shown. Run the balance checks on the company page.`)
  }
  if (cash.length === 0) {
    problems.push('No account carries cash_and_cash_equivalents or bank_indebtedness, so there is no cash to reconcile to.')
  }

  if (disclosures.length) {
    push({code:null,label:'',lineType:'spacer',indent:0,raw:0n})
    push({code:null,label:'Non-cash investing and financing — excluded from cash flows',lineType:'header',indent:0,raw:0n})
    push({code:null,label:'Journal amounts below: debits positive, credits negative',lineType:'header',indent:1,raw:0n})
    for (const disclosure of disclosures) {
      push({code:null,label:disclosure.label,lineType:'header',indent:1,raw:0n})
      for (const a of disclosure.accounts) push({code:null,label:a.name,lineType:'detail',indent:2,raw:a.amount,
        accounts:[a],entries:sources([a.id],true,false).filter(e=>e.id===disclosure.id)})
    }
  }

  return { period, lines, problems, beginning, netChange, ending }
}

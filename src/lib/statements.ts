import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { spanDates } from './movements'
import { driftProblem } from './drift'
import type { Runner } from './acting'

export type StatementFigure={span_id:string;role:string|null;account_id:string;account_code:string;account_name:string;account_type:string;closing_balance:string;period_movement:string}
/** Shared statement/budget basis, all accounts and fiscal spans in one query. */
export function statementFiguresQuery(ledgerId:string,spans:Array<{id:string;fromId:string;throughId:string}>) {
  return sql`WITH spans AS (
    SELECT s.id,first.start_date,last.end_date,last.id AS period_id
    FROM jsonb_to_recordset(${JSON.stringify(spans)}::jsonb) AS s(id text,"fromId" uuid,"throughId" uuid)
    JOIN fiscal_period first ON first.id=s."fromId" AND first.ledger_id=${ledgerId}::uuid
    JOIN fiscal_period last ON last.id=s."throughId" AND last.ledger_id=${ledgerId}::uuid
    WHERE first.start_date<=last.start_date
  ), moved AS (
    SELECT s.id,pb.account_id,SUM(pb.period_debit-pb.period_credit) AS movement
    FROM spans s JOIN fiscal_period fp ON fp.ledger_id=${ledgerId}::uuid AND fp.start_date>=s.start_date AND fp.end_date<=s.end_date
    JOIN period_balance pb ON pb.period_id=fp.id AND pb.ledger_id=${ledgerId}::uuid GROUP BY s.id,pb.account_id
  ) SELECT s.id AS span_id,ar.role,a.id::text AS account_id,a.code AS account_code,a.name AS account_name,a.account_type::text,
    COALESCE(closing.closing_balance,0)::text AS closing_balance,COALESCE(moved.movement,0)::text AS period_movement
    FROM spans s CROSS JOIN ledger l JOIN account a ON a.entity_id=l.entity_id
    LEFT JOIN account_role ar ON ar.account_id=a.id
    LEFT JOIN period_balance closing ON closing.ledger_id=l.id AND closing.period_id=s.period_id AND closing.account_id=a.id
    LEFT JOIN moved ON moved.id=s.id AND moved.account_id=a.id WHERE l.id=${ledgerId}::uuid`
}
export function statementAccountFigures(ledgerId:string,spans:Array<{id:string;fromId:string;throughId:string}>,on:Runner=db) {
  return on.execute<StatementFigure>(statementFiguresQuery(ledgerId,spans))
}

/**
 * Rendering a financial statement from a template.
 *
 * Four mechanisms have to work together, and getting any one wrong produces a
 * statement that is wrong but still balances — the failure mode this whole
 * design is built to avoid:
 *
 *   roles       a detail line sums the accounts carrying any of its roles
 *   value_basis closing balance for a balance sheet, period movement for a P&L
 *   formula     a total line adds and subtracts other lines by their code
 *   sign_flip   applied ONLY when rendering, never to the arithmetic
 *
 * Everything is computed on RAW signed values (debit positive, credit
 * negative), which is what makes the balance check a single identity:
 *
 *   raw(TOTAL ASSETS) + raw(TOTAL LIABILITIES AND EQUITY) = 0
 */

export type StatementLine = {
  code: string | null
  label: string
  lineType: 'header' | 'detail' | 'total' | 'current_earnings' | 'spacer'
  indent: number
  /** Signed: debit positive, credit negative. The arithmetic value. */
  raw: bigint
  /** What to show: raw, with sign_flip applied. */
  shown: bigint
  signFlip: boolean
  roles: string[]
  /** Which figure a detail line read: a position at the end, or movement over the span. */
  valueBasis: 'closing_balance' | 'period_movement'
  /** A total line's recipe, so a breakdown can name the lines it added. */
  formula: string | null
  /** Accounts that fed this line, for tracing a figure back. */
  accounts?: Array<{ id: string; code: string; name: string; amount: bigint }>
}

export type Statement = {
  template: { code: string; name: string; statementType: string; standard: string }
  period: { id: string; name: string; startDate: string; endDate: string; yearName: string }
  lines: StatementLine[]
  /** Empty when the statement is sound. Each entry is something a reader must know. */
  problems: string[]
}

export async function renderStatement(
  ledgerId: string, templateCode: string, periodId: string,
  // The start of the span. Defaults to the end period itself — one month, the
  // original behaviour. A flow statement over "this year" is the same render
  // with movement summed across the covered periods; position lines and the
  // integrity checks read the END period either way, because a position is a
  // fact about a moment and a range only chooses which moment ends it.
  fromPeriodId: string = periodId,
  // The drift answer, when the caller has already asked. The columned view
  // renders one statement per column, and each render asking
  // check_balance_integrity itself made thirteen scans where one answer
  // serves every column (whole-project audit, 2026-09-13).
  opts: { drift?: string | null } = {},
): Promise<Statement | null> {
  const [template] = await db.execute<{
    id: string; code: string; name: string; statement_type: string; accounting_standard: string
  }>(sql`
    SELECT id::text, code, name, statement_type, accounting_standard
      FROM statement_template WHERE code = ${templateCode}`)
  if (!template) return null

  const [period] = await db.execute<{
    id: string; name: string; start_date: string; end_date: string
    year_name: string; year_start: string; year_end: string
  }>(sql`
    SELECT fp.id::text, fp.name, fp.start_date::text, fp.end_date::text,
           fy.name AS year_name, fy.start_date::text AS year_start, fy.end_date::text AS year_end
      FROM fiscal_period fp JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
     WHERE fp.id = ${periodId}::uuid AND fp.ledger_id = ${ledgerId}::uuid`)
  if (!period) return null

  const definitions = await db.execute<{
    code: string | null; label: string; line_type: string; indent: number
    roles: string[]; formula: string | null; sign_flip: boolean; value_basis: string
  }>(sql`
    SELECT code, label, line_type, indent, roles, formula, sign_flip, value_basis
      FROM statement_line WHERE template_id = ${template.id}::uuid ORDER BY sort_order`)

  // One query for every role figure this statement needs, in both bases.
  const figures = await statementAccountFigures(ledgerId,[{id:periodId,fromId:fromPeriodId,throughId:periodId}])
  const byRole = new Map<string, StatementFigure[]>()
  for (const f of figures) {
    if(!f.role)continue
    const list = byRole.get(f.role) ?? []
    list.push(f)
    byRole.set(f.role, list)
  }

  // The profit of the year so far. Without this a mid-year balance sheet cannot
  // balance: the result has not yet been closed into retained earnings, so it
  // is on neither side.
  const [earnings] = await db.execute<{ amount: string }>(sql`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS amount
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
      JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted','reversed')
       AND a.account_type IN ('revenue','expense')
       AND fp.start_date >= ${period.year_start}::date
       AND fp.end_date   <= ${period.end_date}::date`)

  const problems: string[] = []
  const byCode = new Map<string, bigint>()
  const lines: StatementLine[] = []

  for (const d of definitions) {
    let raw = 0n
    let accounts: StatementLine['accounts']

    if (d.line_type === 'detail') {
      accounts = []
      const seen = new Set<string>()
      for (const role of d.roles) {
        for (const f of byRole.get(role) ?? []) {
          // An account carrying two roles on one line must count once.
          if (seen.has(f.account_code)) continue
          seen.add(f.account_code)
          const value = BigInt(
            d.value_basis === 'period_movement' ? f.period_movement : f.closing_balance)
          raw += value
          if (value !== 0n) {
            accounts.push({ id: f.account_id, code: f.account_code, name: f.account_name, amount: value })
          }
        }
      }
      accounts.sort((a, b) => a.code.localeCompare(b.code))
    } else if (d.line_type === 'current_earnings') {
      // Always year-to-date, whatever value_basis says. A balance sheet needs
      // the result accumulated since the year began: the period's own movement
      // would leave every earlier month of the year on neither side.
      raw = BigInt(earnings.amount)
    } else if (d.line_type === 'total') {
      const result = evaluateFormula(d.formula ?? '', byCode)
      if ('error' in result) {
        problems.push(`"${d.label}" could not be computed: ${result.error}`)
      } else {
        raw = result.value
      }
    }

    if (d.code) byCode.set(d.code, raw)
    lines.push({
      code: d.code, label: d.label,
      lineType: d.line_type as StatementLine['lineType'],
      indent: d.indent, raw,
      shown: d.sign_flip ? -raw : raw,
      signFlip: d.sign_flip, roles: d.roles,
      valueBasis: d.value_basis as StatementLine['valueBasis'],
      formula: d.formula, accounts,
    })
  }

  // The statement must prove itself. A figure that reaches no statement line is
  // absent from BOTH sides, so a wrong statement still balances — which is why
  // this compares against the ledger rather than against itself.
  problems.push(...await checkAgainstLedger(ledgerId, periodId, fromPeriodId, template.statement_type, byCode, opts))

  return {
    template: {
      code: template.code, name: template.name,
      statementType: template.statement_type, standard: template.accounting_standard,
    },
    period: {
      id: period.id, name: period.name, startDate: period.start_date,
      endDate: period.end_date, yearName: period.year_name,
    },
    lines, problems,
  }
}

/**
 * Add and subtract other lines by code. Only + and - appear in the templates,
 * and adding more syntax would add failure modes nothing needs.
 *
 * Parsing is separate from evaluating because a total line's BREAKDOWN needs
 * the terms themselves — which lines were added, which subtracted. One
 * tokenizer, so a breakdown cannot name different terms than the total used.
 *
 * One deliberate behaviour shift from the fused version: a formula that is
 * defective twice over (say `X +`, unknown code AND trailing operator) now
 * reports the parse error, where it used to report the unknown code first.
 * Both sentences are true of such a formula; parsing simply finishes first.
 */
export function formulaTerms(
  formula: string,
): { terms: Array<{ sign: 1n | -1n; code: string }> } | { error: string } {
  const trimmed = formula.trim()
  if (!trimmed) return { error: 'the formula is empty' }
  if (!/^[A-Za-z0-9_+\-\s]+$/.test(trimmed)) {
    return { error: `"${formula}" contains something other than line codes, + and -` }
  }

  const tokens = trimmed.match(/[+-]|[A-Za-z0-9_]+/g) ?? []
  const terms: Array<{ sign: 1n | -1n; code: string }> = []
  let sign: 1n | -1n = 1n
  let expectingTerm = true

  for (const token of tokens) {
    if (token === '+' || token === '-') {
      if (expectingTerm) return { error: `"${formula}" has two operators in a row` }
      sign = token === '+' ? 1n : -1n
      expectingTerm = true
      continue
    }
    if (!expectingTerm) return { error: `"${formula}" is missing an operator before ${token}` }
    terms.push({ sign, code: token })
    expectingTerm = false
  }

  if (expectingTerm) return { error: `"${formula}" ends with an operator` }
  return { terms }
}

/**
 * An unknown code is an error, never zero: silently treating it as zero would
 * drop a whole subtotal out of a statement that still balanced.
 */
export function evaluateFormula(
  formula: string, values: Map<string, bigint>,
): { value: bigint } | { error: string } {
  const parsed = formulaTerms(formula)
  if ('error' in parsed) return parsed

  let value = 0n
  for (const { sign, code } of parsed.terms) {
    if (!values.has(code)) {
      return { error: `it refers to "${code}", which is not a line above it` }
    }
    value += sign * values.get(code)!
  }
  return { value }
}

/**
 * Compare the statement with the ledger it claims to describe.
 *
 * A balance sheet that omits an account still balances, because the missing
 * figure is absent from both sides. The only way to notice is to add up the
 * ledger independently and see whether the statement accounts for all of it.
 */
async function checkAgainstLedger(
  ledgerId: string, periodId: string, fromPeriodId: string,
  statementType: string, byCode: Map<string, bigint>,
  opts: { drift?: string | null } = {},
): Promise<string[]> {
  const problems: string[] = []

  // First: does the cache these figures come from still describe the journal?
  //
  // Every detail line reads period_balance. If that cache is wrong, both sides
  // of the statement are wrong by the same amount and the totals still agree —
  // so no check built from the statement's own figures can see it. This is the
  // only question that reaches past the cache to the journal itself.
  const drift = opts.drift !== undefined ? opts.drift : await driftProblem(ledgerId)
  if (drift) problems.push(drift)

  // An account is missing from the statement if EITHER figure the renderer
  // reads is nonzero for it: the end period's closing balance (position) or
  // the movement anywhere in the span (flow). Closing alone missed an account
  // whose movement nets against its opening — zero balance, nonzero flow.
  const untagged = await db.execute<{ code: string; name: string }>(sql`
    WITH span AS (${spanDates(fromPeriodId, periodId)})
    SELECT a.code, a.name
      FROM span, period_balance pb
      JOIN account a ON a.id = pb.account_id
      JOIN fiscal_period fp ON fp.id = pb.period_id
     WHERE pb.ledger_id = ${ledgerId}::uuid
       AND ((pb.period_id = ${periodId}::uuid AND pb.closing_balance <> 0)
         OR (fp.start_date >= span.start_date AND fp.end_date <= span.end_date
             AND pb.period_debit - pb.period_credit <> 0))
       AND NOT EXISTS (
         SELECT 1 FROM account_role ar
          WHERE ar.account_id = a.id
            AND EXISTS (SELECT 1 FROM statement_line sl WHERE ar.role = ANY (sl.roles)))
     GROUP BY a.code, a.name
     ORDER BY a.code`)

  if (untagged.length > 0) {
    problems.push(
      `${untagged.length} account${untagged.length === 1 ? '' : 's'} moved money in the range or ` +
      `hold a balance at its end, and reach no statement line: ` +
      untagged.map((u) => `${u.code} ${u.name}`).join(', '),
    )
  }

  if (statementType !== 'balance_sheet') {
    // A year-end closing entry moves the year's income into retained earnings
    // with ordinary journal lines dated inside the year. A P&L whose range
    // covers that entry therefore shows what remains AFTER it — a closed
    // year's "last year" preset reads zero everywhere, correctly and uselessly.
    // The reader is told, rather than left to conclude the year earned nothing.
    const [closeInside] = await db.execute<{ entry_no: string; entry_date: string }>(sql`
      WITH span AS (${spanDates(fromPeriodId, periodId)})
      SELECT je.entry_no, je.entry_date::text
        FROM span, journal_entry je
       WHERE je.ledger_id = ${ledgerId}::uuid
         AND je.source_type = 'period_close' AND je.status = 'posted'
         AND je.entry_date BETWEEN span.start_date AND span.end_date
       ORDER BY je.entry_date LIMIT 1`)
    if (closeInside) {
      problems.push(
        `This range includes the year-end closing entry ${closeInside.entry_no} ` +
        `(${closeInside.entry_date}), which moved the year's income into retained ` +
        `earnings. The figures show what remains after it — a fully covered closed ` +
        `year reads as zero. End the range before the closing date to see the year's result.`)
    }
  }

  if (statementType === 'balance_sheet') {
    const assets = byCode.get('TA')
    const equityAndLiabilities = byCode.get('TLE')
    if (assets !== undefined && equityAndLiabilities !== undefined) {
      const off = assets + equityAndLiabilities
      if (off !== 0n) {
        const unclosed = await priorYearResult(ledgerId, periodId)
        problems.push(
          `The statement does not balance: assets and the other side differ by ` +
          `${(Number(off < 0n ? -off : off) / 100).toFixed(2)}.` +
          (unclosed !== 0n && unclosed === -off
            ? ` That is exactly the result of the fiscal years before this one, which has not ` +
              `been closed into retained earnings. Post a year-end closing entry for the ` +
              `earlier year and this will balance.`
            : ''),
        )
      }
    }
  }

  return problems
}

/**
 * The revenue and expense recorded in fiscal years EARLIER than this one.
 *
 * Those accounts should be zero by now: a year-end closing entry moves the
 * result into retained earnings. Until that entry is posted, the balance sheet
 * is out by exactly this amount — the profit is in the detail lines' cumulative
 * balances but not in equity, because the current-earnings line only carries
 * the year in progress.
 */
async function priorYearResult(ledgerId: string, periodId: string): Promise<bigint> {
  const [row] = await db.execute<{ amount: string }>(sql`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS amount
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
      JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted','reversed')
       AND a.account_type IN ('revenue','expense')
       AND fp.fiscal_year_id <> (SELECT fiscal_year_id FROM fiscal_period WHERE id = ${periodId}::uuid)
       AND fp.end_date < (SELECT start_date FROM fiscal_period WHERE id = ${periodId}::uuid)`)
  return BigInt(row.amount)
}

export async function availableStatements(standard = 'IFRS') {
  return db.execute<{ code: string; name: string; statement_type: string }>(sql`
    SELECT code, name, statement_type FROM statement_template
     WHERE accounting_standard = ${standard} AND is_active
       -- ONE P&L, the owner decided (2026-09-02): by nature. The by-function
       -- template keeps its rows (append-only; a typed URL still renders it)
       -- but is offered nowhere a statement is chosen.
       AND code <> 'IFRS_PL_FUNCTION_EN'
     ORDER BY statement_type, code`)
}

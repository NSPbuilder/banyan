/**
 * Reading a bank's CSV export, whatever shape it happens to be.
 *
 * There is no sample file and there never will be a complete set of them: every
 * Canadian bank names its columns differently, orders its dates differently,
 * and disagrees about whether a withdrawal is a negative number or its own
 * column. Building against one bank's layout produces something that has to be
 * rewritten for the second bank.
 *
 * So the file is not assumed. It is read, profiled, and shown back — "these are
 * your columns, these are the first values in each, tell me what they mean" —
 * and everything downstream works off that answer. The mapping step IS the
 * feature; the parsing around it exists to make the mapping decidable.
 *
 * Nothing here touches the database and nothing here is `server-only`: these
 * are pure functions over text so that the browser can run them on a file the
 * user picked, and a script can run the same ones on a fixture.
 */

import { parseCsvRows } from './csv'
import { parseMoney } from './money'
import { parseNative } from './fx-money'
import {
  type DateOrder, type OrderVerdict, inferDateOrder, parseDateWith,
} from './dates'

export class BankCsvError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BankCsvError'
  }
}

// ------------------------------------------------------------------- parse --

export const DELIMITERS = [',', '\t', ';', '|'] as const
export type Delimiter = (typeof DELIMITERS)[number]

export const DELIMITER_NAME: Record<Delimiter, string> = {
  ',': 'Comma', '\t': 'Tab', ';': 'Semicolon', '|': 'Pipe',
}

/** Parse complete records, including quoted delimiters and embedded newlines. */
export function parseCsv(text: string, delimiter: string): string[][] {
  return parseCsvRows(text, [delimiter]).map(row => row.cells)
}

const isBlankRow = (r: string[]) => r.every((c) => c.trim() === '')

/** The column count most rows have. Footers and preambles are the minority. */
function modalWidth(rows: string[][]): number {
  const counts = new Map<number, number>()
  for (const r of rows) {
    if (isBlankRow(r)) continue
    counts.set(r.length, (counts.get(r.length) ?? 0) + 1)
  }
  let best = 0
  let bestN = 0
  for (const [width, n] of counts) if (n > bestN || (n === bestN && width > best)) { best = width; bestN = n }
  return best
}

/**
 * Which character separates the columns.
 *
 * Decided by parsing the file with each candidate and asking which one produces
 * a consistent table, rather than by counting characters — a description
 * containing a semicolon beats a naive count, and a tab-separated file has
 * commas inside its amounts.
 */
export function sniffDelimiter(text: string): Delimiter {
  const head = text.split(/\r?\n/).slice(0, 40).join('\n')
  let best: Delimiter = ','
  let bestScore = -1

  for (const d of DELIMITERS) {
    const rows = parseCsv(head, d).filter((r) => !isBlankRow(r))
    if (rows.length === 0) continue
    const width = modalWidth(rows)
    if (width < 2) continue
    const consistent = rows.filter((r) => r.length === width).length / rows.length
    // Consistency decides; width only breaks a tie, so a delimiter that splits
    // every row into two does not beat one that splits them into eight.
    const score = consistent * 1000 + width
    if (score > bestScore) { bestScore = score; best = d }
  }
  return best
}

const looksNumeric = (cell: string) => {
  const t = cell.trim()
  if (!t) return false
  return /^[-+(]?\s*\$?\s*[\d,]+(\.\d+)?\s*\)?-?$/.test(t)
}

const looksDated = (cell: string) => inferDateOrder([cell]).kind !== 'none'

/**
 * Which row holds the column names, or null when the file has none.
 *
 * Headerless exports are common — RBC's is `"Chequing","1234","1/15/2024",…` —
 * and so are preambles, where the first two rows are the account number and a
 * blank before the real header. Both are decided the same way: the header is
 * the first full-width row that contains no data, sitting above one that does.
 */
export function findHeaderRow(rows: string[][]): number | null {
  const width = modalWidth(rows)
  if (width < 2) return null

  const full = rows
    .map((cells, index) => ({ cells, index }))
    .filter((r) => r.cells.length === width && !isBlankRow(r.cells))

  const hasData = (cells: string[]) => cells.some((c) => looksNumeric(c) || looksDated(c))

  const firstData = full.findIndex((r) => hasData(r.cells))
  if (firstData === -1) return null   // nothing in the file reads as data
  if (firstData === 0) return null    // the first full row is already data: headerless

  const candidate = full[firstData - 1]
  const looksNamed = candidate.cells.filter((c) => c.trim() !== '').length >= 2
  return looksNamed ? candidate.index : null
}

// ----------------------------------------------------------------- profile --

export type ColumnShape = 'date' | 'amount' | 'text' | 'empty'

export type ColumnProfile = {
  index: number
  /** The header cell, or '' when the file has no header row. */
  header: string
  /** Up to four non-empty values, for showing under the column name. */
  samples: string[]
  /** How many data rows have something in this column. */
  filled: number
  /** How many different values it holds. A column of one repeated word is not a description. */
  distinct: number
  shape: ColumnShape
  /** Only meaningful when shape is 'date'. */
  dates: OrderVerdict
}

/**
 * Deciding whether a column holds dates at all is cheap on a handful of values.
 * Deciding WHICH format it is has to see every value in the file.
 *
 * Sampling that second question was a real defect: a file whose first 200 rows
 * are unambiguously day-first and whose 201st is written month-first was read
 * as decided, and the late rows landed in the wrong months with nothing said.
 * "It reads cleanly" is not a safe thing to conclude from a sample when the
 * disagreement can be anywhere.
 *
 * So: probe cheaply to find the date columns, then pay for the full scan only
 * on those.
 */
const PROBE_ROWS = 50

export function profileColumns(rows: string[][], headerRow: number | null): ColumnProfile[] {
  const width = modalWidth(rows)
  if (width === 0) return []

  const first = headerRow === null ? 0 : headerRow + 1
  const data = rows.slice(first).filter((r) => !isBlankRow(r))
  const header = headerRow === null ? [] : rows[headerRow]

  return Array.from({ length: width }, (_, index) => {
    const filledValues = data.map((r) => (r[index] ?? '').trim()).filter(Boolean)
    const probe = inferDateOrder(filledValues.slice(0, PROBE_ROWS))
    const verdict = probe.kind === 'none' ? probe : inferDateOrder(filledValues)

    let shape: ColumnShape = 'text'
    if (filledValues.length === 0) shape = 'empty'
    else if (verdict.kind !== 'none') shape = 'date'
    else if (filledValues.filter(looksNumeric).length / filledValues.length >= 0.8) shape = 'amount'

    return {
      index,
      header: (header[index] ?? '').trim(),
      samples: filledValues.slice(0, 4),
      filled: filledValues.length,
      distinct: new Set(filledValues).size,
      shape,
      dates: verdict,
    }
  })
}

// ----------------------------------------------------------------- mapping --

/**
 * `out` and `in` rather than debit and credit, deliberately.
 *
 * A bank statement's "Debit" column is money leaving the account, which in the
 * depositor's own books is a CREDIT to cash. Carrying the bank's words into a
 * mapping screen inside an accounting system is an invitation to map the column
 * to the account that means the opposite. "Money out" cannot be inverted.
 */
export type ColumnRole = 'ignore' | 'date' | 'description' | 'amount' | 'out' | 'in'

export const ROLES: ColumnRole[] = ['ignore', 'date', 'description', 'amount', 'out', 'in']

export const ROLE_LABEL: Record<ColumnRole, string> = {
  ignore: 'Ignore',
  date: 'Date',
  description: 'Description',
  amount: 'Amount — one signed column',
  out: 'Money out',
  in: 'Money in',
}

export type Mapping = {
  /** One role per column, same length as the profiles. */
  roles: ColumnRole[]
  /** Null until the date column's format is decided. */
  order: DateOrder | null
  /** The signed column counts a withdrawal as positive. */
  flip: boolean
}

/** A running balance is numeric and is not the amount. Nothing else uses it. */
const IS_BALANCE = /balance/i

const HEADER_HINTS: Array<[ColumnRole, RegExp]> = [
  ['date', /\b(?:date|time|timestamp|datetime)\b|posted|posting/i],
  ['out', /withdraw|debit|paid\s*out|money\s*out|charges?\b/i],
  ['in', /deposit|credit|paid\s*in|money\s*in/i],
  ['amount', /amount|value|sum\b/i],
  ['description', /desc|narrat|memo|detail|payee|particular|reference|transaction\s*type|merchant/i],
]

/**
 * A first answer, meant to be corrected.
 *
 * Header words decide first because they are what the bank actually said;
 * column shape only fills in what the words left blank. Nothing here is
 * trusted — every guess is shown next to the values it was guessed from, and
 * the point of the screen is that the user disagrees with it.
 */
export function guessMapping(profiles: ColumnProfile[]): Mapping {
  const roles: ColumnRole[] = profiles.map(() => 'ignore')
  const taken = new Set<ColumnRole>()

  for (const p of profiles) {
    if (p.shape === 'empty') continue
    for (const [role, re] of HEADER_HINTS) {
      if (!re.test(p.header)) continue
      // Description may repeat; the single-valued roles may not.
      if (role !== 'description' && taken.has(role)) continue
      if (role === 'date' && p.shape !== 'date') continue
      if ((role === 'amount' || role === 'out' || role === 'in') && p.shape !== 'amount') continue
      if (role === 'amount' && IS_BALANCE.test(p.header)) continue
      roles[p.index] = role
      taken.add(role)
      break
    }
  }

  if (!taken.has('date')) {
    const d = profiles.find((p) => p.shape === 'date' && roles[p.index] === 'ignore')
    if (d) { roles[d.index] = 'date'; taken.add('date') }
  }

  if (!taken.has('amount') && !taken.has('out') && !taken.has('in')) {
    // A running balance column is numeric and would fit here perfectly. It is
    // not the amount, and a file that has one usually has both.
    const money = profiles.filter((p) =>
      p.shape === 'amount' && roles[p.index] === 'ignore' && !IS_BALANCE.test(p.header))
    if (money.length === 1) { roles[money[0].index] = 'amount'; taken.add('amount') }
  }

  if (!taken.has('description')) {
    // The most varied text column, not the first one. A headerless export leads
    // with the account type — "Chequing" on every row — which is text, is
    // filled, and describes nothing. What varies row by row is the description.
    const text = profiles
      .filter((p) => p.shape === 'text' && roles[p.index] === 'ignore' && p.filled > 0)
      .sort((a, b) => b.distinct - a.distinct)
    if (text.length > 0) roles[text[0].index] = 'description'
  }

  // The date format is never guessed, not even when only one reading fits.
  //
  // "Only one reading fits" is a statement about the first 200 rows, not about
  // the file — and the cost of being wrong is a transaction in the wrong month,
  // which is the wrong GST period. The columns are a guess the screen shows you;
  // the date format is a question it asks.
  return { roles, order: null, flip: false }
}

const dateColumns = (roles: ColumnRole[]) =>
  roles.map((r, i) => (r === 'date' ? i : -1)).filter((i) => i !== -1).join(',')

/**
 * Change one column's role.
 *
 * Moving the date to a different column throws away the chosen format, because
 * the format was an answer about the OLD column. Carrying it over reads the new
 * column under an order nobody chose for it — and when the new column happens
 * to accept that order, nothing complains at all. The rows simply come out in
 * the wrong months.
 *
 * This lives here rather than in the change handler because a rule inside a
 * component cannot be tested, and this one is only visible in a sequence of two
 * actions that no static check over the component would ever perform.
 */
export function withRole(mapping: Mapping, index: number, role: ColumnRole): Mapping {
  const roles = mapping.roles.map((r, i) => (i === index ? role : r))
  const moved = dateColumns(roles) !== dateColumns(mapping.roles)
  return { ...mapping, roles, order: moved ? null : mapping.order }
}

export type Problem = { level: 'error' | 'warning'; code: string; message: string }

const named = (p: ColumnProfile) => (p.header ? `"${p.header}"` : `column ${p.index + 1}`)

/**
 * Everything wrong with a mapping, before a single row is read.
 *
 * Each rejection carries its own sentence naming its own columns. Two guards
 * that answer with the same string are one guard as far as any test can tell,
 * and that shape has been this repository's most common defect.
 */
export function validateMapping(profiles: ColumnProfile[], mapping: Mapping): Problem[] {
  const problems: Problem[] = []
  const of = (role: ColumnRole) => profiles.filter((p) => mapping.roles[p.index] === role)

  const dates = of('date')
  const amounts = of('amount')
  const outs = of('out')
  const ins = of('in')
  const descriptions = of('description')

  if (dates.length === 0) {
    problems.push({ level: 'error', code: 'NO_DATE', message: 'No column is marked as the date.' })
  } else if (dates.length > 1) {
    problems.push({
      level: 'error', code: 'TWO_DATES',
      message: `${dates.map(named).join(' and ')} are both marked as the date. Only one column can be.`,
    })
  }

  if (amounts.length > 1) {
    problems.push({
      level: 'error', code: 'TWO_AMOUNTS',
      message: `${amounts.map(named).join(' and ')} are both marked as the amount. `
        + `If the file splits withdrawals and deposits, mark them Money out and Money in instead.`,
    })
  }
  if (outs.length > 1) {
    problems.push({
      level: 'error', code: 'TWO_OUT',
      message: `${outs.map(named).join(' and ')} are both marked Money out. Only one column can be.`,
    })
  }
  if (ins.length > 1) {
    problems.push({
      level: 'error', code: 'TWO_IN',
      message: `${ins.map(named).join(' and ')} are both marked Money in. Only one column can be.`,
    })
  }

  if (amounts.length > 0 && (outs.length > 0 || ins.length > 0)) {
    const other = [...outs, ...ins]
    problems.push({
      level: 'error', code: 'AMOUNT_AND_PAIR',
      message: `${named(amounts[0])} is the amount and ${named(other[0])} is ${
        outs.length > 0 ? 'Money out' : 'Money in'}. A file has one shape or the other, `
        + `not both — otherwise every row would be counted twice.`,
    })
  }

  if (amounts.length === 0 && outs.length === 0 && ins.length === 0) {
    problems.push({
      level: 'error', code: 'NO_AMOUNT',
      message: 'No column holds the amount. Mark one signed column as Amount, '
        + 'or mark a Money out column and a Money in column.',
    })
  }

  if (descriptions.length === 0) {
    problems.push({
      level: 'warning', code: 'NO_DESCRIPTION',
      message: 'No column is marked as the description. The rows will import with an empty '
        + 'description, which makes two payments of the same amount on the same day '
        + 'impossible to tell apart.',
    })
  }

  // The date format. This is the one that must never be resolved by picking.
  if (dates.length === 1) {
    const v = dates[0].dates
    if (v.kind === 'none') {
      problems.push({
        level: 'error', code: 'NOT_DATES',
        message: `${named(dates[0])} is marked as the date, but ${v.because}`,
      })
    } else if (v.kind === 'conflict') {
      problems.push({ level: 'error', code: 'DATE_CONFLICT', message: v.because })
    } else {
      const allowed = v.kind === 'certain' ? [v.order] : v.orders
      if (mapping.order === null) {
        problems.push({
          level: 'error', code: 'ORDER_UNSET',
          message: `Choose how ${named(dates[0])} is written — nothing can be read until it is `
            + `settled, because the readings fall in different months. ${v.because}`,
        })
      } else if (!allowed.includes(mapping.order)) {
        problems.push({
          level: 'error', code: 'ORDER_IMPOSSIBLE',
          message: `The chosen date format cannot read ${named(dates[0])}. ${v.because}`,
        })
      }
    }
  }

  return problems
}

// ------------------------------------------------------------------ amount --

/**
 * A bank's idea of a number.
 *
 * `parseMoney` already handles "$1,234.56" and a leading minus. Two more shapes
 * arrive in statements and nowhere else, so they are normalised here rather
 * than in `money.ts`: accounting parentheses, and a trailing minus that some
 * mainframe exports still emit. Widening `parseMoney` itself would change what
 * the journal entry form accepts, which is not what this feature is for.
 */
export function parseBankAmount(cell: string, currency = 'CAD'): bigint | null {
  let text = cell.trim()
  if (!text) return null

  // "$", "-", "()" and "+" all survive the stripping below and reach parseMoney
  // as an empty string, which it reads as zero. That produced a 0.00 row in the
  // middle of a statement with nothing reported — a transaction the bank never
  // made. A blank cell is no amount; a cell with no digit in it is a bad one,
  // and the two are told apart here rather than merged into zero.
  if (!/\d/.test(text)) {
    throw new BankCsvError('BAD_AMOUNT', `"${cell.trim()}" has no digits in it.`)
  }

  let negative = false
  const bracketed = /^\((.*)\)$/.exec(text)
  if (bracketed) { negative = true; text = bracketed[1].trim() }
  else if (/-$/.test(text)) { negative = true; text = text.slice(0, -1).trim() }

  text = text.replace(/^\+/, '')

  let cents: bigint
  try {
    cents = currency === 'CAD' ? parseMoney(text) : parseNative(text.replace(/[$,\s]/g,''),currency)
  } catch {
    throw new BankCsvError('BAD_AMOUNT', `"${cell.trim()}" is not an amount.`)
  }
  return negative ? -cents : cents
}

// ------------------------------------------------------------------- apply --

export type BankRow = {
  /** 1-based position in the parsed grid. Not a file line: a quoted cell may contain newlines. */
  row: number
  date: string
  /** Positive is money into the account. */
  amount: bigint
  description: string
}

export type RowProblem = { row: number; code: string; message: string }

export type Applied = { rows: BankRow[]; problems: RowProblem[] }

export function applyMapping(
  grid: string[][],
  headerRow: number | null,
  mapping: Mapping,
  currency = 'CAD',
): Applied {
  const rows: BankRow[] = []
  const problems: RowProblem[] = []

  // Without this, `parseDateWith(cell, null)` falls through to month-first and
  // every ambiguous file silently imports as American. The screen is supposed to
  // block that, so reaching here with no order set is a bug upstream — and a bug
  // that puts transactions in the wrong month has to be loud.
  if (mapping.order === null) {
    throw new BankCsvError('ORDER_UNSET',
      'The date format has not been chosen, so no row can be read.')
  }
  const order = mapping.order

  const indexOf = (role: ColumnRole) => mapping.roles.findIndex((r) => r === role)
  const dateAt = indexOf('date')
  const amountAt = indexOf('amount')
  const outAt = indexOf('out')
  const inAt = indexOf('in')
  const descriptionAt = mapping.roles
    .map((r, i) => (r === 'description' ? i : -1))
    .filter((i) => i !== -1)

  const needed = Math.max(dateAt, amountAt, outAt, inAt, ...descriptionAt)
  const first = headerRow === null ? 0 : headerRow + 1

  for (let i = first; i < grid.length; i++) {
    const cells = grid[i]
    const at = i + 1
    if (isBlankRow(cells)) continue

    if (cells.length <= needed) {
      problems.push({
        row: at, code: 'SHORT_ROW',
        message: `Row ${at} has ${cells.length} column${cells.length === 1 ? '' : 's'}, `
          + `and the mapping needs at least ${needed + 1}. `
          + `Statements often end with a total line that is narrower than the rows above it.`,
      })
      continue
    }

    const cell = (n: number) => (n === -1 ? '' : (cells[n] ?? '').trim())

    let date: string
    try {
      date = parseDateWith(cell(dateAt), order)
    } catch (e) {
      problems.push({ row: at, code: 'BAD_DATE', message: `Row ${at}: ${(e as Error).message}` })
      continue
    }

    let amount: bigint
    try {
      if (amountAt !== -1) {
        const signed = parseBankAmount(cell(amountAt),currency)
        if (signed === null) {
          problems.push({ row: at, code: 'NO_AMOUNT_IN_ROW', message: `Row ${at} has no amount.` })
          continue
        }
        amount = mapping.flip ? -signed : signed
      } else {
        const out = outAt === -1 ? null : parseBankAmount(cell(outAt),currency)
        const inn = inAt === -1 ? null : parseBankAmount(cell(inAt),currency)
        if ((out ?? 0n) === 0n && (inn ?? 0n) === 0n) {
          problems.push({ row: at, code: 'NO_AMOUNT_IN_ROW', message: `Row ${at} has no amount.` })
          continue
        }
        if ((out ?? 0n) !== 0n && (inn ?? 0n) !== 0n) {
          problems.push({
            row: at, code: 'BOTH_SIDES',
            message: `Row ${at} has money out and money in on the same line. `
              + `One of the two columns is mapped to something else.`,
          })
          continue
        }
        if ((out ?? 0n) < 0n || (inn ?? 0n) < 0n) {
          problems.push({
            row: at, code: 'NEGATIVE_IN_PAIR',
            message: `Row ${at} has a negative number in a Money out or Money in column. `
              + `Those columns hold plain amounts; a file that signs them has one Amount column instead.`,
          })
          continue
        }
        amount = (inn ?? 0n) - (out ?? 0n)
      }
    } catch (e) {
      problems.push({ row: at, code: 'BAD_AMOUNT', message: `Row ${at}: ${(e as Error).message}` })
      continue
    }

    rows.push({
      row: at,
      date,
      amount,
      description: descriptionAt.map(cell).filter(Boolean).join(' — '),
    })
  }

  return { rows, problems }
}

// ------------------------------------------------------------------ screen --

export type Screen = {
  problems: Problem[]
  /** Null whenever anything is blocking. Never a half-result. */
  applied: Applied | null
}

/**
 * Everything the screen shows, decided here rather than in the component.
 *
 * The page above this has no logic of its own — it holds the file and calls
 * this. That is the shape the sales tax round arrived at the hard way: a rule
 * written inside a component cannot be tested, so it drifts from the rule the
 * library enforces, and the two disagree for six rounds before anyone notices.
 *
 * The one rule that lives here and nowhere else: **a blocked mapping produces
 * no rows at all.** Not an empty list, not the rows that happened to parse —
 * null, so there is nothing on screen that could be read as a result while the
 * date format is still unsettled.
 */
export function screenFor(
  profiles: ColumnProfile[],
  grid: string[][],
  headerRow: number | null,
  mapping: Mapping,
  currency = 'CAD',
): Screen {
  const problems = validateMapping(profiles, mapping)
  if (problems.some((p) => p.level === 'error')) {
    return { problems, applied: null }
  }
  return { problems, applied: applyMapping(grid, headerRow, mapping,currency) }
}

/**
 * Reading a date someone else wrote.
 *
 * `today.ts` answers "what day is it here". This answers a different and more
 * dangerous question: given "03/04/2024" in a file a bank produced, which day
 * is that? It is 3 April in most of the world and 4 March in the United States,
 * and Canadian banks export both.
 *
 * Guessing wrong moves a transaction between months, and this system files GST
 * by period, so the wrong month is the wrong return. The rule here is therefore
 * not "guess well" but **refuse to guess**: inference reports what the evidence
 * actually supports, and when two readings both fit, it says so and stops.
 *
 * No `new Date()` anywhere in this file. JavaScript's Date rolls 31 February
 * forward to 3 March instead of rejecting it, which would turn a corrupt file
 * into plausible data.
 */

export type DateOrder = 'ymd' | 'dmy' | 'mdy'

export const ORDERS: DateOrder[] = ['ymd', 'dmy', 'mdy']

export const ORDER_NAME: Record<DateOrder, string> = {
  ymd: 'Year first',
  dmy: 'Day first',
  mdy: 'Month first',
}

export const ORDER_PATTERN: Record<DateOrder, string> = {
  ymd: 'YYYY-MM-DD',
  dmy: 'DD/MM/YYYY',
  mdy: 'MM/DD/YYYY',
}

/**
 * The same cell under each order, which is the only explanation that has ever
 * helped anyone: 04/03/2024 is 4 March day-first and 3 April month-first.
 */
export const ORDER_EXAMPLE: Record<DateOrder, string> = {
  ymd: '2024-03-04 is 4 March',
  dmy: '04/03/2024 is 4 March',
  mdy: '04/03/2024 is 3 April',
}

export const orderLabel = (o: DateOrder) => `${ORDER_NAME[o]} — ${ORDER_PATTERN[o]}`

export class DateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DateError'
  }
}

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]

const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

export const daysInMonth = (y: number, m: number) =>
  m === 2 && isLeap(y) ? 29 : DAYS_IN[m - 1]

/**
 * Split a cell into exactly three parts, or null if it is not shaped like a
 * date at all. Separators seen in the wild: - / . space, and the comma in
 * "Jan 15, 2024".
 */
export function dateTokens(cell: string): string[] | null {
  const text = cell.trim()
  if (!text) return null
  // Some bank exports provide a timestamp instead of a date. Validate the
  // entire time and offset before keeping its own calendar day; converting
  // through Date would move late transactions into another bank day.
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?$/i.exec(text)
  if (timestamp) {
    const [, year, month, day, hour, minute, second = '0', offsetHour = '0', offsetMinute = '0'] = timestamp
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
        || Number(offsetHour) > 23 || Number(offsetMinute) > 59) return null
    return [year, month, day]
  }
  const parts = text.split(/[\s,./-]+/).filter(Boolean)
  return parts.length === 3 ? parts : null
}

/** A month token: '3', '03', 'Mar' or 'March'. Returns 1-12, or null. */
function monthValue(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) {
    const n = Number(token)
    return n >= 1 && n <= 12 ? n : null
  }
  if (!/^[A-Za-z]+$/.test(token)) return null
  const i = MONTHS.indexOf(token.slice(0, 3).toLowerCase())
  return i === -1 ? null : i + 1
}

/**
 * A two-digit year is read as 20xx.
 *
 * The alternative — a sliding window that sends 98 to 1998 — is worse here than
 * it looks: nobody is importing a 1998 statement into a system whose earliest
 * fiscal year is this one, and a rule that silently produced 1998 would put the
 * row in a period that does not exist, which surfaces as a database error
 * rather than as a date problem.
 */
function yearValue(token: string): number | null {
  if (/^\d{4}$/.test(token)) {
    const n = Number(token)
    return n >= 1900 && n <= 2999 ? n : null
  }
  if (/^\d{2}$/.test(token)) return 2000 + Number(token)
  return null
}

function dayValue(token: string): number | null {
  if (!/^\d{1,2}$/.test(token)) return null
  const n = Number(token)
  return n >= 1 && n <= 31 ? n : null
}

type Reading = { y: number; m: number; d: number }

/**
 * Does this cell read as a valid date under this order?
 *
 * A month name can only ever land in the month position, because `dayValue`
 * and `yearValue` both require digits — so "15-Jan-2024" reads day-first and
 * nothing else, without a separate rule saying so.
 */
export function readAs(cell: string, order: DateOrder): Reading | null {
  const t = dateTokens(cell)
  if (!t) return null

  const [i0, i1, i2] = t
  let y: number | null
  let m: number | null
  let d: number | null

  if (order === 'ymd') { y = yearValue(i0); m = monthValue(i1); d = dayValue(i2) }
  else if (order === 'dmy') { d = dayValue(i0); m = monthValue(i1); y = yearValue(i2) }
  else { m = monthValue(i0); d = dayValue(i1); y = yearValue(i2) }

  if (y === null || m === null || d === null) return null
  if (d > daysInMonth(y, m)) return null
  return { y, m, d }
}

const iso = (r: Reading) =>
  `${r.y}-${String(r.m).padStart(2, '0')}-${String(r.d).padStart(2, '0')}`

/** Parse under a known order. Throws rather than returning a wrong day. */
export function parseDateWith(cell: string, order: DateOrder): string {
  const r = readAs(cell, order)
  if (!r) {
    throw new DateError('BAD_DATE',
      `"${cell.trim()}" is not a date in ${ORDER_PATTERN[order]} form.`)
  }
  return iso(r)
}

/** Which orders could this one cell be? */
export function ordersFitting(cell: string): DateOrder[] {
  return ORDERS.filter((o) => readAs(cell, o) !== null)
}

export type OrderVerdict =
  | { kind: 'certain'; order: DateOrder; because: string }
  | { kind: 'ambiguous'; orders: DateOrder[]; because: string }
  | { kind: 'conflict'; because: string }
  | { kind: 'none'; because: string }

/**
 * What order is this column in?
 *
 * The four answers are deliberately different things, because the caller has to
 * do something different about each:
 *
 *   certain    one order fits every sample — use it
 *   ambiguous  more than one fits every sample — ASK, do not pick
 *   conflict   one sample forces A and another rules A out — the column mixes
 *              formats, and no single order will read all of it correctly
 *   none       nothing in the column is a date
 *
 * Collapsing ambiguous into certain is the whole failure this function exists
 * to prevent, so the two are never produced by the same branch.
 */
export function inferDateOrder(samples: string[]): OrderVerdict {
  const usable = samples.map((s) => s.trim()).filter(Boolean)
  if (usable.length === 0) return { kind: 'none', because: 'The column is empty.' }

  const fits = usable.map((s) => ({ sample: s, orders: ordersFitting(s) }))
  const dates = fits.filter((f) => f.orders.length > 0)
  if (dates.length === 0) return { kind: 'none', because: `"${usable[0]}" is not a date.` }

  let live: DateOrder[] = ORDERS.slice()
  // The sample that last narrowed the set is the one worth quoting: it is the
  // evidence. A message that quotes a sample which excluded nothing reads like
  // a reason while being only an illustration.
  let witness = dates[0].sample

  for (const f of dates) {
    const next = live.filter((o) => f.orders.includes(o))
    if (next.length === 0) {
      return {
        kind: 'conflict',
        because: `"${witness}" can only be ${live.map(orderLabel).join(' or ')}, `
          + `but "${f.sample}" cannot be read that way. `
          + `The column mixes more than one date format.`,
      }
    }
    if (next.length < live.length) witness = f.sample
    live = next
  }

  if (live.length === 1) {
    return {
      kind: 'certain',
      order: live[0],
      because: `"${witness}" only reads as ${orderLabel(live[0])}.`,
    }
  }

  const readings = live
    .map((o) => `${ORDER_NAME[o].toLowerCase()} makes it ${parseDateWith(witness, o)}`)
    .join(', ')
  return {
    kind: 'ambiguous',
    orders: live,
    because: `Every date in this column fits ${live.length} formats. `
      + `"${witness}": ${readings}.`,
  }
}

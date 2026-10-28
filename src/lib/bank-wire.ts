/**
 * How parsed bank rows travel from the browser to the server.
 *
 * Both directions live here, in one file that neither side is `server-only`, so
 * that a check can write a row out and read it back in and see the same money.
 * Splitting the writer from the reader is the shape this repository keeps
 * finding: two spellings of one rule, in two places, drifting.
 *
 * Everything read here was typed by something on the other side of a network
 * request. It is not trusted, it is parsed — and when it does not parse it is
 * refused, never coerced into something that looks like money.
 */

export class WireError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'WireError'
  }
}

/**
 * More than this in one file is refused with a sentence rather than discovered
 * as a failed request. A year of one account is a few hundred rows; five
 * thousand is a decade, and they all travel in one request body.
 */
export const MAX_IMPORT_ROWS = 5000

export const BANK_FIELDS = {
  ledgerId: 'ledgerId',
  accountId: 'accountId',
  sourceFile: 'sourceFile',
  rows: 'rows',
} as const

export type WireRow = { date: string; amount: bigint; description: string }

/** Amounts travel as a string of cents: JSON cannot carry a BigInt. */
type Encoded = { d: string; a: string; t: string }

export function rowsToField(rows: WireRow[]): string {
  return JSON.stringify(rows.map((r): Encoded => ({
    d: r.date, a: r.amount.toString(), t: r.description,
  })))
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Cents, and nothing else.
 *
 * A decimal point here would mean dollars were sent where cents were expected,
 * and `BigInt('12.50')` throws — the right outcome, but not one anybody could
 * read, so the shape is checked first and named in the message.
 */
const CENTS = /^-?\d{1,15}$/

export function rowsFromField(text: string): WireRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new WireError('BAD_PAYLOAD', 'The rows did not arrive intact. Read the file again.')
  }
  if (!Array.isArray(parsed)) {
    throw new WireError('BAD_PAYLOAD', 'The rows did not arrive as a list. Read the file again.')
  }
  if (parsed.length === 0) throw new WireError('EMPTY', 'There are no rows to save.')
  if (parsed.length > MAX_IMPORT_ROWS) {
    throw new WireError('TOO_MANY',
      `That file has ${parsed.length} rows and the limit for one import is ${MAX_IMPORT_ROWS}. `
      + `Split it by date range and import the parts.`)
  }

  return parsed.map((raw, i) => {
    const r = raw as Partial<Encoded>
    if (typeof r?.d !== 'string' || !ISO_DATE.test(r.d)) {
      throw new WireError('BAD_PAYLOAD', `Row ${i + 1} has no usable date. Read the file again.`)
    }
    if (typeof r.a !== 'string' || !CENTS.test(r.a)) {
      throw new WireError('BAD_PAYLOAD',
        `Row ${i + 1} has no usable amount. Amounts cross as whole cents, and this one is "${r.a}".`)
    }
    return { date: r.d, amount: BigInt(r.a), description: typeof r.t === 'string' ? r.t : '' }
  })
}

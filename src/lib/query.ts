import 'server-only'
import { parseMoney } from './money'

/**
 * What a searcher meant — decided ONCE, here.
 *
 * Two readers ask this question: the search page, which asks every table,
 * and the journal page, whose own search box the owner asked for in the same
 * breath (2026-09-03). If each parsed the query itself, "1498" would
 * eventually mean one thing on one page and another on the other, and
 * neither page would look wrong.
 *
 * A query is always a piece of TEXT. It is ALSO an amount when it reads as
 * one — and then it is two amounts, because money lives here as integer
 * cents: the figure read as dollars, and the same digits read as cents.
 * Typing 1498 finds the $1,498.00 bill and the $14.98 receipt, and a person
 * could have meant either. And it is a DAY when it is shaped like one.
 */
export type Query = {
  /** What the reader typed, trimmed. Empty means there is nothing to do. */
  text: string
  /**
   * Every amount this query could be, in cents, unsigned — a match is on the
   * ABSOLUTE amount, because a credit is negative in the books and nobody
   * searches for minus one thousand.
   */
  cents: bigint[]
  /** The day this query is, when it reads as one. */
  date: string | null
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
/**
 * Money is `bigint` in Postgres, and a candidate wider than that is not an
 * amount — it is a bank reference or a long document number, which is
 * exactly what this box is for. Binding it into `abs(amount) IN (…)` would
 * take the page down with an out-of-range error instead of falling back to
 * the text reading the query already has (critic, 2026-09-03).
 */
const INT8_MAX = 9223372036854775807n

export function readQuery(raw: string): Query {
  const text = raw.trim()
  const cents: bigint[] = []
  if (text) {
    try {
      const asMoney = parseMoney(text)
      const abs = asMoney < 0n ? -asMoney : asMoney
      if (abs !== 0n && abs <= INT8_MAX) cents.push(abs)
    } catch { /* not a number; it is still a word */ }
    // The same digits read as cents, but only for a whole number: a reader
    // who wrote the decimal point has already said dollars and cents.
    const bare = text.replace(/[,\s]/g, '')
    if (/^\d+$/.test(bare)) {
      const asCents = BigInt(bare)
      if (asCents !== 0n && asCents <= INT8_MAX && !cents.includes(asCents)) cents.push(asCents)
    }
  }
  return { text, cents, date: ISO_DAY.test(text) ? text : null }
}

/**
 * `%term%` for ILIKE, with `%`, `_` and `\` typed by the reader kept literal.
 * Every caller pairs it with `ESCAPE '\'`; without that a search for "50%"
 * would quietly match everything.
 */
export const like = (q: Query) => `%${escaped(q.text)}%`

/** The three characters ILIKE reads as pattern, kept as characters. */
const PATTERN_CHARS = /[\\%_]/g
const escaped = (v: string) => v.replace(PATTERN_CHARS, (c) => `\\${c}`)

/**
 * How a report is being READ, as opposed to what it says.
 *
 * One name for the parameter and one rule for what "nothing" means, because
 * the trial balance, the general ledger and anything added later have to agree
 * — a row hidden on one screen and shown on another is two answers to one
 * question, and the person would be right to trust neither.
 *
 * Client-safe: the switch that sets it is a client component.
 */

/** The query parameter. In the URL so a shared or printed report is the one
 *  that was looked at. */
export const HIDE_ZEROS = 'nonzero'

export function hidesZeros(params: { [k: string]: string | string[] | undefined }): boolean {
  const v = params[HIDE_ZEROS]
  return (Array.isArray(v) ? v[0] : v) === '1'
}

/**
 * Is there anything on this row?
 *
 * A row is empty when NOTHING about it is a figure — no movement in the range
 * and no closing position. An account that moved and came back to zero has a
 * story and stays; an account that closed at a figure without moving is a
 * balance somebody carried and stays too. Only a row that is zero every way
 * it can be asked is noise.
 */
export function isEmptyRow(r: { debit?: string; credit?: string; balance?: string }): boolean {
  const zero = (v?: string) => v === undefined || v === '' || BigInt(v) === 0n
  return zero(r.debit) && zero(r.credit) && zero(r.balance)
}

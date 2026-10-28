import { formatMoney } from '../money'
import type { Frequency } from './engine'

/**
 * How CRA's pay frequencies read to a person, with the number of pay periods
 * a year in brackets — because that number (P) is what every figure on a stub
 * is divided by, and somebody checking a deduction by hand needs it.
 *
 * Client-safe on purpose: the employee form and the run form both render this
 * list, and neither can import a `server-only` module. One list, so a
 * frequency cannot be offered on one screen and unnameable on the other.
 */
export const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: 'Weekly (52)',
  biweekly: 'Bi-weekly (26)',
  semi_monthly: 'Semi-monthly (24)',
  monthly: 'Monthly (12)',
  four_weekly: 'Every four weeks (13)',
  twenty_two: '22 pay periods a year',
  ten: '10 pay periods a year',
}

/**
 * Hundredths of an hour, as hours: 3750 is '37.50'.
 *
 * ONE spelling. Hours arrived in three places at once — the statement, the ROE
 * page and the run page — each with its own copy of this expression (critic).
 */
export const formatHours = (hundredths: bigint): string =>
  formatMoney(hundredths)

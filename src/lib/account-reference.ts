/**
 * THE ACCOUNT NUMBERS BESIDE A REPORT LINE.
 *
 * "所有report都没有account number给读者做reference" (owner, 2026-09-15). Not
 * quite all of them — the trial balance and the general ledger have printed a
 * code column since they were written, and the template statements print one
 * on screen — but everything derived did not, and no PDF did at all. A reader
 * holding a printed statement had no way back to the chart.
 *
 * Written once, here, because the screen and the PDF must say the same thing:
 * the codes on a printed statement and the codes on the same statement in a
 * browser disagreeing would be worse than neither having any.
 *
 * Long lines are capped rather than wrapped. "Balance at start" on the equity
 * statement is every equity account there is, and thirty codes in a row is not
 * a reference — it is a wall. The first few and a count says as much as a
 * reader can use, and the figure itself opens the full list.
 *
 * Nothing imported: a check calls it directly.
 */

/** The little this needs to know about an account behind a figure. */
export type Referenced = { code: string }

export function accountReference(accounts: Referenced[] | undefined, cap = 6): string {
  if (!accounts || accounts.length === 0) return ''
  const codes = [...new Set(accounts.map((a) => a.code))].sort()
  if (codes.length <= cap) return codes.join(' ')
  return `${codes.slice(0, cap).join(' ')} +${codes.length - cap}`
}

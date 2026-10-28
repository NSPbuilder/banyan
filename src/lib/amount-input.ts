import { parseMoney } from './money'

/** Input validity is separate from cents: an unreadable amount is never zero. */
export function amountInput(value: string): { cents: bigint | null; error?: string } {
  if (!value.trim()) return { cents: 0n }
  try {
    if (!/\d/.test(value)) throw new Error('No digits')
    return { cents: parseMoney(value) }
  } catch { return { cents: null, error: 'Enter an amount with at most two decimal places.' } }
}

export function journalSummary(lines: Array<{accountId: string; debit: string; credit: string}>) {
  let debit = 0n, credit = 0n, filled = 0, invalid = 0, incomplete = 0, dual = 0
  const amounts = lines.map(line => {
    const d = amountInput(line.debit), c = amountInput(line.credit)
    debit += d.cents ?? 0n; credit += c.cents ?? 0n
    if (d.error || c.error) invalid++
    if (d.cents && c.cents) dual++
    if (line.accountId && (d.cents || c.cents)) filled++
    if ((!line.accountId && (d.cents || c.cents)) || (line.accountId && d.cents === 0n && c.cents === 0n)) incomplete++
    return { debit: d, credit: c }
  })
  const difference = debit - credit
  return { debit, credit, difference, filled, invalid, incomplete, dual, amounts,
    balanced: invalid === 0 && incomplete === 0 && dual === 0 && filled >= 2 && difference === 0n }
}

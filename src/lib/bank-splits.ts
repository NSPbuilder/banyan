import { formatMoney } from './money'

export type BankSplit = { accountId: string; amount: bigint }
export const MAX_BANK_SPLITS = 20

/** Gross amounts are positive; the bank row supplies their direction. */
export function bankSplitProblem(parts: BankSplit[], remainder: bigint, bankAccountId?: string): string | null {
  if (parts.length < 2 || parts.length > MAX_BANK_SPLITS) return 'Split into 2 to 20 accounts.'
  if (parts.some((p) => !p.accountId)) return 'Choose an account for every split.'
  if (parts.some((p) => p.amount <= 0n)) return 'Every split amount must be greater than zero.'
  if (parts.some((p) => p.accountId === bankAccountId)) return 'A split cannot use this bank account.'
  if (new Set(parts.map((p) => p.accountId)).size !== parts.length) return 'Choose a different account for each split.'
  const total = parts.reduce((sum, p) => sum + p.amount, 0n)
  const expected = remainder < 0n ? -remainder : remainder
  if (total !== expected) return `Split amounts must total ${formatMoney(expected)}; currently ${formatMoney(total)}.`
  return null
}

import type { BankRowRecord, Candidate } from './bank'

/**
 * What the feed suggests for a row, decided by arithmetic and history — and
 * only suggested. Pure, so the screen harness can decide it the same way the
 * server does; `bank.ts` is `server-only` and cannot be rendered.
 *
 * `match` — exactly ONE posted entry has room for exactly what this row still
 *           needs (QuickBooks: "1 record found"). Two such entries is not a
 *           suggestion, it is a choice, and the row opens to a list instead.
 * `add`   — no such entry, but a row with this description was posted from
 *           this account before, and this is where its other side went.
 * `none`  — open the row and decide.
 */
export type Suggestion =
  | { kind: 'match'; entry: Candidate }
  | { kind: 'add'; contraAccountId: string; contraLabel: string }
  | { kind: 'none' }

export type Remembered = { account_id: string; code: string; name: string } | null

export function suggestionFor(
  row: Pick<BankRowRecord, 'unmatched_amount'>, candidates: Candidate[], remembered: Remembered,
): Suggestion {
  const exact = candidates.filter((c) => c.room === row.unmatched_amount)
  if (exact.length === 1) return { kind: 'match', entry: exact[0] }
  if (remembered) {
    return { kind: 'add', contraAccountId: remembered.account_id,
             contraLabel: `${remembered.code} — ${remembered.name}` }
  }
  return { kind: 'none' }
}

/**
 * The three tabs, in the order QuickBooks shows them — and under the names it
 * shows them under (owner, 2026-09-10, with a screenshot). The key IS the
 * word: a tab called one thing in the URL and another on the screen is two
 * vocabularies for one list.
 */
export const FEED_TABS = ['pending', 'posted', 'excluded'] as const
export type FeedTab = (typeof FEED_TABS)[number]

export const TAB_LABEL: Record<FeedTab, string> = {
  pending: 'Pending',
  posted: 'Posted',
  excluded: 'Excluded',
}

export const STATE_LABEL: Record<BankRowRecord['state'], string> = {
  unmatched: 'not accounted for',
  part: 'partly accounted for',
  matched: 'accounted for',
  ignored: 'set aside',
}

import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { formatMoney } from './money'
import { postEntryCore } from './posting'
import type { Runner } from './acting'

/**
 * Where the books start.
 *
 * Everything already built reads against a ledger that begins at zero, which
 * makes a balance sheet a fragment and lets the bank reconciliation compare
 * movement but not position. An opening balance is the entry that fixes that:
 * the closing figures from whatever came before, entered once.
 *
 * It is an ordinary entry. `source_type = 'opening_balance'` marks it and two
 * rules in 0022 hold it in place — one per ledger, and nothing dated before it —
 * but it balances, it lands in a period, it takes the next number, and it can
 * only be corrected by reversing it. There is no separate path into the ledger
 * here, for the same reason the bank import has none.
 */

export class OpeningError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'OpeningError'
  }
}

export type OpeningLine = { accountId: string; amount: bigint }

export type OpeningRecord = {
  id: string
  entry_no: string | null
  entry_date: string
  description: string
  status: string
  lines: number
}

/** The live opening balance for a ledger, if it has one. */
export async function openingBalanceFor(ledgerId: string, on: Runner = db) {
  const [row] = await on.execute<OpeningRecord>(sql`
    SELECT e.id::text, e.entry_no, e.entry_date::text, e.description, e.status,
           (SELECT count(*) FROM journal_line jl WHERE jl.entry_id = e.id)::int AS lines
      FROM journal_entry e
     WHERE e.ledger_id = ${ledgerId}::uuid
       AND e.source_type = 'opening_balance'
       AND e.status <> 'reversed'`)
  return row ?? null
}

/**
 * What the figures come to, before anything is written.
 *
 * Balances carried over from another system are very often out — a missing
 * account, retained earnings that never quite agreed, a spreadsheet rounded
 * somewhere. That is ordinary, and the number is not the problem. A system that
 * absorbs it quietly is. So this returns it, and the caller has to do something
 * deliberate.
 */
export function differenceOf(lines: OpeningLine[]): bigint {
  return lines.reduce((total, l) => total + l.amount, 0n)
}

export type OpeningResult = {
  entryId: string
  entryNo: string | null
  /**
   * What was put to the balancing account, or null when the figures already
   * balanced. Reported either way — a difference nobody was told about is the
   * thing this is built to prevent.
   */
  difference: bigint | null
}

export const DIFFERENCE_DESCRIPTION = 'Difference on conversion'

export async function postOpeningBalance(input: {
  ledgerId: string
  /** Must sit in a period, and nothing in the ledger may be dated before it. */
  entryDate: string
  lines: OpeningLine[]
  /** Where an out-of-balance difference goes. Needed only when there is one. */
  balancingAccountId?: string
  description?: string
  actor?: string
}, on: Runner = db): Promise<OpeningResult> {
  return on.transaction(async tx => {
  const lines = input.lines.filter((l) => l.amount !== 0n)
  if (lines.length === 0) {
    throw new OpeningError('EMPTY', 'There are no opening balances to enter.')
  }

  const existing = await openingBalanceFor(input.ledgerId, tx)
  if (existing) {
    throw new OpeningError('ALREADY_OPEN',
      `These books already have an opening balance — ${existing.entry_no ?? 'unnumbered'}, `
      + `dated ${existing.entry_date}. Reverse it before entering another.`)
  }

  const difference = differenceOf(lines)

  // The difference goes somewhere of its own. Putting it against an account that
  // was given a figure balances the entry and quietly changes that figure —
  // which is the one thing this is arranged to prevent, and it looks exactly
  // like the honest version afterwards.
  if (difference !== 0n && input.balancingAccountId
      && lines.some((l) => l.accountId === input.balancingAccountId)) {
    throw new OpeningError('BALANCING_ACCOUNT_IN_USE',
      'That account already has a figure of its own. Put the difference somewhere else, '
      + 'or the figure you entered stops being the figure that is recorded.')
  }

  if (difference !== 0n && !input.balancingAccountId) {
    throw new OpeningError('OUT_OF_BALANCE',
      `The figures are out by ${formatMoney(difference)}. Either correct them, or choose the `
      + `account the difference belongs in — it goes in as its own line, so it stays visible.`)
  }

  const balancing: OpeningLine[] = difference === 0n
    ? []
    : [{ accountId: input.balancingAccountId!, amount: -difference }]

  const posted = await postEntryCore(tx, {
    ledgerId: input.ledgerId,
    entryDate: input.entryDate,
    description: input.description?.trim() || 'Opening balances',
    sourceType: 'opening_balance',
    actor: input.actor ?? 'system',
    lines: [
      ...lines.map((l) => ({ accountId: l.accountId, amount: l.amount })),
      ...balancing.map((l) => ({
        accountId: l.accountId, amount: l.amount, description: DIFFERENCE_DESCRIPTION,
      })),
    ],
  })

  return {
    entryId: posted.entry.id,
    entryNo: posted.entry.entryNo,
    difference: difference === 0n ? null : -difference,
  }
  })
}

/**
 * The accounts an opening balance could name, with their normal side.
 *
 * Everything postable, because which accounts carry an opening balance is a
 * question about the business and not about the software: a conversion at a year
 * start carries only the balance sheet, and one done mid-year legitimately
 * carries year-to-date revenue and expenses too.
 */
export async function openingCandidates(entityId: string) {
  return db.execute<{
    id: string; code: string; name: string; account_type: string; normal_balance: string
  }>(sql`
    SELECT a.id::text, a.code, a.name, a.account_type::text, a.normal_balance::text
      FROM account a
     WHERE a.entity_id = ${entityId}::uuid AND a.is_postable AND a.is_active
     ORDER BY a.code`)
}

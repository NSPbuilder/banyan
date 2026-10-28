import 'server-only'
import { accountWithRole } from './accounts'
import { ROLE } from './roles'
import { TAX_CODES, computeTax, type TaxCode } from './tax-rates'

/**
 * ONE tax tag, one meaning: **it splits the line it is on, inclusive.**
 *
 * A line of 113.44 tagged GST+PST becomes 101.29 on its own account, 5.06 on
 * the GST account and 7.09 where PST belongs — the same 113.44 in total, so
 * whatever the line was balancing against is untouched. (On a purchase the
 * PST does not stand on its own: 108.38 stays on the line. Below.) That is what lets the
 * tag exist on a door with no designated counterpart: the bank feed's Add,
 * where the row's amount is what the bank moved and cannot be adjusted, and
 * the journal entry, where nothing is nominated to absorb it.
 *
 * It is the same arithmetic the quick and invoice doors compute with
 * (`computeTax`), read the other way round. Those doors ask "how much tax on
 * top of what was typed"; here the amount is already the total, because the
 * bank says so or because the person typed what the paper says.
 *
 * WHICH SIDE the tax lands on is the line's own sign, not a setting:
 *
 *   a DEBIT line is something bought   → GST is recoverable, PST is cost
 *   a CREDIT line is something sold    → GST is payable,     PST is payable
 *
 * PST paid on a purchase is not recoverable in BC, so it folds back into the
 * line rather than standing on a tax account (`quick.ts` says the same thing
 * and refuses a PST-recoverable account for the same reason). So the purchase
 * above is 108.38 of expense and 5.06 recoverable, not three lines.
 *
 * THE LIMIT, said out loud because the sign is doing the work: a sign is not
 * a direction of trade. A supplier's REFUND arriving at the bank is money in,
 * so this reads it as something sold and puts its GST on the payable side; a
 * sales return debited to revenue reads as something bought. Both are the
 * defect block 458 exists to catch, reached through an ordinary door. Until a
 * door carries its own direction, a refund or a credit note is entered
 * WITHOUT a tag, with its tax as a line of its own against the account the
 * original used — `D22` records that this is the behaviour, so it is a
 * decision rather than an omission (critic, 2026-09-07).
 */

export class TaggedLineError extends Error {
  constructor(readonly code: 'BAD_TAX_CODE' | 'NO_GST_ACCOUNT' | 'NO_PST_ACCOUNT', message: string) {
    super(message)
    this.name = 'TaggedLineError'
  }
}

const GST_ROLE = { bought: ROLE.gstRecoverable, sold: ROLE.gstPayable } as const
const PST_SOLD_ROLE = ROLE.pstPayable

type RoleAccount = { id: string; code: string; name: string } | undefined
type RoleLookup = (role: string) => Promise<RoleAccount>

const freshLookup = (ledgerId: string): RoleLookup =>
  async (role) => (await accountWithRole(ledgerId, role))[0]

/**
 * One query per ROLE per expansion, not per line: a journal of forty tagged
 * lines asked for the same two accounts forty times (whole-project audit,
 * 2026-09-13). Keyed by the role — the ledger is fixed for the expansion.
 */
function memoLookup(ledgerId: string): RoleLookup {
  const seen = new Map<string, Promise<RoleAccount>>()
  return (role) => {
    const hit = seen.get(role)
    if (hit) return hit
    const p = freshLookup(ledgerId)(role)
    seen.set(role, p)
    return p
  }
}

export type TaggedResult = {
  /** What the line itself keeps: the net, plus non-recoverable PST when it was bought. */
  amount: bigint
  /** The tax lines to add beside it, already signed the same way as the line. */
  taxLines: Array<{ accountId: string; amount: bigint; description: string }>
  /** For a caller that wants to say what it did. */
  gst: bigint
  pst: bigint
}

/**
 * Split one signed line by its tag. `amount` is signed in the ledger's own
 * sense (debit positive), and every amount coming back carries that sign, so
 * an entry that balanced before the split balances after it.
 */
export async function splitTaggedLine(
  ledgerId: string, accountId: string, amount: bigint, code: string,
  /** The day the money is dated. The rate in force then is the rate applied. */
  on: string,
  lookup: RoleLookup = freshLookup(ledgerId),
): Promise<TaggedResult> {
  if (!code || code === 'OUT_OF_SCOPE') return { amount, taxLines: [], gst: 0n, pst: 0n }
  if (!TAX_CODES.some((t) => t.code === code)) {
    throw new TaggedLineError('BAD_TAX_CODE', `"${code}" is not a tax tag this ledger knows.`)
  }
  const bought = amount > 0n
  const sign = bought ? 1n : -1n
  // computeTax works in positive money; the sign is put back on every part.
  const t = computeTax(amount < 0n ? -amount : amount, code as TaxCode, true, on)

  const taxLines: TaggedResult['taxLines'] = []
  if (t.gst > 0n) {
    const role = bought ? GST_ROLE.bought : GST_ROLE.sold
    const account = await lookup(role)
    if (!account) {
      throw new TaggedLineError('NO_GST_ACCOUNT',
        `No active account carries the ${role} role. Give one that role in the chart of accounts, `
        + 'or leave the tag out and enter the tax as its own line.')
    }
    taxLines.push({ accountId: account.id, amount: sign * t.gst, description: 'GST/HST' })
  }
  if (t.pst > 0n && !bought) {
    const account = await lookup(PST_SOLD_ROLE)
    if (!account) {
      throw new TaggedLineError('NO_PST_ACCOUNT',
        `No active account carries the ${PST_SOLD_ROLE} role. Register for PST in the sales tax `
        + 'module, or leave the tag out and enter the tax as its own line.')
    }
    taxLines.push({ accountId: account.id, amount: sign * t.pst, description: 'PST' })
  }
  // Bought: the PST stays with the line, because that is what the thing cost.
  const kept = bought ? t.base + t.pst : t.base
  return { amount: sign * kept, taxLines, gst: t.gst, pst: t.pst }
}

/** The tags a ledger can honour right now, for a screen to offer. */
export async function tagsAvailable(ledgerId: string) {
  const [recoverable] = await accountWithRole(ledgerId, GST_ROLE.bought)
  const [payable] = await accountWithRole(ledgerId, GST_ROLE.sold)
  const [pst] = await accountWithRole(ledgerId, PST_SOLD_ROLE)
  return { recoverable: recoverable ?? null, payable: payable ?? null, pstPayable: pst ?? null }
}

/**
 * Every tagged line of an entry, split — and the untagged ones left alone.
 *
 * The order is kept: a split line is immediately followed by its own tax
 * lines, so the journal reads the way the form was typed. Tax lines for two
 * rows tagged the same way are NOT summed; each says which line it came from,
 * because on a journal entry the person's rows are the story and folding them
 * together loses which one carried the tax.
 */
export async function expandTaggedLines<L extends {
  accountId: string; amount: bigint; description?: string; partyId?: string; taxCode?: string
}>(ledgerId: string, lines: L[], on: string): Promise<Array<{
  accountId: string; amount: bigint; description?: string; partyId?: string
}>> {
  const out: Array<{ accountId: string; amount: bigint; description?: string; partyId?: string }> = []
  const lookup = memoLookup(ledgerId)
  for (const line of lines) {
    if (!line.taxCode) {
      out.push({ accountId: line.accountId, amount: line.amount, description: line.description, partyId: line.partyId })
      continue
    }
    const split = await splitTaggedLine(ledgerId, line.accountId, line.amount, line.taxCode, on, lookup)
    out.push({ accountId: line.accountId, amount: split.amount, description: line.description, partyId: line.partyId })
    for (const t of split.taxLines) {
      out.push({
        accountId: t.accountId, amount: t.amount,
        description: line.description ? `${t.description} — ${line.description}` : t.description,
      })
    }
  }
  return out
}

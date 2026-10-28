import 'server-only'
import { ROLE } from './roles'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Runner } from './acting'
import { accountWithRole } from './accounts'
import { postEntry } from './posting'

/**
 * Quick expense / income: one source or destination account against receipt
 * lines, without raising a document. For the coffee receipt and the interest
 * deposit — anything with no invoice behind it and nobody to dun.
 *
 * This is a convenience SHAPE, not a second door: the posting goes through
 * `postEntry` like everything else, under its own source type (0037) so the
 * journal and the audit trail say which door it came through. What earns
 * the function is the arithmetic it refuses to leave to the person: the
 * source or destination line covers the items plus tax, and GST lands on the account
 * carrying the right role for the direction — recoverable when paying,
 * payable when collecting.
 */

export type QuickKind = 'expense' | 'income'

export class QuickEntryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'QuickEntryError'
  }
}

const GST_ROLE: Record<QuickKind, string> = {
  expense: ROLE.gstRecoverable,
  income: 'gst_hst_payable',
}
// PST has a payable side only. BC/SK/MB PST paid on a purchase is not
// recoverable — it is part of what the thing cost, and it lands IN the
// expense line rather than on a tax account (registrations.ts refuses a
// PST-recoverable account for exactly this reason).
const PST_INCOME_ROLE = ROLE.pstPayable
const PL_TYPE: Record<QuickKind, 'expense' | 'revenue'> = {
  expense: 'expense',
  income: 'revenue',
}

/**
 * What the form offers: every account a line could go to, and every account
 * the money could come out of.
 *
 * NEITHER LIST IS THE NARROW ONE IT WAS. The lines used to be expense
 * accounts on an expense and revenue accounts on income, and the money side
 * used to be cash only — so buying a laptop, paying down a loan, or paying
 * for anything at all with a credit card had to be entered as a journal
 * entry (owner, 2026-09-07: 「paid from里应该涵盖更多account，比如信用卡/
 * 股东借款这些liability，或者像quickbooks一样，可以在expense里添加非expense
 * 的account」). Both lists still say what the ordinary answer is — the
 * account's TYPE rides along so the screen can put the likely ones first —
 * but neither refuses the unusual one.
 *
 * The money side includes cash and liabilities. On an expense it also
 * includes every asset: recognizing a previously paid cost credits the
 * prepayment, whether or not the asset has the prepaid-expenses role.
 * Expense and other non-asset accounts are not offered as funding sources.
 */
export async function quickAccountsFor(ledgerId: string, kind: QuickKind) {
  const [plAccounts, bankAccounts, [gstAccount], [pstAccount]] = await Promise.all([
    db.execute<{ id: string; code: string; name: string; account_type: string }>(sql`
      SELECT a.id::text, a.code, a.name, a.account_type::text
        FROM account a
       WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
         AND a.is_postable AND a.is_active
       ORDER BY a.account_type = ${PL_TYPE[kind]}::account_type DESC, a.code`),
    db.execute<{ id: string; code: string; name: string; account_type: string; shareholder_loan: boolean; prepaid_expense: boolean; cash_account: boolean }>(sql`
      SELECT a.id::text, a.code, a.name, a.account_type::text,
             EXISTS (SELECT 1 FROM account_role ar
                      WHERE ar.account_id = a.id AND ar.role = 'due_to_shareholder') AS shareholder_loan,
             EXISTS (SELECT 1 FROM account_role ar
                      WHERE ar.account_id = a.id AND ar.role = 'prepaid_expenses') AS prepaid_expense,
             EXISTS (SELECT 1 FROM account_role ar
                      WHERE ar.account_id = a.id AND ar.role = 'cash_and_cash_equivalents') AS cash_account
        FROM account a
       WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
         AND a.is_postable AND a.is_active
         AND (a.account_type = 'liability'
              OR EXISTS (SELECT 1 FROM account_role ar
                          WHERE ar.account_id = a.id
                            AND ar.role = 'cash_and_cash_equivalents')
              OR (${kind} = 'expense' AND a.account_type = 'asset'))
       ORDER BY EXISTS (SELECT 1 FROM account_role ar
                         WHERE ar.account_id = a.id
                           AND ar.role = 'cash_and_cash_equivalents') DESC, a.code`),
    gstAccountFor(ledgerId, kind),
    // Income only: PST collected needs a payable account. On the expense side
    // there is deliberately no PST account to offer — the tax is cost.
    kind === 'income' ? roleAccountFor(ledgerId, PST_INCOME_ROLE) : Promise.resolve([]),
  ])
  return {
    plAccounts, bankAccounts,
    gstAccount: gstAccount ?? null,
    pstAccount: pstAccount ?? null,
  }
}

function gstAccountFor(ledgerId: string, kind: QuickKind) {
  return roleAccountFor(ledgerId, GST_ROLE[kind])
}

/** The one account a form pre-picks for a tax role — exported for the invoice form. */
export function taxRoleAccount(ledgerId: string, role: string, on: Runner = db) {
  return roleAccountFor(ledgerId, role, on)
}

// "Which account carries this role in this company" is asked here, by the
// invoice form, and now by payroll. It is answered once, in accounts.ts —
// two copies would answer differently the day the tie-break changes.
const roleAccountFor = accountWithRole

/** One item on the receipt: its own account, wording, amount and tax. */
export type QuickItem = {
  accountId: string
  /** The line's own wording; the entry's description covers it when absent. */
  description?: string
  /** Cents, before tax. */
  amount: bigint
  gst?: bigint
  /** PST collected (income) goes to its payable line; PST paid (expense) is
   *  cost and folds into THIS item's line — the thing simply cost that much. */
  pst?: bigint
}

export async function postQuickEntry(input: {
  ledgerId: string
  kind: QuickKind
  /** 'YYYY-MM-DD' */
  entryDate: string
  description: string
  /**
   * The other side's own number for this receipt or invoice — what you quote
   * when they ring up about it. A quick entry HAS no document row, so the
   * entry carries it (0049); an invoice-raised entry never does.
   */
  documentRef?: string
  bankAccountId: string
  /**
   * Who the money was with — the supplier paid, the customer who paid.
   *
   * ONE party for the whole entry, put on the ITEM lines rather than on the
   * bank line or the tax lines: the browse screens read `journal_line.
   * party_id`, so this is what makes a receipt show up under that supplier
   * on the Expenses screen. It was never here before (owner, 2026-09-07,
   * asked whether it had been removed — it had not; a quick entry simply
   * could not name anybody). Optional: the coffee receipt has nobody worth
   * recording, and 0025 has the last word on whether the party may transact
   * on that date.
   */
  partyId?: string
  /** The creditor on a due-to-shareholder/director funding line, distinct from the supplier. */
  fundingPartyId?: string
  /**
   * The items — a receipt is often several of them (owner, 2026-09-02). The
   * single-item fields below remain for callers written when there was only
   * one; both shapes land in the same list and the same arithmetic.
   */
  items?: QuickItem[]
  /** Single-item shape: the P&L account the money lands in or comes from. */
  accountId?: string
  /** Single-item shape: cents, before tax. */
  amount?: bigint
  gst?: bigint
  pst?: bigint
  actor?: string
}) {
  const party = input.partyId || undefined
  const items: QuickItem[] = input.items ?? (input.accountId !== undefined && input.amount !== undefined
    ? [{ accountId: input.accountId, amount: input.amount, gst: input.gst, pst: input.pst }]
    : [])
  if (items.length === 0) {
    throw new QuickEntryError('NO_ITEMS', 'Nothing to post — the entry has no lines.')
  }
  for (const item of items) {
    // ZERO is refused, NEGATIVE is not. A line that takes money back —
    // a deposit returned, a rebate on the same receipt, the loan half of a
    // part-financed purchase — is a negative line, and refusing it forced
    // the whole receipt into a journal entry (owner, 2026-09-07). Zero is
    // still a row somebody left half-typed.
    if (item.amount === 0n) {
      throw new QuickEntryError('NOT_POSITIVE', 'A line needs an amount that is not zero.')
    }
    if ((item.gst ?? 0n) < 0n || (item.pst ?? 0n) < 0n) {
      throw new QuickEntryError('NEGATIVE_GST',
        'A tax cannot be negative here. Leave the tax tag off a negative line, '
        + 'or use a journal entry.')
    }
  }
  const gst = items.reduce((s, i) => s + (i.gst ?? 0n), 0n)
  const pst = items.reduce((s, i) => s + (i.pst ?? 0n), 0n)

  // Every chosen account re-checked here, not trusted from the form: a select
  // is just a string, and this refusal names what is actually wrong with it.
  for (const item of items) {
    const [pl] = await db.execute<{ account_type: string; ok: boolean }>(sql`
      SELECT a.account_type::text, (a.is_postable AND a.is_active) AS ok
        FROM account a
       WHERE a.id = ${item.accountId}::uuid
         AND a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${input.ledgerId}::uuid)`)
    // ANY postable account of this company, not only the P&L one. What is
    // still refused is an account that is not this company's, not postable,
    // or retired — those are not judgements about bookkeeping, they are the
    // account not being usable at all.
    if (!pl || !pl.ok) {
      throw new QuickEntryError('WRONG_ACCOUNT',
        'A line must land in an active, postable account of this company.')
    }
  }
  // The posting gate uses the same type rule as the picker. Any active,
  // postable asset can be credited on an expense, including untagged prepaids.
  const [bank] = await db.execute<{ ok: boolean; shareholder_loan: boolean }>(sql`
    SELECT (a.is_postable AND a.is_active
            AND (a.account_type = 'liability'
                 OR EXISTS (SELECT 1 FROM account_role ar
                             WHERE ar.account_id = a.id
                               AND ar.role = 'cash_and_cash_equivalents')
                 OR (${input.kind} = 'expense' AND a.account_type = 'asset'))) AS ok,
           EXISTS (SELECT 1 FROM account_role ar
                    WHERE ar.account_id = a.id AND ar.role = 'due_to_shareholder') AS shareholder_loan
      FROM account a
     WHERE a.id = ${input.bankAccountId}::uuid
       AND a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${input.ledgerId}::uuid)`)
  if (!bank || !bank.ok) {
    throw new QuickEntryError('NOT_A_BANK_ACCOUNT',
      input.kind === 'expense'
        ? 'Paid from needs an active, postable asset or liability account of this company.'
        : 'Deposited to needs an active cash account or liability of this company.')
  }
  const fundingParty = input.fundingPartyId || undefined
  if (fundingParty) {
    if (input.kind !== 'expense' || !bank.shareholder_loan) {
      throw new QuickEntryError('WRONG_FUNDING_ACCOUNT',
        'Choose a Due to Shareholder/Director account before naming who it is owed to.')
    }
    const [named] = await db.execute<{ ok: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM party p
        JOIN party_role pr ON pr.party_id = p.id
        JOIN ledger l ON l.entity_id = pr.entity_id
       WHERE p.id = ${fundingParty}::uuid AND p.is_active
         AND l.id = ${input.ledgerId}::uuid
         AND pr.role IN ('shareholder', 'director')
         AND (pr.held_to IS NULL OR pr.held_to >= ${input.entryDate}::date)
      ) AS ok`)
    if (!named.ok) {
      throw new QuickEntryError('WRONG_FUNDING_PARTY',
        'Choose a shareholder or director of this company on the expense date.')
    }
  }

  // ONE sign for the whole entry, decided once by the kind. The GST line used
  // to key its own sign on the kind a second time — two spellings of one
  // question, and a mutation of one of them produced an entry that did not
  // balance instead of one that was wrong the same way throughout.
  const sign = input.kind === 'expense' ? 1n : -1n

  const taxLines: Array<{ accountId: string; amount: bigint; description?: string }> = []
  if (gst > 0n) {
    const [gstAccount] = await gstAccountFor(input.ledgerId, input.kind)
    if (!gstAccount) {
      throw new QuickEntryError('NO_GST_ACCOUNT',
        `No active account carries the ${GST_ROLE[input.kind]} role. ` +
        `Give one that role in the chart of accounts, or enter the total without GST.`)
    }
    // One summed GST line, however many items fed it — the receipt itself
    // prints one GST figure, and the trace to the items is the entry.
    taxLines.push({ accountId: gstAccount.id, amount: sign * gst, description: 'GST/HST' })
  }
  // PST collected is a debt to the province; PST paid is cost, folded into
  // each item's own line rather than carried as a line of its own.
  if (pst > 0n && input.kind === 'income') {
    const [pstAccount] = await roleAccountFor(input.ledgerId, PST_INCOME_ROLE)
    if (!pstAccount) {
      throw new QuickEntryError('NO_PST_ACCOUNT',
        `No active account carries the ${PST_INCOME_ROLE} role. ` +
        `Register for PST in the sales tax module, or enter the total without PST.`)
    }
    taxLines.push({ accountId: pstAccount.id, amount: sign * pst, description: 'PST' })
  }

  // Signed cents, debit positive. Expense credits the selected source;
  // income debits the destination. This line carries the total, tax included.
  return postEntry({
    ledgerId: input.ledgerId,
    entryDate: input.entryDate,
    description: input.description,
    documentRef: input.documentRef,
    sourceType: input.kind === 'expense' ? 'quick_expense' : 'quick_income',
    actor: input.actor,
    lines: [
      { accountId: input.bankAccountId, amount: -sign * (items.reduce((s, i) => s + i.amount, 0n) + gst + pst),
        partyId: fundingParty },
      ...items.map((item) => ({
        accountId: item.accountId,
        amount: sign * (input.kind === 'expense' ? item.amount + (item.pst ?? 0n) : item.amount),
        description: item.description,
        partyId: party,
      })),
      ...taxLines,
    ],
  })
}

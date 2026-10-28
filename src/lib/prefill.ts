/**
 * A proposal, turned into the values the ordinary forms open with.
 *
 * This is the whole of what the model's reading does to the books: it fills
 * boxes. The quick forms and the invoice form are the same ones
 * used by hand, posted through the same readers and the same doors; nothing
 * here posts anything. A line whose account the model could not name arrives
 * blank, and the form refuses to post until a person picks one — which is the
 * review the owner asked for, enforced by the door rather than by hope.
 *
 * No `server-only`: the pages that render the forms are server components and
 * the checks call this directly.
 */
import type { Proposal } from './bill-reading'
import type { TaxCode } from './tax-rates'
import type { RowState } from './invoice-rows'
import { INVOICE_LINE_SLOTS } from './forms'
import { factOf } from './reading-facts'

export type Account = { id: string; code: string; name: string }

/** What a quick expense or income form opens with, from a reading. */
export type QuickInitial = {
  entryDate: string
  description: string
  bankAccountId?: string
  fundingPartyId?: string
  /** The party matched by name in the form's own list — suppliers on an expense, customers on income; blank when none matches. */
  partyId: string
  documentRef: string
  rows: Array<{
    accountId: string; description: string; amount: string; tax: TaxCode
    /**
     * True when the account was NOT read off the document but taken from where
     * this party's money went last time. The form says so beside the row:
     * a box filled from the books must not look like a box a person chose
     * (critic, 2026-09-07).
     */
    fromMemory: boolean
  }>
  /** The document's amounts are before tax, so the form opens on exclusive. */
  inclusive: false
  readingId: string
}

export type InvoiceInitial = {
  direction: 'purchase' | 'sales'
  kind?: 'invoice' | 'credit_note'
  header: { partyId: string; controlAccountId: string; issuedOn: string; dueOn: string
            number: string; theirRef: string; note: string }
  rows: Array<{
    accountId: string; description: string; amount: string; taxCode: string
    /** As on the quick form: filled from the books rather than read. */
    fromMemory: boolean
  }>
  readingId: string
  /** The party the reading named, when no party of that name exists yet on this side. */
  unknownParty: string | null
}

const byCode = (accounts: Account[]) => new Map(accounts.map((a) => [a.code, a.id]))

/**
 * The account a line opens on.
 *
 * The model's code when this chart has it. Failing that, WHERE THIS
 * PARTY'S MONEY WENT LAST TIME (`rememberedAccount`) — the books know
 * things the model cannot, and the account was the one box that never
 * filled (owner, 2026-09-07). Failing both, blank, and the door refuses
 * until a person picks: that refusal is the review, and it stays.
 */
const accountIdOf = (ids: Map<string, string>, code: string | null, remembered?: string | null) => {
  const named = code ? ids.get(code) : undefined
  if (named) return named
  // The remembered account only if this form OFFERS it. The lookup admits
  // expense and revenue accounts and a quick-expense form offers expense
  // ones, so a supplier who is also a customer could hand back a revenue
  // account — and an uncontrolled select given a value matching no option
  // shows the first option instead, which is neither the remembered account
  // nor the blank (critic, 2026-09-07).
  const offered = remembered && [...ids.values()].includes(remembered)
  return offered ? remembered! : ''
}

/** The date to open a form on: what the document said, or today. */
const dateOr = (said: string | null, today: string) => (said && /^\d{4}-\d{2}-\d{2}$/.test(said) ? said : today)

export type ChequeInitial = {
  chequeDate: string; payee: string; payeeAddress: string; expenseAccountId: string
  amount: string; memo: string; readingId: string; warning: string | null
}

/** A manual cheque has one expense line. Leave unsupported totals blank rather than losing tax or line detail. */
export function chequeInitialFrom(
  readingId: string, proposal: Proposal, expenses: Account[], today: string,
): ChequeInitial {
  const line = proposal.lines.length === 1 ? proposal.lines[0] : null
  const hasTax = !!line?.taxCode || !!(proposal.gst && Number(proposal.gst)) || !!(proposal.pst && Number(proposal.pst))
  const oneLine = proposal.lines.length <= 1 && !hasTax && proposal.currency === 'CAD'
  const stated = proposal.total ?? line?.amount ?? null
  const amount = oneLine && stated && /^\d+(?:\.\d{1,2})?$/.test(stated) && Number(stated) > 0
    && (!line || !proposal.total || Number(proposal.total) === Number(line.amount)) ? stated : ''
  const warning = proposal.currency !== 'CAD'
    ? 'The reading is in another currency. Enter a reviewed CAD amount before creating the cheque.'
    : proposal.lines.length > 1 || hasTax || (line && proposal.total && Number(proposal.total) !== Number(line.amount))
      ? 'A manual cheque has one expense line and no separate tax lines. Review the full reading; choose an amount and expense account yourself, or use the expense form for line and tax detail.'
      : null
  return {
    chequeDate: dateOr(proposal.issuedOn, today),
    payee: proposal.party,
    payeeAddress: factOf(proposal.facts, ['payeeAddress', 'mailingAddress', 'address']) ?? '',
    expenseAccountId: line && oneLine ? expenses.find((a) => a.code === line.accountCode)?.id ?? '' : '',
    amount,
    memo: (line?.description || proposal.documentRef).slice(0, 500),
    readingId,
    warning,
  }
}

export function quickInitialFrom(
  kind: 'expense' | 'income', readingId: string, proposal: Proposal, accounts: Account[], today: string,
  /** Where this party's money went last time, when the books remember — of the kind's own type. */
  remembered?: string | null,
  /** The parties this form offers, to open the Party box on the one the reading names. */
  parties: Array<{ id: string; label: string }> = [],
): QuickInitial {
  const ids = byCode(accounts)
  const wanted = plainName(proposal.party)
  const named = wanted ? parties.find((p) => plainName(p.label) === wanted) : undefined
  return {
    entryDate: dateOr(proposal.issuedOn, today),
    description: proposal.party || (kind === 'expense' ? 'Bill' : 'Income'),
    partyId: named?.id ?? '',
    // A sale read as income carries OUR number, which is not the customer's reference.
    documentRef: kind === 'income' && proposal.suggests === 'sale' ? '' : proposal.documentRef,
    rows: proposal.lines.map((l) => {
      const accountId = accountIdOf(ids, l.accountCode, remembered)
      return {
        accountId,
        description: l.description,
        amount: l.amount,
        tax: (l.taxCode || 'OUT_OF_SCOPE') as TaxCode,
        fromMemory: accountId !== '' && !(l.accountCode && ids.get(l.accountCode)),
      }
    }),
    inclusive: false,
    readingId,
  }
}

const LEGAL_SUFFIXES = new Set(['inc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'llc', 'llp', 'ulc', 'company'])
const CHINESE_SUFFIX = /(股份有限公司|有限责任公司|有限責任公司|有限公司|公司)$/u

/**
 * A party's name, as loosely as a name can be matched without guessing: the
 * same letters in any script — full-width and decomposed forms folded, symbols
 * such as ™ dropped before folding turns them into letters — ignoring case and
 * punctuation, and a legal suffix only where it ends the name (Inc, Ltd,
 * 有限公司), so "The Company Store" is not "The Store". One rule for a supplier
 * on a bill and a customer on a sales invoice.
 */
const plainName = (s: string) => {
  const words = s.replace(/\p{S}+/gu, ' ').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .split(' ').filter((w) => w !== '')
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop()
  const last = words.length - 1
  if (last >= 0) words[last] = words[last].replace(CHINESE_SUFFIX, '')
  return words.filter((w) => w !== '').join(' ')
}

/**
 * Whether a name reads as a company's rather than a person's: it ENDS in a
 * legal suffix (Ltd, Inc, 有限公司). The same two lists `plainName` strips, so
 * the words that make "Acme Ltd." match "Acme" are the words that make it an
 * organisation when a register row names it for the first time (2026-09-16).
 */
export function endsLikeACompany(name: string): boolean {
  const words = name.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean)
  const last = words[words.length - 1] ?? ''
  return words.length > 1 && LEGAL_SUFFIXES.has(last) || CHINESE_SUFFIX.test(last)
}

export function invoiceInitialFrom(
  direction: 'purchase' | 'sales', readingId: string, proposal: Proposal, accounts: Account[], today: string,
  /** The parties this direction offers: suppliers for a bill, customers for a sales invoice. */
  parties: Array<{ id: string; label: string }>,
  /** The payable account for a bill, the receivable one for a sales invoice. */
  controlAccountId: string,
  remembered?: string | null,
): InvoiceInitial {
  const ids = byCode(accounts)
  const wanted = plainName(proposal.party)
  const match = wanted ? parties.find((p) => plainName(p.label) === wanted) : undefined
  return {
    direction,
    header: {
      partyId: match?.id ?? '',
      controlAccountId,
      issuedOn: dateOr(proposal.issuedOn, today),
      dueOn: dateOr(proposal.dueOn, dateOr(proposal.issuedOn, today)),
      // The document's number is OURS on a sales invoice — `documentNumber` is
      // ours before theirs, and a repeated number of ours is refused — and the
      // supplier's on a bill (critic, 2026-09-15).
      number: direction === 'sales' ? proposal.documentRef : '',
      theirRef: direction === 'purchase' ? proposal.documentRef : '',
      note: proposal.notes,
    },
    rows: proposal.lines.map((l) => {
      const accountId = accountIdOf(ids, l.accountCode, remembered)
      return {
        accountId,
        description: l.description,
        amount: l.amount,
        taxCode: l.taxCode,
        fromMemory: accountId !== '' && !(l.accountCode && ids.get(l.accountCode)),
      }
    }),
    readingId,
    unknownParty: match ? null : (proposal.party || null),
  }
}

/**
 * The line editor's rows from a proposal's: keyed by position once, at the
 * start, which is the one moment the two numbers agree — and padded to the
 * usual six so the form still looks like itself.
 */
export function rowStateFrom(rows: InvoiceInitial['rows']): RowState {
  const out = rows.map((r, i) => ({
    key: i, account: r.accountId, description: r.description, amount: r.amount,
    taxCode: r.taxCode || 'OUT_OF_SCOPE',
  }))
  for (let i = out.length; i < INVOICE_LINE_SLOTS; i++) {
    out.push({ key: i, account: '', description: '', amount: '', taxCode: 'OUT_OF_SCOPE' })
  }
  return { rows: out, nextKey: out.length }
}

/** The lines, counted from 1, whose account was filled from the books rather than read — so a form can say which. */
export function rememberedLines(rows: Array<{ fromMemory: boolean }>): number[] {
  return rows.flatMap((r, i) => (r.fromMemory ? [i + 1] : []))
}

/**
 * Which side of the invoice form a reading opens on: `sales` when its link
 * says so, a purchase bill otherwise, as before 2026-09-15 — the parties and
 * control accounts to offer, the account type to remember, and the role to
 * name in a sentence.
 */
export function invoiceSideFor(direction: string | undefined) {
  return direction === 'sales'
    ? { direction: 'sales' as const, key: 'sales' as const, rememberedType: 'revenue' as const, role: 'customer' }
    : { direction: 'purchase' as const, key: 'purchase' as const, rememberedType: 'expense' as const, role: 'supplier' }
}

import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { openItemsQuery, owedAmount } from './payments'

/**
 * Browsing what was SPENT and what CAME IN, by party (owner, 2026-09-03).
 *
 * One derivation for both directions: posted entries in the range that touch
 * an account of the given type, each with the party its trading lines name
 * and the entry's movement on that account type. A quick entry can also name
 * a creditor on its first, funding line; that person is not the supplier or
 * customer this page groups under.
 * Opening balances and year-end closes are positions, not trading, and stay
 * out — the same exclusions the supporting-document reminder makes.
 *
 * The amounts tie to the trial balance by construction and by check: the sum
 * over a range equals the debit-minus-credit movement of every account of
 * that type in `trialBalanceSpan` (X32) — two readers, one answer.
 */
export type BrowseRow = {
  entry_id: string
  entry_no: string
  entry_date: string
  description: string
  source_type: string
  status: string
  /** Signed movement on the browsed account type: debit positive. */
  amount: string
  party_id: string | null
  party_name: string | null
  /** The number the document is known by — see the query's own note. */
  doc_ref: string | null
}

export async function entriesByParty(
  ledgerId: string, accountType: 'expense' | 'revenue', from: string, to: string,
): Promise<BrowseRow[]> {
  return db.execute<BrowseRow>(sql`
    SELECT je.id::text AS entry_id, je.entry_no, je.entry_date::text, je.description,
           je.source_type, je.status,
           COALESCE(SUM(jl.amount) FILTER (WHERE a.account_type = ${accountType}::account_type), 0)::text AS amount,
           p.id::text AS party_id, p.name AS party_name,
           -- The number the document is known by. The rule lives in
           -- doc-number.ts and is stated here in SQL because it is computed
           -- inside an aggregate, where TypeScript cannot be called: whoever
           -- RAISED the document gave it its number, so the invoice's own
           -- direction decides — not the account type this browse is reading,
           -- which would be the same fact inferred a second time. V113
           -- holds the two statements of it against each other.
           -- (No backticks in this string: it is a template literal and one
           -- would close it. The invoice total's SQL carries the same note.)
           -- An entry with no invoice row behind it (a quick expense, a
           -- journal) IS its own document and carries the number itself
           -- (0049), which is why this coalesces rather than picking a table.
           COALESCE(doc.ref, je.document_ref) AS doc_ref
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id
      JOIN account a ON a.id = jl.account_id
      LEFT JOIN LATERAL (
        SELECT p2.id, p2.name FROM journal_line l2 JOIN party p2 ON p2.id = l2.party_id
         WHERE l2.entry_id = je.id
           AND (je.source_type::text NOT IN ('quick_expense', 'quick_income') OR l2.line_no > 1)
         ORDER BY l2.line_no LIMIT 1) p ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN i.direction = 'purchase'
                    THEN COALESCE(NULLIF(btrim(i.their_ref), ''), NULLIF(btrim(i.number), ''))
                    ELSE COALESCE(NULLIF(btrim(i.number), ''), NULLIF(btrim(i.their_ref), '')) END AS ref
          FROM invoice i WHERE i.entry_id = je.id LIMIT 1) doc ON true
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted', 'reversed')
       AND je.source_type NOT IN ('opening_balance', 'period_close')
       AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       AND EXISTS (SELECT 1 FROM journal_line x JOIN account ax ON ax.id = x.account_id
                    WHERE x.entry_id = je.id AND ax.account_type = ${accountType}::account_type)
     GROUP BY je.id, p.id, p.name, doc.ref
     ORDER BY p.name NULLS LAST, je.entry_date DESC, je.entry_no DESC`)
}

/* ------------------------------------------------------------------ *
 * Everything about a party, on one page (owner, 2026-09-03).
 * ------------------------------------------------------------------ */

/**
 * Money out or money in. Not "expense" and "revenue": a payment is neither,
 * and the whole point of this page is that a party's payments are on it.
 */
export type Direction = 'out' | 'in'

const TYPE: Record<Direction, 'expense' | 'revenue'> = { out: 'expense', in: 'revenue' }
const DOCS: Record<Direction, 'purchase' | 'sales'> = { out: 'purchase', in: 'sales' }

/** What a row IS. The owner asked for this column by name. */
export type RowKind =
  | 'Bill' | 'Invoice' | 'Credit note' | 'Expense' | 'Income'
  | 'Payment' | 'Journal' | 'Bank' | 'Opening'

export type LedgerRow = {
  key: string
  kind: RowKind
  /** 'draft' and 'void' documents have never touched the books. */
  state: 'posted' | 'reversed' | 'draft' | 'void'
  on_date: string
  description: string
  doc_ref: string | null
  /** The journal behind this row, distinct from its invoice/document id. */
  entry_id: string | null
  entry_no: string | null
  party_id: string | null
  party_name: string | null
  /** Where clicking the row goes: the DOCUMENT if there is one, else the entry. */
  href: { kind: 'invoice' | 'entry'; id: string }
  /**
   * What this row put into the profit and loss, in signed cents — and NULL
   * for a row that put nothing there. A payment moves money without being an
   * expense; a draft is not in the books at all. This column is the one that
   * still adds up to the trial balance's movement (X32), which is why it
   * must stay empty for everything that is not trading.
   */
  pl_amount: string | null
  /**
   * What is still owed on this document, gross — tax included, because that
   * is what will actually be paid; an unspent credit note's is negative, since
   * it reduces what is owed. NULL for a row that creates no debt.
   * Not a range figure: a debt is a position, and it is owed today or it is
   * not (the owner's "真正的未付余额").
   */
  unpaid: string | null
  /** Why a row carries no p&l figure when one might be expected: where the money landed instead. */
  note?: string
}

/** The source an entry came through, as a word a reader knows. */
function kindOf(sourceType: string, documentKind: string | null): RowKind {
  if (documentKind === 'credit_note') return 'Credit note'
  switch (sourceType) {
    case 'ap_bill': return 'Bill'
    case 'ar_invoice': return 'Invoice'
    case 'quick_expense': return 'Expense'
    case 'quick_income': return 'Income'
    case 'payment': return 'Payment'
    case 'bank': return 'Bank'
    case 'opening_balance': return 'Opening'
    default: return 'Journal'
  }
}

/**
 * EVERY row about a party in one direction: what was spent or earned, what
 * was paid, and what is still owed.
 *
 * The Invoices page used to be a second place to look, and a party's bill sat
 * there while the entry it raised sat here — one company, two lists, and the
 * owner had to visit both (2026-09-03). So this is not "invoices added to the
 * browse": a POSTED invoice has always been here, as the entry it produced.
 * What was missing was the NAME of each row, the documents that never reached
 * the books (drafts and voids), the payments — whose entries touch no
 * expense or revenue account at all, so no filter on account type could ever
 * find them — and how much of each document is still unpaid.
 *
 * Three reads, one answer. The first is `entriesByParty` unchanged, so the
 * figure this page adds up is the same figure the trial balance moves by and
 * X32 still holds the two together. The other two bring rows that are not
 * trading at all, and they carry NO p&l amount — that is what keeps a bill
 * and its payment from counting as two thousand dollars of anything.
 */
export async function partyLedger(
  ledgerId: string, direction: Direction, from: string, to: string,
): Promise<LedgerRow[]> {
  const [entries, payments, unposted, balances, capital] = await Promise.all([
    entriesByParty(ledgerId, TYPE[direction], from, to),
    paymentsByParty(ledgerId, direction, from, to),
    unpostedDocuments(ledgerId, direction, from, to),
    documentBalances(ledgerId, direction),
    capitalDocuments(ledgerId, direction, from, to),
  ])

  const owed = new Map(balances.map((b) => [b.entry_id, b]))
  const rows: LedgerRow[] = entries.map((e) => {
    const bal = owed.get(e.entry_id)
    return {
      key: `e${e.entry_id}`,
      kind: kindOf(e.source_type, bal?.document_kind ?? null),
      state: e.status === 'reversed' ? 'reversed' : 'posted',
      on_date: e.entry_date,
      description: e.description,
      doc_ref: e.doc_ref,
      entry_id: e.entry_id,
      entry_no: e.entry_no,
      party_id: e.party_id,
      party_name: e.party_name,
      href: bal ? { kind: 'invoice' as const, id: bal.invoice_id } : { kind: 'entry' as const, id: e.entry_id },
      pl_amount: e.amount,
      // A settled document reads as nothing owed rather than as no debt at
      // all: the column means "still owed", and zero is an answer.
      unpaid: bal ? unpaidOf(bal) : null,
    }
  })

  for (const p of payments) {
    rows.push({
      key: `p${p.entry_id}`,
      kind: 'Payment',
      state: p.status === 'reversed' ? 'reversed' : 'posted',
      on_date: p.entry_date,
      description: p.description,
      doc_ref: null,
      entry_id: p.entry_id,
      entry_no: p.entry_no,
      party_id: p.party_id,
      party_name: p.party_name,
      href: { kind: 'entry', id: p.entry_id },
      // Deliberately NULL. A payment is money moving, not money earned or
      // spent; counting it beside the expense it settles is the double count
      // this page exists to avoid.
      pl_amount: null,
      unpaid: null,
    })
  }

  for (const d of unposted) {
    rows.push({
      key: `i${d.invoice_id}`,
      kind: kindOf(direction === 'out' ? 'ap_bill' : 'ar_invoice', d.document_kind),
      state: d.status === 'void' ? 'void' : 'draft',
      on_date: d.issued_on,
      description: d.note ?? (d.status === 'void' ? 'Voided document' : 'Draft document'),
      doc_ref: d.doc_ref,
      entry_id: null,
      entry_no: null,
      party_id: d.party_id,
      party_name: d.party_name,
      href: { kind: 'invoice', id: d.invoice_id },
      // Never in the books, so never in the movement, and owing nothing:
      // a draft is a piece of paper somebody is still writing.
      pl_amount: null,
      unpaid: null,
    })
  }

  // Every document that is STILL OWED, whatever its date. A debt is a
  // position: it is owed today or it is not, and a bill from last quarter
  // does not stop being owed because the range picker says this month. The
  // first version reached these balances only through the entries in the
  // range, so the Unpaid column quietly under-reported on every range that
  // did not happen to contain the bill — while the page, the code comment
  // and the column heading all called it a position (critic, 2026-09-03).
  //
  // It carries NO p&l figure: whatever it put into the books, it put there
  // in some other range, and counting it here would break the tie to the
  // trial balance. It also catches the document whose entry touches no
  // expense or revenue account at all — a bill for a fixed asset — which
  // the account-type read can never return.
  // Money out (or in) whose entry has no line of THIS direction's P&L type:
  // a bill for a fixed asset, a quick "expense" that bought equipment, a
  // deposit taken as deferred revenue. The account-type read can never return them and the
  // balances read only while they are owed, so a paid one vanished from this
  // page (whole-project audit, 2026-09-13). They carry NO p&l figure — the
  // tie to the trial balance stays — and the note says where the money went.
  for (const c of capital) {
    const bal = owed.get(c.entry_id)
    rows.push({
      key: `e${c.entry_id}`,
      kind: kindOf(c.source_type, c.document_kind),
      state: c.status === 'reversed' ? 'reversed' : 'posted',
      on_date: c.entry_date,
      description: c.description,
      doc_ref: c.doc_ref,
      entry_id: c.entry_id,
      entry_no: c.entry_no,
      party_id: c.party_id,
      party_name: c.party_name,
      href: c.invoice_id ? { kind: 'invoice', id: c.invoice_id } : { kind: 'entry', id: c.entry_id },
      pl_amount: null,
      unpaid: bal ? unpaidOf(bal) : null,
      note: `landed in ${c.landed ?? 'an account this page does not add up'} — not ${direction === 'out' ? 'an expense' : 'income'}, so not in the total`,
    })
  }

  const already = new Set(rows.map((r) => r.key))
  for (const b of balances) {
    if (BigInt(b.balance) === 0n || already.has(`e${b.entry_id}`)) continue
    rows.push({
      key: `e${b.entry_id}`,
      kind: kindOf(direction === 'out' ? 'ap_bill' : 'ar_invoice', b.document_kind),
      state: 'posted',
      on_date: b.issued_on,
      description: b.description ?? 'Outstanding document',
      doc_ref: b.doc_ref,
      entry_id: b.entry_id,
      entry_no: b.entry_no,
      party_id: b.party_id,
      party_name: b.party_name,
      href: { kind: 'invoice', id: b.invoice_id },
      pl_amount: null,
      unpaid: unpaidOf(b),
    })
  }

  return rows.sort((a, b) =>
    (a.party_name ?? '￿').localeCompare(b.party_name ?? '￿')
    || b.on_date.localeCompare(a.on_date))
}

/** Payments that moved money the way this page is about. */
async function paymentsByParty(
  ledgerId: string, direction: Direction, from: string, to: string,
) {
  // Which way the cash went, not which document it settled: an unapplied
  // payment on account settles nothing yet and is still money that moved.
  const outward = direction === 'out'
  return db.execute<{
    entry_id: string; entry_no: string; entry_date: string; description: string
    status: string; party_id: string | null; party_name: string | null
  }>(sql`
    SELECT je.id::text AS entry_id, je.entry_no, je.entry_date::text, je.description,
           je.status, p.id::text AS party_id, p.name AS party_name
      FROM journal_entry je
      LEFT JOIN LATERAL (
        SELECT p2.id, p2.name FROM journal_line l2 JOIN party p2 ON p2.id = l2.party_id
         WHERE l2.entry_id = je.id ORDER BY l2.line_no LIMIT 1) p ON true
      JOIN LATERAL (
        SELECT COALESCE(SUM(jl.amount), 0) AS cash
          FROM journal_line jl
          JOIN account a ON a.id = jl.account_id
          JOIN account_role ar ON ar.account_id = a.id AND ar.role = 'cash_and_cash_equivalents'
         WHERE jl.entry_id = je.id) money ON true
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.source_type = 'payment'
       AND je.status IN ('posted', 'reversed')
       AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       -- A payment that moved no cash at all is not money out and not money
       -- in: without this, its zero sums to "not negative" and it appears on
       -- the income page (critic, 2026-09-03).
       AND money.cash <> 0
       AND ${outward} = (money.cash < 0)
     ORDER BY je.entry_date DESC, je.entry_no DESC`)
}

/**
 * Documents that never reached the books: drafts, and voided paper.
 *
 * Filtered by the range like every other row that is a fact ABOUT a period.
 * Only an outstanding debt ignores the range, because only a debt is a
 * position — a 2019 draft on a page filtered to this month was the same page
 * meaning two things by its own date picker (critic, 2026-09-03).
 */
async function unpostedDocuments(
  ledgerId: string, direction: Direction, from: string, to: string,
) {
  return db.execute<{
    invoice_id: string; document_kind: string; status: string; issued_on: string
    party_id: string; party_name: string; doc_ref: string | null; note: string | null
  }>(sql`
    SELECT i.id::text AS invoice_id, i.document_kind, i.status, i.issued_on::text,
           i.party_id::text, p.name AS party_name, i.note,
           CASE WHEN i.direction = 'purchase'
                THEN COALESCE(NULLIF(btrim(i.their_ref), ''), NULLIF(btrim(i.number), ''))
                ELSE COALESCE(NULLIF(btrim(i.number), ''), NULLIF(btrim(i.their_ref), '')) END AS doc_ref
      FROM invoice i JOIN party p ON p.id = i.party_id
     WHERE i.ledger_id = ${ledgerId}::uuid
       AND i.direction = ${DOCS[direction]}
       AND i.status <> 'posted'
       AND i.issued_on BETWEEN ${from}::date AND ${to}::date
     ORDER BY i.issued_on DESC`)
}

/**
 * What each posted document of this direction still owes, keyed by the entry
 * it raised — which is how a row on this page finds its own debt.
 *
 * The arithmetic is `payments.ts`'s, joined rather than repeated.
 */
/**
 * Documents of this direction whose entry has no line of the direction's
 * P&L type — usually because what was bought or sold landed on the balance
 * sheet, though a quick line can land anywhere (26-money-out-money-in.md).
 * `landed` names the accounts on the far side from the cash — debited for
 * money out, credited for money in — so the row can say where it went.
 */
async function capitalDocuments(ledgerId: string, direction: Direction, from: string, to: string) {
  // Two parameters, not one array: the driver would send an array as a record.
  const kinds = direction === 'out' ? ['quick_expense', 'ap_bill'] as const : ['quick_income', 'ar_invoice'] as const
  const landedSide = direction === 'out' ? sql`jl.amount > 0` : sql`jl.amount < 0`
  return db.execute<{
    entry_id: string; entry_no: string; entry_date: string; description: string; status: string
    source_type: string; party_id: string | null; party_name: string | null; doc_ref: string | null
    invoice_id: string | null; document_kind: string | null; landed: string | null
  }>(sql`
    SELECT je.id::text AS entry_id, je.entry_no, je.entry_date::text, je.description, je.status, je.source_type::text,
           p.id::text AS party_id, p.name AS party_name,
           i.id::text AS invoice_id, i.document_kind,
           -- The same rule as entriesByParty's doc_ref (whoever raised the
           -- document numbered it); spelled with trim() so the two texts
           -- differ — the battery anchors a block on the other one.
           COALESCE(CASE WHEN i.direction = 'purchase'
                         THEN COALESCE(NULLIF(trim(i.their_ref), ''), NULLIF(trim(i.number), ''))
                         ELSE COALESCE(NULLIF(trim(i.number), ''), NULLIF(trim(i.their_ref), '')) END,
                    je.document_ref) AS doc_ref,
           (SELECT string_agg(DISTINCT a.code || ' ' || a.name, ', ')
              FROM journal_line jl JOIN account a ON a.id = jl.account_id
             WHERE jl.entry_id = je.id AND ${landedSide}
               AND NOT EXISTS (SELECT 1 FROM account_role ar
                                WHERE ar.account_id = a.id AND ar.role = 'cash_and_cash_equivalents')) AS landed
      FROM journal_entry je
      LEFT JOIN invoice i ON i.entry_id = je.id
      LEFT JOIN LATERAL (
        SELECT p2.id, p2.name FROM journal_line l2 JOIN party p2 ON p2.id = l2.party_id
         WHERE l2.entry_id = je.id
           AND (je.source_type::text NOT IN ('quick_expense', 'quick_income') OR l2.line_no > 1)
         ORDER BY l2.line_no LIMIT 1) p ON true
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted', 'reversed')
       AND je.source_type::text IN (${kinds[0]}, ${kinds[1]})
       AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       AND NOT EXISTS (SELECT 1 FROM journal_line x JOIN account ax ON ax.id = x.account_id
                        WHERE x.entry_id = je.id AND ax.account_type = ${TYPE[direction]}::account_type)
     ORDER BY je.entry_date DESC`)
}

/**
 * What a document row puts in the Unpaid column. `openItemsQuery`'s balance is
 * a size, and an unspent credit note reduces what is owed, so it goes in
 * negative and a party's subtotal nets it.
 */
const unpaidOf = (b: { document_kind: string; balance: string }): string =>
  String(owedAmount({ document_kind: b.document_kind, balance: BigInt(b.balance) }))

async function documentBalances(ledgerId: string, direction: Direction) {
  return db.execute<{
    invoice_id: string; entry_id: string; document_kind: string; balance: string
    issued_on: string; party_id: string; party_name: string
    doc_ref: string | null; description: string | null; entry_no: string | null
  }>(sql`
    SELECT bal.invoice_id, i.entry_id::text, i.document_kind, bal.balance::text,
           i.issued_on::text, i.party_id::text, p.name AS party_name,
           -- The entry's own words, so a row reads the same whether it
           -- arrived because it is in the range or because it is still owed.
           je.description, je.entry_no,
           CASE WHEN i.direction = 'purchase'
                THEN COALESCE(NULLIF(btrim(i.their_ref), ''), NULLIF(btrim(i.number), ''))
                ELSE COALESCE(NULLIF(btrim(i.number), ''), NULLIF(btrim(i.their_ref), '')) END AS doc_ref
      FROM (${openItemsQuery(sql`AND i.ledger_id = ${ledgerId}::uuid
                                 AND i.direction = ${DOCS[direction]}`)}) bal
      JOIN invoice i ON i.id = bal.invoice_id::uuid
      JOIN party p ON p.id = i.party_id
      LEFT JOIN journal_entry je ON je.id = i.entry_id
     WHERE i.entry_id IS NOT NULL`)
}

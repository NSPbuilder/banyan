import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * What is owed, and how long it has been owed.
 *
 * Read from the ledger. There is no aging table, no cached balance, and there
 * will not be one — `docs/design/03-parties.md` section 3 argues that out, and
 * `P24`/`P25` check that no such column has appeared anywhere.
 *
 * WHAT THIS ANSWERS, and what it does not, stated up front because the
 * difference is the whole design:
 *
 *   It answers "what does this party owe us, and how old is it" by OPEN ITEMS:
 *   each entry's movement on a control account, less what applications
 *   (`invoice_application`, 11-payments.md) have consumed of it, aged by the
 *   ORIGINAL entry date. A settled invoice is gone; a partly settled one shows
 *   its remainder in its own month's bucket.
 *
 *   "How much is still owed on INV-001" is `payments.ts`'s `balanceOf`, from
 *   the same applications — one record, two reports reading it.
 *
 * UNAPPLIED money keeps the old behaviour on purpose: a June receipt nobody
 * has applied sits whole in June's bucket as a negative, and does not reach
 * back to the invoice it was probably for. The report shows what is recorded,
 * not what is likely — applying it is one click, and `A09b` asserts the
 * unapplied reading so the limitation stays a fact in the suite.
 */

export type Bucket = { label: string; from: number; to: number | null }

/**
 * The buckets, oldest last. `to` is inclusive; the last bucket is open-ended.
 *
 * Defined once and exported, because the SQL and the screen must agree about
 * what "31-60" means. Two lists that drifted would put a figure under a heading
 * it does not belong to, and nothing about the total would look wrong.
 */
export const BUCKETS: Bucket[] = [
  { label: 'Not yet due', from: -36500, to: -1 },
  { label: '0–30', from: 0, to: 30 },
  { label: '31–60', from: 31, to: 60 },
  { label: '61–90', from: 61, to: 90 },
  { label: 'Over 90', from: 91, to: null },
]

export type AgingRow = {
  party_id: string
  party_name: string
  /** One figure per bucket, in `BUCKETS` order. Signed as the ledger holds it. */
  buckets: bigint[]
  total: bigint
}

export type Aging = {
  asOf: string
  /** 'trade_receivables' or 'trade_payables'. */
  role: string
  rows: AgingRow[]
  /** The same figures added up, per bucket. */
  totals: bigint[]
  /** What the control accounts say, read without the party join and without the
   *  bucket filters. The two must agree. */
  controlBalance: bigint
  /** Anything owed with no party on it — invisible to the rows above. */
  unattributed: bigint
}

/**
 * Aging as at a date, for one side.
 *
 * `asOf` is what the age is measured from, and it also cuts off the lines
 * considered: a line dated after it has not happened yet as far as this report
 * is concerned.
 */

/**
 * The open-items derivation, ONE definition. `aging()` buckets it; the
 * customer statement lists it entry by entry. A second copy of these CTEs
 * would be a second answer to "what is still open" — the defect this whole
 * file exists to end, in the file that exists to end it.
 */
function openItemsCte(
  ledgerId: string, role: 'trade_receivables' | 'trade_payables', asOf: string,
) {
  return sql`
    WITH control_movements AS (
      SELECT jl.party_id, jl.account_id, COALESCE(fx_document.entry_id,fx_origin.id,je.id) AS entry_id,
             COALESCE(fx_document.issued_on,je.entry_date) AS entry_date,
             SUM(jl.amount) AS movement
        FROM journal_line jl
        JOIN journal_entry je ON je.id = jl.entry_id
        LEFT JOIN invoice fx_document ON fx_document.id=jl.fx_invoice_id
         LEFT JOIN LATERAL(SELECT origin.id FROM journal_entry origin WHERE origin.ledger_id=je.ledger_id
           AND origin.source_id=fx_document.id AND origin.source_type IN ('ar_invoice','ap_bill')
           AND origin.reverses_id IS NULL ORDER BY origin.created_at LIMIT 1) fx_origin ON true
        JOIN account a ON a.id = jl.account_id
        JOIN account_role ar ON ar.account_id = a.id AND ar.role = ${role}
       WHERE je.ledger_id = ${ledgerId}::uuid
         AND je.status IN ('posted', 'reversed')
         AND je.entry_date <= ${asOf}::date
         AND jl.party_id IS NOT NULL
       GROUP BY jl.party_id, jl.account_id, COALESCE(fx_document.entry_id,fx_origin.id,je.id),COALESCE(fx_document.issued_on,je.entry_date)
    ),
    in_scope_applications AS (
      SELECT i.entry_id AS document_entry_id, ia.entry_id AS settling_entry_id,
             i.party_id, i.control_account_id, ia.amount
        FROM invoice_application ia
        JOIN invoice i ON i.id = ia.invoice_id
        JOIN account_role iar ON iar.account_id = i.control_account_id
                             AND iar.role = ${role}
        JOIN journal_entry de ON de.id = i.entry_id
        JOIN journal_entry se ON se.id = ia.entry_id
       WHERE i.fx_currency IS NULL AND de.entry_date <= ${asOf}::date
         AND se.entry_date <= ${asOf}::date
    ),
    consumed AS (
      SELECT entry_id, party_id, account_id, SUM(amount) AS amount FROM (
        SELECT document_entry_id AS entry_id, party_id,
               control_account_id AS account_id, amount FROM in_scope_applications
        UNION ALL
        SELECT settling_entry_id AS entry_id, party_id,
               control_account_id AS account_id, amount FROM in_scope_applications
      ) both_sides GROUP BY entry_id, party_id, account_id
    ),
    open_items AS (
      SELECT cm.party_id, cm.entry_id, COALESCE(migration_source.original_date,cm.entry_date) AS entry_date,
             (cm.movement - sign(cm.movement)::bigint * COALESCE(c.amount, 0))::bigint AS open_amount
        FROM control_movements cm
        LEFT JOIN consumed c ON c.entry_id = cm.entry_id
                            AND c.party_id = cm.party_id
                            AND c.account_id = cm.account_id
        -- Conversion GL remains on the snapshot date. Aging retains the original
        -- immutable source document/payment date; ordinary entries keep their date.
        LEFT JOIN (SELECT entry_id,min(original_issued_on) AS original_date
                     FROM migration_reference WHERE ledger_id=${ledgerId}::uuid
                     AND original_issued_on IS NOT NULL GROUP BY entry_id) migration_source
          ON migration_source.entry_id=cm.entry_id
    )`
}

/**
 * The open entries themselves, one row per (entry, party) still carrying an
 * amount — what the customer statement lists, joined to whichever document
 * (if any) the entry belongs to. Same CTEs as `aging()`, by construction.
 */
export async function openControlEntries(
  ledgerId: string, role: 'trade_receivables' | 'trade_payables', asOf: string,
  partyId?: string,
) {
  // Hoisted so the battery can anchor a block on a plain line: the customer
  // statement asks for ONE party, and reading the whole ledger to filter in
  // JS was the whole-project audit's finding (2026-09-13).
  const onlyParty = partyId === undefined ? sql`` : sql`AND oi.party_id = ${partyId}::uuid`
  return db.execute<{
    party_id: string; entry_id: string; entry_date: string; open_amount: bigint
    entry_no: string; description: string | null; invoice_id: string | null
    number: string | null; document_kind: string | null; due_on: string | null
  }>(sql`
    ${openItemsCte(ledgerId, role, asOf)}
    SELECT oi.party_id::text, oi.entry_id::text, oi.entry_date::text, oi.open_amount,
           je.entry_no, je.description, i.id::text AS invoice_id,
           i.number, i.document_kind, i.due_on::text
      FROM open_items oi
      JOIN journal_entry je ON je.id = oi.entry_id
      LEFT JOIN invoice i ON i.entry_id = oi.entry_id
     WHERE oi.open_amount <> 0
       ${onlyParty}
     ORDER BY oi.entry_date, je.entry_no`)
}

export async function aging(
  ledgerId: string, role: 'trade_receivables' | 'trade_payables', asOf: string,
): Promise<Aging> {
  // One CASE per bucket, built from the same list the screen renders. Writing
  // the ranges out in SQL would be the second list that drifts.
  const bucketSums = BUCKETS.map((b, i) => {
    const lower = sql`${b.from}`
    const upper = b.to === null ? sql`` : sql`AND (${asOf}::date - oi.entry_date) <= ${b.to}`
    return sql`COALESCE(SUM(oi.open_amount) FILTER (
      WHERE (${asOf}::date - oi.entry_date) >= ${lower} ${upper}), 0)::text AS b${sql.raw(String(i))}`
  })

  // OPEN ITEMS, since 核销 exists (11-payments.md). Each entry's movement on
  // the control account, per party, less what applications have consumed of
  // it — on EITHER side: an invoice's entry is consumed by being settled, a
  // payment's or credit note's entry is consumed by settling. The remainder
  // ages by the ORIGINAL entry date, so a thousand-dollar January invoice
  // with 850 applied shows 150 in January's bucket, not a pair of figures a
  // reader has to net by hand.
  //
  // An application counts only when BOTH entries it links are dated within
  // asOf, and only when its INVOICE belongs to the role being aged — a review
  // constructed a contra settlement (one entry netting a receivable against a
  // payable, same party) whose payable-side application was being subtracted
  // from the receivables report too, which showed 100,000 owing where the
  // ledger said 20,000. Under those two conditions every in-scope application
  // subtracts once from a positive movement and once from a negative one on
  // the SAME account, so Σ open = Σ movement = the control balance. The
  // tripwires for the one-sided cases are A19b/A11/A15 and A22 (blocks 178,
  // 182) — not A04, which runs before any application fixture exists.
  // (An UNAPPLIED payment still sits whole in its own bucket — the limitation
  // `A09b` asserts is now about unapplied money, not all money.)
  const rows = await db.execute<Record<string, string> & { party_id: string; party_name: string }>(sql`
    ${openItemsCte(ledgerId, role, asOf)}
    SELECT p.id::text AS party_id, p.name AS party_name,
           ${sql.join(bucketSums, sql`, `)},
           COALESCE(SUM(oi.open_amount), 0)::text AS total
      FROM open_items oi
      JOIN party p ON p.id = oi.party_id
     GROUP BY p.id, p.name
    HAVING COALESCE(SUM(oi.open_amount), 0) <> 0
     ORDER BY p.name`)

  const parsed: AgingRow[] = rows.map((r) => ({
    party_id: r.party_id,
    party_name: r.party_name,
    buckets: BUCKETS.map((_, i) => BigInt(r[`b${i}`])),
    total: BigInt(r.total),
  }))

  // What the control accounts hold, read WITHOUT the party join and WITHOUT the
  // bucket filters — the two places above where this report can quietly lose
  // money, since the join discards party-less lines and the ranges could leave
  // a gap between them.
  //
  // Not an independent reading, and it should not be called one: this query
  // sits in the same function as the one above and shares the ledger, the
  // status list, the as-at cut and the account-role joins, so a mistake in any
  // of those moves both sides together. `A04` pins the figure as well as
  // comparing the two, which is what catches that.
  //
  // The difference between the two sums is exactly what is owed by nobody.
  const [control] = await db.execute<{ total: string; with_party: string }>(sql`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS total,
           COALESCE(SUM(jl.amount) FILTER (WHERE jl.party_id IS NOT NULL), 0)::text AS with_party
      FROM journal_line jl
      JOIN journal_entry je ON je.id = jl.entry_id
      JOIN account a ON a.id = jl.account_id
      JOIN account_role ar ON ar.account_id = a.id AND ar.role = ${role}
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status IN ('posted', 'reversed')
       AND je.entry_date <= ${asOf}::date`)

  return {
    asOf,
    role,
    rows: parsed,
    totals: BUCKETS.map((_, i) => parsed.reduce((s, r) => s + r.buckets[i], 0n)),
    controlBalance: BigInt(control?.total ?? '0'),
    // Not a rounding difference and not noise: a figure sitting in receivables
    // with no party on it is a debt nobody is going to chase. It gets its own
    // number rather than being absorbed into a bucket.
    unattributed: BigInt(control?.total ?? '0') - BigInt(control?.with_party ?? '0'),
  }
}

/** The days-late of one entry as at a date, for showing beside a document. */
export function ageOf(entryDate: string, asOf: string): number {
  const ms = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${entryDate}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

/** Which bucket a given age falls in. The screen and the SQL share this list. */
export function bucketOf(age: number): number {
  return BUCKETS.findIndex((b) => age >= b.from && (b.to === null || age <= b.to))
}

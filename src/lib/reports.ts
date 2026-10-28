import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { trialBalanceSpan } from './balances'
import { like, type Query } from './query'

/**
 * One row per journal entry, with a short summary of its lines.
 *
 * The lines are aggregated in the same query rather than fetched per entry:
 * a journal page showing fifty entries would otherwise issue fifty-one queries,
 * and the cost would grow with the books.
 */
export async function journalEntries(ledgerId: string, opts: {
  status: 'draft' | 'posted'
  limit?: number
  offset?: number
  /**
   * The journal's own search box and date range (owner, 2026-09-03). They
   * live HERE rather than in the page, and the query is parsed by
   * `readQuery` rather than by this file, because the search page asks the
   * same question of the same rows — one reader, one answer. A page that
   * filtered the list it was handed would be a second answer that only
   * differed on the rows the limit had already dropped.
   */
  q?: Query
  from?: string
  to?: string
}) {
  const wantDraft = opts.status === 'draft'
  const q = opts.q?.text ? opts.q : null
  return db.execute<{
    id: string; entry_no: string | null; entry_date: string; description: string
    status: string; total: string; line_count: string
    accounts: string[]; names: string[]; debits: string[]; credits: string[]
    original_currencies: string[]; original_amounts: string[]; fx_snapshots: string[]
    reversed_by: string | null; reverses: string | null
  }>(sql`
    SELECT je.id::text, je.entry_no, je.entry_date::text, je.description, je.status,
           COALESCE(SUM(jl.debit), 0)::text AS total,
           count(jl.id)::text AS line_count,
           array_remove(array_agg(a.code ORDER BY jl.line_no), NULL)                          AS accounts,
           array_remove(array_agg(a.name ORDER BY jl.line_no), NULL)                          AS names,
           -- Integer cents, like every other money figure in the app. The
           -- earlier /100.0 "for display" forced every consumer to round-trip
           -- through floats to get the real number back.
           array_remove(array_agg(jl.debit::text  ORDER BY jl.line_no), NULL)                 AS debits,
           array_remove(array_agg(jl.credit::text ORDER BY jl.line_no), NULL)                 AS credits,
           array_agg(COALESCE(jl.original_currency,'') ORDER BY jl.line_no) AS original_currencies,
           array_agg(COALESCE(jl.original_amount::text,'') ORDER BY jl.line_no) AS original_amounts,
           array_agg(COALESCE(jl.fx_snapshot::text,'') ORDER BY jl.line_no) AS fx_snapshots,
           (SELECT r.entry_no FROM journal_entry r WHERE r.id = je.reversed_by_id)            AS reversed_by,
           (SELECT r.entry_no FROM journal_entry r WHERE r.id = je.reverses_id)               AS reverses
      FROM journal_entry je
      LEFT JOIN journal_line jl ON jl.entry_id = je.id
      LEFT JOIN account a       ON a.id = jl.account_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND (${wantDraft} AND je.status = 'draft' OR NOT ${wantDraft} AND je.status IN ('posted','reversed'))
       AND ${opts.from ? sql`je.entry_date >= ${opts.from}::date` : sql`true`}
       AND ${opts.to ? sql`je.entry_date <= ${opts.to}::date` : sql`true`}
       AND ${q ? sql`(
             je.description ILIKE ${like(q)} ESCAPE '\\'
          OR je.memo ILIKE ${like(q)} ESCAPE '\\'
          OR je.document_ref ILIKE ${like(q)} ESCAPE '\\'
          OR je.entry_no ILIKE ${like(q)} ESCAPE '\\'
          OR ${q.date ? sql`je.entry_date = ${q.date}::date` : sql`false`}
          OR ${q.cents.length > 0 ? sql`abs(je.total_debit) IN ${q.cents}` : sql`false`}
          -- A line's own words and its own amount belong to the entry that
          -- carries them: somebody searching for a figure wants the entry it
          -- is on, not a row number.
          OR EXISTS (SELECT 1 FROM journal_line l
                      WHERE l.entry_id = je.id
                        AND (l.description ILIKE ${like(q)} ESCAPE '\\'
                             OR ${q.cents.length > 0 ? sql`abs(l.amount) IN ${q.cents}` : sql`false`}))
       )` : sql`true`}
     GROUP BY je.id
     ORDER BY je.entry_date DESC, je.entry_no DESC NULLS FIRST, je.created_at DESC, je.id DESC
     LIMIT ${opts.limit ?? 100}
     OFFSET ${opts.offset ?? 0}`)
}

/** A line's explicit party wins. Untagged invoice, tax and bank lines can
 * carry the entry's sole party, but never an arbitrary party from a mixed entry. */
const historyPartyJoins = sql`
  LEFT JOIN party line_party ON line_party.id = jl.party_id
  LEFT JOIN LATERAL (
    SELECT min(p.id::text) AS id, min(p.name) AS name
      FROM journal_line other JOIN party p ON p.id = other.party_id
     WHERE other.entry_id = je.id AND jl.party_id IS NULL
    HAVING count(DISTINCT p.id) = 1
  ) entry_party ON true`

/**
 * An account's history: every posted line, in date order, with a running
 * balance and the other accounts on the same entry.
 *
 * This reads the JOURNAL directly. `period_balance` is a cache of the same
 * figures maintained separately, so the two are different sources, not one
 * arithmetic — and when the cache is stale they disagree. That is what
 * `check_balance_integrity()` exists to report; this page is the version that
 * cannot be stale, because it is derived on the spot.
 *
 * Drafts are excluded: they are in no balance and on no statement, so including
 * them here would make this page disagree with every other page.
 */
export async function accountLedger(
  accountId: string, ledgerId: string,
  opts: { periodId?: string; from?: string; to?: string } = {},
) {
  const rows = await db.execute<{
    entry_id: string; entry_no: string; entry_date: string; description: string
    line_description: string | null; period_name: string
    party_id: string | null; party_name: string | null
    debit: string; credit: string; amount: string; running: string
    contra_codes: string[]; status: string
  }>(sql`
    WITH lines AS (
      SELECT je.id AS entry_id, je.entry_no, je.entry_date, je.description, je.status,
             jl.description AS line_description, jl.line_no,
             COALESCE(line_party.id::text, entry_party.id) AS party_id,
             COALESCE(line_party.name, entry_party.name) AS party_name,
             fp.name AS period_name, fp.id AS period_id,
             jl.debit, jl.credit, jl.amount,
             SUM(jl.amount) OVER (ORDER BY je.entry_date, je.entry_no, jl.line_no
                                  ROWS UNBOUNDED PRECEDING)::bigint AS running,
             -- the other side of this entry: what it was posted against
             ARRAY(SELECT DISTINCT a2.code
                     FROM journal_line o JOIN account a2 ON a2.id = o.account_id
                    WHERE o.entry_id = je.id AND o.account_id <> jl.account_id
                    ORDER BY a2.code) AS contra_codes
        FROM journal_line jl
        JOIN journal_entry je ON je.id = jl.entry_id
        JOIN fiscal_period fp ON fp.id = je.period_id
        ${historyPartyJoins}
       WHERE jl.account_id = ${accountId}::uuid
         AND je.ledger_id = ${ledgerId}::uuid
         AND je.status IN ('posted','reversed')
    )
    SELECT entry_id::text, entry_no, entry_date::text, description, line_description,
           period_name, party_id, party_name, debit::text, credit::text, amount::text, running::text,
           contra_codes, status
      FROM lines
     WHERE ${opts.periodId ? sql`period_id = ${opts.periodId}::uuid` : sql`true`}
       AND ${opts.from ? sql`entry_date >= ${opts.from}::date` : sql`true`}
       AND ${opts.to ? sql`entry_date <= ${opts.to}::date` : sql`true`}
     ORDER BY entry_date, entry_no, line_no`)

  return rows
}

/** Header figures for an account's history page. */
export async function accountSummary(accountId: string) {
  const [row] = await db.execute<{
    code: string; name: string; account_type: string; normal_balance: string
    is_active: boolean; is_postable: boolean; entity_id: string; entity: string
    line_count: string; total_debit: string; total_credit: string; balance: string
    roles: string[]
    parent_id: string | null; parent_code: string | null; parent_name: string | null
    /** Whether anything points at it — what decides if it may be deleted (0084, `deleteAccount`). */
    in_use: boolean
  }>(sql`
    SELECT a.code, a.name, a.account_type::text, a.normal_balance::text,
           (EXISTS (SELECT 1 FROM journal_line WHERE account_id = a.id)
             OR EXISTS (SELECT 1 FROM account k WHERE k.parent_id = a.id)
             OR EXISTS (SELECT 1 FROM invoice_line WHERE account_id = a.id)
             OR EXISTS (SELECT 1 FROM invoice WHERE control_account_id = a.id)
             OR EXISTS (SELECT 1 FROM bank_transaction WHERE account_id = a.id)
             OR EXISTS (SELECT 1 FROM bank_statement WHERE account_id = a.id)
             OR EXISTS (SELECT 1 FROM pay_run WHERE bank_account_id = a.id)) AS in_use,
           a.is_active, a.is_postable, a.entity_id::text, e.name AS entity,
           p.id::text AS parent_id, p.code AS parent_code, p.name AS parent_name,
           (SELECT count(*)::text FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
             WHERE jl.account_id = a.id AND je.status IN ('posted','reversed')) AS line_count,
           (SELECT COALESCE(SUM(jl.debit), 0)::text FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
             WHERE jl.account_id = a.id AND je.status IN ('posted','reversed')) AS total_debit,
           (SELECT COALESCE(SUM(jl.credit), 0)::text FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
             WHERE jl.account_id = a.id AND je.status IN ('posted','reversed')) AS total_credit,
           (SELECT COALESCE(SUM(jl.amount), 0)::text FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
             WHERE jl.account_id = a.id AND je.status IN ('posted','reversed')) AS balance,
           array_remove(array_agg(rd.label ORDER BY rd.sort_order), NULL) AS roles
      FROM account a
      JOIN entity e ON e.id = a.entity_id
      LEFT JOIN account p ON p.id = a.parent_id
      LEFT JOIN account_role ar ON ar.account_id = a.id
      LEFT JOIN role_definition rd ON rd.code = ar.role
     WHERE a.id = ${accountId}::uuid
     GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance,
              a.is_active, a.is_postable, a.entity_id, e.name,
              p.id, p.code, p.name`)
  return row
}

export type GeneralLedgerRow = Awaited<ReturnType<typeof accountLedger>>[number]

export type GeneralLedgerAccount = {
  account: { id: string; code: string; name: string }
  opening: bigint
  debit: bigint
  credit: bigint
  closing: bigint
  rows: GeneralLedgerRow[]
}

/**
 * The general ledger: every account that did anything in the span (or stood
 * at a balance through it), with its detail rows and running balance.
 *
 * Two readers on purpose. The summary line per account comes from the SAME
 * `trialBalanceSpan` the trial balance prints — opening is its closing minus
 * its net movement, so the GL and the TB cannot disagree by construction.
 * The detail rows come from `accountLedger`, which reads `journal_line`
 * directly. That makes "opening + the rows shown = closing" a real
 * cross-check between the balance cache and the journal, and the export
 * suite asserts it per account.
 */
export async function generalLedger(
  ledgerId: string,
  span: { fromPeriodId: string; toPeriodId: string; fromDate: string; toDate: string },
  // One account instead of all of them — the drill-down behind a trial balance
  // figure. The SAME loop, filtered, so the single-account view cannot use
  // different arithmetic than the full ledger; and the all-zero skip is off,
  // because the person clicked a zero and deserves the zero explained.
  opts: { accountId?: string } = {},
): Promise<GeneralLedgerAccount[]> {
  const tb = await trialBalanceSpan(ledgerId, span.fromPeriodId, span.toPeriodId)
  // Every account's rows in ONE read, shaped exactly as accountLedger shapes
  // them: the window is partitioned by account, the running balance still
  // spans all history (the date filter sits outside the window), and the
  // date range cuts which rows are shown. One query per account before
  // (whole-project audit, 2026-09-13); X16 still ties opening + rows to the
  // closing per account, which is what catches a broken carry.
  // The one-account drill-down filters in the QUERY, as the old per-account
  // read did — without this the drill-down read the whole ledger and threw
  // away every account but one (critic, 2026-09-13). Inside the CTE is where
  // accountLedger's own filter sits, so the window never sees other accounts.
  const onlyAccount = opts.accountId ? sql`AND jl.account_id = ${opts.accountId}::uuid` : sql``
  const all = await db.execute<{
    account_id: string; entry_id: string; entry_no: string; entry_date: string; description: string
    line_description: string | null; period_name: string
    party_id: string | null; party_name: string | null
    debit: string; credit: string; amount: string; running: string
    contra_codes: string[]; status: string
  }>(sql`
    WITH lines AS (
      SELECT jl.account_id, je.id AS entry_id, je.entry_no, je.entry_date, je.description, je.status,
             jl.description AS line_description, jl.line_no,
             COALESCE(line_party.id::text, entry_party.id) AS party_id,
             COALESCE(line_party.name, entry_party.name) AS party_name,
             fp.name AS period_name,
             jl.debit, jl.credit, jl.amount,
             SUM(jl.amount) OVER (PARTITION BY jl.account_id
                                  ORDER BY je.entry_date, je.entry_no, jl.line_no
                                  ROWS UNBOUNDED PRECEDING)::bigint AS running,
             ARRAY(SELECT DISTINCT a2.code
                     FROM journal_line o JOIN account a2 ON a2.id = o.account_id
                    WHERE o.entry_id = je.id AND o.account_id <> jl.account_id
                    ORDER BY a2.code) AS contra_codes
        FROM journal_line jl
        JOIN journal_entry je ON je.id = jl.entry_id
        JOIN fiscal_period fp ON fp.id = je.period_id
        ${historyPartyJoins}
       WHERE je.ledger_id = ${ledgerId}::uuid
         AND je.status IN ('posted','reversed')
         ${onlyAccount}
    )
    SELECT account_id::text, entry_id::text, entry_no, entry_date::text, description, line_description,
           period_name, party_id, party_name, debit::text, credit::text, amount::text, running::text, contra_codes, status
      FROM lines
     WHERE entry_date BETWEEN ${span.fromDate}::date AND ${span.toDate}::date
     ORDER BY account_id, entry_date, entry_no, line_no`)
  const byAccount = new Map<string, GeneralLedgerRow[]>()
  for (const r of all) {
    const { account_id, ...rest } = r
    const list = byAccount.get(account_id) ?? []
    list.push(rest)
    byAccount.set(account_id, list)
  }

  const out: GeneralLedgerAccount[] = []
  for (const row of tb) {
    if (opts.accountId && row.id !== opts.accountId) continue
    const debit = BigInt(row.debit)
    const credit = BigInt(row.credit)
    const closing = BigInt(row.balance)
    const opening = closing - (debit - credit)
    if (!opts.accountId && debit === 0n && credit === 0n && opening === 0n && closing === 0n) continue
    const rows: GeneralLedgerRow[] = debit === 0n && credit === 0n
      ? []
      : byAccount.get(row.id) ?? []
    out.push({ account: { id: row.id, code: row.code, name: row.name },
               opening, debit, credit, closing, rows })
  }
  return out
}

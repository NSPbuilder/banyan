import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, actingAs, lockBankAccount, type Tx } from './acting'
import { splitTaggedLine } from './tagged-line'
import { MAX_IMPORT_ROWS } from './bank-wire'
import { bankSplitProblem, type BankSplit } from './bank-splits'
import { postEntryCore } from './posting'
import { assertCurrencyOpen, assertNoLaterFx, lockFxLedger } from './fx'
import { fxRateFor } from './fx-rates'
import { toFunctional, type FxSnapshot } from './fx-money'
import { suggestionFor, type Suggestion } from './bank-feed'

/**
 * Bank rows, landed.
 *
 * `bank-csv.ts` reads a file into rows. This puts them somewhere, once, and the
 * whole of the difficulty is in that word: importing the same statement twice
 * must add nothing, and a statement that really does contain the same
 * transaction twice must add both.
 *
 * Those two cases look identical field by field. What separates them is
 * `occurrence` — which of several identical rows this is, within its own
 * (date, amount, description). Numbering is done here; uniqueness is enforced
 * by the database over the real columns, so there is no fingerprint string for
 * this file and the schema to disagree about.
 */

export class BankError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BankError'
  }
}

export { MAX_IMPORT_ROWS }

export type ImportRow = { date: string; amount: bigint; description: string }
export type NumberedRow = ImportRow & { occurrence: number }
export type ImportResult = { total: number; inserted: number; duplicates: number }

// The separator is a NUL, written as an escape rather than as the byte itself:
// a literal NUL makes this file binary to git, so every diff of it goes blank.
const SEP = '\u0000'
const key = (r: ImportRow) => `${r.date}${SEP}${r.amount}${SEP}${r.description}`

/**
 * Number each row within its own group of identical rows.
 *
 * Order within a group cannot matter — the members are identical by definition
 * — so the numbering does not depend on how the file happened to be sorted.
 * That is what makes it survive the case it exists for: next month's statement
 * overlapping this month's by a few days, where the overlapping rows have to
 * recognise themselves.
 *
 * Numbering down the whole file instead of within the group would look almost
 * the same and be useless: the same row would be 1 on Monday and 2 on Tuesday,
 * collide with nothing, and import twice.
 *
 * **The database catches most of that, and not all of it.** Numbering by file
 * position gives distinct rows occurrences 2, 3, 4 with no row at occurrence − 1
 * in their own group, and the gapless constraint refuses the whole import — a
 * mutation block records it doing exactly that.
 *
 * An import is one transaction, so one gap anywhere refuses everything,
 * including the rows that were fine. **The duplicate lands only when every row
 * of the mis-numbered file finds its predecessor already present** — from an
 * earlier import or from earlier in the same file.
 *
 * That sentence is the whole rule and it is deliberately not illustrated. Three
 * rounds of review were spent on illustrations of it, each one an over-specific
 * "so that means…" that turned out false: the duplicate must be last (it need
 * not be), only one lands (several can), the file shape decides (the account's
 * prior state decides). Whether a positional file is refused depends on what is
 * already in the account, and an account with any history of repeated
 * transactions — an ordinary bank account — supplies those predecessors.
 *
 * What lands cannot be told apart from a legitimate repeat, because the
 * difference is not in the data — it is in whether this function is correct.
 *
 * Which is why it is a pure function with its own paired checks and its own
 * mutation block. See docs/design/06-bank-csv.md §6.
 */
export function withOccurrences(rows: ImportRow[]): NumberedRow[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    const n = (seen.get(key(r)) ?? 0) + 1
    seen.set(key(r), n)
    return { ...r, occurrence: n }
  })
}

const CHUNK = 500

/**
 * Land a file's rows against one account.
 *
 * One transaction. Rows already present are skipped and counted; anything else
 * that goes wrong takes the whole file with it. Half an imported statement is
 * worse than none, because nobody can tell afterwards which half arrived.
 */
export async function importBankRows(input: {
  accountId: string
  rows: ImportRow[]
  sourceFile?: string
  actor?: string
}): Promise<ImportResult> {
  const actor = input.actor ?? 'system'

  if (input.rows.length === 0) {
    throw new BankError('EMPTY', 'That file has no rows to import.')
  }
  if (input.rows.length > MAX_IMPORT_ROWS) {
    throw new BankError('TOO_MANY',
      `That file has ${input.rows.length} rows and the limit for one import is ${MAX_IMPORT_ROWS}. `
      + `Split it by date range and import the parts.`)
  }

  const numbered = withOccurrences(input.rows)
  let inserted = 0

  await db.transaction(async (tx) => {
    await acting(tx, actor)
    await lockBankAccount(tx, input.accountId)
    const [acct] = await tx.execute<{ id: string }>(sql`
      SELECT id::text FROM account WHERE id = ${input.accountId}::uuid`)
    if (!acct) throw new BankError('NO_ACCOUNT', 'That account does not exist.')

    for (let i = 0; i < numbered.length; i += CHUNK) {
      const batch = numbered.slice(i, i + CHUNK)
      const values = sql.join(
        batch.map((r) => sql`(${input.accountId}::uuid, ${r.date}::date, ${r.amount}::bigint,
                              ${r.description}, ${r.occurrence}::smallint,
                              ${input.sourceFile ?? null}, ${actor})`),
        sql`, `)

      const landed = await tx.execute<{ id: string }>(sql`
        INSERT INTO bank_transaction
          (account_id, txn_date, amount, description, occurrence, source_file, imported_by)
        VALUES ${values}
        ON CONFLICT (account_id, txn_date, amount, description, occurrence) DO NOTHING
        RETURNING id::text`)
      inserted += landed.length
    }

    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
      VALUES (${actor}, 'import_bank_rows', 'bank_transaction', ${input.accountId},
              ${JSON.stringify({
                total: numbered.length,
                inserted,
                duplicates: numbered.length - inserted,
              })}::jsonb,
              ${JSON.stringify({ source_file: input.sourceFile ?? null })}::jsonb)`)
  })

  return { total: numbered.length, inserted, duplicates: numbered.length - inserted }
}

// ------------------------------------------------------------------ queries --

/**
 * How far a bank row has been dealt with. THE VALUE FIRST, the type from it:
 * the assistant offers these to the model and has to have them at run time, and
 * a union type alone cannot be listed (owner, 2026-09-16: 「尽量不要用硬编码」).
 */
export const BANK_ROW_STATES = ['unmatched', 'part', 'matched', 'ignored'] as const
export type BankRowState = (typeof BANK_ROW_STATES)[number]

export type BankRowRecord = {
  id: string
  txn_date: string
  amount: bigint
  description: string
  occurrence: number
  /** Worked out from the row's matches and its ignore decision. Never stored. */
  state: BankRowState
  matched_amount: bigint
  unmatched_amount: bigint
  ignored_reason: string | null
  source_file: string | null
  imported_at: string
}

/**
 * Rows with their state, read from `bank_row_state`.
 *
 * The state is not a column. It is what the row's matches add up to, plus
 * whether someone decided to ignore it, and both of those are recorded
 * elsewhere — so there is nothing here that can disagree with them.
 */
export async function bankRows(accountId: string, opts: { state?: BankRowState; after?: string; through?: string } = {}) {
  return db.execute<BankRowRecord>(sql`
    SELECT id::text, txn_date::text, amount, description, occurrence, state,
           matched_amount, unmatched_amount, ignored_reason,
           source_file, imported_at::text
      FROM bank_row_state
     WHERE account_id = ${accountId}::uuid
       ${opts.state ? sql`AND state = ${opts.state}` : sql``}
       ${opts.after ? sql`AND txn_date > ${opts.after}::date` : sql``}
       ${opts.through ? sql`AND txn_date <= ${opts.through}::date` : sql``}
     ORDER BY txn_date, id`)
}

/** What one account's landed statement adds up to, for comparing with the books. */
export async function bankTotals(accountId: string) {
  const [row] = await db.execute<{
    rows: string; unmatched: string; net: bigint | null; outstanding: bigint | null
  }>(sql`
    SELECT count(*)::text AS rows,
           count(*) FILTER (WHERE state IN ('unmatched', 'part'))::text AS unmatched,
           -- sum(bigint) is numeric in Postgres, which comes back a string. Cast
           -- it, or the total silently stops being money.
           coalesce(sum(amount), 0)::bigint AS net,
           coalesce(sum(unmatched_amount) FILTER (WHERE state <> 'ignored'), 0)::bigint AS outstanding
      FROM bank_row_state
     WHERE account_id = ${accountId}::uuid`)
  return {
    rows: Number(row?.rows ?? 0),
    unmatched: Number(row?.unmatched ?? 0),
    net: row?.net ?? 0n,
    /** What the statement says that the books have not accounted for yet. */
    outstanding: row?.outstanding ?? 0n,
  }
}

/** Postable, active accounts a statement could belong to. */
export async function importableAccounts(entityId: string) {
  return db.execute<{ id: string; code: string; name: string; account_type: string; landed: string; currency: string }>(sql`
    SELECT a.id::text, a.code, a.name, a.account_type::text, COALESCE(a.foreign_currency,'CAD') AS currency,
           (SELECT count(*) FROM bank_transaction b WHERE b.account_id = a.id)::text AS landed
      FROM account a
     WHERE a.entity_id = ${entityId}::uuid AND a.is_postable AND a.is_active
     ORDER BY a.code`)
}

/**
 * Does this account belong to the company whose books this ledger is?
 *
 * The row itself carries no ledger — an account belongs to an entity, and that
 * is deliberately the only answer to which books a statement belongs to. But
 * the form arrives with both, and nothing had ever checked that they agree: the
 * dropdown is built from one company's accounts, and the value posted back is
 * just a string.
 */
export async function accountInLedger(accountId: string, ledgerId: string): Promise<boolean> {
  const rows = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok
      FROM account a
      JOIN ledger l ON l.entity_id = a.entity_id
     WHERE a.id = ${accountId}::uuid AND l.id = ${ledgerId}::uuid`)
  return rows.length > 0
}

/**
 * Does this thing belong to the company whose books this ledger is?
 *
 * Every form on both bank doors carries the ledger it was posted from, and
 * `requireLedger` judges THAT. The ids beside it — a row, a match, a
 * statement, an account — were judged by nothing: a person with the Bank seat
 * on company A could post company B's statement id with A's ledger id and
 * finish B's reconciliation (critic, 2026-09-04). The same hole existed for
 * match, unmatch, ignore, post and the statement forms before this node and
 * this node added three more, so it is closed as a class here: one function,
 * every handler calls it, and `RC37`-`RC45` post the wrong company's id at each.
 *
 * `accountInLedger` is the account case, kept as the older name.
 */
export async function belongsToLedger(
  kind: 'row' | 'match' | 'statement' | 'account' | 'party', id: string, ledgerId: string,
): Promise<boolean> {
  if (!/^[0-9a-fA-F-]{36}$/.test(id) || !/^[0-9a-fA-F-]{36}$/.test(ledgerId)) return false
  const rows = await db.execute<{ ok: number }>(
    kind === 'account' ? sql`
      SELECT 1 AS ok FROM account a JOIN ledger l ON l.entity_id = a.entity_id
       WHERE a.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`
    : kind === 'row' ? sql`
      SELECT 1 AS ok FROM bank_transaction b
        JOIN account a ON a.id = b.account_id JOIN ledger l ON l.entity_id = a.entity_id
       WHERE b.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`
    : kind === 'match' ? sql`
      SELECT 1 AS ok FROM bank_match m JOIN bank_transaction b ON b.id = m.bank_transaction_id
        JOIN account a ON a.id = b.account_id JOIN ledger l ON l.entity_id = a.entity_id
       WHERE m.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`
    : kind === 'party' ? sql`
      SELECT 1 AS ok FROM party_role pr JOIN ledger l ON l.entity_id = pr.entity_id
       WHERE pr.party_id = ${id}::uuid AND l.id = ${ledgerId}::uuid`
    : sql`
      SELECT 1 AS ok FROM bank_statement st
        JOIN account a ON a.id = st.account_id JOIN ledger l ON l.entity_id = a.entity_id
       WHERE st.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`)
  return rows.length > 0
}

/**
 * Setting a row aside, with a reason.
 *
 * Same shape as closing a period over a blocker: the system does not need the
 * reason, the person reading the books in a year does. "Ignored" with nothing
 * beside it is indistinguishable from "forgotten".
 */
export async function ignoreBankRow(id: string, reason: string, actor = 'system') {
  const text = reason.trim()
  if (text.length < 3) {
    throw new BankError('NO_REASON', 'Say why this row is being set aside.')
  }
  await actingAs(actor, async (tx) => {
    await lockBankAccount(tx, await accountOfRow(tx, id))
    await tx.execute(sql`
      UPDATE bank_transaction
         SET ignored_at = now(), ignored_by = ${actor}, ignored_reason = ${text}
       WHERE id = ${id}::uuid`)
  })
}

/**
 * Delete a row imported by mistake — into the wrong account, or a file
 * imported twice (0084). 0017 named this as the fix ("remove it and import
 * again") and no door did it. A row that settles an entry, one set aside on
 * purpose, and one inside a finished reconciliation stay: the database refuses
 * all three (0020, 0056), and the sentences say what to undo first. The audit
 * log keeps the row's date, amount and description (0017).
 */
export async function deleteBankRow(id: string, actor = 'system') {
  await actingAs(actor, async (tx) => {
    await lockBankAccount(tx, await accountOfRow(tx, id))
    const [row] = await tx.execute<{ matched: boolean; ignored: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM bank_match m WHERE m.bank_transaction_id = b.id) AS matched,
             b.ignored_at IS NOT NULL AS ignored
        FROM bank_transaction b WHERE b.id = ${id}::uuid`)
    if (row?.matched) throw new BankError('ROW_MATCHED', 'That row settles an entry. Undo the match first.')
    if (row?.ignored) throw new BankError('ROW_IGNORED', 'That row was set aside on purpose. Put it back first.')
    await tx.execute(sql`DELETE FROM bank_transaction WHERE id = ${id}::uuid`)
  })
}

/**
 * The account a row, a match or a statement belongs to — read INSIDE the
 * transaction that is about to lock it, so the lock is taken before the
 * write and before any trigger the write fires. Taking it after would let
 * the freeze trigger (0055) judge the row against a statement Finish has not
 * yet committed, and then let both commit.
 */
async function accountOfRow(tx: Tx, rowId: string): Promise<string> {
  const [r] = await tx.execute<{ account_id: string }>(sql`
    SELECT account_id::text FROM bank_transaction WHERE id = ${rowId}::uuid`)
  if (!r) throw new BankError('NO_ROW', 'That bank row does not exist.')
  return r.account_id
}
async function accountOfMatch(tx: Tx, matchId: string): Promise<string> {
  const [r] = await tx.execute<{ account_id: string }>(sql`
    SELECT b.account_id::text FROM bank_match m
      JOIN bank_transaction b ON b.id = m.bank_transaction_id
     WHERE m.id = ${matchId}::uuid`)
  if (!r) throw new BankError('NO_MATCH', 'That match does not exist.')
  return r.account_id
}
async function accountOfStatement(tx: Tx, statementId: string): Promise<string> {
  const [r] = await tx.execute<{ account_id: string }>(sql`
    SELECT account_id::text FROM bank_statement WHERE id = ${statementId}::uuid`)
  if (!r) throw new BankError('NO_STATEMENT', 'That statement is not on file.')
  return r.account_id
}

/**
 * Putting a row back in play.
 *
 * The three ignore columns are all-or-nothing by CHECK constraint, so there is
 * nowhere on the row to carry who undid it — the first version of this tried
 * to set `ignored_by` while clearing `ignored_at` and the constraint refused
 * it, correctly. The audit row is the trigger's, and until 0060 it could only
 * name the database role, so this took no actor at all rather than accept one
 * and drop it. Now the transaction says who is acting and the trigger's row
 * carries that name (RISKS §10, closed).
 */
export async function unignoreBankRow(id: string, actor = 'system') {
  await actingAs(actor, async (tx) => {
    await lockBankAccount(tx, await accountOfRow(tx, id))
    await tx.execute(sql`
      UPDATE bank_transaction
         SET ignored_at = NULL, ignored_by = NULL, ignored_reason = NULL
       WHERE id = ${id}::uuid`)
  })
}

// ----------------------------------------------------------------- matching --

export type MatchRecord = {
  id: string
  entry_id: string
  entry_no: string | null
  entry_date: string
  entry_description: string
  /** Where the entry came from — 'bank', 'payroll', an invoice… or null for a typed journal. */
  source_type: string | null
  amount: bigint
  matched_by: string
  matched_at: string
}

export async function matchesFor(bankTransactionId: string) {
  return db.execute<MatchRecord>(sql`
    SELECT m.id::text, m.entry_id::text, e.entry_no, e.entry_date::text,
           e.description AS entry_description, e.source_type, m.amount, m.matched_by, m.matched_at::text
      FROM bank_match m JOIN journal_entry e ON e.id = m.entry_id
     WHERE m.bank_transaction_id = ${bankTransactionId}::uuid
     ORDER BY e.entry_date, e.entry_no`)
}

/** One read for all displayed rows; each row keeps the single-row ordering. */
async function matchesForRows(ids: string[]) {
  const out = new Map<string, MatchRecord[]>()
  if (!ids.length) return out
  const records = await db.execute<MatchRecord & { bank_transaction_id: string }>(sql`
    SELECT m.bank_transaction_id::text, m.id::text, m.entry_id::text,
           e.entry_no, e.entry_date::text, e.description AS entry_description,
           e.source_type, m.amount, m.matched_by, m.matched_at::text
      FROM bank_match m JOIN journal_entry e ON e.id = m.entry_id
     WHERE m.bank_transaction_id = ANY(string_to_array(${ids.join(',')}, ',')::uuid[])
     ORDER BY m.bank_transaction_id, e.entry_date, e.entry_no`)
  for (const { bank_transaction_id: id, ...record } of records) {
    const group = out.get(id) ?? []
    group.push(record); out.set(id, group)
  }
  return out
}

/**
 * How much of this row is still unaccounted for, and how much room this entry
 * has left on this account.
 *
 * Both are needed before a match can be sized, and both are the sums the
 * database will check again at COMMIT. Working them out here is for choosing a
 * sensible default and for saying something readable when it does not fit —
 * not for deciding whether it is allowed.
 */
async function roomFor(tx: Tx, bankTransactionId: string, entryId: string) {
  const [r] = await tx.execute<{
    row_amount: bigint; row_matched: bigint; on_account: bigint | null; entry_matched: bigint
  }>(sql`
    WITH b AS (SELECT * FROM bank_transaction WHERE id = ${bankTransactionId}::uuid)
    SELECT b.amount AS row_amount,
           coalesce((SELECT sum(amount) FROM bank_match WHERE bank_transaction_id = b.id), 0)::bigint
             AS row_matched,
           -- Cast: sum(bigint) is numeric in Postgres and comes back a string,
           -- and a string in this arithmetic throws "cannot mix BigInt" three
           -- calls away from here.
           (SELECT sum(COALESCE(jl.original_amount,jl.amount))::bigint FROM journal_line jl
             WHERE jl.entry_id = ${entryId}::uuid AND jl.account_id = b.account_id) AS on_account,
           coalesce((SELECT sum(m.amount) FROM bank_match m
                       JOIN bank_transaction bb ON bb.id = m.bank_transaction_id
                      WHERE m.entry_id = ${entryId}::uuid AND bb.account_id = b.account_id), 0)::bigint
             AS entry_matched
      FROM b`)
  if (!r) throw new BankError('NO_ROW', 'That bank row does not exist.')
  if (r.on_account === null) {
    throw new BankError('ENTRY_NOT_ON_ACCOUNT',
      'That entry has no line on the account this statement is for.')
  }
  return {
    rowLeft: r.row_amount - r.row_matched,
    entryLeft: r.on_account - r.entry_matched,
  }
}

const smallerOf = (a: bigint, b: bigint) => (a < 0n ? (a > b ? a : b) : (a < b ? a : b))

/**
 * Say that this entry accounts for this much of this bank row.
 *
 * With no amount, as much as both sides have room for — which is the whole row
 * in the ordinary case and the remainder when a deposit is being split across
 * several invoices.
 */
export async function matchEntry(input: {
  bankTransactionId: string
  entryId: string
  amount?: bigint
  actor?: string
}) {
  await actingAs(input.actor ?? 'system', async (tx) => {
    // The lock first, then the room: a Finish holding the lock may be about to
    // freeze this row, and the room must be judged after it has.
    await lockBankAccount(tx, await accountOfRow(tx, input.bankTransactionId))
    const { rowLeft, entryLeft } = await roomFor(tx, input.bankTransactionId, input.entryId)

    if (rowLeft === 0n) {
      throw new BankError('ROW_FULL', 'That row is already fully accounted for.')
    }
    if (entryLeft === 0n) {
      throw new BankError('ENTRY_FULL', 'That entry is already fully claimed by other rows.')
    }

    const amount = input.amount ?? smallerOf(rowLeft, entryLeft)
    if (amount === 0n) throw new BankError('ZERO_MATCH', 'A match of nothing is not a match.')

    await tx.execute(sql`
      INSERT INTO bank_match (bank_transaction_id, entry_id, amount, matched_by)
      VALUES (${input.bankTransactionId}::uuid, ${input.entryId}::uuid, ${amount}::bigint,
              ${input.actor ?? 'system'})`)
  })
}

export async function unmatch(matchId: string, actor = 'system') {
  await actingAs(actor, async (tx) => {
    await lockBankAccount(tx, await accountOfMatch(tx, matchId))
    await tx.execute(sql`DELETE FROM bank_match WHERE id = ${matchId}::uuid`)
  })
}

export type Candidate = {
  entry_id: string
  entry_no: string | null
  entry_date: string
  description: string
  on_account: bigint
  already_matched: bigint
  room: bigint
  /** Days between the entry and the bank row. Nearer is likelier. */
  day_gap: number
}

/**
 * Entries this row could plausibly settle.
 *
 * Posted, on the same account, moving it the same way, with room left. Exact
 * remainders first, then nearest in time — a suggestion, never an answer: what
 * makes a match right is a person recognising it, and the arithmetic only stops
 * the ones that cannot be right.
 */
export async function candidateEntries(bankTransactionId: string, limit = 20) {
  return db.execute<Candidate>(sql`
    WITH b AS (SELECT * FROM bank_transaction WHERE id = ${bankTransactionId}::uuid),
    room AS (
      SELECT e.id, e.entry_no, e.entry_date, e.description,
             sum(COALESCE(jl.original_amount,jl.amount))::bigint AS on_account,
             coalesce((SELECT sum(m.amount) FROM bank_match m
                         JOIN bank_transaction bb ON bb.id = m.bank_transaction_id
                        WHERE m.entry_id = e.id AND bb.account_id = b.account_id), 0)::bigint
               AS already_matched
        FROM b
        JOIN journal_line jl ON jl.account_id = b.account_id
        -- Not the opening balance: its cash line is where the account started,
        -- not something that moved. Offered as a candidate it will happily
        -- "settle" any deposit up to the whole opening position.
        JOIN journal_entry e ON e.id = jl.entry_id AND e.status = 'posted'
                            AND NOT ${IS_OPENING}  -- not a candidate
                            -- Nor the reversal half of a correction pair. It
                            -- moves the account the opposite way from the
                            -- entry it cancels, so it reads as a deposit for
                            -- every payment ever corrected, and the owner's
                            -- feed offered one against real income
                            -- (2026-09-07). The reversed original is already
                            -- out, on its status. Neither half is money that
                            -- moved at the bank; a bank row that really did
                            -- come back is Added as its own entry.
                            AND e.reverses_id IS NULL
       GROUP BY e.id, e.entry_no, e.entry_date, e.description, b.account_id
    )
    SELECT r.id::text AS entry_id, r.entry_no, r.entry_date::text, r.description,
           r.on_account, r.already_matched,
           (r.on_account - r.already_matched)::bigint AS room,
           abs(r.entry_date - b.txn_date)::int AS day_gap
      FROM room r, b
     WHERE sign(r.on_account) = sign(b.amount)
       AND abs(r.on_account - r.already_matched) > 0
       AND NOT EXISTS (SELECT 1 FROM bank_match m
                        WHERE m.entry_id = r.id AND m.bank_transaction_id = b.id)
     ORDER BY (r.on_account - r.already_matched) = (b.amount - coalesce(
                (SELECT sum(amount) FROM bank_match WHERE bank_transaction_id = b.id), 0)) DESC,
              abs(r.entry_date - b.txn_date),
              r.entry_date
     LIMIT ${limit}`)
}

/** Aggregate the account once, then rank and limit independently for each row. */
async function candidatesForRows(accountId: string, ids: string[], limit: number) {
  const out = new Map<string, Candidate[]>()
  if (!ids.length) return out
  const records = await db.execute<Candidate & { bank_transaction_id: string }>(sql`
    WITH b AS MATERIALIZED (
      SELECT id, txn_date, amount FROM bank_transaction
       WHERE account_id = ${accountId}::uuid
         AND id = ANY(string_to_array(${ids.join(',')}, ',')::uuid[])
    ), entry_matches AS (
      SELECT m.entry_id, sum(m.amount)::bigint AS amount
        FROM bank_match m JOIN bank_transaction bb ON bb.id = m.bank_transaction_id
       WHERE bb.account_id = ${accountId}::uuid GROUP BY m.entry_id
    ), room AS MATERIALIZED (
      SELECT e.id, e.entry_no, e.entry_date, e.description,
             sum(COALESCE(jl.original_amount,jl.amount))::bigint AS on_account,
             coalesce(em.amount, 0)::bigint AS already_matched
        FROM journal_line jl
        JOIN journal_entry e ON e.id = jl.entry_id AND e.status = 'posted'
          AND NOT ${IS_OPENING} AND e.reverses_id IS NULL
        LEFT JOIN entry_matches em ON em.entry_id = e.id
       WHERE jl.account_id = ${accountId}::uuid
       GROUP BY e.id, em.amount
    ), row_totals AS (
      SELECT m.bank_transaction_id, sum(m.amount)::bigint AS amount,
             array_agg(m.entry_id) AS entry_ids
        FROM bank_match m JOIN b ON b.id = m.bank_transaction_id
       GROUP BY m.bank_transaction_id
    )
    SELECT b.id::text AS bank_transaction_id, c.entry_id, c.entry_no,
           c.entry_date::text, c.description, c.on_account, c.already_matched, c.room, c.day_gap
      FROM b LEFT JOIN row_totals bt ON bt.bank_transaction_id = b.id
      CROSS JOIN LATERAL (
        SELECT r.id::text AS entry_id, r.entry_no, r.entry_date, r.description,
               r.on_account, r.already_matched,
               (r.on_account - r.already_matched)::bigint AS room,
               abs(r.entry_date - b.txn_date)::int AS day_gap,
               (r.on_account - r.already_matched) = (b.amount - coalesce(bt.amount, 0)) AS exact
          FROM room r
         WHERE sign(b.amount) = sign(r.on_account)
           AND abs(r.on_account - r.already_matched) > 0
           AND NOT (r.id = ANY(coalesce(bt.entry_ids, '{}'::uuid[])))
         ORDER BY exact DESC, day_gap, r.entry_date
         LIMIT ${limit}
      ) c
     ORDER BY b.id, c.exact DESC, c.day_gap, c.entry_date`)
  for (const { bank_transaction_id: id, ...candidate } of records) {
    const group = out.get(id) ?? []
    group.push(candidate); out.set(id, group)
  }
  return out
}

// ------------------------------------------------------- entry from a row --

/**
 * Post an entry for a bank row and record the match, in one transaction.
 *
 * `postEntryCore` is THE way into the ledger — the same function a typed
 * journal, a reversal and a year-end close go through — so an entry made from a
 * statement is subject to every rule the others are: it balances, it lands in an
 * open period, it takes the next number with no gap. There is no second path,
 * and this is deliberately not one.
 *
 * The match is written in the same transaction. An entry without its match would
 * be money in the books that the reconciliation cannot see, which is worse than
 * neither.
 */
export async function postFromBankRow(input: {
  bankTransactionId: string
  rate?: FxSnapshot
  contraAccountId: string
  /** Positive gross allocations. One bank line and match settle all of them. */
  splits?: BankSplit[]
  /** Business wording for the entry and item; defaults to the selected account's name. */
  description?: string
  /**
   * Who it was with. The supplier or customer goes on the OTHER side's line,
   * not on the bank's: the bank line says which account moved, and 0025
   * refuses a party with no transacting role at this date either way. The
   * owner asked for it because an expense posted from the feed was the one
   * kind of expense with nobody's name on it (2026-09-07).
   */
  partyId?: string
  /**
   * The tax the row's amount already includes. The bank moved what the bank
   * moved, so the tag splits the other side inclusive rather than adding on
   * top of it — `splitTaggedLine` is the one place that arithmetic lives.
   */
  taxCode?: string
  actor?: string
}) {
  const actor = input.actor ?? 'system'

  const [row] = await db.execute<{
    id: string; account_id: string; txn_date: string; amount: bigint
    description: string; ignored_at: string | null; ledger_id: string; foreign_currency: string | null
  }>(sql`
    SELECT b.id::text, b.account_id::text, b.txn_date::text, b.amount, b.description,
           b.ignored_at::text, l.id::text AS ledger_id,a.foreign_currency
      FROM bank_transaction b
      JOIN account a ON a.id = b.account_id
      JOIN ledger l ON l.entity_id = a.entity_id
     WHERE b.id = ${input.bankTransactionId}::uuid`)

  if (!row) throw new BankError('NO_ROW', 'That bank row does not exist.')
  if (row.ignored_at) {
    throw new BankError('ROW_IGNORED', 'That row was set aside. Un-ignore it before posting from it.')
  }
  if (!input.splits && row.account_id === input.contraAccountId) {
    throw new BankError('SAME_ACCOUNT',
      'The other side of the entry cannot be the bank account itself — that entry would say nothing.')
  }

  const [already] = await db.execute<{ matched: bigint }>(sql`
    SELECT coalesce(sum(amount), 0)::bigint AS matched
      FROM bank_match WHERE bank_transaction_id = ${input.bankTransactionId}::uuid`)
  const left = row.amount - (already?.matched ?? 0n)
  if (left === 0n) throw new BankError('ROW_FULL', 'That row is already fully accounted for.')

  if (input.splits) {
    const problem = bankSplitProblem(input.splits, left, row.account_id)
    if (problem) throw new BankError('BAD_SPLIT', problem)
  }
  // Canonical order makes an unchanged allocation replay even after row reordering.
  const allocations = input.splits
    ? [...input.splits].sort((a, b) => a.accountId.localeCompare(b.accountId))
    : [{ accountId: input.contraAccountId, amount: left < 0n ? -left : left }]
  const lines: Parameters<typeof postEntryCore>[1]['lines'] = []
  const names: string[] = []
  for (const part of allocations) {
    const [contra] = await db.execute<{ name: string }>(sql`
      SELECT a.name FROM account a JOIN ledger l ON l.entity_id = a.entity_id
       WHERE a.id = ${part.accountId}::uuid AND l.id = ${row.ledger_id}::uuid`)
    if (!contra) throw new BankError('FOREIGN_ACCOUNT', 'Choose accounts from this company.')
    names.push(contra.name)
    const split = await splitTaggedLine(row.ledger_id, part.accountId,
      left < 0n ? part.amount : -part.amount, input.taxCode ?? '', row.txn_date)
    lines.push({ accountId: part.accountId, amount: split.amount,
      description: input.description?.trim() || contra.name, partyId: input.partyId || undefined }, ...split.taxLines)
  }
  const description = input.description?.trim() || names.join(' / ') || 'Bank transaction'
  const wordingKey = createHash('sha256').update(description).digest('hex')
  const categories = input.splits
    ? 'split:' + allocations.map((p) => `${p.accountId}=${p.amount}`).join(',')
    : input.contraAccountId
  const shape = [categories, input.taxCode ?? '', input.partyId ?? '', wordingKey].join(':')
  const replayKey = `bank:${row.id}:${left}:${shape}`

  return db.transaction(async (tx) => {
    await acting(tx, input.actor ?? 'system')
    if (row.foreign_currency) {
      await lockFxLedger(tx,row.ledger_id)
      await assertCurrencyOpen(tx,row.ledger_id,row.foreign_currency)
      await assertNoLaterFx(tx,row.ledger_id,row.txn_date,[],[row.account_id])
    }
    await lockBankAccount(tx, row.account_id)
    let postedLines = [{ accountId: row.account_id, amount: left },...lines] as Parameters<typeof postEntryCore>[1]['lines']
    if (row.foreign_currency) {
      const quote=await fxRateFor(row.foreign_currency,row.txn_date,tx,input.rate)
      const {cashMovement,fxDifference}=await import('./fx-accounting')
      const cash=await cashMovement(tx,row.ledger_id,row.account_id,row.foreign_currency,left,row.txn_date,quote)
      postedLines=[...(cash?[cash]:[]),...lines.map(l=>({...l,originalCurrency:row.foreign_currency!,originalAmount:l.amount,
        amount:toFunctional(l.amount,row.foreign_currency!,quote.rate),fxSnapshot:quote}))]
      postedLines.push(...await fxDifference(tx,row.ledger_id,-postedLines.reduce((sum,l)=>sum+l.amount,0n)))
    }
    const posted = await postEntryCore(tx, {
      ledgerId: row.ledger_id,
      entryDate: row.txn_date,
      description,
      sourceType: 'bank',
      sourceId: row.id,
      // Replayable per remainder, not per row. Keyed on the row alone, a row
      // could only ever carry one generated entry: post part of it, unmatch
      // something else, and the second post silently replayed the first entry
      // while the screen said the row was now settled.
      idempotencyKey: replayKey,
      actor,
      lines: postedLines,
    })

    // `replayed` means the idempotency key found an entry already posted from
    // this row. Saying so matters: the caller is about to tell someone their
    // entry was created, and it was created earlier.
    const entry = posted.entry

    await tx.execute(sql`
      INSERT INTO bank_match (bank_transaction_id, entry_id, amount, matched_by)
      VALUES (${row.id}::uuid, ${entry.id}::uuid, ${left}::bigint, ${actor})
      ON CONFLICT (bank_transaction_id, entry_id) DO NOTHING`)

    return { entryId: entry.id, entryNo: entry.entryNo, replayed: posted.replayed === true }
  })
}

// ------------------------------------------------------------ reconciling --

/**
 * What counts as being in the books.
 *
 * A reversed entry keeps its lines and the reversal's mirror lines cancel them,
 * so both belong in a balance and dropping either is wrong by twice the amount.
 * Named once because `reconciliation` got it wrong on its own and printed a
 * figure that disagreed with the same account's history page —
 * `accounts.ts`, `reports.ts`, `statements.ts`, `tax.ts` and `periods.ts` all
 * say the same thing in their own words, and this is the sixth.
 *
 * A fragment rather than a list: both places alias the entry table `e`, and a
 * JS array reaches Postgres as a record rather than an array.
 */
const IN_THE_BOOKS = sql`e.status IN ('posted', 'reversed')`

/** An opening balance is a position, not something that moved. */
const IS_OPENING = sql`e.source_type = 'opening_balance'`

export type Reconciliation = {
  currency?: string
  asOf: string
  /** What the statement says moved through the account up to that day. */
  statement: bigint
  /** What the books say, on posted entries up to that day. */
  books: bigint
  difference: bigint
  /** Statement rows nothing in the books accounts for. */
  statementUnaccounted: bigint
  /** Movement in the books no statement row claims. */
  booksUnclaimed: bigint
  /** Matches whose row and entry fall on opposite sides of the day. */
  straddling: bigint
  /** `booksUnclaimed` again, worked out per entry. They must agree. */
  unclaimedPerEntry: bigint
  /**
   * How much of `books` is the opening balance — where the account started.
   *
   * It is inside `booksUnclaimed` because no statement row claims it and none
   * ever will: the statement records what moved, and this is the position it
   * started from. Named separately so it is not read as an unexplained gap on a
   * screen whose whole job is explaining the gap.
   */
  openingPosition: bigint
}

/**
 * The difference between the statement and the books, and what makes it up.
 *
 * The three explanations add up to the difference exactly:
 *
 *   difference = statementUnaccounted − booksUnclaimed + straddling
 *
 * That identity is arithmetic, not evidence. Substitute the definitions and the
 * matched totals cancel, so it holds for every possible input — including inputs
 * where both sums are wrong. A check that asserts only the identity proves the
 * subtraction, which was never in doubt. `unclaimedPerEntry` is the one that
 * can fail: the same figure as `booksUnclaimed`, computed per entry instead of
 * as two totals, so a wrong total on either side shows up as a disagreement.
 *
 * `straddling` is the term most reconciliations leave out and then explain away
 * by hand: a cheque written on the 30th and cleared on the 2nd is matched, and
 * it belongs to a different side of the line on each side. It is a timing
 * difference, it is normal, and giving it a name is what stops the other two
 * numbers from having to absorb it.
 */
export type StatementRecord = {
  id: string; statement_date: string; ending_balance: bigint; created_by: string
  /** The Finish decision (0055), or null while the statement is open. */
  reconciled_at: string | null; reconciled_by: string | null
}

/** The bank's assertions on file for this account, newest first. */
export async function statementsFor(accountId: string): Promise<StatementRecord[]> {
  const rows = await db.execute<{
    id: string; statement_date: string; ending_balance: string; created_by: string
    reconciled_at: string | null; reconciled_by: string | null
  }>(sql`
    SELECT id::text, statement_date::text, ending_balance::text, created_by,
           reconciled_at::text, reconciled_by
      FROM bank_statement WHERE account_id = ${accountId}::uuid
     ORDER BY statement_date DESC`)
  return rows.map((r) => ({ ...r, ending_balance: BigInt(r.ending_balance) }))
}

export async function saveStatement(input: {
  accountId: string; statementDate: string; endingBalance: bigint; actor?: string
}) {
  try {
    return await actingAs(input.actor ?? 'system', async (tx) => {
      await lockBankAccount(tx, input.accountId)
      const [saved] = await tx.execute<{ id: string }>(sql`
        INSERT INTO bank_statement (account_id, statement_date, ending_balance, created_by)
        VALUES (${input.accountId}::uuid, ${input.statementDate}::date,
                ${input.endingBalance}, ${input.actor ?? 'system'}) RETURNING id::text`)
      return saved
    })
  } catch (e) {
    const msg = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e)
    if (msg.includes('bank_statement_account_id_statement_date_key')) {
      throw new BankError('STATEMENT_EXISTS',
        'A statement for that date is already on file. Delete it first if the figure was typed wrong.')
    }
    throw e
  }
}

export async function deleteStatement(id: string, actor = 'system') {
  await actingAs(actor, async (tx) => {
    await lockBankAccount(tx, await accountOfStatement(tx, id))
    const [paper] = await tx.execute(sql`SELECT id FROM bank_statement_attachment WHERE statement_id = ${id}::uuid LIMIT 1`)
    if (paper) throw new BankError('STATEMENT_HAS_FILES', 'Remove the statement files before deleting the statement.')
    await tx.execute(sql`DELETE FROM bank_statement WHERE id = ${id}::uuid`)
  })
}

export type StatementReport = {
  currency?: string
  statementDate: string
  endingBalance: bigint
  /** The previous assertion this one continues from, or the account's dawn. */
  beginningDate: string | null
  beginningBalance: bigint
  /** Sum of imported rows in (beginningDate, statementDate]. */
  rowsInPeriod: bigint
  rowCount: number
  /** beginning + rows — what the imported rows say the ending should be. */
  impliedEnding: bigint
  /**
   * endingBalance − impliedEnding. Nonzero means rows are MISSING from the
   * import or imported twice — the one error no row-by-row match can see,
   * and the whole reason the statement's own figure is asked for.
   */
  importGap: bigint
  /** The book-side identity for the same date, the existing three terms. */
  recon: Reconciliation
  /** Rows in the period still unmatched or partly matched — the work left. */
  openRows: BankRowRecord[]
}

/**
 * The reconciliation report — the QuickBooks shape, derived: only the
 * bank's assertions are stored; every other line comes from rows and books
 * at render time and cannot go stale.
 */
export async function statementReport(accountId: string, statementDate: string): Promise<StatementReport | null> {
  const statements = await statementsFor(accountId)
  const current = statements.find((st) => st.statement_date === statementDate)
  if (!current) return null
  const prior = statements.find((st) => st.statement_date < statementDate)

  const [sums] = await db.execute<{ total: string; n: string }>(sql`
    SELECT COALESCE(SUM(amount), 0)::text AS total, count(*)::text AS n
      FROM bank_transaction
     WHERE account_id = ${accountId}::uuid
       AND txn_date <= ${statementDate}::date
       AND (${prior?.statement_date ?? null}::date IS NULL OR txn_date > ${prior?.statement_date ?? null}::date)`)

  const beginningBalance = prior?.ending_balance ?? 0n
  const rowsInPeriod = BigInt(sums.total)
  const impliedEnding = beginningBalance + rowsInPeriod

  const all = await bankRows(accountId)
  const openRows = all.filter((r) =>
    (r.state === 'unmatched' || r.state === 'part')
    && r.txn_date <= statementDate
    && (!prior || r.txn_date > prior.statement_date))

  return {
    statementDate,
    endingBalance: current.ending_balance,
    beginningDate: prior?.statement_date ?? null,
    beginningBalance,
    rowsInPeriod,
    rowCount: Number(sums.n),
    impliedEnding,
    importGap: current.ending_balance - impliedEnding,
    recon: await reconciliation(accountId, statementDate),
    currency:(await db.execute<{currency:string}>(sql`SELECT COALESCE(foreign_currency,'CAD') AS currency FROM account WHERE id=${accountId}::uuid`))[0]?.currency??'CAD',
    openRows,
  }
}

export async function reconciliation(accountId: string, asOf: string): Promise<Reconciliation> {
  const [currencyRow]=await db.execute<{currency:string}>(sql`SELECT COALESCE(foreign_currency,'CAD') AS currency FROM account WHERE id=${accountId}::uuid`)
  const [r] = await db.execute<{
    statement: bigint; books: bigint
    matched_rows: bigint; matched_entries: bigint; unclaimed_per_entry: bigint
    opening_position: bigint
  }>(sql`
    SELECT
      coalesce((SELECT sum(amount) FROM bank_transaction
                 WHERE account_id = ${accountId}::uuid AND txn_date <= ${asOf}::date), 0)::bigint
        AS statement,
      -- 'posted','reversed', the same as every other balance in the system
      -- (accounts.ts, reports.ts, statements.ts, tax.ts, periods.ts). A reversed
      -- entry keeps its lines and the reversal's mirror lines cancel them;
      -- dropping the original while keeping the mirror is wrong by twice the
      -- amount, and put a number on this screen that disagreed with the same
      -- account's own history page.
      coalesce((SELECT sum(COALESCE(jl.original_amount,jl.amount)) FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
                 WHERE jl.account_id = ${accountId}::uuid
                   AND ${IN_THE_BOOKS}  -- the balance
                   AND e.entry_date <= ${asOf}::date), 0)::bigint
        AS books,
      coalesce((SELECT sum(m.amount) FROM bank_match m
                  JOIN bank_transaction b ON b.id = m.bank_transaction_id
                 WHERE b.account_id = ${accountId}::uuid AND b.txn_date <= ${asOf}::date), 0)::bigint
        AS matched_rows,
      coalesce((SELECT sum(m.amount) FROM bank_match m
                  JOIN bank_transaction b ON b.id = m.bank_transaction_id
                  JOIN journal_entry e ON e.id = m.entry_id
                 WHERE b.account_id = ${accountId}::uuid AND e.entry_date <= ${asOf}::date), 0)::bigint
        AS matched_entries,
      -- The same figure as books - matched_entries, arrived at a different way:
      -- per entry rather than as two totals. Equal by arithmetic, so a check
      -- comparing them catches a wrong sum on either side — which the identity
      -- below cannot, because it telescopes.
      coalesce((SELECT sum(COALESCE(jl.original_amount,jl.amount)) FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
                 WHERE jl.account_id = ${accountId}::uuid
                   AND ${IS_OPENING}
                   AND ${IN_THE_BOOKS}  -- the opening position
                   AND e.entry_date <= ${asOf}::date), 0)::bigint
        AS opening_position,
      coalesce((SELECT sum(net) FROM (
        SELECT sum(COALESCE(jl.original_amount,jl.amount)) - coalesce((SELECT sum(m.amount) FROM bank_match m
                                            JOIN bank_transaction b ON b.id = m.bank_transaction_id
                                           WHERE m.entry_id = e.id
                                             AND b.account_id = ${accountId}::uuid), 0) AS net
          FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
         WHERE jl.account_id = ${accountId}::uuid
           AND ${IN_THE_BOOKS}  -- the same, per entry
           AND e.entry_date <= ${asOf}::date
         GROUP BY e.id) per_entry), 0)::bigint
        AS unclaimed_per_entry`)

  const statement = r?.statement ?? 0n
  const books = r?.books ?? 0n
  const matchedRows = r?.matched_rows ?? 0n
  const matchedEntries = r?.matched_entries ?? 0n

  return {
    currency:currencyRow?.currency??'CAD',
    asOf,
    statement,
    books,
    difference: statement - books,
    statementUnaccounted: statement - matchedRows,
    booksUnclaimed: books - matchedEntries,
    straddling: matchedRows - matchedEntries,
    unclaimedPerEntry: r?.unclaimed_per_entry ?? 0n,
    openingPosition: r?.opening_position ?? 0n,
  }
}

// ------------------------------------------------------------------- feed --

/**
 * The bank feed, the QuickBooks way: three tabs and a suggestion on every row
 * still waiting (docs/design/19-bank-feed-and-reconcile.md).
 *
 * A suggestion is one of two things, and never an action: an entry whose
 * remaining room is exactly what this row still needs, when there is exactly
 * ONE such entry (QuickBooks: "1 record found"); or, failing that, the account
 * the other side went to the last time a row with this description was posted
 * (QuickBooks: "remembered"). A person confirms it with one click, or opens the
 * row and chooses. Nothing here matches or posts by itself — 07 §5.
 */
export type FeedRow = {
  currency?: string
  row: BankRowRecord
  matches: MatchRecord[]
  /** Only for rows still waiting; empty otherwise. */
  candidates: Candidate[]
  suggestion: Suggestion
}

export type Feed = {
  pending: FeedRow[]
  posted: FeedRow[]
  excluded: FeedRow[]
}

/**
 * What a description looks like once the parts that change every month are
 * gone: case, and every run of digits — card suffixes, reference numbers, the
 * date the bank folds into the text. Written once, in SQL, and used on both
 * sides of the comparison so the two cannot normalise differently.
 */
/**
 * "The same payee", as a statement writes it: lower-cased, with every run of
 * digits removed (a card's last four, a reference, the date the bank shoved
 * into the description) and whitespace collapsed.
 *
 * EXPORTED because the bill reader needs the same question answered
 * (`rememberedAccount` in bill-reading.ts), and its own copy of this
 * expression was not the same: `'\s+'` inside a tagged template cooks to
 * `'s+'`, so Postgres was deleting runs of the letter S rather than
 * collapsing spaces — "Staples" and "Taple" became the same payee, and two
 * suppliers could hand each other their accounts (critic, 2026-09-07). One
 * spelling, in one place, is the fix that stays fixed.
 */
export const SAME_PAYEE = (col: ReturnType<typeof sql>) =>
  sql`btrim(regexp_replace(regexp_replace(lower(${col}), '[0-9]+', '', 'g'), '\\s+', ' ', 'g'))`

/**
 * Where the other side went last time a row like this one was posted from this
 * account. Null when there is no last time.
 */
export async function rememberedContra(accountId: string, description: string) {
  const [r] = await db.execute<{ account_id: string; code: string; name: string }>(sql`
    SELECT a.id::text AS account_id, a.code, a.name
      FROM journal_entry e
      JOIN bank_transaction b ON b.id = e.source_id AND b.account_id = ${accountId}::uuid
      JOIN journal_line jl ON jl.entry_id = e.id AND jl.account_id <> b.account_id
      JOIN account a ON a.id = jl.account_id
     WHERE e.source_type = 'bank'
       AND e.status = 'posted'
       AND ${SAME_PAYEE(sql`b.description`)} = ${SAME_PAYEE(sql`${description}::text`)}
       AND ${SAME_PAYEE(sql`b.description`)} <> ''
     ORDER BY e.posted_at DESC NULLS LAST, e.created_at DESC
     LIMIT 1`)
  return r ?? null
}

async function rememberedForRows(accountId: string, ids: string[]) {
  type Remembered = { account_id: string; code: string; name: string }
  const out = new Map<string, Remembered>()
  if (!ids.length) return out
  const records = await db.execute<Remembered & { bank_transaction_id: string }>(sql`
    WITH requested AS MATERIALIZED (
      SELECT id, ${SAME_PAYEE(sql`description`)} AS payee
        FROM bank_transaction WHERE account_id = ${accountId}::uuid
         AND id = ANY(string_to_array(${ids.join(',')}, ',')::uuid[])
    ), history AS (
      SELECT DISTINCT ON (${SAME_PAYEE(sql`b.description`)})
             ${SAME_PAYEE(sql`b.description`)} AS payee,
             a.id::text AS account_id, a.code, a.name
        FROM journal_entry e
        JOIN bank_transaction b ON b.id = e.source_id AND b.account_id = ${accountId}::uuid
        JOIN journal_line jl ON jl.entry_id = e.id AND jl.account_id <> b.account_id
        JOIN account a ON a.id = jl.account_id
       WHERE e.source_type = 'bank' AND e.status = 'posted'
         AND ${SAME_PAYEE(sql`b.description`)} <> ''
         AND ${SAME_PAYEE(sql`b.description`)} IN (SELECT payee FROM requested)
       ORDER BY ${SAME_PAYEE(sql`b.description`)}, e.posted_at DESC NULLS LAST, e.created_at DESC
    )
    SELECT r.id::text AS bank_transaction_id, h.account_id, h.code, h.name
      FROM requested r JOIN history h ON h.payee = r.payee`)
  for (const { bank_transaction_id: id, ...remembered } of records) out.set(id, remembered)
  return out
}

export async function feed(accountId: string): Promise<Feed> {
  const [currencyRow]=await db.execute<{currency:string}>(sql`SELECT COALESCE(foreign_currency,'CAD') AS currency FROM account WHERE id=${accountId}::uuid`)
  const rows = await bankRows(accountId)
  const openIds = rows.filter(row => row.state === 'unmatched' || row.state === 'part').map(row => row.id)
  const matchesByRow = await matchesForRows(rows.filter(row => row.matched_amount !== 0n).map(row => row.id))
  const candidatesByRow = await candidatesForRows(accountId, openIds, 8)
  const rememberedByRow = await rememberedForRows(accountId, openIds)
  const out: Feed = { pending: [], posted: [], excluded: [] }
  for (const row of rows) {
    const open = row.state === 'unmatched' || row.state === 'part'
    const matches = matchesByRow.get(row.id) ?? []
    const candidates = candidatesByRow.get(row.id) ?? []
    const remembered = rememberedByRow.get(row.id) ?? null
    const view: FeedRow = {
      currency:currencyRow?.currency??'CAD',row, matches, candidates,
      suggestion: open ? suggestionFor(row, candidates, remembered) : { kind: 'none' },
    }
    if (row.state === 'ignored') out.excluded.push(view)
    else if (open) out.pending.push(view)
    else out.posted.push(view)
  }
  // Newest first on the feed, the way a statement is read; oldest first stays
  // for the reconcile lists, which are read against a statement.
  out.pending.reverse(); out.posted.reverse(); out.excluded.reverse()
  return out
}

/**
 * Accept every exact-match suggestion among the rows named, in one go.
 *
 * Only the rows whose suggestion is a match, recomputed here rather than
 * trusted from the form — the screen that offered the suggestion is a minute
 * old, and somebody else may have claimed that entry since. Each match is its
 * own statement; one refusal does not undo the others, and the count says how
 * many actually happened.
 */
export async function acceptMatches(input: { accountId: string; rowIds: string[]; actor: string }) {
  let accepted = 0
  // Why each skipped row was skipped, by reason — so the sentence afterwards
  // can say "no longer exact" only about the rows that were, and name the
  // freeze or a full entry for the ones those refused (critic, 2026-09-04).
  const skipped: Record<string, number> = {}
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1 }
  const rows = await bankRows(input.accountId)
  for (const rowId of input.rowIds) {
    const row = rows.find((r) => r.id === rowId)
    if (!row || !(row.state === 'unmatched' || row.state === 'part')) { skip('not waiting'); continue }
    const s = suggestionFor(row, await candidateEntries(rowId, 8), null)
    if (s.kind !== 'match') { skip('no longer an exact match'); continue }
    try {
      await matchEntry({ bankTransactionId: rowId, entryId: s.entry.entry_id, actor: input.actor })
      accepted += 1
    } catch (e) {
      const code = e instanceof BankError ? e.code
        : /RECONCILED/.test(String((e as Error)?.message) + String((e as { cause?: Error })?.cause?.message)) ? 'RECONCILED'
        : 'refused'
      skip(code === 'RECONCILED' ? 'inside a finished reconciliation' : code.toLowerCase().replace(/_/g, ' '))
    }
  }
  return { accepted, skipped }
}

// ---------------------------------------------------------- reconcile view --

export type ClearedRow = {
  id: string
  txn_date: string
  description: string
  amount: bigint
  /** The entries that account for it — usually one. */
  entries: Array<{ entry_no: string | null; description: string; amount: bigint; source_type: string | null }>
}

/**
 * A book entry on this account, as at a date, that no bank row fully claims —
 * QuickBooks' "uncleared transactions": in the register, not ticked. The
 * amount is the part still unclaimed. The opening balance is one of these
 * for ever (no row will ever claim it) and is named so the report can say so.
 */
export type UnclearedEntry = {
  entry_id: string
  entry_no: string | null
  entry_date: string
  description: string
  source_type: string | null
  amount: bigint
}

export async function unclearedEntries(accountId: string, asOf: string): Promise<UnclearedEntry[]> {
  const rows = await db.execute<Omit<UnclearedEntry, 'amount'> & { amount: string }>(sql`
    SELECT e.id::text AS entry_id, e.entry_no, e.entry_date::text, e.description, e.source_type,
           (sum(COALESCE(jl.original_amount,jl.amount)) - coalesce((SELECT sum(m.amount) FROM bank_match m
                                         JOIN bank_transaction b ON b.id = m.bank_transaction_id
                                        WHERE m.entry_id = e.id AND b.account_id = ${accountId}::uuid), 0))::text
             AS amount
      FROM journal_line jl JOIN journal_entry e ON e.id = jl.entry_id
     WHERE jl.account_id = ${accountId}::uuid
       AND ${IN_THE_BOOKS}  -- the same balance as everywhere else
       AND e.entry_date <= ${asOf}::date
     GROUP BY e.id, e.entry_no, e.entry_date, e.description, e.source_type
    HAVING sum(COALESCE(jl.original_amount,jl.amount)) - coalesce((SELECT sum(m.amount) FROM bank_match m
                                        JOIN bank_transaction b ON b.id = m.bank_transaction_id
                                       WHERE m.entry_id = e.id AND b.account_id = ${accountId}::uuid), 0) <> 0
     ORDER BY e.entry_date, e.entry_no`)
  return rows.map((r) => ({ ...r, amount: BigInt(r.amount) }))
}

/**
 * The reconcile screen, the QuickBooks way: beginning, cleared, ending,
 * difference — and the lists. Everything is derived except the two decisions
 * (the statement itself, and whether it is finished).
 *
 * `cleared` is the beginning balance plus every match on every row in the
 * period. A tick in QuickBooks is a person saying "the bank cleared this"; here
 * the bank's own row says it, by claiming the entry. There is no manual tick,
 * by decision (owner, 2026-09-04): a cleared mark with no row behind it would
 * be a second answer to a question the rows already answer.
 *
 * `difference` comes from the database function the Finish guard calls, so the
 * number on the screen and the number that decides whether Finish is allowed
 * are one number. `ReconcileReport.recon` and `importGap` are the older
 * explanations and are still true; they explain WHY the difference is what it
 * is.
 */
export type ReconcileView = StatementReport & {
  statementId: string
  cleared: bigint
  difference: bigint
  clearedRows: ClearedRow[]
  /** Rows in the period the books have not accounted for yet, set aside included. */
  pendingRows: BankRowRecord[]
  /** Book entries as at the statement date no row fully claims (the register side). */
  unclearedEntries: UnclearedEntry[]
  finished: { at: string; by: string } | null
  /** Whether Undo would be accepted: this is the newest finished statement. */
  isNewestFinished: boolean
  /** Whether Finish would be accepted: zero difference and nothing earlier open. */
  earlierOpen: string | null
}

export async function reconcileView(accountId: string, statementDate: string): Promise<ReconcileView | null> {
  const report = await statementReport(accountId, statementDate)
  if (!report) return null
  const statements = await statementsFor(accountId)
  const current = statements.find((s) => s.statement_date === statementDate)!
  const prior = report.beginningDate

  const [d] = await db.execute<{ diff: string }>(sql`
    SELECT bank_statement_difference(${current.id}::uuid)::text AS diff`)
  const difference = BigInt(d.diff)

  const inPeriod = await bankRows(accountId, { after: prior ?? undefined, through: statementDate })
  const clearedRows: ClearedRow[] = []
  const cleared = inPeriod.filter((x) => x.state === 'matched' || x.state === 'part')
  const matchesByRow = await matchesForRows(cleared.map(row => row.id))
  for (const r of cleared) {
    const ms = matchesByRow.get(r.id) ?? []
    clearedRows.push({
      id: r.id, txn_date: r.txn_date, description: r.description, amount: r.matched_amount,
      entries: ms.map((m) => ({ entry_no: m.entry_no, description: m.entry_description,
                                amount: m.amount, source_type: m.source_type })),
    })
  }
  const pendingRows = inPeriod.filter((x) => x.state !== 'matched')

  const newestFinished = statements.find((s) => s.reconciled_at !== null)
  const earlierOpen = statements
    .filter((s) => s.statement_date < statementDate && s.reconciled_at === null)
    .map((s) => s.statement_date).sort().at(-1) ?? null

  return {
    ...report,
    statementId: current.id,
    cleared: report.endingBalance - difference,
    difference,
    clearedRows,
    pendingRows,
    unclearedEntries: await unclearedEntries(accountId, statementDate),
    finished: current.reconciled_at
      ? { at: current.reconciled_at, by: current.reconciled_by ?? '' } : null,
    isNewestFinished: newestFinished?.id === current.id,
    earlierOpen,
  }
}

/**
 * Finish: the decision that this statement reconciles. The database refuses it
 * unless the difference is zero and everything earlier is finished, and from
 * then on everything up to this date is frozen (0055). Audited by the app with
 * the person's name, because the trigger cannot see who asked.
 */
export async function finishReconciliation(statementId: string, actor: string) {
  await db.transaction(async (tx) => {
    await acting(tx, actor)
    // The lock before the UPDATE: the guard that computes the difference runs
    // inside the UPDATE, and it must see every import, match and ignore that
    // committed before this — and nothing that is waiting on this lock.
    await lockBankAccount(tx, await accountOfStatement(tx, statementId))
    const rows = await tx.execute<{ id: string; statement_date: string }>(sql`
      UPDATE bank_statement SET reconciled_at = now(), reconciled_by = ${actor}
       WHERE id = ${statementId}::uuid AND reconciled_at IS NULL
       RETURNING id::text, statement_date::text`)
    if (rows.length === 0) throw new BankError('NO_STATEMENT', 'That statement is not on file, or is already finished.')
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, after)
      VALUES (${actor}, 'reconciliation_finished', 'bank_statement', ${statementId},
              ${JSON.stringify({ statement_date: rows[0].statement_date })}::jsonb)`)
  })
}

/** Undo: only the newest finished one, and the freeze lifts with it. */
export async function undoReconciliation(statementId: string, actor: string, reason: string) {
  const why = reason.trim()
  if (!why) {
    throw new BankError('NO_REASON',
      'Undoing a finished reconciliation reopens frozen bank history. Say why.')
  }
  await db.transaction(async (tx) => {
    await acting(tx, actor)
    await lockBankAccount(tx, await accountOfStatement(tx, statementId))
    const rows = await tx.execute<{ id: string; statement_date: string }>(sql`
      UPDATE bank_statement SET reconciled_at = NULL, reconciled_by = NULL
       WHERE id = ${statementId}::uuid AND reconciled_at IS NOT NULL
       RETURNING id::text, statement_date::text`)
    if (rows.length === 0) throw new BankError('NO_STATEMENT', 'That statement is not on file, or was not finished.')
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, context)
      VALUES (${actor}, 'reconciliation_undone', 'bank_statement', ${statementId},
              ${JSON.stringify({ statement_date: rows[0].statement_date })}::jsonb,
              ${JSON.stringify({ reason: why })}::jsonb)`)
  })
}

/**
 * Every account with bank rows, and where each stands: how many rows wait,
 * the newest statement, whether it is finished. The landing for both doors.
 */
export type AccountStanding = {
  currency?: string
  id: string; code: string; name: string
  rows: number; review: number
  newestStatement: string | null
  finishedThrough: string | null
  /**
   * TWO FIGURES, AND NEITHER IS A BANK FEED.
   *
   * QuickBooks' cards show what the bank says beside what the books say,
   * because it is connected to the bank. This system reads a CSV (frozen
   * decision), so the honest pair is what the BOOKS hold and what the last
   * STATEMENT ended at — and the gap between them is what has not been
   * reconciled yet, which is the same question QuickBooks' pair answers.
   *
   * Signed the way the account normally sits, so a bank account in funds is
   * positive and a credit card owing is positive too.
   */
  books: bigint
  statement: bigint | null
}

export async function accountStandings(entityId: string): Promise<AccountStanding[]> {
  const rows = await db.execute<{
    id: string; code: string; name: string; rows: string; review: string
    newest: string | null; finished: string | null; currency:string
    books: string | null; statement: string | null
  }>(sql`
    SELECT a.id::text, a.code, a.name,COALESCE(a.foreign_currency,'CAD') AS currency,
           (SELECT count(*) FROM bank_transaction b WHERE b.account_id = a.id)::text AS rows,
           (SELECT count(*) FROM bank_row_state s
             WHERE s.account_id = a.id AND s.state IN ('unmatched', 'part'))::text AS review,
           (SELECT max(statement_date)::text FROM bank_statement st WHERE st.account_id = a.id) AS newest,
           bank_frozen_through(a.id)::text AS finished,
           COALESCE((SELECT SUM(COALESCE(jl.original_amount,jl.amount)) FROM journal_line jl
                       JOIN journal_entry je ON je.id = jl.entry_id
                      WHERE jl.account_id = a.id AND je.status IN ('posted','reversed')), 0)
             * CASE WHEN a.normal_balance = 'credit' THEN -1 ELSE 1 END AS books,
           (SELECT st.ending_balance FROM bank_statement st
             WHERE st.account_id = a.id ORDER BY st.statement_date DESC LIMIT 1) AS statement
      FROM account a
     WHERE a.entity_id = ${entityId}::uuid
       AND EXISTS (SELECT 1 FROM bank_transaction b WHERE b.account_id = a.id)
     ORDER BY a.code`)
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name,currency:r.currency,
    rows: Number(r.rows), review: Number(r.review),
    newestStatement: r.newest, finishedThrough: r.finished,
    books: BigInt(r.books ?? 0), statement: r.statement === null ? null : BigInt(r.statement),
  }))
}

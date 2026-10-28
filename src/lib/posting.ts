import { moduleManifests } from './module-manifests'
import { moduleEntryChange } from './module-extensions'
import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { type Runner, acting, actingAs, lockBankAccount } from './acting'
import {
  account, dimension, journalEntry, journalLine,
  ledger, } from '@/db/schema'
import { ROLE } from './roles'
import { assertCurrencyOpen, lockFxLedger, assertFxCorrection, assertNoLaterFx } from './fx'
import { FxError, validateSnapshot, toFunctional, type FxSnapshot } from './fx-money'
import { mustBeOurs } from './ours'

export type SourceType =
  | 'manual' | 'opening_balance' | 'ar_invoice' | 'ap_bill'
  | 'payment' | 'bank' | 'period_close' | 'adjustment' | 'fx_revaluation' | 'fx_transfer'
  | 'quick_expense' | 'quick_income' | 'payroll'
  | 'fixed_asset' | 'asset_depreciation' | 'asset_deferred_tax' | 'inventory' | 'production' | 'operations_opening'

/**
 * The entry number's prefix names the door the entry came through — the
 * user's ask, verbatim: the source as a label, no JE on sourced entries, no
 * year anywhere (the date already says it). ONE map, exported so screens and
 * checks read the same spelling; a second copy would drift.
 */
export const ENTRY_PREFIX: Partial<Record<SourceType, string>> = Object.assign({
  manual: 'JE',
  opening_balance: 'OPN',
  ar_invoice: 'INV',
  ap_bill: 'BILL',
  payment: 'PAY',
  bank: 'BNK',
  period_close: 'CLS',
  adjustment: 'ADJ',
  fx_revaluation: 'FXR',
  fx_transfer: 'FXT',
  quick_expense: 'EXP',
  quick_income: 'INC',
}, ...moduleManifests.map(manifest => manifest.journalPrefixes ?? {}))

export type PostEntryLine = {
  originalCurrency?: string
  originalAmount?: bigint
  fxSnapshot?: FxSnapshot
  fxInvoiceId?: string
  accountId: string
  /** Signed cents. Positive is a debit, negative a credit. */
  amount: bigint
  description?: string
  dimensions?: Record<string, string>
  /**
   * Who the line is about. The database refuses one who is not a customer,
   * supplier or employee of this company on the day of the entry — see 0025.
   */
  partyId?: string
}

export type PostEntryInput = {
  /** A mirror correction; the database verifies the complete original metadata. */
  reversesId?: string
  ledgerId: string
  /** 'YYYY-MM-DD' */
  entryDate: string
  description: string
  memo?: string
  /**
   * The number the paper behind this entry is known by — a supplier's receipt
   * or invoice number, a cheque stub. Only for entries that ARE their own
   * document: an entry raised by an invoice takes its number from the invoice,
   * and the database refuses a second copy here (0049).
   */
  documentRef?: string
  sourceType?: SourceType
  sourceId?: string
  /** Same key twice posts once. Pass one for anything replayable: imports, retries. */
  idempotencyKey?: string
  actor?: string
  lines: PostEntryLine[]
}

export class PostingError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PostingError'
  }
}

/**
 * THE ONLY WAY ANYTHING ENTERS THE LEDGER.
 *
 * Invoices, bills, payments, bank imports and manual journals all come through
 * here. Validation lives in one place, so it is correct in one place. The
 * database triggers behind it enforce the same rules again — this layer exists
 * to produce a readable error, not to be the last line of defence.
 */
export async function postEntry(input: PostEntryInput) {
  return db.transaction((tx) => postEntryCore(tx, input))
}

/**
 * postEntry's body, callable from inside an already-open transaction (that is
 * how reverseEntry posts its mirror entry atomically with the reversal, and how
 * a bank row posts its entry atomically with the match that says which row it
 * settles — an entry without its match would be money in the books that the
 * reconciliation cannot see).
 */
export async function postEntryCore(tx: Tx, input: PostEntryInput) {
  const actor = input.actor ?? 'system'
  {
    // 1 — idempotency: a replay returns the original entry and changes nothing.
    if (input.idempotencyKey) {
      const existing = await tx.query.journalEntry.findFirst({
        where: eq(journalEntry.idempotencyKey, input.idempotencyKey),
      })
      if (existing) return { entry: existing, replayed: true as const }
    }

    const prefix = ENTRY_PREFIX[input.sourceType ?? 'manual']
    if (!prefix) throw new PostingError('SOURCE_UNAVAILABLE', 'The module for this journal source is not installed.')
    const { led, period, totalDebit } = await validateEntry(tx, input)

    // 6 — the document number is taken LAST, so a failure above never burns one.
    const entryNo = await nextDocumentNumber(
      tx, led.entityId, prefix)

    // 7 — write the entry and its lines.
    const [entry] = await tx.insert(journalEntry).values({
      ledgerId: input.ledgerId,
      reversesId: input.reversesId,
      entryNo,
      entryDate: input.entryDate,
      periodId: period.id,
      description: input.description,
      memo: input.memo,
      documentRef: input.documentRef,
      sourceType: input.sourceType ?? 'manual',
      sourceId: input.sourceId,
      status: 'posted',
      currency: led.currency,
      totalDebit,
      totalCredit: totalDebit,
      idempotencyKey: input.idempotencyKey,
      createdBy: actor,
      postedAt: new Date(),
      postedBy: actor,
    }).returning()

    await tx.insert(journalLine).values(
      input.lines.map((l, i) => ({
        entryId: entry.id,
        lineNo: i + 1,
        accountId: l.accountId,
        description: l.description,
        amount: l.amount,
        originalCurrency: l.originalCurrency,
        originalAmount: l.originalAmount,
        fxSnapshot: l.fxSnapshot,
        fxInvoiceId: l.fxInvoiceId,
        currency: led.currency,
        dimensions: l.dimensions ?? {},
        partyId: l.partyId,
      })),
    )

    // 8 — keep the balance cache in step. It is only a cache: if it ever drifts,
    //     rebuild_period_balances() restores it from the lines above.
    await applyBalanceDeltas(tx, input.ledgerId, period.id, input.lines)

    // 9 — audit trail.
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
      VALUES (${actor}, 'post', 'journal_entry', ${entry.id},
              ${JSON.stringify({ entryNo, entryDate: input.entryDate, totalDebit: totalDebit.toString() })}::jsonb,
              ${JSON.stringify({ ledgerId: input.ledgerId, periodId: period.id, sourceType: input.sourceType ?? 'manual' })}::jsonb)
    `)

    // 10 — on COMMIT the deferred trigger re-checks the balance at the database level.
    return { entry, replayed: false as const }
  }
}

/**
 * Correct a posted entry by reversing it. The original is never touched beyond
 * being marked 'reversed' and linked to its reversal.
 */
/** The sources whose entries are edited and deleted HERE. Every other source
 *  has its own door, and the refusal names it — an invoice's entry edited
 *  directly would leave the document telling a different story. */
/**
 * The sources whose entries are edited and deleted in place rather than
 * corrected by reversal. Everything here was typed by a person into a form
 * that has no other record of it, so the form is the only thing to go back to.
 *
 * `bank` joined them on the owner's word (2026-09-07): "银行 add 的交易也要能
 * 编辑能删除，不必要一定要冲掉旧帐做新帐". A row Added with the wrong account is
 * a typo, not an accounting event, and reverse-and-replace left three entries
 * behind every one of them. What makes it safe is below: the row's match
 * RIDES ALONG through an edit and the database refuses an edit that breaks
 * it, and a delete releases the row back into the feed.
 */
export const OPEN_EDIT_SOURCES: SourceType[] = ['manual', 'quick_expense', 'quick_income', 'adjustment', 'bank']

// `bank` is deliberately absent: since 2026-09-07 an entry made from a bank
// row is edited and deleted at this door like a typed one, so a sentence
// telling the person to unmatch first would be a sentence about a rule that
// no longer exists (critic).
const WRONG_DOOR: Partial<Record<SourceType, string>> = {
  ar_invoice: 'this entry belongs to a sales invoice — edit or delete the invoice itself',
  ap_bill: 'this entry belongs to a purchase bill — edit or delete the bill itself',
  payment: "this entry is a payment — remove it from the invoice's payments panel",
  opening_balance: 'the opening balance screen owns this entry',
  period_close: 'a year-end closing entry moves with its year — reopen the year instead',
}

/**
 * The row every open-book mutation starts from, with every refusal that is
 * not the database's to make. FOR UPDATE, so two tabs cannot both pass the
 * gates and then take turns mutating.
 */
async function loadForOpenEdit(tx: Tx, entryId: string, ownDoor?: SourceType) {
  const [e] = await tx.execute<{
    id: string; ledger_id: string; status: string; source_type: string
    entry_no: string | null; entry_date: string; description: string
    memo: string | null; period_id: string | null
    reverses_id: string | null; reversed_by_id: string | null
  }>(sql`
    SELECT id::text, ledger_id::text, status, source_type, entry_no,
           entry_date::text, description, memo, period_id::text,
           reverses_id::text, reversed_by_id::text
      FROM journal_entry WHERE id = ${entryId}::uuid FOR UPDATE`)
  if (!e) throw new PostingError('NO_ENTRY', 'That entry does not exist.')
  const foreign = await tx.execute<{fx_invoice_id:string|null;account_id:string}>(sql`
    SELECT fx_invoice_id::text,account_id::text FROM journal_line WHERE entry_id=${entryId}::uuid AND original_currency IS NOT NULL`)
  if (foreign.length) throw new PostingError('FX_CORRECTION', 'Use the foreign-currency workspace to reverse this entry; its original currency and rate must be preserved.')
  if (e.status === 'draft') {
    throw new PostingError('IS_DRAFT',
      'That is a draft — edit it by saving it again, or discard it.')
  }
  if (e.status === 'reversed' || e.reverses_id) {
    throw new PostingError('CORRECTION_PAIR',
      `${e.entry_no} is half of a correction pair — the two explain each other ` +
      'and move together. Post a new entry instead.')
  }
  // A caller editing through the entry's OWN door (the invoice module for an
  // ar_invoice entry) passes its source; everyone else is turned away by name.
  if (e.source_type !== ownDoor
      && !OPEN_EDIT_SOURCES.includes(e.source_type as SourceType)) {
    throw new PostingError('WRONG_DOOR',
      `${e.entry_no}: ${WRONG_DOOR[e.source_type as SourceType] ?? 'this source has its own door'}.`)
  }
  const [period] = await tx.execute<{ status: string; name: string }>(sql`
    SELECT status, name FROM fiscal_period WHERE id = ${e.period_id}::uuid`)
  if (period && period.status !== 'open') {
    throw new PostingError('PERIOD_CLOSED',
      `${e.entry_no} sits in ${period.name}, which is ${period.status}. ` +
      'Reopen the period, or correct it with a reversal — a closed period is the freeze.')
  }
  return e
}

/**
 * The owner's cascade (docs/design/14-open-books.md): changing or deleting a
 * live entry RELEASES what refers to it — its invoice applications (the
 * settled debt is owed again) and its bank matches (the row is unreconciled
 * again) — and reports both counts so nothing is released in silence.
 * Re-applying and re-matching are human judgments, not something this door
 * guesses at; releasing everything also means 0036's caps have nothing left
 * to exceed after an edit.
 *
 * ONE EXCEPTION, `carryMatches`: an entry made FROM a bank row is edited with
 * its match kept, the way `amendEntry` carries one to the replacement. The
 * match is not a judgment there — it is the reason the entry exists — and
 * releasing it would put a row back in the feed because somebody fixed the
 * expense account on it. The carry is not a promise: `recheckMatches` below
 * makes the database say whether the edited entry still settles the row, and
 * an edit that no longer does is refused whole.
 */
async function releaseReferences(tx: Tx, entryId: string, carryMatches = false) {
  const apps = await tx.execute<{ id: string }>(sql`
    DELETE FROM invoice_application WHERE entry_id = ${entryId}::uuid RETURNING id::text`)
  await lockMatchedAccounts(tx, entryId)
  if (carryMatches) return { releasedApplications: apps.length, releasedMatches: 0 }
  const matches = await tx.execute<{ id: string }>(sql`
    DELETE FROM bank_match WHERE entry_id = ${entryId}::uuid RETURNING id::text`)
  return { releasedApplications: apps.length, releasedMatches: matches.length }
}

/**
 * Make the match guards speak again, after the lines under them have changed.
 *
 * `trg_bank_match` (0020/0023) and the deferred `trg_match_totals` fire on
 * writes to `bank_match`, not on writes to `journal_line` — so an edit that
 * moved the bank line out from under a match would pass unseen. Touching the
 * rows re-runs both: the entry must still have a line on that account, moving
 * it the same way, by at least what is claimed against it. If it does not,
 * this raises and the whole edit goes with it, which is the right answer:
 * changing what an entry settles means undoing the match on purpose first.
 */
async function recheckMatches(tx: Tx, entryId: string) {
  await tx.execute(sql`
    UPDATE bank_match SET amount = amount WHERE entry_id = ${entryId}::uuid`)
}

/**
 * Every bank account this entry is matched on, locked BEFORE its matches are
 * deleted or moved. Releasing a match changes what a statement reconciles
 * against, so this path has to wait for a Finish in flight exactly as an
 * import does (RISKS §21b; the critic found the first version had left it
 * out). Sorted, so two releases touching the same accounts cannot deadlock.
 */
async function lockMatchedAccounts(tx: Tx, entryId: string) {
  const accounts = await tx.execute<{ account_id: string }>(sql`
    SELECT DISTINCT b.account_id::text
      FROM bank_match m JOIN bank_transaction b ON b.id = m.bank_transaction_id
     WHERE m.entry_id = ${entryId}::uuid
     ORDER BY 1`)
  for (const a of accounts) await lockBankAccount(tx, a.account_id)
}

/** The lines as they stand, for deltas and for the audit record. */
async function linesForOpenEdit(tx: Tx, entryId: string) {
  return tx.execute<{
    account_id: string; amount: bigint; description: string | null
    dimensions: Record<string, string>; party_id: string | null
  }>(sql`
    SELECT account_id::text, amount, description, dimensions, party_id::text
      FROM journal_line WHERE entry_id = ${entryId}::uuid ORDER BY line_no`)
}

/**
 * Edit a live entry in an open period — the open-books contract
 * (docs/design/14-open-books.md). Same validation as posting, the number and
 * the source kept, the balance cache moved by deltas, the change audited
 * with before and after. The `erp.open_edit` flag is what the 0038 triggers
 * look for: it marks "this mutation was rebalanced and audited", nothing
 * else, and it dies with the transaction.
 */
export async function editEntry(entryId: string, input: {
  entryDate: string
  description: string
  memo?: string
  documentRef?: string
  lines: PostEntryLine[]
}, actor = 'system', ledgerId?: string, reason?: string, on: Runner = db) {
  await mustBeOurs('entry', entryId, ledgerId, (m) => new PostingError('NOT_OURS', m))
  return on.transaction((tx) => editEntryCore(tx, entryId, input, actor, undefined, reason))
}

/**
 * editEntry's body, callable inside an already-open transaction — the invoice
 * door regenerates its entry atomically with the document change, and passes
 * its own source so the wrong-door gate lets it through for exactly that
 * source and no other.
 */
export async function editEntryCore(tx: Tx, entryId: string, input: {
  entryDate: string
  description: string
  memo?: string
  documentRef?: string
  lines: PostEntryLine[]
}, actor = 'system', ownDoor?: SourceType, reason?: string) {
  {
    const e = await loadForOpenEdit(tx, entryId, ownDoor)
    await acting(tx, actor)

    const { led, period, totalDebit } = await validateEntry(tx, {
      ledgerId: e.ledger_id,
      entryDate: input.entryDate,
      description: input.description,
      lines: input.lines,
    })

    const before = await linesForOpenEdit(tx, entryId)
    // A bank entry keeps its match through an edit; see releaseReferences.
    const carry = e.source_type === 'bank'
    const released = await releaseReferences(tx, entryId, carry)
    await tx.execute(sql`SELECT set_config('erp.open_edit', 'on', true)`)

    // Out of the old period, line by line, before the lines change.
    await removeBalanceDeltas(tx, e.ledger_id, e.period_id!,
      before.map((l) => ({ accountId: l.account_id, amount: BigInt(l.amount) })))

    await tx.execute(sql`DELETE FROM journal_line WHERE entry_id = ${entryId}::uuid`)

    await tx.update(journalEntry).set({
      entryDate: input.entryDate,
      periodId: period.id,
      description: input.description,
      memo: input.memo ?? null,
      documentRef: input.documentRef ?? null,
      totalDebit,
      totalCredit: totalDebit,
    }).where(eq(journalEntry.id, entryId))

    await tx.insert(journalLine).values(
      input.lines.map((l, i) => ({
        entryId,
        lineNo: i + 1,
        accountId: l.accountId,
        description: l.description,
        amount: l.amount,
        originalCurrency: l.originalCurrency,
        originalAmount: l.originalAmount,
        fxSnapshot: l.fxSnapshot,
        fxInvoiceId: l.fxInvoiceId,
        currency: led.currency,
        dimensions: l.dimensions ?? {},
        partyId: l.partyId,
      })),
    )

    await applyBalanceDeltas(tx, e.ledger_id, period.id, input.lines)

    // The carried matches, re-judged against the lines that now exist.
    if (carry) await recheckMatches(tx, entryId)

    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (${actor}, 'edit', 'journal_entry', ${entryId},
              ${JSON.stringify({
                entryDate: e.entry_date, description: e.description, memo: e.memo,
                lines: before.map((l) => ({ accountId: l.account_id, amount: String(l.amount), partyId: l.party_id })),
              })}::jsonb,
              ${JSON.stringify({
                entryDate: input.entryDate, description: input.description, memo: input.memo ?? null,
                lines: input.lines.map((l) => ({ accountId: l.accountId, amount: l.amount.toString(), partyId: l.partyId ?? null })),
              })}::jsonb,
              ${JSON.stringify({ ledgerId: e.ledger_id, periodId: period.id, entryNo: e.entry_no,
                reason: reason?.trim() || undefined })}::jsonb)`)

    return { entry: { id: entryId, entryNo: e.entry_no }, periodId: period.id, ...released }
  }
}

/**
 * Delete a live entry in an open period. The number is not reissued — the
 * gap, together with the audit row holding the full text of what was
 * deleted, IS the trace (the owner's call, docs/design/14-open-books.md).
 */
export async function deleteEntry(entryId: string, actor = 'system', ledgerId?: string, reason?: string, on: Runner = db) {
  await mustBeOurs('entry', entryId, ledgerId, (m) => new PostingError('NOT_OURS', m))
  return on.transaction((tx) => deleteEntryCore(tx, entryId, actor, undefined, reason))
}

/** deleteEntry's body, for the same reason editEntryCore exists. */
export async function deleteEntryCore(
  tx: Tx, entryId: string, actor = 'system', ownDoor?: SourceType, reason?: string,
) {
  {
    const e = await loadForOpenEdit(tx, entryId, ownDoor)
    await acting(tx, actor)
    const before = await linesForOpenEdit(tx, entryId)
    const released = await releaseReferences(tx, entryId)

    await tx.execute(sql`SELECT set_config('erp.open_edit', 'on', true)`)
    await removeBalanceDeltas(tx, e.ledger_id, e.period_id!,
      before.map((l) => ({ accountId: l.account_id, amount: BigInt(l.amount) })))
    await tx.execute(sql`DELETE FROM journal_line WHERE entry_id = ${entryId}::uuid`)
    await tx.execute(sql`DELETE FROM journal_entry WHERE id = ${entryId}::uuid`)

    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, context)
      VALUES (${actor}, 'delete', 'journal_entry', ${entryId},
              ${JSON.stringify({
                entryNo: e.entry_no, entryDate: e.entry_date, description: e.description,
                memo: e.memo, sourceType: e.source_type,
                lines: before.map((l) => ({ accountId: l.account_id, amount: String(l.amount), partyId: l.party_id })),
              })}::jsonb,
              ${JSON.stringify({ ledgerId: e.ledger_id, periodId: e.period_id,
                reason: reason?.trim() || undefined })}::jsonb)`)

    return { entryNo: e.entry_no, ...released }
  }
}

export async function reverseEntry(
  entryId: string, reversalDate: string, reason: string, actor = 'system', ledgerId?: string, on: Runner = db,
) {
  await mustBeOurs('entry', entryId, ledgerId, (m) => new PostingError('NOT_OURS', m))
  return on.transaction((tx) => reverseEntryCore(tx, entryId, reversalDate, reason, actor))
}

/**
 * What the "Edit" button on a posted entry actually does: reverse the old one,
 * post a new one, and link them. The screen folds all three into one row.
 *
 * Both halves run in ONE transaction. If the replacement is rejected — an
 * unbalanced edit, a closed period, a bad account — the reversal rolls back
 * with it. There is no path that leaves the original reversed with nothing
 * standing in its place.
 */
export async function amendEntry(
  entryId: string, replacement: Omit<PostEntryInput, 'ledgerId'>, actor = 'system', ledgerId?: string, on: Runner = db,
) {
  await mustBeOurs('entry', entryId, ledgerId, (m) => new PostingError('NOT_OURS', m))
  return on.transaction(async (tx) => {
    const original = await tx.query.journalEntry.findFirst({ where: eq(journalEntry.id, entryId) })
    if (!original) throw new PostingError('NO_ENTRY', 'That entry does not exist.')

    await moduleEntryChange(tx, { id: entryId, sourceType: original.sourceType, operation: 'amend' })

    const { reversal } = await reverseEntryCore(tx, entryId, replacement.entryDate, 'amended', actor)

    // Where an entry came from survives being corrected, unless the caller says
    // otherwise. Without this the replacement was always 'manual': amending a
    // bank-generated entry lost the row it came from, and amending an opening
    // balance freed the one-per-ledger slot — the books could then be entered a
    // second time, and the surviving copy no longer anchored the rule that
    // nothing may be dated before it.
    const posted = await postEntryCore(tx, {
      sourceType: original.sourceType as SourceType,
      sourceId: original.sourceId ?? undefined,
      // Where it came from and what paper it is survive a correction alike.
      documentRef: original.documentRef ?? undefined,
      ...replacement,
      ledgerId: original.ledgerId,
      actor,
    })

    await tx.update(journalEntry)
      .set({ replacesId: entryId })
      .where(eq(journalEntry.id, posted.entry.id))

    // Anything reconciled against the original is reconciled against the
    // replacement — the replacement is where the money is now. Without this the
    // match stays on a reversed entry, the bank row still reads as accounted
    // for, and the replacement cannot be matched because the row is already
    // full: the correction becomes unreachable.
    //
    // One statement rather than an import, to keep the ledger from depending on
    // the bank module. Its guards do the validating: if the replacement has no
    // line on that account, or no longer moves enough of it, the match cannot
    // move and the whole amendment is refused — which is the right answer.
    // Amending a reconciled entry into a different shape means undoing the
    // match first, on purpose.
    await lockMatchedAccounts(tx, entryId) // the match moves to the replacement
    await tx.execute(sql`
      UPDATE bank_match SET entry_id = ${posted.entry.id}::uuid WHERE entry_id = ${entryId}::uuid`)

    // Applications ride along the same way, for the same reason, and the same
    // guard has the last word: `trg_application_valid` is deferred, so if the
    // replacement no longer moves the invoice's control account far enough the
    // carry is refused at commit and the amendment fails whole — undo the
    // application first, on purpose.
    await tx.execute(sql`
      UPDATE invoice_application SET entry_id = ${posted.entry.id}::uuid WHERE entry_id = ${entryId}::uuid`)

    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (${actor}, 'amend', 'journal_entry', ${entryId},
              ${JSON.stringify({ entryNo: original.entryNo, status: 'posted' })}::jsonb,
              ${JSON.stringify({ replacedBy: posted.entry.entryNo, reversedBy: reversal.entryNo })}::jsonb,
              ${JSON.stringify({ description: replacement.description })}::jsonb)
    `)

    return { original, reversal, replacement: posted.entry }
  })
}

// ---------------------------------------------------------------- internals --

/**
 * THE GATE. Everything that becomes part of the ledger passes through here,
 * whether it arrives as a finished entry or as a draft being posted.
 *
 * It is one function on purpose. Two posting paths each carrying their own copy
 * of these checks would drift, and the place they drifted would be a way in
 * that nothing tested — which is the shape of most of what adversarial review
 * has found in this ledger so far.
 *
 * ONE EXCEPTION, said out loud because a comment claiming completeness is worth
 * less than one that is true: the party rule (0025/0026) is not checked here.
 * It lives entirely in the database — on `journal_line` insert and update, on
 * `party_role` update and delete, and on a change to `entry_date`. Deliberate,
 * because that rule has to hold against a hand-written UPDATE as well, but it
 * does mean a bad party arrives as a database error rather than as one of the
 * sentences this function produces.
 */
async function validateEntry(tx: Tx, input: PostEntryInput) {
  // Shape first, so the message is about the entry rather than about some
  // account the person has not thought about yet.
  if (input.lines.length < 2) {
    throw new PostingError('TOO_FEW_LINES', 'A journal entry needs at least two lines.')
  }
  if (input.lines.some((l) => l.amount === 0n && (l.originalAmount === undefined || l.originalAmount === 0n))) {
    throw new PostingError('ZERO_LINE', 'A journal line cannot be for zero.')
  }
  const netCents = input.lines.reduce((sum, l) => sum + l.amount, 0n)
  if (netCents !== 0n) {
    throw new PostingError(
      'OUT_OF_BALANCE',
      `Debits and credits differ by ${fmt(netCents)}. An entry must net to zero.`,
    )
  }

  const led = await tx.query.ledger.findFirst({ where: eq(ledger.id, input.ledgerId) })
  if (!led) throw new PostingError('NO_LEDGER', 'That ledger does not exist.')

  // Accounts must belong to this ledger's entity, be postable and be active.
  const ids = [...new Set(input.lines.map((l) => l.accountId))]
  const accounts = await tx.query.account.findMany({
    where: (a, { inArray }) => inArray(a.id, ids),
  })
  const byId = new Map(accounts.map((a) => [a.id, a]))
  for (const id of ids) {
    const a = byId.get(id)
    if (!a) throw new PostingError('NO_ACCOUNT', `Account ${id} does not exist.`)
    if (a.entityId !== led.entityId) {
      throw new PostingError('WRONG_ENTITY', `Account ${a.code} ${a.name} belongs to a different company.`)
    }
    if (!a.isPostable) {
      throw new PostingError('HEADER_ACCOUNT', `${a.code} ${a.name} is a heading and cannot be posted to.`)
    }
    if (!a.isActive) {
      throw new PostingError('INACTIVE_ACCOUNT', `${a.code} ${a.name} is inactive.`)
    }
  }

  const nativeLines=input.lines.filter(l=>l.originalCurrency)
  if(nativeLines.length){
    await lockFxLedger(tx,input.ledgerId)
    await assertNoLaterFx(tx,input.ledgerId,input.entryDate,
      nativeLines.flatMap(l=>l.fxInvoiceId?[l.fxInvoiceId]:[]),
      nativeLines.filter(l=>byId.get(l.accountId)?.foreignCurrency).map(l=>l.accountId))
  }
  for (const line of input.lines) {
    const a = byId.get(line.accountId)!
    if (a.foreignCurrency && (line.originalCurrency !== a.foreignCurrency || line.originalAmount === undefined)) {
      throw new PostingError('FX_BANK_NATIVE', 'Use the foreign-currency workspace for this bank account; its native amount is required.')
    }
    if (!line.originalCurrency) {
      if (line.originalAmount !== undefined || line.fxSnapshot || line.fxInvoiceId) throw new FxError('NATIVE_SHAPE','Original amount and rate require a currency.')
      continue
    }
    if (line.originalAmount === undefined || !line.fxSnapshot || line.fxSnapshot.currency !== line.originalCurrency) throw new FxError('NATIVE_SHAPE','Keep the original amount, currency and rate together.')
    line.fxSnapshot = validateSnapshot(line.fxSnapshot)
    if (line.fxSnapshot.observedOn > input.entryDate) throw new FxError('FUTURE_RATE','A transaction cannot use a future quote.')
    if (line.originalAmount !== 0n && line.amount !== 0n && (line.originalAmount < 0n) !== (line.amount < 0n)) throw new FxError('NATIVE_SIGN','Original and functional amounts must move in the same direction.')
    if (!line.fxInvoiceId && line.originalAmount !== 0n && line.fxSnapshot.source !== 'carrying'
        && line.amount !== toFunctional(line.originalAmount,line.originalCurrency,line.fxSnapshot.rate)) throw new FxError('CONVERSION','The native amount and saved rate do not produce this functional amount.')
    if (!input.reversesId && !['payment','fx_revaluation','fx_transfer'].includes(input.sourceType ?? 'manual')) await assertCurrencyOpen(tx,input.ledgerId,line.originalCurrency)
  }

  await validateDimensions(tx, led.entityId, input.lines, byId)

  // The period is resolved HERE, from the date, every time. A draft never
  // stores one: a period it stored at save time could have closed before it was
  // posted, and posting would then have used the stale, closed period.
  const [period] = await tx.execute<{
    id: string; name: string; status: string; start_date: string
    year_name: string; year_status: string
  }>(sql`
    SELECT fp.id::text, fp.name, fp.status, fp.start_date::text,
           fy.name AS year_name, fy.status AS year_status
      FROM fiscal_period fp JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
     WHERE fp.ledger_id = ${input.ledgerId}::uuid
       AND ${input.entryDate}::date BETWEEN fp.start_date AND fp.end_date`)
  if (!period) {
    throw new PostingError('NO_PERIOD', `No fiscal period covers ${input.entryDate}. Create the fiscal year first.`)
  }
  // The year's status counts as much as the period's, and saying so here means
  // the reader gets a sentence rather than the database's message about a UUID.
  if (period.year_status !== 'open') {
    throw new PostingError('PERIOD_CLOSED',
      `${period.year_name} is ${period.year_status}. Reopen the year to post into ${period.name}.`)
  }
  if (period.status !== 'open') {
    throw new PostingError('PERIOD_CLOSED', `Period ${period.name} is ${period.status}. Reopen it to post here.`)
  }

  const totalDebit = input.lines.reduce((s, l) => (l.amount > 0n ? s + l.amount : s), 0n)
  return { led, period: { id: period.id, name: period.name, startDate: period.start_date },
           totalDebit, accounts: byId }
}

/** reverseEntry's body, callable from inside an already-open transaction. */
export async function reverseEntryCore(tx: Tx, entryId: string, reversalDate: string, reason: string, actor: string) {
  await assertFxCorrection(tx,entryId,reversalDate)
  const original = await tx.query.journalEntry.findFirst({ where: eq(journalEntry.id, entryId) })
  if (!original) throw new PostingError('NO_ENTRY', 'That entry does not exist.')
  await moduleEntryChange(tx, { id: entryId, sourceType: original.sourceType, operation: 'reverse' })
  if (original.status !== 'posted') {
    throw new PostingError('NOT_POSTED', `Entry ${original.entryNo ?? entryId} is ${original.status}, not posted.`)
  }

  const lines = await tx.query.journalLine.findMany({ where: eq(journalLine.entryId, entryId) })

  const { entry: reversal } = await postEntryCore(tx, {
    ledgerId: original.ledgerId,
    entryDate: reversalDate,
    description: `Reversal of ${original.entryNo} — ${reason}`,
    sourceType: 'adjustment',
    reversesId: original.id,
    // The same paper, unwound. A reversal that forgets the supplier's own
    // number leaves the browse showing one line that names the receipt and
    // one that does not, for the two halves of a single receipt.
    documentRef: original.documentRef ?? undefined,
    actor,
    lines: lines.map((l) => ({
      accountId: l.accountId,
      amount: -l.amount,
      originalCurrency: l.originalCurrency ?? undefined,
      originalAmount: l.originalAmount === null ? undefined : -l.originalAmount,
      fxSnapshot: l.fxSnapshot ?? undefined,
      fxInvoiceId: l.fxInvoiceId ?? undefined,
      description: l.description ?? undefined,
      dimensions: l.dimensions,
      // The same party. A reversal that forgets who it was about leaves the
      // invoice in their aging and takes the credit somewhere else.
      partyId: l.partyId ?? undefined,
    })),
  })

  await tx.update(journalEntry)
    .set({ status: 'reversed', reversedById: reversal.id, voidReason: reason })
    .where(eq(journalEntry.id, entryId))

  await tx.update(journalEntry)
    .set({ reversesId: entryId })
    .where(eq(journalEntry.id, reversal.id))

  await tx.execute(sql`
    INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
    VALUES (${actor}, 'reverse', 'journal_entry', ${entryId},
            ${JSON.stringify({ status: 'posted' })}::jsonb,
            ${JSON.stringify({ status: 'reversed', reversedBy: reversal.id })}::jsonb,
            ${JSON.stringify({ reason })}::jsonb)
  `)

  return { original, reversal }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function validateDimensions(
  tx: Tx,
  entityId: string,
  lines: PostEntryLine[],
  accountsById: Map<string, typeof account.$inferSelect>,
) {
  const used = new Set<string>()
  for (const l of lines) for (const k of Object.keys(l.dimensions ?? {})) used.add(k)

  const required = new Set(
    lines.flatMap((l) => accountsById.get(l.accountId)?.requiredDimensions ?? []),
  )
  for (const r of required) used.add(r)
  if (used.size === 0) return

  const dims = await tx.query.dimension.findMany({ where: eq(dimension.entityId, entityId) })
  const dimByCode = new Map(dims.map((d) => [d.code, d]))
  const values = dims.length
    ? await tx.query.dimensionValue.findMany({
        where: (v, { inArray }) => inArray(v.dimensionId, dims.map((d) => d.id)),
      })
    : []
  const valueKeys = new Set(values.map((v) => `${v.dimensionId}:${v.code}`))

  for (const l of lines) {
    const a = accountsById.get(l.accountId)!
    const given = l.dimensions ?? {}
    for (const need of a.requiredDimensions) {
      if (!given[need]) {
        throw new PostingError('MISSING_DIMENSION', `${a.code} ${a.name} requires a ${need} value.`)
      }
    }
    for (const [code, value] of Object.entries(given)) {
      const d = dimByCode.get(code)
      if (!d) throw new PostingError('NO_DIMENSION', `There is no dimension called "${code}".`)
      if (!valueKeys.has(`${d.id}:${value}`)) {
        throw new PostingError('NO_DIMENSION_VALUE', `"${value}" is not a valid ${code}.`)
      }
    }
  }
}

/**
 * Gapless numbering. Postgres SEQUENCE is deliberately gap-prone — a rollback
 * burns the number — so the counter is a row we lock and bump inside the same
 * transaction as the entry. Called last, once everything else has passed.
 */
async function nextDocumentNumber(tx: Tx, entityId: string, docType: string) {
  // One continuous sequence per source, across years — 'ALL' where a fiscal
  // year used to sit. The number carries no year, so a per-year restart would
  // mint INV-00001 twice; rows keyed by real years belong to numbers already
  // issued under the old JE-<year>- format and stay untouched.
  await tx.execute(sql`
    INSERT INTO number_sequence (entity_id, doc_type, fiscal_year, prefix)
    VALUES (${entityId}, ${docType}, 'ALL', ${`${docType}-`})
    ON CONFLICT (entity_id, doc_type, fiscal_year) DO NOTHING
  `)

  const rows = await tx.execute(sql`
    UPDATE number_sequence SET next_number = next_number + 1
     WHERE entity_id = ${entityId} AND doc_type = ${docType} AND fiscal_year = 'ALL'
    RETURNING prefix, next_number - 1 AS allocated, padding
  `)

  const row = (rows as unknown as Array<{ prefix: string; allocated: string; padding: number }>)[0]
  return `${row.prefix}${String(row.allocated).padStart(row.padding, '0')}`
}

/**
 * Undo lines from the cache — the mirror of applyBalanceDeltas, and NOT the
 * same as applying negated lines: the sign of a line decides which SIDE it
 * sits on, so a negated debit would be booked as a new credit and inflate
 * both movement columns while every closing balance still agreed. E2 caught
 * exactly that on the first run of the open-books door.
 */
async function removeBalanceDeltas(tx: Tx, ledgerId: string, periodId: string,
                                   lines: Array<{ accountId: string; amount: bigint }>) {
  const perAccount = new Map<string, { d: bigint; c: bigint; net: bigint }>()
  for (const l of lines) {
    const t = perAccount.get(l.accountId) ?? { d: 0n, c: 0n, net: 0n }
    if (l.amount > 0n) t.d += l.amount; else t.c += -l.amount
    t.net += l.amount
    perAccount.set(l.accountId, t)
  }
  for (const [accountId, t] of perAccount) {
    await tx.execute(sql`
      UPDATE period_balance
         SET period_debit    = period_debit  - ${t.d},
             period_credit   = period_credit - ${t.c},
             closing_balance = closing_balance - ${t.net},
             updated_at      = now()
       WHERE ledger_id = ${ledgerId} AND period_id = ${periodId} AND account_id = ${accountId}
    `)
    await tx.execute(sql`
      UPDATE period_balance pb
         SET opening_balance = pb.opening_balance - ${t.net},
             closing_balance = pb.closing_balance - ${t.net},
             updated_at      = now()
        FROM fiscal_period fp
       WHERE fp.id = pb.period_id
         AND pb.ledger_id = ${ledgerId} AND pb.account_id = ${accountId}
         AND fp.start_date > (SELECT start_date FROM fiscal_period WHERE id = ${periodId})
    `)
  }
}

async function applyBalanceDeltas(tx: Tx, ledgerId: string, periodId: string, lines: PostEntryLine[]) {
  // BY SIDE, not netted. An entry may legally carry both a debit and a credit
  // on the same account (the contra-settlement wash is a real shape), and the
  // journal, the rebuild, and the integrity check all count sides — a netted
  // live path recorded a wash as nothing and the first side-comparing probe
  // called it drift. removeBalanceDeltas was already side-accurate; now both
  // directions are the same arithmetic.
  const perAccount = new Map<string, { d: bigint; c: bigint; net: bigint }>()
  for (const l of lines) {
    const t = perAccount.get(l.accountId) ?? { d: 0n, c: 0n, net: 0n }
    if (l.amount > 0n) t.d += l.amount; else t.c += -l.amount
    t.net += l.amount
    perAccount.set(l.accountId, t)
  }

  for (const [accountId, t] of perAccount) {
    // Every posted account carries a row in EVERY period, so a dormant month
    // never drops the account off the balance sheet.
    await tx.execute(sql`
      INSERT INTO period_balance (ledger_id, period_id, account_id)
      SELECT ${ledgerId}, fp.id, ${accountId}
        FROM fiscal_period fp WHERE fp.ledger_id = ${ledgerId}
      ON CONFLICT (ledger_id, period_id, account_id) DO NOTHING
    `)

    await tx.execute(sql`
      UPDATE period_balance
         SET period_debit    = period_debit  + ${t.d},
             period_credit   = period_credit + ${t.c},
             closing_balance = closing_balance + ${t.net},
             updated_at      = now()
       WHERE ledger_id = ${ledgerId} AND period_id = ${periodId} AND account_id = ${accountId}
    `)

    // Later periods inherit the movement through both opening and closing.
    await tx.execute(sql`
      UPDATE period_balance pb
         SET opening_balance = pb.opening_balance + ${t.net},
             closing_balance = pb.closing_balance + ${t.net},
             updated_at      = now()
        FROM fiscal_period fp
       WHERE fp.id = pb.period_id
         AND pb.ledger_id = ${ledgerId} AND pb.account_id = ${accountId}
         AND fp.start_date > (SELECT start_date FROM fiscal_period WHERE id = ${periodId})
    `)
  }
}

function fmt(cents: bigint) {
  const neg = cents < 0n
  const a = neg ? -cents : cents
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}

// -------------------------------------------------------------------- drafts --

export type DraftInput = {
  ledgerId: string
  entryDate: string
  description: string
  memo?: string
  /** The paper's own number, when the entry is its own document (0049). */
  documentRef?: string
  actor?: string
  lines: PostEntryLine[]
}

/**
 * Save a draft. A draft may be unbalanced, may name one account, may be
 * nonsense — it is not the ledger yet, and no balance or statement includes it.
 *
 * It deliberately stores no period. A period stored at save time could close
 * before the draft is posted, and posting would then file the entry into a
 * closed period. The period is resolved from the date at posting, every time.
 */
export async function saveDraft(input: DraftInput, draftId?: string, on: Runner = db) {
  const actor = input.actor ?? 'system'

  return on.transaction(async (tx) => {
    await acting(tx, actor)
    if (input.lines.some((l) => l.amount === 0n)) {
      throw new PostingError('ZERO_LINE', 'A journal line cannot be for zero. Leave the row blank instead.')
    }

    let entryId = draftId
    if (entryId) {
      await tx.execute(sql`SELECT id FROM journal_entry WHERE id=${entryId}::uuid FOR UPDATE`)
      const existing = await tx.query.journalEntry.findFirst({ where: eq(journalEntry.id, entryId) })
      if (!existing) throw new PostingError('NO_ENTRY', 'That draft no longer exists.')
      if (existing.status !== 'draft') {
        throw new PostingError('NOT_DRAFT',
          `${existing.entryNo ?? 'That entry'} is already in the books — edit it on its own page while its month is open.`)
      }
      if (existing.ledgerId !== input.ledgerId) {
        throw new PostingError('WRONG_LEDGER', 'That draft belongs to another company.')
      }
      // The database trigger sees only entry_date and description, so a draft
      // whose every amount changed under an unchanged header left no trace.
      // The lines are recorded here, where the real actor is also known.
      const previous = await tx.query.journalLine.findMany({
        where: eq(journalLine.entryId, entryId),
        orderBy: (l, { asc }) => [asc(l.lineNo)],
      })

      await tx.update(journalEntry).set({
        entryDate: input.entryDate,
        description: input.description,
        memo: input.memo,
        documentRef: input.documentRef ?? null,
        totalDebit: 0n,
        totalCredit: 0n,
      }).where(eq(journalEntry.id, entryId))
      await tx.delete(journalLine).where(eq(journalLine.entryId, entryId))

      const summarise = (ls: Array<{ accountId: string; amount: bigint }>) =>
        ls.map((l) => `${l.accountId}:${l.amount.toString()}`)
      const beforeLines = summarise(previous)
      const afterLines = summarise(input.lines)
      if (beforeLines.join('|') !== afterLines.join('|')) {
        await tx.execute(sql`
          INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
          VALUES (${actor}, 'edit_draft_lines', 'journal_entry', ${entryId},
                  ${JSON.stringify({ lines: beforeLines })}::jsonb,
                  ${JSON.stringify({ lines: afterLines })}::jsonb)`)
      }
    } else {
      const [row] = await tx.insert(journalEntry).values({
        ledgerId: input.ledgerId,
        entryDate: input.entryDate,
        description: input.description,
        memo: input.memo,
        documentRef: input.documentRef,
        status: 'draft',
        sourceType: 'manual',
        createdBy: actor,
      }).returning()
      entryId = row.id
    }

    if (input.lines.length > 0) {
      // Say why in words. The database refuses these too, but its message names
      // a bare UUID, which is no help to someone repairing a draft on screen.
      const led = await tx.query.ledger.findFirst({ where: eq(ledger.id, input.ledgerId) })
      const named = await tx.query.account.findMany({
        where: (a, { inArray }) => inArray(a.id, [...new Set(input.lines.map((l) => l.accountId))]),
      })
      const byId = new Map(named.map((a) => [a.id, a]))
      for (const l of input.lines) {
        const a = byId.get(l.accountId)
        if (!a) throw new PostingError('NO_ACCOUNT', 'A line names an account that no longer exists.')
        if (a.entityId !== led!.entityId) {
          throw new PostingError('WRONG_ENTITY', `${a.code} ${a.name} belongs to a different company.`)
        }
        if (!a.isPostable) {
          throw new PostingError('HEADER_ACCOUNT', `${a.code} ${a.name} is a heading and cannot be posted to.`)
        }
        if (!a.isActive) {
          throw new PostingError('INACTIVE_ACCOUNT', `${a.code} ${a.name} is inactive. Choose another account.`)
        }
      }

      // The account/entity check on journal_line runs on INSERT, and a draft's
      // ledger can never change (0010), so what is checked here stays true.
      await tx.insert(journalLine).values(input.lines.map((l, i) => ({
        entryId: entryId!,
        lineNo: i + 1,
        accountId: l.accountId,
        description: l.description,
        amount: l.amount,
        dimensions: l.dimensions ?? {},
        partyId: l.partyId,
      })))
    }

    const [saved] = await tx.select().from(journalEntry).where(eq(journalEntry.id, entryId))
    const [revision] = await tx.execute<{version:string}>(sql`SELECT COALESCE(to_jsonb(j)->>'version','1') AS version FROM journal_entry j WHERE id=${entryId}::uuid`)
    return {...saved,version:revision.version}
  })
}

/**
 * Post a draft. It goes through validateEntry — the same gate a finished entry
 * goes through — and only then becomes part of the ledger.
 */
export async function postDraft(draftId: string, actor = 'system', on: Runner = db) {
  return on.transaction(async (tx) => {
    // Lock the row first. Two tabs pressing Post on the same draft would
    // otherwise both read 'draft' and both post it; the idempotency key
    // protects postEntry's insert path and does nothing for this one.
    const locked = await tx.execute<{ id: string; status: string; ledger_id: string; entry_date: string; description: string; memo: string | null; source_type: string }>(sql`
      SELECT id::text, status, ledger_id::text, entry_date::text, description, memo, source_type
        FROM journal_entry WHERE id = ${draftId}::uuid FOR UPDATE`)
    if (locked.length === 0) throw new PostingError('NO_ENTRY', 'That draft no longer exists.')

    const draft = locked[0]
    if (draft.status !== 'draft') {
      throw new PostingError('ALREADY_POSTED', 'That draft has already been posted.')
    }

    const lines = await tx.query.journalLine.findMany({
      where: eq(journalLine.entryId, draftId),
      orderBy: (l, { asc }) => [asc(l.lineNo)],
    })

    const { led, period, totalDebit } = await validateEntry(tx, {
      ledgerId: draft.ledger_id,
      entryDate: draft.entry_date,
      description: draft.description,
      lines: lines.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        description: l.description ?? undefined,
        dimensions: l.dimensions,
      })),
    })

    const prefix = ENTRY_PREFIX[draft.source_type as SourceType]
    if (!prefix) throw new PostingError('SOURCE_UNAVAILABLE', 'The module for this journal source is not installed.')
    const entryNo = await nextDocumentNumber(tx, led.entityId, prefix)

    const [posted] = await tx.update(journalEntry).set({
      status: 'posted',
      entryNo,
      periodId: period.id,
      currency: led.currency,
      totalDebit,
      totalCredit: totalDebit,
      postedAt: new Date(),
      postedBy: actor,
    }).where(and(eq(journalEntry.id, draftId), eq(journalEntry.status, 'draft'))).returning()

    if (!posted) throw new PostingError('ALREADY_POSTED', 'That draft was posted by something else.')

    await applyBalanceDeltas(tx, draft.ledger_id, period.id, lines.map((l) => ({
      accountId: l.accountId, amount: l.amount,
    })))

    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (${actor}, 'post', 'journal_entry', ${draftId},
              ${JSON.stringify({ status: 'draft' })}::jsonb,
              ${JSON.stringify({ status: 'posted', entryNo, totalDebit: totalDebit.toString() })}::jsonb,
              ${JSON.stringify({ periodId: period.id, from: 'draft' })}::jsonb)`)

    const [revision] = await tx.execute<{version:string}>(sql`SELECT COALESCE(to_jsonb(j)->>'version','1') AS version FROM journal_entry j WHERE id=${draftId}::uuid`)
    return {...posted,version:revision.version}
  })
}

export async function discardDraft(draftId: string, actor = 'system', ledgerId?: string, on: Runner = db) {
  await mustBeOurs('entry', draftId, ledgerId, (m) => new PostingError('NOT_OURS', m))
  const existing = await on.query.journalEntry.findFirst({ where: eq(journalEntry.id, draftId) })
  if (!existing) throw new PostingError('NO_ENTRY', 'That draft no longer exists.')
  if (existing.status !== 'draft') {
    throw new PostingError('NOT_DRAFT', 'Only a draft is discarded here — a live entry is deleted from its own page while its month is open.')
  }
  // The trigger writes the discard's audit row; the transaction says who.
  await actingAs(actor, (tx) => tx.delete(journalEntry).where(eq(journalEntry.id, draftId)), on)
  return existing
}

/**
 * Save what is on screen, then post it — the exact sequence both the Save and
 * Post buttons run, extracted so it can be tested.
 *
 * It ALWAYS returns the draft's id, including when posting is refused. That is
 * the whole point: the screen must send the id back on the next attempt, or
 * every retry of a rejected post writes another draft. This lived only in the
 * server action and the form component, where nothing could reach it, and the
 * check that claimed to guard it passed against the broken version.
 */
export async function saveThenPost(input: DraftInput, draftId?: string, on: Runner = db): Promise<
  | { ok: true; entryId: string; entryNo: string; version?:string }
  | { ok: false; entryId?: string; error: string; code: string; version?:string }
> {
  let saved
  try {
    saved = await saveDraft(input, draftId, on)
  } catch (e) {
    const err = e as PostingError
    return { ok: false, entryId: draftId, error: err.message, code: err.code ?? 'SAVE_FAILED' }
  }

  try {
    const posted = await postDraft(saved.id, input.actor ?? 'system', on)
    return { ok: true, entryId: posted.id, entryNo: posted.entryNo!,version:String(posted.version) }
  } catch (e) {
    const err = e as PostingError
    return { ok: false, entryId: saved.id, version:String(saved.version),error: err.message, code: err.code ?? 'POST_FAILED' }
  }
}

// ------------------------------------------------------------- year-end close --

/**
 * Close a fiscal year: move every revenue and expense balance into retained
 * earnings, so the next year starts from zero.
 *
 * Without this the balance sheet for any later year is out by exactly the
 * earlier year's profit. The detail lines carry balances accumulated since the
 * ledger began, while the current-earnings line carries only the year in
 * progress — so a result that was never closed sits in the assets and in
 * nothing on the other side.
 *
 * It is an ordinary entry: numbered, reversible, and refused if the period is
 * closed. Reversing it reopens the year, which is what correcting a filed year
 * requires.
 */
export async function closeFiscalYear(
  ledgerId: string, fiscalYearId: string, actor = 'system',
) {
  return db.transaction(async (tx) => {
    await acting(tx, actor)
    const [year] = await tx.execute<{
      name: string; end_date: string; status: string; period_id: string; period_status: string
    }>(sql`
      SELECT fy.name, fy.end_date::text, fy.status,
             fp.id::text AS period_id, fp.status AS period_status
        FROM fiscal_year fy
        JOIN fiscal_period fp ON fp.fiscal_year_id = fy.id
       WHERE fy.id = ${fiscalYearId}::uuid AND fy.ledger_id = ${ledgerId}::uuid
       ORDER BY fp.end_date DESC LIMIT 1`)
    if (!year) throw new PostingError('NO_YEAR', 'That fiscal year does not exist.')

    const already = await tx.execute<{ entry_no: string }>(sql`
      SELECT je.entry_no FROM journal_entry je
        JOIN fiscal_period fp ON fp.id = je.period_id
       WHERE fp.fiscal_year_id = ${fiscalYearId}::uuid
         AND je.source_type = 'period_close' AND je.status = 'posted'`)
    if (already.length > 0) {
      throw new PostingError('ALREADY_CLOSED',
        `${year.name} was already closed by ${already[0].entry_no}. ` +
        `To reopen it, use the year's heading on the Periods page.`)
    }

    // What each revenue and expense account holds for this year.
    const balances = await tx.execute<{ account_id: string; code: string; amount: string }>(sql`
      SELECT jl.account_id::text, a.code, SUM(jl.amount)::text AS amount
        FROM journal_entry je
        JOIN journal_line jl ON jl.entry_id = je.id
        JOIN account a ON a.id = jl.account_id
        JOIN fiscal_period fp ON fp.id = je.period_id
       WHERE je.ledger_id = ${ledgerId}::uuid
         AND je.status IN ('posted','reversed')
         AND fp.fiscal_year_id = ${fiscalYearId}::uuid
         AND a.account_type IN ('revenue','expense')
       GROUP BY jl.account_id, a.code
      HAVING SUM(jl.amount) <> 0
       ORDER BY a.code`)

    if (balances.length === 0) {
      throw new PostingError('NOTHING_TO_CLOSE',
        `${year.name} has no revenue or expense to close.`)
    }

    const [retained] = await tx.execute<{ id: string; code: string }>(sql`
      SELECT a.id::text, a.code FROM account a
        JOIN account_role ar ON ar.account_id = a.id
        JOIN ledger l ON l.id = ${ledgerId}::uuid AND l.entity_id = a.entity_id
       WHERE ar.role = ${ROLE.retainedEarnings} AND a.is_postable AND a.is_active
       LIMIT 1`)
    if (!retained) {
      throw new PostingError('NO_RETAINED_EARNINGS',
        'No account carries the "Retained earnings" role, so there is nowhere to close the year to. ' +
        'Tag one on the chart of accounts first.')
    }

    const result = balances.reduce((sum, b) => sum + BigInt(b.amount), 0n)

    // Each account is zeroed by the opposite of what it holds; the total goes
    // to retained earnings. Written out account by account so the entry reads
    // as a closing entry rather than a single mystery figure.
    const lines: PostEntryLine[] = balances.map((b) => ({
      accountId: b.account_id,
      amount: -BigInt(b.amount),
      description: `Close ${b.code}`,
    }))
    // A year that broke even needs no retained-earnings line, and must not have
    // one: journal_line forbids a zero amount, so appending it unconditionally
    // made a break-even year impossible to close. The closing lines alone
    // already zero every account and net to nil.
    if (result !== 0n) {
      lines.push({
        accountId: retained.id,
        amount: result,
        description: result < 0n ? 'Profit for the year' : 'Loss for the year',
      })
    }

    const posted = await postEntryCore(tx, {
      ledgerId,
      entryDate: year.end_date,
      description: `Closing entry — ${year.name}`,
      sourceType: 'period_close',
      actor,
      lines,
    })

    // Mark the year closed. Until now nothing ever set this, so 0006's
    // year-status gate was inert and reopenPeriod's "reopen the year first"
    // named an operation that did not exist.
    await tx.execute(sql`
      UPDATE fiscal_year SET status = 'closed' WHERE id = ${fiscalYearId}::uuid`)

    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
      VALUES (${actor}, 'close_year', 'fiscal_year', ${fiscalYearId},
              ${JSON.stringify({ entryNo: posted.entry.entryNo, accountsClosed: balances.length,
                                 result: result.toString() })}::jsonb,
              ${JSON.stringify({ year: year.name, retainedEarnings: retained.code })}::jsonb)`)

    return {
      year: year.name,
      entry: posted.entry,
      accountsClosed: balances.length,
      /** Signed: negative is a profit, since revenue is a credit. */
      result,
    }
  })
}

/**
 * Fiscal years that still hold P&L and have no closing entry.
 *
 * "Hold P&L" is judged per ACCOUNT, the way closeFiscalYear judges it: a
 * year whose revenue and expenses net to exactly zero still has accounts to
 * close and a year-end to mark. The old rule — a nonzero TOTAL — never
 * offered such a year, so a break-even year could be closed by the library
 * (P23) and never from the company page (whole-project audit, 2026-09-13).
 * `result` is the total, and may be 0.
 */
export async function unclosedYears(ledgerId: string) {
  return db.execute<{ id: string; name: string; end_date: string; result: string; status: string }>(sql`
    SELECT fy.id::text, fy.name, fy.end_date::text, fy.status, pl.total::text AS result
      FROM fiscal_year fy
      JOIN LATERAL (
        SELECT COALESCE(SUM(per_account.amount), 0) AS total,
               COUNT(*) > 0 AS any_account
          FROM (
            SELECT SUM(jl.amount) AS amount
              FROM fiscal_period fp
              JOIN journal_entry je ON je.period_id = fp.id AND je.status IN ('posted','reversed')
              JOIN journal_line jl ON jl.entry_id = je.id
              JOIN account a ON a.id = jl.account_id AND a.account_type IN ('revenue','expense')
             WHERE fp.fiscal_year_id = fy.id
             GROUP BY jl.account_id
            HAVING SUM(jl.amount) <> 0) per_account) pl ON true
     WHERE fy.ledger_id = ${ledgerId}::uuid
       AND pl.any_account
       AND NOT EXISTS (
         SELECT 1 FROM journal_entry c
           JOIN fiscal_period cp ON cp.id = c.period_id
          WHERE cp.fiscal_year_id = fy.id AND c.source_type = 'period_close' AND c.status = 'posted')
     ORDER BY fy.end_date`)
}

/**
 * Reopen a closed fiscal year by reversing its closing entry.
 *
 * The year's result goes back into the revenue and expense accounts it came
 * from, and the year's periods become closable again. Both entries stay: the
 * close and its reversal are part of the record.
 */
export async function reopenFiscalYear(
  ledgerId: string, fiscalYearId: string, reason: string, actor = 'system',
) {
  if (!reason.trim()) {
    throw new PostingError('NO_REASON',
      'Reopening a closed year undoes a figure that was treated as final. Say why.')
  }
  // The year beside the ledger is asked, as every id is (ours.ts): the first
  // screen for this door was gated on the ledger alone, and the id it posted
  // could have been any company's year (independent critic, 2026-09-13).
  await mustBeOurs('fiscal_year', fiscalYearId, ledgerId, (m) => new PostingError('NOT_OURS', m))

  const [closing] = await db.execute<{ id: string; entry_no: string }>(sql`
    SELECT je.id::text, je.entry_no FROM journal_entry je
      JOIN fiscal_period fp ON fp.id = je.period_id
      JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id AND fy.ledger_id = ${ledgerId}::uuid
     WHERE fp.fiscal_year_id = ${fiscalYearId}::uuid
       AND je.source_type = 'period_close' AND je.status = 'posted'`)
  if (!closing) {
    throw new PostingError('NOT_CLOSED', 'That year has no closing entry to reverse.')
  }

  const [year] = await db.execute<{ name: string; end_date: string }>(sql`
    SELECT name, end_date::text FROM fiscal_year
     WHERE id = ${fiscalYearId}::uuid AND ledger_id = ${ledgerId}::uuid`)

  // The year must be open for the reversal to post into it.
  await actingAs(actor, (tx) => tx.execute(sql`
    UPDATE fiscal_year SET status = 'open'
     WHERE id = ${fiscalYearId}::uuid AND ledger_id = ${ledgerId}::uuid`))

  try {
    const reversed = await reverseEntry(closing.id, year.end_date, `year reopened — ${reason.trim()}`, actor, ledgerId)
    await db.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (${actor}, 'reopen_year', 'fiscal_year', ${fiscalYearId},
              ${JSON.stringify({ status: 'closed', closedBy: closing.entry_no })}::jsonb,
              ${JSON.stringify({ status: 'open', reversedBy: reversed.reversal.entryNo })}::jsonb,
              ${JSON.stringify({ reason: reason.trim(), year: year.name })}::jsonb)`)
    return { year: year.name, reversal: reversed.reversal }
  } catch (e) {
    // Put the year back as it was rather than leaving it open on a failure.
    await actingAs(actor, (tx) => tx.execute(sql`
      UPDATE fiscal_year SET status = 'closed'
       WHERE id = ${fiscalYearId}::uuid AND ledger_id = ${ledgerId}::uuid`))
    throw e
  }
}

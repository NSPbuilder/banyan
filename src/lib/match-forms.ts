import 'server-only'
import {
  BankError, acceptMatches, belongsToLedger, deleteBankRow, finishReconciliation, ignoreBankRow, matchEntry,
  postFromBankRow, undoReconciliation, unignoreBankRow, unmatch, saveStatement, deleteStatement,
} from './bank'
import { MATCH_FIELDS as F } from './forms'
import { attachIfAny } from './attach-forms'
import { parseMoney } from './money'
import { MAX_BANK_SPLITS, type BankSplit } from './bank-splits'
import { causesOf } from './db-errors'
import { AttachmentError, attachStatementFile } from './attachments'
import { readStatementUpload } from './bank-statement-forms'

/**
 * What the reconcile screen's forms do, separated from the `'use server'`
 * actions that wrap them.
 *
 * Same reason as `tax-forms.ts` and `bank-forms.ts`: the wrapper calls
 * `revalidatePath` and drags in enough of React that no plain script can import
 * it, so the form handling would go untested. These take a `FormData` and return
 * a result, and a check builds the FormData from the same field names the
 * components render.
 */

export type MatchFormResult = { error?: string; ok?: string }

/** Cents on the wire, same rule as the import: a decimal point means dollars. */
const CENTS = /^-?\d{1,15}$/

const deepMessage = (e: unknown) => causesOf(e)

/**
 * The database guards raise named errors that Drizzle then wraps. Showing the
 * wrapper would tell nobody anything, and each of these is a different thing to
 * do about it — which is why they are separate sentences and not one.
 */
function readable(e: unknown): string | null {
  const m = deepMessage(e)
  if (m.includes('ENTRY_NOT_POSTED')) {
    return 'That entry is not posted. Only a posted entry can settle a bank row.'
  }
  if (m.includes('ENTRY_NOT_ON_ACCOUNT')) {
    return 'That entry has no line on this bank account.'
  }
  if (m.includes('ENTRY_OVER_MATCHED')) {
    return 'That entry is already claimed by other rows for everything it did here.'
  }
  if (m.includes('OVER_MATCHED')) return 'That is more than the row has left.'
  if (m.includes('MATCH_SIGN') || m.includes('ENTRY_SIGN')) {
    return 'That entry moved the account the other way.'
  }
  if (m.includes('ROW_IGNORED')) return 'That row was set aside. Put it back first.'
  if (m.includes('ROW_IS_MATCHED')) return 'Undo the match before setting this row aside.'
  if (m.includes('BANK_ROW_MATCHED')) return 'Undo the match first.'
  if (m.includes('PERIOD_CLOSED')) {
    return 'That row falls in a closed period. Reopen the period to post into it.'
  }
  // 0055 — the freeze and the Finish rules. Each names the date, because
  // "which reconciliation" is the thing the person has to go and undo.
  const frozen = reconciledSentence(m)
  if (frozen) return frozen
  if (m.includes('NOT_BALANCED')) {
    return 'The difference is not zero, so this statement cannot be finished yet. '
      + 'Every row on it must be matched or posted, and the import must be complete.'
  }
  if (m.includes('EARLIER_OPEN')) {
    return 'An earlier statement of this account is not finished. Reconciliations are finished in order.'
  }
  if (m.includes('ALREADY_FINISHED')) return 'The account is already reconciled through that date.'
  if (m.includes('NOT_THE_NEWEST')) {
    const when = /\((\d{4}-\d{2}-\d{2})\)/.exec(m)?.[1]
    return `Only the newest finished reconciliation${when ? ` (${when})` : ''} can be undone; the later ones rest on this one.`
  }
  if (m.includes('STATEMENT_IMMUTABLE')) return 'A statement cannot be edited. Delete it and enter it again.'
  return null
}

/**
 * The id in the form is this company's, or the handler does not run.
 *
 * `requireLedger` judged the ledger id in the form; this judges the other id
 * beside it against that ledger. Every handler in this file calls it before
 * touching anything — the refusal is the same sentence the gate uses, because
 * it is the same refusal.
 */
async function ours(
  formData: FormData, kind: 'row' | 'match' | 'statement' | 'account' | 'party', field: string,
): Promise<{ id: string } | { error: string }> {
  const id = String(formData.get(field) ?? '')
  const ledgerId = String(formData.get(F.ledgerId) ?? '')
  if (!id) return { error: 'Nothing was chosen.' }
  if (!(await belongsToLedger(kind, id, ledgerId))) {
    return { error: 'That is not in this company\'s books.' }
  }
  return { id }
}

/**
 * The freeze's refusal, in a sentence, naming the reconciliation to undo.
 * Exported because the same refusal reaches a person from three directions —
 * a bank form, an import, and deleting an entry the freeze holds a match on
 * (posting.ts releases matches) — and each used to have to spell it.
 */
export function reconciledSentence(text: string): string | null {
  if (!text.includes('RECONCILED:')) return null
  const when = /reconciliation of (\d{4}-\d{2}-\d{2})/.exec(text)?.[1]
  return `That is inside the finished reconciliation${when ? ` of ${when}` : ''}. Undo that reconciliation first.`
}

async function run(fn: () => Promise<string>): Promise<MatchFormResult> {
  try {
    return { ok: await fn() }
  } catch (e) {
    if (e instanceof BankError) return { error: e.message }
    const said = readable(e)
    if (said) return { error: said }
    // A PostingError carries its own sentence and is meant to be shown.
    const named = e as { name?: string; message?: string }
    if (['PostingError', 'TaggedLineError'].includes(named?.name ?? '') && named.message) return { error: named.message }
    throw e
  }
}

export async function matchFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const row = await ours(formData, 'row', F.rowId)
  if ('error' in row) return row
  const rowId = row.id
  const entryId = String(formData.get(F.entryId) ?? '')
  if (!entryId) return { error: 'Nothing was chosen to match.' }

  const raw = String(formData.get(F.amount) ?? '').trim()
  if (raw && !CENTS.test(raw)) {
    return { error: `Amounts cross as whole cents, and this one is "${raw}".` }
  }

  return run(async () => {
    await matchEntry({
      bankTransactionId: rowId, entryId,
      amount: raw ? BigInt(raw) : undefined,
      actor: actor,
    })
    return 'Matched.'
  })
}

export async function unmatchFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const m = await ours(formData, 'match', F.matchId)
  if ('error' in m) return m
  return run(async () => {
    await unmatch(m.id, actor)
    return 'Match undone.'
  })
}

export async function ignoreFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const row = await ours(formData, 'row', F.rowId)
  if ('error' in row) return row
  return run(async () => {
    await ignoreBankRow(row.id, String(formData.get(F.reason) ?? ''), actor)
    return 'Set aside.'
  })
}

export async function unignoreFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const row = await ours(formData, 'row', F.rowId)
  if ('error' in row) return row
  return run(async () => {
    await unignoreBankRow(row.id, actor)
    return 'Back in play.'
  })
}

/** A row imported by mistake, deleted — not one matched, set aside or reconciled (0084). */
export async function deleteRowFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const row = await ours(formData, 'row', F.rowId)
  if ('error' in row) return row
  return run(async () => {
    await deleteBankRow(row.id, actor)
    return 'Deleted. Import the right file again if the row belongs elsewhere.'
  })
}

export async function postFromRowForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const row = await ours(formData, 'row', F.rowId)
  if ('error' in row) return row
  const rowId = row.id
  const splitting = formData.get(F.splitMode) === 'yes'
  const contra = String(formData.get(F.contraAccountId) ?? '')
  let splits: BankSplit[] | undefined
  if (splitting) {
    const ids = formData.getAll(F.splitAccountId).map(String)
    const amounts = formData.getAll(F.splitAmount).map(String)
    if (ids.length < 2 || ids.length > MAX_BANK_SPLITS || ids.length !== amounts.length) {
      return { error: 'Split into 2 to 20 accounts, each with an amount.' }
    }
    splits = []
    for (let i = 0; i < ids.length; i++) {
      if (!ids[i] || !await belongsToLedger('account', ids[i], String(formData.get(F.ledgerId) ?? ''))) {
        return { error: 'Choose accounts from this company for every split.' }
      }
      try { splits.push({ accountId: ids[i], amount: parseMoney(amounts[i]) }) }
      catch { return { error: `Split ${i + 1}: enter a valid amount with at most two decimals.` } }
    }
  } else {
    if (!contra) return { error: 'Choose the account for the other side of the entry.' }
    const other = await ours(formData, 'account', F.contraAccountId)
    if ('error' in other) return other
  }

  // Whoever it was with goes through the same gate the account does — an id
  // in a form is an id in a form, and the rule design 19 records (RC37-45) is
  // that every one of them is checked against this company first. 0025's
  // trigger is the backstop, not the door (critic, 2026-09-07).
  const partyRaw = String(formData.get(F.partyId) ?? '').trim()
  if (partyRaw) {
    const who = await ours(formData, 'party', F.partyId)
    if ('error' in who) return who
  }

  return run(async () => {
    const posted = await postFromBankRow({
      bankTransactionId: rowId,
      contraAccountId: contra,
      splits,
      description: String(formData.get(F.description) ?? ''),
      partyId: partyRaw || undefined,
      taxCode: String(formData.get(F.taxCode) ?? '').trim() || undefined,
      actor: actor,
    })
    const paper = await attachIfAny(formData, {
      ledgerId: String(formData.get(F.ledgerId) ?? ''), entryId: posted.entryId, actor,
    })
    // Says what is true after the fact, not what was expected to happen: a
    // replay means nothing new was posted, and whether the row is settled now is
    // a separate question with its own answer.
    return (posted.replayed
      ? `That amount had already been posted as ${posted.entryNo ?? 'an entry'}; nothing new was created.`
      : `Posted as ${posted.entryNo ?? 'an entry'} and matched.`) + paper
  })
}

export async function saveStatementFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const statementDate = String(formData.get(F.statementDate) ?? '')
  const raw = String(formData.get(F.endingBalance) ?? '').trim()
  if (!statementDate) return { error: "The statement's date is needed." }
  if (!raw) return { error: "The statement's printed ending balance is needed." }
  let endingBalance: bigint
  try {
    endingBalance = parseMoney(raw)
  } catch {
    return { error: `"${raw}" does not read as an amount of money.` }
  }
  const acct = await ours(formData, 'account', F.accountId)
  if ('error' in acct) return acct
  let file: Awaited<ReturnType<typeof readStatementUpload>>
  try { file = await readStatementUpload(formData) } catch (e) {
    if (e instanceof AttachmentError) return { error: e.message }
    throw e
  }
  return run(async () => {
    const statement = await saveStatement({
      accountId: acct.id,
      statementDate, endingBalance, actor: actor,
    })
    if (file) {
      try {
        const saved = await attachStatementFile({ ...file, ledgerId: String(formData.get(F.ledgerId) ?? ''),
          accountId: acct.id, statementId: statement.id, actor })
        return saved.warning ? `Statement recorded. ${saved.warning}` : 'Statement recorded and file uploaded.'
      } catch (e) {
        console.error('Statement recorded; original upload failed', e)
        return 'Statement recorded. The file could not be uploaded; open this statement and upload it again.'
      }
    }
    return 'Statement recorded.'
  })
}

export async function deleteStatementFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const st = await ours(formData, 'statement', F.statementId)
  if ('error' in st) return st
  return run(async () => {
    await deleteStatement(st.id, actor)
    return 'Statement removed.'
  })
}

/**
 * The feed's batch accept: every row ticked whose suggestion is an exact
 * match. The rows are re-judged on the server; the form only says which.
 */
export async function acceptMatchesFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const acct = await ours(formData, 'account', F.accountId)
  if ('error' in acct) return acct
  const rowIds = formData.getAll(F.rowIds).map(String).filter(Boolean)
  if (rowIds.length === 0) return { error: 'Tick the rows to accept first.' }
  // Every ticked row must be this account's: `acceptMatches` reads the account's
  // rows and ignores ids that are not among them, so a foreign id can do nothing
  // — but the person should be told, not shown a skip.
  for (const id of rowIds) {
    if (!(await belongsToLedger('row', id, String(formData.get(F.ledgerId) ?? '')))) {
      return { error: 'That is not in this company\'s books.' }
    }
  }
  return run(async () => {
    const r = await acceptMatches({ accountId: acct.id, rowIds, actor })
    const why = Object.entries(r.skipped).map(([k, n]) => `${n} ${k}`).join(', ')
    if (r.accepted === 0) return `Nothing was accepted — ${why || 'nothing was ticked'}.`
    return `${r.accepted} match${r.accepted === 1 ? '' : 'es'} accepted`
      + (why ? `; skipped: ${why}.` : '.')
  })
}

export async function finishFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const st = await ours(formData, 'statement', F.statementId)
  if ('error' in st) return st
  return run(async () => {
    await finishReconciliation(st.id, actor)
    return 'Reconciled. Everything up to this statement is now frozen; undo it to change anything.'
  })
}

export async function undoFromForm(formData: FormData, actor: string): Promise<MatchFormResult> {
  const st = await ours(formData, 'statement', F.statementId)
  if ('error' in st) return st
  return run(async () => {
    await undoReconciliation(st.id, actor, String(formData.get(F.reason) ?? ''))
    return 'Reconciliation undone. Rows and matches up to this statement can be changed again.'
  })
}

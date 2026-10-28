import 'server-only'
import { parseMoney } from './money'
import { OpeningError, postOpeningBalance, type OpeningLine } from './opening'
import { OPENING_FIELDS as F, accountOf } from './forms'

/**
 * What the opening balance screen does, separated from the `'use server'` action
 * that wraps it — the same split as `tax-forms.ts`, `bank-forms.ts` and
 * `match-forms.ts`, and for the same reason: a wrapper that calls
 * `revalidatePath` cannot be imported by a plain script, so the form handling
 * would go untested.
 */

export type OpeningFormResult = { error?: string; ok?: string }

/**
 * Read one amount per account off the form.
 *
 * Keyed by account id, so a figure cannot land against the wrong account when
 * the page is re-rendered in a different order. Blank means no opening balance
 * for that account and is skipped; anything that is not a number is refused
 * naming the account, because a figure silently read as zero is a balance sheet
 * that is wrong by exactly that much.
 */
export function linesFrom(
  formData: FormData,
  nameOf: (accountId: string) => string,
): OpeningLine[] {
  const lines: OpeningLine[] = []
  for (const [field, value] of formData.entries()) {
    const accountId = accountOf(field)
    if (!accountId) continue
    const text = String(value).trim()
    if (!text) continue
    try {
      lines.push({ accountId, amount: parseMoney(text) })
    } catch {
      throw new OpeningError('BAD_AMOUNT',
        `"${text}" is not an amount — it was entered against ${nameOf(accountId)}.`)
    }
  }
  return lines
}

export async function openingFromForm(
  formData: FormData,
  /**
   * Turns an account id into something a person recognises, for the message
   * when a figure will not parse.
   *
   * Required, not defaulted. It used to default to the id, and the check that
   * said "refused, naming the account" passed because the harness handed in a
   * real map — while the shipped action passed none and put a uuid on screen.
   * A required parameter is a compile error instead of a check that agrees with
   * itself.
   */
  nameOf: (accountId: string) => string,
  actor: string,
): Promise<OpeningFormResult> {
  const ledgerId = String(formData.get(F.ledgerId) ?? '')
  const entryDate = String(formData.get(F.entryDate) ?? '')
  if (!ledgerId) return { error: 'No ledger was named.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    return { error: 'Choose the date the books start.' }
  }

  try {
    const result = await postOpeningBalance({
      ledgerId,
      entryDate,
      lines: linesFrom(formData, nameOf),
      balancingAccountId: String(formData.get(F.balancingAccountId) ?? '') || undefined,
      description: String(formData.get(F.description) ?? ''),
      actor,
    })

    if (result.difference === null) {
      return { ok: `Opening balances entered as ${result.entryNo ?? 'an entry'}. They balanced.` }
    }
    // Said out loud, every time. A difference that was absorbed without anyone
    // being told is the failure this whole screen is arranged around.
    const abs = result.difference < 0n ? -result.difference : result.difference
    return {
      ok: `Opening balances entered as ${result.entryNo ?? 'an entry'}, with `
        + `${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')} put to the difference `
        + `account as its own line.`,
    }
  } catch (e) {
    if (e instanceof OpeningError) return { error: e.message }
    const named = e as { name?: string; message?: string }
    if (named?.name === 'PostingError' && named.message) return { error: named.message }
    const m = e instanceof Error ? String(e.cause ?? e.message) : String(e)
    if (m.includes('BEFORE_OPENING')) {
      return { error: 'There are already entries dated before this. The opening balance has to be '
        + 'the earliest thing in the books — date it earlier, or reverse those entries.' }
    }
    if (m.includes('one_opening_balance_per_ledger')) {
      return { error: 'These books already have an opening balance. Reverse it before entering another.' }
    }
    throw e
  }
}

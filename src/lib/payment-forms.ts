import 'server-only'
import { type FormResult, attemptWith, g, PAYMENT_FIELDS as F } from './forms'
import { parseMoney } from './money'
import {
  PaymentError, applyEntryToInvoice, deletePayment, recordPayment, unapply,
} from './payments'
import { refuseUnlessOurs } from './ours'

/**
 * Reading the payments panel.
 *
 * Separate from `app/actions.ts` for the reason every *-forms.ts is: a check
 * can call this and cannot call a server action. When the two live in one
 * file, what gets checked is a function the shipped page never runs.
 */

export type { FormResult }


const attempt = (run: () => Promise<unknown>, ok: string) => attemptWith(run, ok, PaymentError)

function readAmount(f: FormData): bigint {
  const raw = g(f, F.amount)
  if (!raw) throw new PaymentError('NO_AMOUNT', 'How much? The amount is empty.')
  let cents: bigint
  try {
    cents = parseMoney(raw)
  } catch {
    throw new PaymentError('BAD_AMOUNT', `"${raw}" does not read as an amount of money.`)
  }
  if (cents <= 0n) {
    throw new PaymentError('NOT_POSITIVE', 'A payment is a positive amount of money.')
  }
  return cents
}

export async function payInvoiceFromForm(f: FormData, actor: string): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['invoice', g(f, F.invoiceId)], ['account', g(f, F.bankAccountId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(async () => {
    const bankAccountId = g(f, F.bankAccountId)
    const paidOn = g(f, F.paidOn)
    if (!bankAccountId) throw new PaymentError('NO_BANK', 'Which bank account did the money move through?')
    if (!paidOn) throw new PaymentError('NO_DATE', 'When was it paid?')
    await recordPayment({
      invoiceId: g(f, F.invoiceId),
      bankAccountId,
      amount: readAmount(f),
      paidOn,
      actor,
      reference: g(f, F.reference) || undefined,
    })
  }, 'Payment recorded.')
}

export async function applyCreditFromForm(f: FormData, actor: string): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['invoice', g(f, F.invoiceId)], ['entry', g(f, F.entryId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(async () => {
    const invoiceId = g(f, F.invoiceId)
    const entryId = g(f, F.entryId)
    if (!invoiceId) throw new PaymentError('NO_INVOICE', 'Which invoice is it applied to?')
    if (!entryId) throw new PaymentError('NO_ENTRY', 'There is no entry to apply.')
    await applyEntryToInvoice({ invoiceId, entryId, amount: readAmount(f), actor })
  }, 'Applied.')
}

export async function unapplyFromForm(f: FormData, actor: string): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['application', g(f, F.applicationId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(async () => {
    const applicationId = g(f, F.applicationId)
    if (!applicationId) throw new PaymentError('NO_APPLICATION', 'Which application?')
    await unapply(applicationId, actor)
  }, 'Unapplied. The balance is back.')
}

export async function deletePaymentFromForm(f: FormData, actor: string): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['entry', g(f, F.entryId)]], g(f, F.ledgerId))
  if (nope) return nope
  try {
    const entryId = g(f, F.entryId)
    if (!entryId) throw new PaymentError('NO_ENTRY', 'Which payment?')
    const gone = await deletePayment(entryId, actor)
    const bits = [`${gone.entryNo} deleted.`]
    if (gone.releasedApplications > 0) {
      bits.push(`${gone.releasedApplications} application(s) released — that debt is owed again.`)
    }
    if (gone.releasedMatches > 0) {
      bits.push(`${gone.releasedMatches} bank match(es) released — reconcile the row again.`)
    }
    bits.push('The audit log keeps the lines.')
    return { ok: bits.join(' ') }
  } catch (e) {
    if (e instanceof PaymentError) return { error: e.message }
    const msg = e instanceof Error ? e.message : String(e)
    return { error: msg.split('\n')[0].slice(0, 200) }
  }
}

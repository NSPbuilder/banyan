import 'server-only'
import {
  ceaseTax, correctRegistration, deleteRegistration, registerTax, RegistrationError, type TaxKind,
} from './registrations'
import { AccountError } from './accounts'
import { accountRowsFrom, TAX_FIELDS as F } from './forms'
import { refuseUnlessOurs } from './ours'

/**
 * What the sales tax forms do, separated from the Next.js action that wraps
 * them.
 *
 * The wrapper is `'use server'` and calls `revalidatePath`, which drags in
 * enough of React that a plain script cannot import it — so nothing could
 * exercise the form-handling code, and it went untested: renaming one field in
 * the component broke every cease from the browser with all 41 checks green.
 *
 * These take a `FormData` and return a result. A test can build the FormData
 * from the same `TAX_FIELDS` the component renders and drive the real parsing.
 */
export type TaxFormResult = { error?: string; ok?: string }

export async function registerTaxFromForm(formData: FormData, actor: string): Promise<TaxFormResult> {
  const nope = await refuseUnlessOurs([['entity', String(formData.get(F.entityId) ?? '')]], String(formData.get(F.ledgerId) ?? ''))
  if (nope) return nope
  const accounts = accountRowsFrom(formData)

  try {
    const result = await registerTax({
      entityId: String(formData.get(F.entityId) ?? ''),
      tax: String(formData.get(F.tax) ?? '') as TaxKind,
      number: String(formData.get(F.number) ?? ''),
      registeredOn: String(formData.get(F.registeredOn) ?? ''),
      accounts, actor,
    })
    return {
      ok: result.created.length > 0
        ? `Registered. Created ${result.created.join(' and ')}.`
        : 'Registered. The accounts for this tax already existed, so nothing was added.',
    }
  } catch (e) {
    if (e instanceof RegistrationError || e instanceof AccountError) return { error: e.message }
    throw e
  }
}

export async function ceaseTaxFromForm(formData: FormData, actor: string): Promise<TaxFormResult> {
  const nope = await refuseUnlessOurs([['registration', String(formData.get(F.registrationId) ?? '')]], String(formData.get(F.ledgerId) ?? ''))
  if (nope) return nope
  try {
    const done = await ceaseTax(
      String(formData.get(F.registrationId) ?? ''),
      String(formData.get(F.ceasedOn) ?? ''), actor)
    return { ok: `Registration ${done.number} ends ${done.ceasedOn}. The accounts stay.${done.outside ? ` ${done.outside}.` : ''}` }
  } catch (e) {
    if (e instanceof RegistrationError) return { error: e.message }
    throw e
  }
}

/**
 * A registration entered wrong, put right — its number, start and end, where an
 * empty end means still registered (0084).
 */
export async function correctRegistrationFromForm(formData: FormData, actor: string): Promise<TaxFormResult> {
  const id = String(formData.get(F.registrationId) ?? '')
  const nope = await refuseUnlessOurs([['registration', id]], String(formData.get(F.ledgerId) ?? ''))
  if (nope) return nope
  const typed = (field: string) => String(formData.get(field) ?? '')
  try {
    const done = await correctRegistration({
      registrationId: id, number: typed(F.number), registeredOn: typed(F.registeredOn), ceasedOn: typed(F.ceasedOn), actor,
    })
    return {
      ok: `Saved: ${done.number}, from ${done.registeredOn}${done.ceasedOn ? ` to ${done.ceasedOn}` : ', still registered'}.`
        + (done.renumbered ? ' Documents printed from now on carry the new number, including reprints of ones already sent.' : '')
        + (done.outside ? ` ${done.outside}.` : ''),
    }
  } catch (e) {
    if (e instanceof RegistrationError) return { error: e.message }
    throw e
  }
}

/** A registration entered by mistake, removed. Its accounts stay (0084). */
export async function deleteRegistrationFromForm(formData: FormData, actor: string): Promise<TaxFormResult> {
  const registrationId = String(formData.get(F.registrationId) ?? '')
  const refused = await refuseUnlessOurs([['registration', registrationId]], String(formData.get(F.ledgerId) ?? ''))
  if (refused) return refused
  try {
    const gone = await deleteRegistration(registrationId, actor)
    return { ok: `Deleted the registration ${gone.number}. Its accounts stay, with anything posted to them.` }
  } catch (e) {
    if (e instanceof RegistrationError) return { error: e.message }
    throw e
  }
}

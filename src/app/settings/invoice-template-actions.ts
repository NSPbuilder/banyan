'use server'

import { revalidatePath } from 'next/cache'
import { requireUser, requireLedger } from '@/lib/gate'
import type { FormState } from '@/app/actions'
import { createInvoiceTemplate, InvoiceTemplateError, reviseInvoiceTemplate, setInvoiceTemplateAccess, setInvoiceTemplateAssignment } from '@/lib/invoice-templates'
import { INVOICE_LOGO_MAX_BYTES, type InvoiceTemplateSettings } from '@/lib/invoice-template-types'

const g = (form: FormData, key: string) => String(form.get(key) ?? '')
async function settings(form: FormData): Promise<InvoiceTemplateSettings> {
  let logoDataUrl = g(form, 'logoDataUrl')
  const logo = form.get('logo')
  if (logo instanceof File && logo.size) {
    if (logo.size > INVOICE_LOGO_MAX_BYTES || !['image/png', 'image/jpeg'].includes(logo.type)) throw new InvoiceTemplateError('BAD_LOGO', 'Choose a PNG or JPEG logo up to 256 KB.')
    logoDataUrl = `data:${logo.type};base64,${Buffer.from(await logo.arrayBuffer()).toString('base64')}`
  }
  return { layout: g(form, 'layout') as InvoiceTemplateSettings['layout'], paymentInstructions: g(form, 'paymentInstructions'), footer: g(form, 'footer'), logoDataUrl,
    contact: {address: g(form, 'address'), city: g(form, 'city'), province: g(form, 'province'), postalCode: g(form, 'postalCode'), officePhone: g(form, 'officePhone'), cellPhone: g(form, 'cellPhone'), email: g(form, 'email')} }
}
function changed() {
  revalidatePath('/settings')
  revalidatePath('/settings/invoice-templates')
  revalidatePath('/ledger/[ledgerId]/invoices', 'layout')
}
const failure = (e: unknown): FormState => {
  if (e instanceof InvoiceTemplateError) return { error: e.message }
  throw e
}

export async function createTemplateAction(_previous: FormState, form: FormData): Promise<FormState> {
  const me = await requireUser()
  try {
    const id = await createInvoiceTemplate(me, { entityId: g(form, 'entityId'), name: g(form, 'name'), settings: await settings(form) })
    changed(); return { ok: 'Template created.', madeId: id }
  } catch (e) { return failure(e) }
}
export async function reviseTemplateAction(_previous: FormState, form: FormData): Promise<FormState> {
  const me = await requireUser(), ledgerId = g(form, 'ledgerId')
  if (ledgerId) await requireLedger(ledgerId, '/invoices')
  try {
    const version = await reviseInvoiceTemplate(me, { templateId: g(form, 'templateId'), version: Number(g(form, 'version')), name: g(form, 'name'), settings: await settings(form), isActive: g(form, 'isActive') === 'on', ledgerId: ledgerId || undefined })
    changed(); return { ok: `Template saved as v${version}.` }
  } catch (e) { return failure(e) }
}
export async function templateAccessAction(_previous: FormState, form: FormData): Promise<FormState> {
  const me = await requireUser()
  try {
    const revoke = g(form, 'operation') === 'revoke'
    await setInvoiceTemplateAccess(me, { templateId: g(form, 'templateId'), entityId: g(form, 'entityId'), canUse: g(form, 'canUse') === 'on', canEdit: g(form, 'canEdit') === 'on', revoke })
    changed(); return { ok: revoke ? 'Company access revoked.' : 'Company access saved.' }
  } catch (e) { return failure(e) }
}
export async function templateAssignmentAction(_previous: FormState, form: FormData): Promise<FormState> {
  const ledgerId = g(form, 'ledgerId'), me = await requireLedger(ledgerId, '/invoices')
  try {
    await setInvoiceTemplateAssignment(me, { ledgerId, partyId: g(form, 'partyId') || undefined, templateId: g(form, 'templateId') || undefined })
    changed(); return { ok: 'Default template saved.' }
  } catch (e) { return failure(e) }
}

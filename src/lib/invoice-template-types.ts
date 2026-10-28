/** Client-safe invoice paper configuration. Company/customer/accounting data stays in the books. */
export type InvoiceTemplateSettings = {
  layout: 'standard' | 'compact'
  paymentInstructions: string
  footer: string
  /** Embedded presentation asset; immutable versions and invoice snapshots retain its bytes. */
  logoDataUrl?: string
  contact?: InvoiceTemplateContact
}
export type InvoiceTemplateContact = {
  address: string; city: string; province: string; postalCode: string
  officePhone: string; cellPhone: string; email: string
}
export const INVOICE_CONTACT_LIMITS = {address: 200, city: 80, province: 80, postalCode: 20, officePhone: 40, cellPhone: 40, email: 254} as const
export const INVOICE_LOGO_MAX_BYTES = 256 * 1024
export const INVOICE_LOGO_MAX_DATA_URL = Math.ceil(INVOICE_LOGO_MAX_BYTES / 3) * 4 + 32
/** Client-safe allowlist. Never render an external URL, SVG or arbitrary data URI. */
export function invoiceLogoDataUrl(settings?: InvoiceTemplateSettings): string | undefined {
  const value = settings?.logoDataUrl
  return typeof value === 'string' && value.length <= INVOICE_LOGO_MAX_DATA_URL && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined
}
/** HTML and PDF share the same header lines; tax registrations still come from the books. */
export function invoiceContactLines(settings: InvoiceTemplateSettings | undefined, registeredAddress: string[]): string[] {
  const c = settings?.contact
  if (!c) return registeredAddress
  const customAddress = [c.address, [c.city, c.province, c.postalCode].filter(Boolean).join(' ')].filter(Boolean)
  return [
    ...(customAddress.length ? customAddress.flatMap(line => line.split('\n')) : registeredAddress),
    ...(c.officePhone ? ['Office: ' + c.officePhone] : []),
    ...(c.cellPhone ? ['Cell: ' + c.cellPhone] : []),
    ...(c.email ? [c.email] : []),
  ]
}
export type InvoiceTemplateSnapshot = {
  templateId: string | null
  name: string
  version: number
  settings: InvoiceTemplateSettings
  /** Per-invoice paper prose, editable through Project; never an accounting schedule. */
  paymentStages?: string
}
export type InvoiceTemplate = {
  id: string; entity_id: string; owner_name: string; name: string
  is_active: boolean; current_version: number; settings: InvoiceTemplateSettings
}
export type TemplateCompanyAccess = { entity_id: string; name: string; can_use: boolean; can_edit: boolean }
export type AvailableInvoiceTemplate = InvoiceTemplate & { can_edit: boolean }
export type InvoiceTemplateAssignment = { party_id: string | null; party_name: string | null; template_id: string; template_name: string }

export const STANDARD_INVOICE_SETTINGS: InvoiceTemplateSettings = { layout: 'standard', paymentInstructions: '', footer: '' }
export function standardInvoiceSnapshot(): InvoiceTemplateSnapshot {
  return { templateId: null, name: 'System standard', version: 0, settings: { ...STANDARD_INVOICE_SETTINGS } }
}

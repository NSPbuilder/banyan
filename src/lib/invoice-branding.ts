import 'server-only'
import {PDFDocument} from 'pdf-lib'
import {validateInboxFile} from './inbox-file'
import {INVOICE_CONTACT_LIMITS, INVOICE_LOGO_MAX_BYTES, INVOICE_LOGO_MAX_DATA_URL, type InvoiceTemplateContact} from './invoice-template-types'

export class InvoiceBrandingError extends Error {
  constructor(readonly code: 'BAD_LOGO' | 'BAD_CONTACT', message: string) {super(message); this.name = 'InvoiceBrandingError'}
}
/** Validate stored snapshots too: PDFKit is only ever handed verified in-memory bytes. */
export async function parseInvoiceLogo(value?: string) {
  if (value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > INVOICE_LOGO_MAX_DATA_URL) throw new InvoiceBrandingError('BAD_LOGO', 'Choose a PNG or JPEG logo up to 256 KB.')
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) throw new InvoiceBrandingError('BAD_LOGO', 'Choose a PNG or JPEG image; links, SVG and Illustrator files must be exported first.')
  const bytes = Buffer.from(match[2], 'base64'), mime = 'image/' + match[1]
  if (!bytes.length || bytes.length > INVOICE_LOGO_MAX_BYTES || bytes.toString('base64') !== match[2]) throw new InvoiceBrandingError('BAD_LOGO', 'Choose a complete PNG or JPEG logo up to 256 KB.')
  if (match[1] === 'png' && bytes.length >= 24 && bytes.subarray(12, 16).toString() === 'IHDR' && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 2_000_000)
    throw new InvoiceBrandingError('BAD_LOGO', 'Choose a logo no larger than 2 megapixels.')
  try {
    await validateInboxFile('logo.' + (match[1] === 'png' ? 'png' : 'jpg'), mime, bytes)
    const doc = await PDFDocument.create(), image = match[1] === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
    if (image.width * image.height > 2_000_000 || image.width > 4096 || image.height > 4096) throw new InvoiceBrandingError('BAD_LOGO', 'Choose a logo no larger than 2 megapixels and 4096 pixels per side.')
    return {bytes, width: image.width, height: image.height}
  } catch (error) {
    if (error instanceof InvoiceBrandingError) throw error
    throw new InvoiceBrandingError('BAD_LOGO', 'The logo is malformed or its contents do not match its PNG/JPEG type. Export a readable image.')
  }
}
export function normalizeInvoiceContact(contact?: InvoiceTemplateContact): InvoiceTemplateContact | undefined {
  if (contact === undefined) return undefined
  if (!contact || typeof contact !== 'object' || Array.isArray(contact)) throw new InvoiceBrandingError('BAD_CONTACT', 'Enter the company contact information in the template fields.')
  const clean = {} as InvoiceTemplateContact
  for (const key of Object.keys(INVOICE_CONTACT_LIMITS) as Array<keyof InvoiceTemplateContact>) {
    const raw = contact[key] ?? ''
    if (typeof raw !== 'string') throw new InvoiceBrandingError('BAD_CONTACT', 'Contact fields must contain text.')
    const text = raw.replace(/\r\n?/g, '\n').trim()
    if (text.length > INVOICE_CONTACT_LIMITS[key] || /[\x00-\x09\x0b-\x1f\x7f]/.test(text) || (key !== 'address' && text.includes('\n')) || (key === 'address' && text.split('\n').length > 3))
      throw new InvoiceBrandingError('BAD_CONTACT', 'Keep contact fields within the displayed limits; the address allows up to three lines. Control characters are not allowed.')
    clean[key] = text
  }
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) throw new InvoiceBrandingError('BAD_CONTACT', 'Enter a valid contact email address.')
  return Object.values(clean).some(Boolean) ? clean : undefined
}

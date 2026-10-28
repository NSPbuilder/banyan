import { formatNative } from './fx-money'
import type { InvoiceDocument } from './customer-docs'
import { formatMoney } from './money'

const dateFormat = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })

/** Invoice dates are calendar dates, independent of the viewer's timezone. */
export function invoiceDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(value + 'T12:00:00Z')
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date)
}

export function invoiceAmount(amount: bigint, currency?: string): string {
  if(currency && !['CAD','USD'].includes(currency)) return `${formatNative(amount,currency)} ${currency}`
  const value = (amount < 0n ? '-$' : '$') + formatMoney(amount < 0n ? -amount : amount)
  return currency ? `${value} ${currency}` : value
}

/** Presentation only: tax amounts are the posted lines, never recalculated rates. */
export function invoicePaper(doc: InvoiceDocument) {
  const taxes = doc.lines.filter(line => line.generatedFor === 'GST' || line.generatedFor === 'PST')
  const items = doc.lines.filter(line => !taxes.includes(line))
  const summary: Array<{ label: string; amount: bigint; emphasis?: boolean; balance?: boolean }> = []
  if (taxes.length) {
    summary.push({ label: 'Subtotal', amount: items.reduce((sum, line) => sum + line.amount, 0n) })
    summary.push(...taxes.map(line => ({ label: line.description || line.generatedFor!, amount: line.amount })))
  }
  summary.push({ label: 'Total', amount: doc.total, emphasis: true })
  if (doc.receipt) return { items, summary,
    headline: `${invoiceAmount(doc.receipt.amountPaid, doc.currency)} paid on ${invoiceDate(doc.receipt.paidOn)}` }
  if (doc.payments.length) summary.push({
    label: doc.kind === 'credit_note' ? 'Credit applied' : 'Amount paid',
    amount: doc.payments.reduce((sum, payment) => sum + payment.amount, 0n),
  })
  summary.push({ label: doc.kind === 'credit_note' ? 'Remaining credit' : 'Amount due', amount: doc.balance, emphasis: true, balance: true })
  const balance = invoiceAmount(doc.balance, doc.currency)
  const headline = doc.kind === 'credit_note' ? `${balance} remaining credit`
    : doc.balance === 0n ? `${invoiceAmount(doc.total, doc.currency)} paid in full`
    : `${balance} due ${invoiceDate(doc.dueOn)}`
  return { items, summary, headline }
}

import type { InvoiceDocument } from './customer-docs'
import type { InvoiceTemplateSnapshot } from './invoice-template-types'

/** Clearly marked sample data; never saved to the ledger. */
export function invoiceTemplateSample(companyName: string, today: string, template: InvoiceTemplateSnapshot): InvoiceDocument {
  return {
    kind: 'invoice', title: 'Invoice', number: 'SAMPLE-001', issuedOn: today, dueOn: today, currency: 'CAD',
    company: { name: companyName, addressLines: [], taxNumbers: [] },
    billTo: { name: 'Sample customer', addressLines: ['100 Sample Street', 'Vancouver BC V0X 0X0'] },
    lines: [{ description: 'Professional services (sample)', amount: 125000n }, { description: 'GST (sample)', amount: 6250n, generatedFor: 'GST' }],
    total: 131250n, payments: [], balance: 131250n, template,
  }
}

/** Synthetic paper fixtures; this process never reads or writes a database. */
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PDFDocument } from 'pdf-lib'
import type { InvoiceDocument } from '../src/lib/customer-docs'
import { standardInvoiceSnapshot } from '../src/lib/invoice-template-types'
import { invoicePaper } from '../src/lib/invoice-paper'

const evidence = process.env.STAGES_EVIDENCE_DIR || 'docs/evidence/project-payment-stages'
mkdirSync(evidence, { recursive: true })
require.extensions['.css'] = (module, file) => {
  module.exports = Object.fromEntries([...readFileSync(file, 'utf8').matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => [match[1], match[1]]))
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { InvoiceDocView } = require('../src/app/ledger/[ledgerId]/invoices/[invoiceId]/print/InvoiceDocView') as typeof import('../src/app/ledger/[ledgerId]/invoices/[invoiceId]/print/InvoiceDocView')
const stages = ['Deposit: 30% on confirmation', 'Progress payment: 40% after stage 1', 'Final payment: 30% on completion'].join(String.fromCharCode(10))
const base: InvoiceDocument = { kind: 'invoice', title: 'Invoice', number: 'SAMPLE-1001', currency: 'CAD', issuedOn: '2026-10-01', dueOn: '2026-11-01', company: { name: 'Sample Company', addressLines: ['100 Example Street'], taxNumbers: [] }, billTo: { name: 'Sample Customer', addressLines: ['200 Example Street'] }, lines: [{ description: 'Project services', amount: 100000n }], total: 100000n, balance: 100000n, payments: [], template: { ...standardInvoiceSnapshot(), settings: { ...standardInvoiceSnapshot().settings, paymentInstructions: 'Pay by bank transfer.', footer: 'Thank you.' } } }
const staged: InvoiceDocument = { ...base, template: { ...base.template!, paymentStages: stages } }
const longStages = Array.from({ length: 70 }, (_, i) => `Stage ${i + 1}: ${'x'.repeat(35)}`).join(String.fromCharCode(10))
assert(longStages.length <= 4000)
const docs: Record<string, InvoiceDocument> = {
  plain: base, standard: staged,
  compact: { ...staged, template: { ...staged.template!, settings: { ...staged.template!.settings, layout: 'compact' } } },
  receipt: { ...staged, title: 'Receipt', receipt: { number: 'R-INTERNAL-1', paidOn: '2026-10-15', amountPaid: 30000n, direction: 'received', invoiceNumber: base.number } },
  credit: { ...staged, kind: 'credit_note', title: 'Credit note', number: 'SAMPLE-CN-1' },
  escaped: { ...staged, template: { ...staged.template!, paymentStages: 'Deposit: <confirmation> & agreement' } },
  long: { ...staged, template: { ...staged.template!, paymentStages: longStages } },
}
let checks = 0
const pass = (label: string) => { checks++; console.log('PASS ' + label) }
async function main() {
  assert.deepEqual(invoicePaper(base), invoicePaper(staged)); pass('paper stages never enter invoice numeric summaries or payment history')
  for (const [name, doc] of Object.entries(docs)) {
    const visible = !['plain', 'receipt', 'credit'].includes(name)
    const html = renderToStaticMarkup(createElement(InvoiceDocView, { doc: { ...doc, note: 'PRIVATE INTERNAL NOTE' } as InvoiceDocument, controls: false }))
    assert.equal(html.includes('aria-label="Payment stages"'), visible); assert(!html.includes('PRIVATE INTERNAL NOTE'))
    if (name === 'escaped') { assert(html.includes('&lt;confirmation&gt; &amp; agreement')); assert(!html.includes('<confirmation>')) }
    if (name === 'standard' || name === 'compact') for (const line of stages.split(String.fromCharCode(10))) assert(html.includes(line))
    assert(html.includes('Pay by bank transfer.') && html.includes('Thank you.'))
    writeFileSync(`${evidence}/${name}.html`, html); pass(name + ' HTML stage visibility, internal-note privacy and template prose are correct')
    const source = "const {renderInvoicePdf}=require('./src/lib/invoice-pdf');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',async()=>{try{const doc=JSON.parse(input,(_,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.cents==='string'?BigInt(v.cents):v);process.stdout.write(await renderInvoicePdf(doc))}catch(e){console.error(e);process.exitCode=1}})"
    const bytes = execFileSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '-e', source], { input: JSON.stringify(doc, (_, value) => typeof value === 'bigint' ? { cents: String(value) } : value), maxBuffer: 10 * 1024 * 1024 })
    const file = `${evidence}/${name}.pdf`; writeFileSync(file, bytes)
    const pdf = await PDFDocument.load(bytes), text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' })
    assert.equal(text.includes('Payment stages'), visible); assert(!text.includes('PRIVATE INTERNAL NOTE'))
    assert(text.includes('Pay by bank transfer.') && text.includes('Thank you.'))
    if (name === 'standard' || name === 'compact') for (const phrase of ['Deposit: 30%', 'Progress payment: 40%', 'Final payment: 30%']) assert(text.includes(phrase))
    if (name === 'long') { assert(pdf.getPageCount() > 1); assert(text.includes('Stage 70:')) }
    pass(name + ' PDF has the expected stages and preserves existing prose with valid pagination')
  }
  writeFileSync(`${evidence}/presentation.json`, JSON.stringify({ checks, passed: true, syntheticOnly: true, databaseReadsOrWrites: false }, null, 2) + String.fromCharCode(10))
  console.log(`=== ALL CHECKS PASSED (${checks} paper cases) ===`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })

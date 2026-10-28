/** Synthetic presentation fixtures only; no database read or mutation. */
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PDFDocument } from 'pdf-lib'
import dotenv from 'dotenv'
import type { InvoiceDocument } from '../src/lib/customer-docs'
import { pdfText } from './pdf-text'

dotenv.config({ path: '.env.local', quiet: true })
const group = process.argv.find(arg => arg.startsWith('--only='))?.slice(7)
const evidence = process.env.RECEIPT_PRESENTATION_EVIDENCE || 'docs/evidence/receipt-presentation'
mkdirSync(evidence, { recursive: true })
require.extensions['.css'] = (module, file) => {
  module.exports = Object.fromEntries([...readFileSync(file, 'utf8').matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => [match[1], match[1]]))
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { InvoiceDocView } = require('../src/app/ledger/[ledgerId]/invoices/[invoiceId]/print/InvoiceDocView') as typeof import('../src/app/ledger/[ledgerId]/invoices/[invoiceId]/print/InvoiceDocView')
const internalNumber = 'R-INTERNAL-ONLY-928471'
const linked: InvoiceDocument = {
  kind: 'invoice', title: 'Receipt', number: 'PUBLIC-1001', currency: 'CAD', issuedOn: '2026-10-01', dueOn: '2026-11-01',
  company: { name: 'Sample Company', addressLines: ['100 Example Street'], taxNumbers: ['GST/HST SAMPLE'] },
  billTo: { name: 'Sample Customer', addressLines: ['200 Example Street'] },
  lines: [{ description: 'Project services', amount: 100000n }, { description: 'GST/HST', amount: 5000n, generatedFor: 'GST' }, { description: 'PST', amount: 7000n, generatedFor: 'PST' }],
  total: 112000n, balance: 0n,
  payments: [{ on: '2026-10-10', what: '', amount: 20000n }, { on: '2026-10-20', what: '', amount: 30000n }],
  receipt: { number: internalNumber, paidOn: '2026-10-20', amountPaid: 30000n, direction: 'received', invoiceNumber: 'PUBLIC-1001' },
}
const unlinked: InvoiceDocument = { ...linked, number: null, receipt: { ...linked.receipt!, invoiceNumber: null } }
const long: InvoiceDocument = { ...linked, payments: Array.from({ length: 90 }, (_, i) => ({ on: `2026-10-${String(i % 28 + 1).padStart(2, '0')}`, what: '', amount: 100n })) }
const documents = { linked, unlinked, long }
let checks = 0
const pass = (label: string) => { console.log('PASS ' + label); checks++ }
async function main() {
  for (const [name, doc] of Object.entries(documents)) {
    if (!group || group === 'html') {
      const html = renderToStaticMarkup(createElement(InvoiceDocView, { doc, controls: false }))
      assert(!html.includes(internalNumber) && !html.includes('Receipt number'))
      assert(html.includes('Date paid') && html.includes('Payment history'))
      assert.equal(html.includes('Invoice number'), name !== 'unlinked')
      if (name !== 'unlinked') assert(html.includes('PUBLIC-1001'))
      writeFileSync(`${evidence}/${name}.html`, html)
      pass(name + ' HTML hides internal receipt identity and retains public payment details')
    }
    if (!group || group === 'pdf' || group === 'filename') {
      const wrapper = group === 'filename'
      const child = wrapper
        ? "const {invoicePaperPdf}=require('./src/lib/pdf-reports'); const {sql}=require('./src/db/client');"
        : "const {renderInvoicePdf}=require('./src/lib/invoice-pdf');"
      const result = execFileSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '-e', child +
        "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',async()=>{try{const doc=JSON.parse(input,(_,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.cents==='string'?BigInt(v.cents):v);" +
        (wrapper ? "const pdf=await invoicePaperPdf(doc);process.stdout.write(pdf.filename);await sql.end();" : "process.stdout.write(await renderInvoicePdf(doc));") +
        "}catch(error){console.error(error);process.exitCode=1}})"], {
        input: JSON.stringify(doc, (_, value) => typeof value === 'bigint' ? { cents: String(value) } : value), maxBuffer: 10 * 1024 * 1024,
      })
      if (wrapper) {
        const filename = result.toString()
        assert(!filename.includes(internalNumber)); assert(filename.includes('2026-10-20'))
        assert.equal(filename.includes('PUBLIC-1001'), name !== 'unlinked')
        pass(name + ' download filename uses public invoice/date without internal receipt identity')
      } else {
        const pdf = await PDFDocument.load(result), text = pdfText(result)
        assert(!text.includes(internalNumber) && !text.includes('Receipt number'))
        assert(!pdf.getTitle()?.includes(internalNumber)); assert(text.includes('Date paid') && text.includes('Payment history'))
        assert.equal(text.includes('Invoice number'), name !== 'unlinked')
        if (name === 'long') assert(pdf.getPageCount() > 1)
        writeFileSync(`${evidence}/${name}.pdf`, result)
        pass(name + ' PDF body, metadata and continuation headers hide internal receipt identity')
      }
    }
  }
  assert.equal(linked.receipt!.number, internalNumber, 'internal data is preserved')
  writeFileSync(`${evidence}/presentation-result${group ? '-' + group : ''}.json`, JSON.stringify({ checks, passed: true, syntheticOnly: true, noDatabaseReadsOrWrites: true }, null, 2) + '\n')
  console.log(`=== ALL CHECKS PASSED (${checks} presentation cases) ===`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })

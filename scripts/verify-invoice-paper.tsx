/** Read-only fixtures: this suite never imports the database or changes real invoices. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { chromium } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import type { InvoiceDocument } from '../src/lib/customer-docs'
import { invoicePaper, invoiceDate } from '../src/lib/invoice-paper'
import { standardInvoiceSnapshot } from '../src/lib/invoice-template-types'
import { pdfText } from './pdf-text'

const directory = 'docs/evidence/invoice-paper-redesign'
const cssPath = 'src/app/ledger/[ledgerId]/invoices/[invoiceId]/print/InvoiceDocView.module.css'
// Node has no CSS loader; use the exact module stylesheet with unmangled local names.
require.extensions['.css'] = (module, filename) => {
  const css = readFileSync(filename, 'utf8')
  module.exports = Object.fromEntries(Array.from(css.matchAll(/\.([a-zA-Z][\w-]*)/g), m => [m[1], m[1]]))
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { InvoiceDocView } = require('../src/app/ledger/[ledgerId]/invoices/[invoiceId]/print/InvoiceDocView') as typeof import('../src/app/ledger/[ledgerId]/invoices/[invoiceId]/print/InvoiceDocView')

async function main() {
  mkdirSync(directory, { recursive: true })
  mkdirSync('output/pdf', { recursive: true })
  const template = standardInvoiceSnapshot()
  template.settings.logoDataUrl = 'data:image/png;base64,' + readFileSync('scripts/fixtures/branding/test-logo.png').toString('base64')
  const sample: InvoiceDocument = {
    kind: 'invoice', title: 'Invoice', number: 'SAMPLE-001', issuedOn: '2026-10-01', dueOn: '2026-10-31', currency: 'CAD', template,
    company: { name: 'VIEWMAX (sample)', addressLines: ['100 Business Avenue', 'Vancouver BC V0X 0X0', 'contact@example.test'], taxNumbers: ['GST/HST 123456789RT0001'] },
    billTo: { name: 'Sample customer', addressLines: ['100 Sample Street', 'Richmond BC V0X 0X0'] },
    lines: [{ description: 'Professional services\nOctober 2026', amount: 125000n }, { description: 'GST', amount: 6250n, generatedFor: 'GST' }, { description: 'PST', amount: 8750n, generatedFor: 'PST' }],
    total: 140000n, payments: [], balance: 140000n,
  }
  const paper = invoicePaper(sample)
  assert.equal(paper.items.length, 1)
  assert.equal(paper.summary.filter(r => r.label !== 'Total' && !r.balance).reduce((sum, r) => sum + r.amount, 0n), sample.total)
  assert.equal(invoiceDate('2026-10-01'), 'October 1, 2026')
  assert.equal(invoiceDate('invalid'), 'invalid')
  const legacy = { ...sample, template: undefined, currency: undefined, lines: [{ description: 'Manual tax adjustment', amount: 140000n }] }
  assert.equal(invoicePaper(legacy).items.length, 1)
  assert.equal(invoicePaper(legacy).summary.length, 2)
  const partial = { ...sample, payments: [{ on: '2026-10-10', what: 'Payment reference', amount: 40000n }], balance: 100000n }
  assert.equal(invoicePaper(partial).headline, '$1,000.00 CAD due October 31, 2026')
  const paid = { ...sample, payments: [{ on: '2026-10-10', what: 'Payment reference', amount: 140000n }], balance: 0n }
  assert.equal(invoicePaper(paid).headline, '$1,400.00 CAD paid in full')
  const note: InvoiceDocument = { ...partial, kind: 'credit_note', title: 'Credit note' }
  assert.equal(invoicePaper(note).headline, '$1,000.00 CAD remaining credit')
  assert.equal(invoicePaper(note).summary.at(-1)?.label, 'Remaining credit')

  const variants: Array<[string, InvoiceDocument]> = [
    ['default-invoice-sample', sample],
    ['compact-invoice-sample', { ...partial, template: { ...template, settings: { ...template.settings, layout: 'compact', paymentInstructions: 'CUSTOM PAYMENT REFERENCE', footer: 'SAMPLE ONLY. Thank you for your business.' } } }],
    ['credit-note-sample', note],
    ['long-invoice-sample', { ...sample, lines: Array.from({ length: 90 }, (_, i) => ({ description: `Service item ${i + 1}: professional consulting and project support.\nDelivery period: October 2026.`, amount: 100n })), total: 9000n, balance: 9000n }],
    ['long-description-sample', { ...sample, lines: [{ description: 'Long description starts. ' + 'Detailed service scope and delivery notes. '.repeat(400) + ' Long description ends.', amount: 140000n }] }],
  ]
  for (const [name, value] of variants) {
    const buffer = execFileSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', '-e',
      "const {renderInvoicePdf}=require('./src/lib/invoice-pdf'); let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',async()=>{try{const value=JSON.parse(input,(_,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.invoiceCents==='string'?BigInt(v.invoiceCents):v);process.stdout.write(await renderInvoicePdf(value))}catch(e){console.error(e);process.exitCode=1}})",
    ], { input: JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { invoiceCents: String(v) } : v), maxBuffer: 10 * 1024 * 1024 })
    const parsed = await PDFDocument.load(buffer)
    const content = pdfText(buffer)
    assert(content.includes(value.number!))
    assert(content.includes('GST/HST 123456789RT0001'))
    assert(content.includes(invoicePaper(value).summary.at(-1)!.label))
    assert(!content.includes('Pay online'))
    if (name.startsWith('long-')) assert(parsed.getPageCount() > 1)
    else assert.equal(parsed.getPageCount(), 1, name)
    if (name === 'default-invoice-sample') {
      assert(content.includes('1,250.00') && content.includes('62.50') && content.includes('87.50') && content.includes('1,400.00 CAD'))
      assert(!content.includes('Payment instructions'))
    }
    if (name === 'compact-invoice-sample') assert(content.includes('CUSTOM PAYMENT REFERENCE') && content.includes('Payment reference'))
    if (name === 'credit-note-sample') assert(!content.includes('Date due'))
    writeFileSync('output/pdf/' + name + '.pdf', buffer)
    const fullText = execFileSync('pdftotext', ['-layout', 'output/pdf/' + name + '.pdf', '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ')
    if (name === 'long-invoice-sample') assert(fullText.includes('Service item 90:'))
    if (name === 'long-description-sample') {
      assert(fullText.includes('Long description ends.'))
      const firstPage = execFileSync('pdftotext', ['-f', '1', '-l', '1', 'output/pdf/' + name + '.pdf', '-'], { encoding: 'utf8' })
      assert(firstPage.includes('Long description starts.'))
    }
    execFileSync('pdftoppm', ['-singlefile', '-scale-to', '1400', '-png', 'output/pdf/' + name + '.pdf', directory + '/' + name])
    console.log(`PASS ${name}: ${parsed.getPageCount()} page(s), source amounts and labels retained`)
  }

  const globalCss = readdirSync('.next/static/chunks').filter(name => name.endsWith('.css')).map(name => readFileSync('.next/static/chunks/' + name, 'utf8')).join('\n')
  const html = '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + globalCss + '\n' + readFileSync(cssPath, 'utf8') + '</style><body><main style="padding:16px;max-width:816px;margin:auto">' + renderToStaticMarkup(createElement(InvoiceDocView, { doc: sample, controls: false })) + '</main></body></html>'
  writeFileSync(directory + '/preview.html', html)
  const browser = await chromium.launch({ headless: true })
  const measurements = []
  try {
    const page = await browser.newPage()
    for (const width of [900, 600, 390, 320]) {
      await page.setViewportSize({ width, height: 1056 })
      await page.setContent(html)
      await page.evaluate('globalThis.__name = (fn) => fn')
      const measured = await page.evaluate(() => {
        const paper = document.querySelector('[data-invoice-doc]')!
        const box = (element: Element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
        const root = box(paper), title = box(paper.querySelector('h1')!), logo = box(paper.querySelector('img')!), total = box(paper.querySelector('[data-doc-total]')!), balance = box(paper.querySelector('[data-doc-balance]')!)
        const outside = Array.from(paper.querySelectorAll('h1,h2,p,dt,dd,th,td,img')).filter(e => { const r = e.getBoundingClientRect(); return r.x < root.x - 1 || r.right > root.right + 1 || r.width <= 0 || r.height <= 0 }).map(e => e.textContent)
        const overlappingCells = Array.from(paper.querySelectorAll('tr')).filter(row => { const cells = Array.from(row.children); return cells.some((cell, i) => i > 0 && cell.getBoundingClientRect().left < cells[i - 1].getBoundingClientRect().right - 1) }).length
        const overlappingSummary = Array.from(paper.querySelectorAll('.summaryRow')).some(row => row.querySelector('dt')!.getBoundingClientRect().right > row.querySelector('dd')!.getBoundingClientRect().left - 1)
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, root, title, logo, total, balance, outside, overlappingCells, overlappingSummary, background: getComputedStyle(paper).backgroundColor }
      })
      assert.equal(measured.scrollWidth, width)
      assert.deepEqual(measured.outside, [])
      assert.equal(measured.overlappingCells, 0)
      assert.equal(measured.overlappingSummary, false)
      assert(measured.title.right < measured.logo.x)
      assert(Math.abs(measured.total.right - measured.balance.right) < 1)
      assert.equal(measured.background, 'rgb(255, 255, 255)')
      measurements.push(measured)
      await page.screenshot({ path: directory + `/preview-${width}.png`, fullPage: true })
      console.log(`PASS HTML at ${width}px: logo upper right, no overflow/overlap, amounts aligned`)
    }
    await page.setViewportSize({ width: 900, height: 1056 })
    await page.setContent(html)
    await page.evaluate('document.documentElement.dataset.mode = "dark"')
    assert.equal(await page.locator('[data-invoice-doc]').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 255, 255)')
    await page.screenshot({ path: directory + '/preview-dark.png', fullPage: true })
    const enormous = { ...sample, total: 9223372036854775807n, balance: 9223372036854775807n, lines: [{ description: 'Large value', amount: 9223372036854775807n }] }
    await page.setViewportSize({ width: 320, height: 1056 })
    await page.setContent(html.replace(/<main[\s\S]*<\/main>/, '<main style="padding:16px">' + renderToStaticMarkup(createElement(InvoiceDocView, { doc: enormous, controls: false })) + '</main>'))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320, 'bigint monetary values remain readable on narrow previews')
  } finally { await browser.close() }
  writeFileSync(directory + '/layout.json', JSON.stringify(measurements, null, 2) + '\n')
  console.log('PASS exact cents, legacy/manual lines, partial/full payments, credit notes, pagination, custom prose and light/dark preview')
}
main().catch(error => { console.error(error); process.exitCode = 1 })

/** Real browser regression for receipt presentation and the existing plain-text invoice note. */
import assert from 'node:assert/strict'
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import dotenv from 'dotenv'
import postgres from 'postgres'
import { chromium, expect } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'

dotenv.config({ path: '.env.local', quiet: true })
const proof = JSON.parse(readFileSync(process.env.FIGTREE_TEST_ISOLATION_PROOF, 'utf8'))
const url = new URL(process.env.DATABASE_URL)
assert(proof.createdNew && !proof.productionTouched)
assert(/^figtree_receipt_app_[a-f0-9]+_test$/.test(proof.appDatabase))
assert.equal(url.pathname.slice(1), proof.appDatabase); assert.equal(url.hostname, '127.0.0.1'); assert.equal(Number(url.port), proof.pgPort)
assert.equal(statSync(proof.environmentPath).mode & 0o777, 0o600)
assert.equal(createHash('sha256').update(readFileSync(proof.environmentPath)).digest('hex'), proof.environmentSha256)
const fixture = JSON.parse(readFileSync(proof.fixturePath, 'utf8'))
const origin = `http://127.0.0.1:${proof.appPort}`, base = `/ledger/${fixture.ledgerId}`
const evidence = resolve(process.env.BILLING_EVIDENCE_DIR || 'docs/evidence/billing-experience')
mkdirSync(evidence, { recursive: true })
const database = postgres(url.href, { max: 2 }), browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addCookies([{ name: 'erp_session', value: fixture.token, url: origin, httpOnly: true, sameSite: 'Lax' }])
const page = await context.newPage(), checks = [], errors = []
page.on('pageerror', error => errors.push(error.message))
const normalized = value => value?.replace(/\r\n?/g, '\n')
const pass = text => { checks.push(text); console.log('PASS ' + text) }
try {
  assert.equal((await database`SELECT current_database() AS name`)[0].name, proof.appDatabase)
  await page.goto(origin + base + '/projects/' + fixture.financeProjectId)
  for (const label of ['Receive customer payment', 'Pay supplier']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: label, exact: true }); await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await expect(dialog).not.toBeVisible()
  }
  pass('Project incoming/outgoing buttons open clearly named customer/supplier dialogs')
  const note = 'Deposit: 30% on acceptance\nProgress payment: 40% after stage 1\nFinal payment: 30% on completion'
  const number = 'NOTE-' + Date.now()
  await page.goto(origin + base + '/invoices/new?copy=' + fixture.invoiceId)
  const noteField = page.locator('textarea[name="note"]'); await expect(noteField).toBeVisible()
  await expect(noteField).toHaveAttribute('placeholder', /Deposit:.*\nProgress payment:.*\nFinal payment:/)
  await noteField.fill(note); await page.locator('[name="number"]').fill(number)
  await page.getByRole('button', { name: 'Save to the books', exact: true }).click()
  await expect.poll(async () => normalized((await database`SELECT note FROM invoice WHERE ledger_id=${fixture.ledgerId} AND number=${number}`)[0]?.note)).toBe(note)
  const invoiceId = (await database`SELECT id FROM invoice WHERE ledger_id=${fixture.ledgerId} AND number=${number}`)[0].id
  pass('existing F.note saves all three lines through the real new-invoice action')
  await page.goto(origin + base + '/invoices/new?copy=' + invoiceId)
  await expect(page.locator('textarea[name="note"]')).toHaveValue(note)
  pass('copying an invoice preserves the existing multiline note')
  await page.goto(origin + base + '/invoices/' + invoiceId)
  await page.getByRole('link', { name: 'Edit', exact: true }).click()
  const panel = page.locator('.overlay-panel'); await expect(panel).toBeVisible()
  await expect(panel.locator('[name="editToken"]')).not.toHaveValue('')
  await expect(panel.locator('textarea[name="note"]')).toHaveValue(note)
  const edited = note + '\nPayment by bank transfer.'
  await panel.locator('textarea[name="note"]').fill(edited)
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => normalized((await database`SELECT note FROM invoice WHERE id=${invoiceId}`)[0].note)).toBe(edited)
  await expect.poll(async () => page.locator('form:has([name="note"])').getAttribute('data-pending')).not.toBe('true')
  if (await panel.isVisible()) await panel.getByRole('button', { name: 'Close', exact: true }).click()
  else await page.getByRole('link', { name: 'Back to the document', exact: true }).click()
  await expect.poll(() => page.url()).toBe(origin + base + '/invoices/' + invoiceId)
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).not.toBeVisible()
  pass('editing multiline note saves and closes without false unsaved prompt or access redirect')
  await page.goto(origin + base + '/bills/new?copy=' + fixture.billId)
  await expect(page.locator('textarea[name="note"]')).toBeVisible()
  assert.equal(await page.locator('[name="note"]').getAttribute('placeholder'), null)
  pass('purchase bills retain a generic optional note without sales-stage instructions')
  const documentPaths = [
    base + '/invoices/' + fixture.invoiceId + '/payments/' + fixture.entryId + '/receipt',
    base + '/projects/' + fixture.projectId + '/payments/' + fixture.projectPaymentId + '/receipt',
    base + '/entries/' + fixture.advanceEntryId + '/receipt',
  ]
  const entry = (await database`SELECT entry_no FROM journal_entry WHERE id=${fixture.entryId}`)[0]
  for (const href of documentPaths) {
    const response = await context.request.get(origin + href + '?download=1'); assert(response.ok())
    const disposition = response.headers()['content-disposition']; assert(disposition.startsWith('attachment;')); assert(!/R-/.test(disposition))
    const pdf = await PDFDocument.load(await response.body()); assert(!pdf.getTitle()?.includes('R-' + entry.entry_no))
  }
  pass('linked, Project and unallocated receipt downloads omit internal receipt identity')
  await page.goto(origin + base + '/projects/' + fixture.projectId + '/payments/' + fixture.projectPaymentId + '/receipt/preview')
  const paper = page.locator('[data-invoice-doc]'); await expect(paper).toBeVisible()
  const text = await paper.innerText(); assert(!text.includes('Receipt number')); assert(!text.includes('PRIVATE'))
  assert.equal(await paper.locator('table[aria-label="Payment history"] tbody tr').count(), 2)
  pass('second Project receipt shows prior and current payments without internal note or receipt number on paper')
  assert.deepEqual(errors, [])
  writeFileSync(join(evidence, 'browser-result.json'), JSON.stringify({ checks, pageErrors: errors, productionTouched: false, passed: true }, null, 2) + '\n')
  console.log(`=== ALL CHECKS PASSED (${checks.length} real browser cases) ===`)
} finally { await browser.close(); await database.end() }

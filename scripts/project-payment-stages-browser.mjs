/** Actual Add revenue browser regression; fresh isolated APP database only. */
import assert from 'node:assert/strict'
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import dotenv from 'dotenv'
import postgres from 'postgres'
import { chromium, expect } from '@playwright/test'

dotenv.config({ path: '.env.local', quiet: true })
const proof = JSON.parse(readFileSync(process.env.FIGTREE_TEST_ISOLATION_PROOF, 'utf8'))
const url = new URL(process.env.DATABASE_URL)
assert(proof.createdNew && !proof.productionTouched && proof.initialTables === 0)
assert(/^figtree_receipt_app_[a-f0-9]+_test$/.test(proof.applicationDatabase))
assert.equal(url.pathname.slice(1), proof.applicationDatabase); assert.equal(url.hostname, '127.0.0.1'); assert.equal(Number(url.port), proof.pgPort)
assert.equal(statSync(proof.environmentPath).mode & 0o777, 0o600)
assert.equal(createHash('sha256').update(readFileSync(proof.environmentPath)).digest('hex'), proof.environmentSha256)
const fixture = JSON.parse(readFileSync(proof.fixturePath, 'utf8'))
const phase = process.env.STAGES_BROWSER_PHASE || 'development'
const origin = `http://127.0.0.1:${proof.appPort}`, base = `/ledger/${fixture.ledgerId}`
const evidence = resolve(process.env.STAGES_EVIDENCE_DIR || 'docs/evidence/project-payment-stages')
mkdirSync(evidence, { recursive: true })
const database = postgres(url.href, { max: 2 }), browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await context.addCookies([{ name: 'erp_session', value: fixture.token, url: origin, httpOnly: true, sameSite: 'Lax' }])
const page = await context.newPage(), checks = [], pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
const normalized = value => value?.replace(/\r\n?/g, '\n')
const pass = label => { checks.push(label); console.log('PASS ' + label) }
const stages = ['Deposit: 30% on confirmation', 'Progress payment: 40% after stage 1', 'Final payment: 30% on completion'].join(String.fromCharCode(10))
const descriptionPrefix = 'PAPER-' + phase + '-' + Date.now()
const recordFor = async description => (await database`SELECT r.id::text AS record_id,r.description,i.id::text AS invoice_id,i.note,i.status,i.print_template_snapshot,i.issued_on::text,i.due_on::text FROM project_record r JOIN project_accounting_link h ON h.record_id=r.id JOIN invoice i ON i.id=h.invoice_id WHERE r.project_id=${fixture.financeProjectId} AND r.description=${description}`)[0]
try {
  assert.equal((await database`SELECT current_database() AS name`)[0].name, proof.applicationDatabase)
  await page.goto(origin + base + '/projects/' + fixture.financeProjectId)
  await page.getByRole('button', { name: 'Add revenue', exact: true }).click()
  let panel = page.getByRole('dialog', { name: 'Add revenue', exact: true })
  const option = panel.getByRole('checkbox', { name: /Payment in stages/ })
  await expect(option).not.toBeChecked(); await expect(panel.locator('[name="paymentStages"]')).toBeHidden(); await expect(panel.locator('[name="paymentStages"]')).toBeDisabled()
  const description = descriptionPrefix + '-staged'
  await panel.locator('[name="description"]').fill(description); await panel.locator('[name="base"]').fill('100.00')
  const fields = async () => panel.locator('form').evaluate(form => [...new FormData(form)].filter(([name]) => name !== 'paymentStages').map(([name, value]) => [name, String(value)]))
  const before = await fields()
  await option.check(); const stageField = panel.locator('textarea[name="paymentStages"]')
  await expect(stageField).toBeVisible(); await expect(stageField).toHaveAttribute('maxlength', '4000')
  await stageField.fill(stages); assert.deepEqual(await fields(), before)
  pass('actual Add revenue has a separate optional printed-stage textarea; all financial form fields stay unchanged')
  await panel.locator('[name="dueDate"]').fill('2020-01-01')
  await panel.getByRole('button', { name: 'Save and post', exact: true }).click()
  await expect(panel.getByRole('alert')).toBeVisible(); await expect(stageField).toHaveValue(stages); await expect(option).toBeChecked(); assert.equal(await recordFor(description), undefined)
  pass('refused real save retains stage text and creates no source or accounting invoice')
  await panel.locator('[name="dueDate"]').fill('')
  await panel.getByRole('button', { name: 'Save and post', exact: true }).click()
  await expect.poll(async () => (await recordFor(description))?.status).toBe('posted')
  const made = await recordFor(description)
  assert.equal(normalized(made.print_template_snapshot.paymentStages), stages); assert.equal(made.description, description); assert.equal(made.note, description); assert.equal(made.issued_on, made.due_on)
  assert((await database`SELECT amount::text,description FROM invoice_line WHERE invoice_id=${made.invoice_id}`).every(line => !line.description?.includes('Deposit:')))
  assert((await database`SELECT j.description FROM journal_entry j JOIN invoice i ON i.entry_id=j.id WHERE i.id=${made.invoice_id}`).every(line => !line.description?.includes('Deposit:')))
  await expect(option).not.toBeChecked(); await expect(stageField).toBeHidden(); await expect(stageField).toHaveValue('')
  pass('real Project action saves stage prose only in the posted paper snapshot; success resets the option')
  await panel.getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: 'Edit ' + description, exact: true }).click(); panel = page.locator('dialog[open]')
  await expect(panel.getByRole('checkbox', { name: /Payment in stages/ })).toBeChecked()
  await expect(panel.locator('textarea[name="paymentStages"]')).toHaveValue(stages)
  await expect(panel.locator('[name="description"]')).toHaveValue(description)
  const revised = 'Deposit: 20% on confirmation\nFinal payment: 80% on completion'
  await panel.locator('textarea[name="paymentStages"]').fill(revised)
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => normalized((await recordFor(description)).print_template_snapshot.paymentStages)).toBe(revised)
  await expect(panel.locator('form')).not.toHaveAttribute('data-pending', 'true')
  await expect(panel.locator('textarea[name="paymentStages"]')).toHaveValue(revised)
  await panel.getByRole('button', { name: 'Close', exact: true }).click(); await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).not.toBeVisible()
  pass('saved stages are editable and stay saved on close without an unsaved-change prompt')
  await page.getByRole('button', { name: 'Edit ' + description, exact: true }).click(); panel = page.locator('dialog[open]')
  await expect(panel.locator('textarea[name="paymentStages"]')).toHaveValue(revised)
  await panel.getByRole('checkbox', { name: /Payment in stages/ }).uncheck()
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => (await recordFor(description)).print_template_snapshot.paymentStages).toBe(undefined)
  await expect(panel.locator('form')).not.toHaveAttribute('data-pending', 'true')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Edit ' + description, exact: true }).click(); panel = page.locator('dialog[open]')
  await panel.getByRole('checkbox', { name: /Payment in stages/ }).check()
  await panel.locator('textarea[name="paymentStages"]').fill(stages)
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => normalized((await recordFor(description)).print_template_snapshot.paymentStages)).toBe(stages)
  await expect(panel.locator('form')).not.toHaveAttribute('data-pending', 'true')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  pass('unchecking clears the saved stages and later editing can add them back')
  const pdf = await context.request.get(origin + base + '/invoices/' + made.invoice_id + '/pdf'); assert(pdf.ok())
  const pdfPath = join(evidence, phase + '-invoice.pdf'); writeFileSync(pdfPath, await pdf.body())
  const pdfText = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' })
  for (const value of ['Payment stages', 'Deposit: 30%', 'Progress payment: 40%', 'Final payment: 30%']) assert(pdfText.includes(value), value)
  pass('actual customer Invoice PDF displays all three payment stages')
  for (const mode of ['off', 'blank']) {
    await page.getByRole('button', { name: 'Add revenue', exact: true }).click(); panel = page.getByRole('dialog', { name: 'Add revenue', exact: true })
    const currentOption = panel.getByRole('checkbox', { name: /Payment in stages/ })
    await currentOption.check(); if (mode === 'off') { await panel.locator('[name="paymentStages"]').fill('DO NOT PRINT'); await currentOption.uncheck() }
    const text = descriptionPrefix + '-' + mode
    await panel.locator('[name="description"]').fill(text); await panel.locator('[name="base"]').fill('100.00')
    await panel.getByRole('button', { name: 'Save and post', exact: true }).click(); await expect.poll(async () => (await recordFor(text))?.status).toBe('posted')
    assert.equal((await recordFor(text)).print_template_snapshot.paymentStages, undefined)
    // A committed row can precede the action response and its form reset.
    await expect(panel.locator('form')).not.toHaveAttribute('data-pending', 'true')
    await expect(panel.locator('[name="description"]')).toHaveValue('')
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
  }
  pass('unchecked and blank stage options preserve the original no-stage invoice snapshot')
  const blankDescription = descriptionPrefix + '-blank'
  await page.getByRole('button', { name: 'Edit ' + blankDescription, exact: true }).click(); panel = page.locator('dialog[open]')
  await expect(panel.getByRole('checkbox', { name: /Payment in stages/ })).not.toBeChecked()
  await panel.getByRole('checkbox', { name: /Payment in stages/ }).check()
  await panel.locator('textarea[name="paymentStages"]').fill('Added after creation: final payment on completion')
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => (await recordFor(blankDescription)).print_template_snapshot.paymentStages).toBe('Added after creation: final payment on completion')
  await expect(panel.locator('form')).not.toHaveAttribute('data-pending', 'true')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).not.toBeVisible()
  pass('revenue created without stages can add them later through the actual Edit action')
  await page.getByRole('button', { name: 'Add cost', exact: true }).click(); panel = page.getByRole('dialog', { name: 'Add cost', exact: true }); await expect(panel.getByRole('checkbox', { name: /Payment in stages/ })).toHaveCount(0); await panel.getByRole('button', { name: 'Close', exact: true }).click()
  pass('cost forms retain their original behavior without a stage option')
  await context.clearCookies(); await context.addCookies([{ name: 'erp_session', value: fixture.projectToken, url: origin, httpOnly: true, sameSite: 'Lax' }])
  await page.goto(origin + base + '/projects/' + fixture.financeProjectId); await page.getByRole('button', { name: 'Add revenue', exact: true }).click(); panel = page.getByRole('dialog', { name: 'Add revenue', exact: true }); await expect(panel.getByRole('checkbox', { name: /Payment in stages/ })).toHaveCount(0)
  pass('Project-only access without invoice capability does not offer a paper field that could be discarded')
  assert.deepEqual(pageErrors, [])
  writeFileSync(join(evidence, phase + '-browser.json'), JSON.stringify({ checks, pageErrors, passed: true, productionTouched: false, invoiceId: made.invoice_id }, null, 2) + String.fromCharCode(10))
  console.log(`=== ALL CHECKS PASSED (${checks.length} real browser cases) ===`)
} finally { await browser.close(); await database.end() }

/** Real save/close regressions against an explicitly confirmed synthetic APP. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import dotenv from 'dotenv'
import postgres from 'postgres'
import { chromium, expect } from '@playwright/test'

dotenv.config({ path: '.env.local', quiet: true })
const proof = JSON.parse(readFileSync(process.env.FIGTREE_TEST_ISOLATION_PROOF, 'utf8'))
const url = new URL(process.env.DATABASE_URL)
assert(proof.createdNew && !proof.productionTouched)
assert(/^figtree_.*_test$/.test(proof.applicationDatabase))
assert.equal(url.pathname.slice(1), proof.applicationDatabase)
assert.equal(url.hostname, '127.0.0.1')
assert.equal(Number(url.port), proof.pgPort)
assert.equal(statSync(proof.environmentPath).mode & 0o777, 0o600)
assert.equal(createHash('sha256').update(readFileSync(proof.environmentPath)).digest('hex'), proof.environmentSha256)
const fixture = JSON.parse(readFileSync(proof.browserFixturePath, 'utf8'))
const base = `http://127.0.0.1:${proof.appPort}`
const evidence = resolve(process.env.CLOSE_EVIDENCE_DIR || 'docs/evidence/saved-form-close-fix')
mkdirSync(evidence, { recursive: true })
const database = postgres(url.href, { max: 2 })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const checks = [], errors = []
page.on('pageerror', error => errors.push(error.message))
const pass = text => { checks.push(text); console.log('PASS ' + text) }
const login = async (view, email = fixture.email) => {
  await view.goto(base + '/login')
  await view.getByLabel('Email', { exact: true }).fill(email)
  await view.getByLabel('Password', { exact: true }).fill(fixture.password)
  await view.getByRole('button', { name: 'Sign in', exact: true }).click()
  await view.waitForURL(value => !value.pathname.startsWith('/login'))
}
const bank = `/ledger/${fixture.ledgerId}/bank/${fixture.bankAccountId}?tab=posted`
let entryId
const liveLease = async () => Boolean((await database`SELECT expires_at>clock_timestamp() AS live FROM document_edit_lease WHERE journal_entry_id=${entryId}`)[0]?.live)
const openEntry = async () => {
  await page.goto(base + bank)
  await page.locator(`[data-row="${fixture.regressionBankRowId}"] a[href*="/entries/"]`).click()
  const panel = page.locator('.overlay-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('input[name="editToken"]')).not.toHaveValue('')
  return panel
}
const closeClean = async panel => {
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await expect.poll(() => page.url()).toBe(base + bank)
  await expect.poll(liveLease).toBe(false)
  assert.equal(await page.getByRole('button', { name: 'Keep editing', exact: true }).count(), 0)
}
const saveReference = async (panel, reference) => {
  await panel.locator('input[name="documentRef"]').fill(reference)
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => (await database`SELECT document_ref FROM journal_entry WHERE id=${entryId}`)[0].document_ref).toBe(reference)
  await expect(panel.getByText('Saved. The books moved with it.', { exact: true })).toBeVisible()
}
try {
  const [identity] = await database`SELECT current_database() AS name`
  assert.equal(identity.name, proof.applicationDatabase)
  await login(page)
  const existing = await database`SELECT entry_id FROM bank_match WHERE bank_transaction_id=${fixture.regressionBankRowId}`
  if (!existing.length) {
    await page.goto(base + `/ledger/${fixture.ledgerId}/bank/${fixture.bankAccountId}`)
    const row = page.locator(`[data-row="${fixture.regressionBankRowId}"]`)
    await row.getByRole('combobox', { name: 'Category for the new entry' }).fill('Synthetic close expenses')
    await page.getByRole('option', { name: /CLOSE5000/ }).click()
    await row.getByRole('button', { name: 'Post new', exact: true }).click()
    await expect.poll(async () => Number((await database`SELECT count(*)::int AS n FROM bank_match WHERE bank_transaction_id=${fixture.regressionBankRowId}`)[0].n)).toBe(1)
  }
  entryId = (await database`SELECT entry_id FROM bank_match WHERE bank_transaction_id=${fixture.regressionBankRowId}`)[0].entry_id
  let panel = await openEntry()
  await saveReference(panel, 'CLOSE-FINAL-REFERENCE')
  const measurements = await panel.evaluate(root => [...root.querySelectorAll('input:not([type="hidden"]), button')].filter(e => e.getClientRects().length).map(e => {
    const r = e.getBoundingClientRect()
    return { tag: e.tagName, name: e.getAttribute('name'), label: e.getAttribute('aria-label'), x: r.x, y: r.y, width: r.width, height: r.height }
  }))
  writeFileSync(join(evidence, 'after-measurements.json'), JSON.stringify(measurements, null, 2) + '\n')
  await closeClean(panel)
  pass('bank Post → Posted → reference Save → Close returns to Posted, persists reference and releases lease')
  panel = await openEntry(); await closeClean(panel)
  pass('asynchronous lease acquisition alone does not make a clean editor dirty')

  panel = await openEntry()
  await panel.locator('input[name="documentRef"]').fill('CLOSE-UNSAVED')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(panel.locator('input[name="documentRef"]')).toHaveValue('CLOSE-UNSAVED')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect.poll(() => page.url()).toBe(base + bank)
  await expect.poll(liveLease).toBe(false)
  assert.equal((await database`SELECT document_ref FROM journal_entry WHERE id=${entryId}`)[0].document_ref, 'CLOSE-FINAL-REFERENCE')
  pass('subsequent unsaved input prompts; Keep editing retains it and Discard leaves saved data intact')

  panel = await openEntry()
  await panel.getByLabel('Description on line 1', { exact: true }).fill('Unsaved controlled line')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect.poll(() => page.url()).toBe(base + bank)
  await expect.poll(liveLease).toBe(false)
  pass('controlled line data submitted as hidden JSON remains protected')

  panel = await openEntry()
  await panel.locator('input[name="documentRef"]').fill('CLOSE-REFUSED')
  await panel.locator('form:has(input[name="documentRef"]) input[name="expectedVersion"]').evaluate(input => { input.value = '0' })
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(panel.locator('form:has(input[name="documentRef"]) [role="alert"]')).toBeVisible()
  await expect(panel.locator('input[name="documentRef"]')).toHaveValue('CLOSE-REFUSED')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Keep editing', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect.poll(() => page.url()).toBe(base + bank)
  await expect.poll(liveLease).toBe(false)
  assert.equal((await database`SELECT document_ref FROM journal_entry WHERE id=${entryId}`)[0].document_ref, 'CLOSE-FINAL-REFERENCE')
  pass('refused invalid-version save preserves input and unsaved confirmation without changing the saved reference')

  panel = await openEntry()
  let continueSave, intercepted
  const reached = new Promise(resolve => { intercepted = resolve })
  await page.route('**/*', async route => {
    const request = route.request()
    if (request.method() === 'POST' && request.postData()?.includes('CLOSE-PENDING')) {
      intercepted(); await new Promise(resolve => { continueSave = resolve })
    }
    await route.continue()
  })
  await panel.locator('input[name="documentRef"]').fill('CLOSE-PENDING')
  const clicked = panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await reached
  await expect(panel.locator('form:has(input[name="documentRef"])')).toHaveAttribute('data-pending', 'true')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Saving is in progress', exact: true })).toBeVisible()
  assert.equal(await page.getByRole('button', { name: 'Discard changes', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Keep waiting', exact: true }).click()
  continueSave(); await clicked; await page.unroute('**/*')
  await expect.poll(async () => (await database`SELECT document_ref FROM journal_entry WHERE id=${entryId}`)[0].document_ref).toBe('CLOSE-PENDING')
  await expect(panel.getByText('Saved. The books moved with it.', { exact: true })).toBeVisible()
  await closeClean(panel)
  pass('pending save blocks discard; completing the actual action restores clean close')

  await page.goto(base + `/ledger/${fixture.ledgerId}/invoices/${fixture.invoiceId}`)
  await page.getByRole('link', { name: 'Edit draft', exact: true }).click()
  panel = page.locator('.overlay-panel'); await expect(panel).toBeVisible()
  await expect(panel.locator('input[name="editToken"]')).not.toHaveValue('')
  await panel.locator('[name="note"]').fill('Saved ActionForm note')
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => (await database`SELECT note FROM invoice WHERE id=${fixture.invoiceId}`)[0].note).toBe('Saved ActionForm note')
  await expect.poll(async () => page.locator('form:has([name="note"])').getAttribute('data-pending')).not.toBe('true')
  if (await panel.isVisible()) await panel.getByRole('button', { name: 'Close', exact: true }).click()
  else await page.getByRole('link', { name: 'Back to the document', exact: true }).click()
  await expect.poll(() => page.url()).toBe(base + `/ledger/${fixture.ledgerId}/invoices/${fixture.invoiceId}`)
  await expect(page.locator('.overlay-panel form:has([name="note"])')).not.toBeVisible()
  assert(!page.url().includes('/no-access'))
  pass('shared ActionForm invoice Modify saves and closes without an unsaved prompt or access redirect')

  await page.goto(base + `/ledger/${fixture.ledgerId}/parties`)
  await page.locator(`a[href="/ledger/${fixture.ledgerId}/parties/${fixture.partyId}"]`).first().click()
  panel = page.locator('.overlay-panel'); await expect(panel).toBeVisible()
  await expect(panel.locator('[data-edit-protection] input[name="editToken"]')).not.toHaveValue('')
  const partyForm = panel.locator('form:has(input[name="notes"])')
  await partyForm.locator('input[name="notes"]').fill('Saved shared Modify notes')
  await partyForm.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await database`SELECT notes FROM party WHERE id=${fixture.partyId}`)[0].notes).toBe('Saved shared Modify notes')
  await expect(partyForm).not.toHaveAttribute('data-pending', 'true')
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(panel).not.toBeVisible()
  await expect.poll(() => page.url()).toBe(base + `/ledger/${fixture.ledgerId}/parties`)
  pass('saving one shared Modify form leaves sibling proof/version-only forms clean')

  panel = await openEntry()
  let resumeRelease, captured
  const releaseReached = new Promise(resolve => { captured = resolve })
  await page.route('**/*', async route => {
    const request = route.request()
    if (request.method() === 'POST' && request.postData()?.includes('"release"') && request.postData().includes(entryId)) {
      captured(request); await new Promise(resolve => { resumeRelease = resolve })
    }
    await route.continue()
  })
  const stop = panel.getByRole('button', { name: 'Stop editing', exact: true }).click()
  const request = await releaseReached
  const headers = { 'next-action': request.headers()['next-action'], 'content-type': request.headers()['content-type'], origin: base }
  const replay = async (client, data = request.postDataBuffer()) => client.post(request.url(), { headers, data, maxRedirects: 0 })
  const anonymous = await browser.newContext()
  let response = await replay(anonymous.request)
  assert(!response.headers()['x-action-redirect'])
  assert(response.headers().location?.includes('/login') || (await response.text()).includes('Sign in again before editing.'))
  assert(await liveLease()); await anonymous.close()
  pass('unauthenticated release is denied at the front door and cannot expire the held lease')
  const foreign = await browser.newContext(), peer = await foreign.newPage()
  await login(peer, fixture.peerEmail)
  response = await replay(foreign.request)
  assert(!response.headers()['x-action-redirect']); assert((await response.text()).includes('"released":false')); assert(await liveLease())
  pass('another authenticated session cannot release the current editor proof')
  const limited = await browser.newContext(), outsider = await limited.newPage()
  await login(outsider, fixture.limitedEmail)
  response = await replay(limited.request)
  assert((await response.text()).includes('This company or module is unavailable')); assert(await liveLease())
  await limited.close(); pass('missing company/module grant cannot release a lease')
  response = await replay(context.request, Buffer.from(request.postData().replaceAll(fixture.ledgerId, randomUUID())))
  assert((await response.text()).includes('This company or module is unavailable')); assert(await liveLease())
  pass('wrong ledger cannot release the document lease')
  await database`UPDATE user_session SET revoked_at=clock_timestamp() WHERE user_id=${fixture.peerId} AND revoked_at IS NULL`
  response = await replay(foreign.request)
  assert((await response.text()).includes('Sign in again before editing.')); assert(await liveLease()); await foreign.close()
  pass('revoked session cannot release the current lease')
  resumeRelease(); await stop; await page.unroute('**/*')
  await expect.poll(liveLease).toBe(false)
  await closeClean(panel)
  pass('the owning authenticated session releases its exact lease and closes without navigation side effects')

  await page.evaluate(href => localStorage.setItem('erp.desk.v1', JSON.stringify({ tabs: [{ id: 't1', href }], active: 't1' })), bank)
  await page.goto(base + '/')
  const frame = page.frameLocator('iframe[data-frame="t1"]')
  await frame.locator(`[data-row="${fixture.regressionBankRowId}"] a[href*="/entries/"]`).click()
  const embedded = frame.locator('.overlay-panel'); await expect(embedded).toBeVisible()
  await expect(embedded.locator('input[name="editToken"]')).not.toHaveValue('')
  await embedded.locator('input[name="documentRef"]').fill('CLOSE-DESK-REFERENCE')
  await embedded.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => (await database`SELECT document_ref FROM journal_entry WHERE id=${entryId}`)[0].document_ref).toBe('CLOSE-DESK-REFERENCE')
  await expect(embedded.getByText('Saved. The books moved with it.', { exact: true })).toBeVisible()
  await embedded.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(embedded).not.toBeVisible()
  await expect.poll(() => page.frames().some(view => view.url() === base + bank)).toBe(true)
  assert.equal(new URL(page.url()).pathname, '/')
  await expect.poll(liveLease).toBe(false)
  pass('real Desk iframe save/close returns to its own Posted list and preserves the Desk')
  assert.deepEqual(errors, [])
  writeFileSync(join(evidence, 'browser.json'), JSON.stringify({ checks, pageErrors: errors, productionTouched: false, applicationDatabase: identity.name }, null, 2) + '\n')
  console.log(`=== ALL CHECKS PASSED (${checks.length} real browser cases) ===`)
} finally {
  await browser.close()
  await database.end()
}

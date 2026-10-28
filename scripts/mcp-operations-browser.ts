/** Real Next/browser actions against the explicitly confirmed disposable test DB.
 * First seed with MCP_BROWSER_FIXTURE=<private-path> db:verify-mcp-operations.
 * Run --before before a UI refinement, then reseed and run again to compare. */
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { parse } from 'dotenv'
import { chromium, expect, type Page } from '@playwright/test'

async function browser_evaluate(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready })
  return page.evaluate(() => {
    const main = document.querySelector('main:not([aria-busy])')!, r = main.getBoundingClientRect()
    const visible = (e: Element) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
    const controls = Array.from(main.querySelectorAll('button,a[href]')).filter(visible).map(e => {
      const b = e.getBoundingClientRect(); return { text: e.textContent?.trim(), tag: e.tagName, x: b.x, y: b.y, width: b.width, height: b.height }
    })
    const outside = controls.filter(b => b.x < -1 || b.x + b.width > innerWidth + 1)
    const buttons = controls.filter(b => b.tag === 'BUTTON'), overlaps: unknown[] = [], spacing: number[] = []
    for (let i = 0; i < buttons.length; i++) for (const b of buttons.slice(i + 1)) {
      const a = buttons[i], dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      if (dx > 1 && dy > 1) overlaps.push([a.text, b.text])
      if (dy > 1) spacing.push(Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width))
    }
    const labelGaps = Array.from(main.querySelectorAll('dl dt')).map(dt => dt.nextElementSibling!.getBoundingClientRect().x - dt.getBoundingClientRect().right)
    const svgErrors = Array.from(main.querySelectorAll('svg')).flatMap(svg => {
      const b = svg.getBoundingClientRect(), v = svg.viewBox.baseVal
      return b.width <= 0 || b.height <= 0 || ![v.x, v.y, v.width, v.height].every(Number.isFinite) ? ['Invalid SVG geometry'] : []
    })
    const table = main.querySelector('table'), tableBox = table?.getBoundingClientRect()
    return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      main: { x: r.x, width: r.width }, table: tableBox ? { x: tableBox.x, width: tableBox.width, scrollContainerWidth: table!.parentElement!.clientWidth } : null,
      controls, outside, overlaps, spacing, labelGaps, svgErrors }
  })
}

async function main() {
  const config = { ...(existsSync('.env') ? parse(readFileSync('.env')) : {}), ...parse(readFileSync('.env.local')), ...process.env }
  const url = new URL(config.TEST_DATABASE_URL ?? '')
  if (!/^[a-z][a-z0-9_]*_test$/.test(url.pathname.slice(1)) || config.TEST_DATABASE_CONFIRMATION !== url.pathname.slice(1)
    || config.DATABASE_URL === config.TEST_DATABASE_URL) throw Error('Unconfirmed isolated browser database')
  const fixturePath = process.env.MCP_BROWSER_FIXTURE
  if (!fixturePath) throw Error('MCP_BROWSER_FIXTURE must point to the private seeded fixture')
  const f = JSON.parse(readFileSync(fixturePath, 'utf8')), before = process.argv.includes('--before')
  const evidence = 'docs/evidence/mcp-operations', stage = before ? 'before' : 'after'
  mkdirSync(evidence, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'figtree-mcp-browser-')), port = 4062, origin = `http://localhost:${port}`
  const server = spawn('npm', ['run', 'dev', '--', '--hostname','127.0.0.1','--port', String(port)], { detached: true,
    env: { ...config, DATABASE_URL: config.TEST_DATABASE_URL!, MCP_ENABLED: 'true', MCP_WRITES_ENABLED: 'true', MCP_PUBLIC_ORIGIN: origin,
      ATTACHMENTS_DIR: scratch, PROJECT_ATTACHMENTS_DIR: scratch }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = '', browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  server.stdout?.on('data', b => { logs += b }); server.stderr?.on('data', b => { logs += b })
  const measurements = [], comparison = []
  try {
    let ready = false
    for (let n = 0; n < 120; n++) { try { if ((await fetch(origin + '/login')).ok) { ready = true; break } } catch {}
      await new Promise(resolve => setTimeout(resolve, 500)) }
    if (!ready) throw Error('Isolated MCP browser server did not start')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext(); await context.addInitScript('globalThis.__name = (fn) => fn')
    await context.addCookies([{ name: 'erp_session', value: f.token, url: origin, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage(), prior = before ? null : JSON.parse(readFileSync(evidence + '/before-layout.json', 'utf8'))
    for (const width of [1440, 390]) for (const kind of ['pending', 'rejection']) {
      await page.setViewportSize({ width, height: 1000 }); await page.goto(origin + f[kind].reviewUrl)
      await expect(page.getByRole('heading', { name: 'Review proposal', exact: true })).toBeVisible({ timeout: 60000 })
      await expect(page.getByRole('button', { name: 'Create draft', exact: true })).toBeVisible()
      const measured = await browser_evaluate(page)
      if (measured.scrollWidth > width + 1 || measured.outside.length || measured.overlaps.length || measured.svgErrors.length
        || measured.spacing.some(g => g < 10) || measured.labelGaps.some(g => g < 12)) throw Error('MCP layout health failed: ' + JSON.stringify(measured))
      measurements.push({ width, kind, ...measured })
      if (prior) {
        const old = prior.find((m: { width: number; kind: string }) => m.width === width && m.kind === kind)
        const differences = ['x', 'width'].filter(k => Math.abs(old.main[k] - measured.main[k as 'x']) > 1)
        const buttonDifferences = old.controls.filter((c: { tag: string }) => c.tag === 'BUTTON').filter((c: { text: string; width: number; height: number }) => {
          const current = measured.controls.find(n => n.tag === 'BUTTON' && n.text === c.text)
          return !current || Math.abs(current.width - c.width) > 1 || Math.abs(current.height - c.height) > 1
        })
        comparison.push({ width, kind, differences, buttonDifferences })
        if (differences.length || buttonDifferences.length) throw Error('Existing MCP page/control dimensions changed')
        if (kind === 'pending') await expect(page.locator('main:not([aria-busy])')).toContainText('MCP Supplier')
        else await expect(page.locator('main:not([aria-busy])')).toContainText('1200 · Receivables')
      }
      await page.screenshot({ path: `${evidence}/${stage}-${kind}-${width}.png`, fullPage: true })
    }
    writeFileSync(`${evidence}/${stage}-layout.json`, JSON.stringify(measurements, null, 2) + '\n')
    if (before) { console.log('PASS  MCP UI baseline measured before financial-preview refinement at 1440/390'); return }
    writeFileSync(evidence + '/layout-comparison.json', JSON.stringify(comparison, null, 2) + '\n')
    await page.goto(origin + f.pending.reviewUrl, { waitUntil: 'networkidle' })
    await page.locator('input[name="expectedDigest"]').first().evaluate((e: HTMLInputElement) => { e.value = 'forged-preview' })
    await page.getByRole('button', { name: 'Create draft', exact: true }).click()
    await expect(page.locator('main p[role="alert"]')).toContainText('Reload the immutable proposal', { timeout: 60000 })
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Create draft', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Open created journal draft' })).toBeVisible({ timeout: 60000 })
    const resultLink = page.getByRole('link', { name: 'Open created journal draft' }), resultHref = await resultLink.getAttribute('href')
    await page.reload(); await expect(resultLink).toHaveAttribute('href', resultHref!)
    await expect(page.getByRole('button', { name: 'Create draft', exact: true })).toHaveCount(0)
    await resultLink.click(); await expect(page.locator('main:not([aria-busy])')).toContainText('MCP journal')
    await page.goto(origin + f.rejection.reviewUrl); await page.getByRole('button', { name: 'Reject proposal', exact: true }).click()
    await expect(page.locator('main [role="status"]').first()).toHaveText('rejected', { timeout: 60000 })
    await expect(page.getByRole('button', { name: 'Create draft', exact: true })).toHaveCount(0)
    await page.goto(origin + f.expired.reviewUrl); await expect(page.locator('[data-mcp-proposal-review] [role="status"]').first()).toHaveText('expired')
    await expect(page.getByRole('button', { name: 'Create draft', exact: true })).toHaveCount(0)
    await page.goto(origin + `/ledger/${f.ledgerId}/assistant/mcp`); await expect(page.getByRole('heading', { name: 'MCP proposals', exact: true })).toBeVisible()
    await page.goto(origin + `/ledger/${f.ledgerId}/assistant`); await expect(page.getByRole('link', { name: 'Review your MCP proposals' })).toBeVisible()
    const denied = await browser.newContext(); await denied.addCookies([{ name: 'erp_session', value: f.clerkToken, url: origin, httpOnly: true, sameSite: 'Lax' }])
    const deniedPage = await denied.newPage(), response = await deniedPage.goto(origin + f.pending.reviewUrl)
    // Next streaming can send 200 before notFound renders; verify the actual
    // denial content and absence of proposal data rather than only HTTP status.
    await expect(deniedPage.getByRole('heading', { name: 'Not here', exact: true })).toBeVisible()
    const deniedBody = await response!.text()
    if (deniedBody.includes(f.pending.digest) || deniedBody.includes(f.pending.reason)) throw Error('Another user received proposal data')
    await expect(deniedPage.locator('[data-mcp-proposal-review]')).toHaveCount(0)
    await expect(deniedPage.getByRole('button', { name: 'Create draft', exact: true })).toHaveCount(0)
    const anonymous = await browser.newPage(); await anonymous.goto(origin + f.pending.reviewUrl)
    if (!anonymous.url().includes('/login')) throw Error('Anonymous proposal review did not require login')
    writeFileSync(evidence + '/browser-result.json', JSON.stringify({ passed: true, widths: [1440, 390], layoutComparisons: comparison.length,
      realNextServerActions: ['refuse changed digest', 'confirm', 'reject'], checked: ['stable result on reload', 'result workspace opens', 'expired', 'other user including streamed payload', 'anonymous', 'assistant navigation'],
      database: url.pathname.slice(1), actualApplicationTouched: false, baseline: 'Current initial MCP UI before financial-preview refinement; not a pre-feature Assistant measurement',
      verifierSource: 'Inline computational overlap, visibility, spacing and SVG checks; docs/verifiers/layout_verifiers.js does not exist in this checkout' }, null, 2) + '\n')
    console.log('PASS  MCP browser 1440/390 layout comparison, real confirm/reject, result navigation, expiry and access denial\n=== ALL CHECKS PASSED ===')
  } finally {
    writeFileSync(`${evidence}/${stage}-server.log`, logs)
    await browser?.close(); try { process.kill(-server.pid!, 'SIGTERM') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e }
    rmSync(scratch, { recursive: true, force: true })
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })

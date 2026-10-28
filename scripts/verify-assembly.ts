import './env'
import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { assembleModules, buildAssembly, selectedModules } from './module-assembly'
import { BASE, fileModule } from './module-map'
import { addonCatalog } from './addon-catalog'
import { reporter } from './suite'

const r = reporter(70)
const root = process.cwd()
const build = process.argv.includes('--build')
const profiles = ['base', 'payroll', 'records', 'crm', 'esign', 'project', 'payroll,ops', 'payroll,sred', 'all']
async function files(directory: string): Promise<string[]> {
  const children = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(children.map(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : Promise.resolve([path])
  }))).flat()
}

async function command(cwd: string, args: string[]) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, NODE_OPTIONS: '--conditions=react-server' }, stdio: 'inherit' })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, `Command failed in ${cwd}`)
}

async function runtime(output: string) {
  await cp(join(root, 'scripts/assembly-runtime-smoke.ts'), join(output, 'scripts/assembly-runtime-smoke.ts'))
  await command(output, ['--import', 'tsx', 'scripts/assembly-runtime-smoke.ts'])
  const fixture = JSON.parse(await readFile(join(output, '.assembly-smoke.json'), 'utf8'))
  const listener = createServer()
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const address = listener.address(); assert.ok(address && typeof address !== 'string')
  const port = address.port
  listener.close(); await once(listener, 'close')
  const log = createWriteStream(join(output, 'runtime.log'))
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: output, env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production', AUTH_ADMIN_MFA_REQUIRED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.pipe(log); server.stderr.pipe(log)
  try {
    const origin = `http://127.0.0.1:${port}`
    let ready = false
    for (let attempt = 0; attempt < 120; attempt++) {
      assert.equal(server.exitCode, null, 'Production server exited before readiness')
      try { if ((await fetch(origin + '/login')).ok) { ready = true; break } } catch {}
      await new Promise(accept => setTimeout(accept, 250))
    }
    assert.ok(ready, 'Production server readiness timeout')
    const headers = { cookie: 'erp_session=' + fixture.token }
    for (const path of ['', '/entries', '/invoices', '/bank', '/reports']) {
      const response = await fetch(`${origin}/ledger/${fixture.ledgerId}${path}`, { headers, redirect: 'manual' })
      assert.equal(response.status, 200, `Base HTTP ${path}`)
      assert.ok(!(await response.text()).includes('Application error'))
    }
    for (const path of ['/payroll', '/records', '/crm', '/documents', '/projects', '/assets', '/inventory', '/sred']) {
      for (const authenticated of [false, true]) assert.equal((await fetch(`${origin}/ledger/${fixture.ledgerId}${path}`, { headers: authenticated ? headers : {}, redirect: 'manual' })).status, 404, `Omitted ${path}`)
    }
    assert.equal((await fetch(origin + '/api/documenso/00000000-0000-0000-0000-000000000001', { method: 'POST', redirect: 'manual' })).status, 404)
    r.pass('AS9 base production HTTP opens accounting and refuses omitted routes', 'five accounting pages; eight omitted workspaces, with and without a session; omitted webhook')
  } finally {
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited }
    log.end()
    await rm(join(output, '.assembly-smoke.json'), { force: true })
    await rm(join(output, 'scripts/assembly-runtime-smoke.ts'), { force: true })
  }
}

async function traceIsolation(output: string) {
  const traces = (await files(join(output, '.next'))).filter(path => path.endsWith('.nft.json'))
  assert.ok(traces.length >= 10, 'A failed or empty build is not isolation evidence')
  let referenced = 0
  for (const path of traces) for (const file of JSON.parse(await readFile(path, 'utf8')).files as string[]) {
    const target = resolve(dirname(path), file), local = relative(output, target)
    assert.ok(!isAbsolute(local) && local !== '..' && !local.startsWith('..' + sep), `Trace escaped output: ${path}: ${file}`)
    assert.ok(!/^(?:\.nsp|\.git|attachments|project-attachments)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(local.replaceAll(sep, '/')), `Private file traced: ${local}`)
    referenced++
  }
  return { traceFiles: traces.length, references: referenced, outside: 0, privateFiles: 0 }
}

async function main() {
  for (const selection of ['', 'unknown', 'ops', 'sred', 'payroll,,crm']) assert.throws(() => selectedModules(selection))
  assert.deepEqual(selectedModules('sred,payroll').map(manifest => manifest.id), ['PAYROLL', 'SRED'])
  r.pass('AS1 selections reject unknown modules and unsatisfied dependencies')
  await mkdir(join(root, 'build'), { recursive: true })
  const directory = await mkdtemp(join(root, 'build/assembly-check-'))
  const evidence: Array<Record<string, unknown>> = []
  try {
    for (const selection of profiles) {
      const key = selection.replaceAll(',', '-'), selected = selectedModules(selection), ids = new Set(selected.map(manifest => manifest.id))
      const result = await assembleModules({ selection, output: join(directory, key) })
      const source = await files(join(result.output, 'src'))
      const invalid = source.filter(path => { const owner = fileModule(relative(result.output, path).replaceAll(sep, '/')); return !BASE.has(owner) && !ids.has(owner as typeof selected[number]['id']) })
      assert.deepEqual(invalid, [])
      assert.ok(source.length > 400)
      const rootFiles = await readdir(result.output)
      for (const privateFile of ['.env.local', '.env', '.nsp', '.git', 'attachments', 'project-attachments']) assert.ok(!rootFiles.includes(privateFile))
      const inventory = JSON.parse(await readFile(join(result.output, 'figtree-assembly.json'), 'utf8'))
      const runtimePackage = JSON.parse(await readFile(join(result.output, 'package.json'), 'utf8'))
      for (const name of ['backup', 'backup:check', 'backup:status', 'db:migrate', 'automation:worker', 'mcp']) assert.ok(runtimePackage.scripts[name], `Missing operational command: ${name}`)
      for (const command of Object.values(runtimePackage.scripts) as string[]) for (const match of command.matchAll(/scripts\/([\w.-]+\.(?:ts|sh))/g)) await access(join(result.output, 'scripts', match[1]))
      assert.equal(inventory.version, JSON.parse(await readFile('package.json', 'utf8')).version)
      assert.deepEqual(inventory.addons, selected.map(manifest => manifest.id))
      const exclusions = await readFile(join(result.output, 'src/assembly/excluded.ts'), 'utf8')
      for (const manifest of addonCatalog) if (!ids.has(manifest.id)) for (const table of Object.keys(manifest.backup?.excluded ?? {})) {
        if (!manifest.referenceTables?.includes(table)) assert.ok(exclusions.includes(`"${table}"`), `Local module data omitted from compatibility guard: ${table}`)
      }
      if (selection === 'base') {
        await assert.rejects(assembleModules({ selection, output: result.output }), /already exists/)
        await assert.rejects(assembleModules({ selection, output: join(root, 'src/unsafe-output') }), /under build/)
      }
      r.pass(`AS2 ${key} physically contains only its selected module sources`, `${source.length} source files, unified version, no private workspace inputs`)
      if (build) {
        await buildAssembly(result.output)
        const traces = await traceIsolation(result.output)
        if (selection === 'base') await runtime(result.output)
        evidence.push({ profile: selection, modules: result.modules, sources: source.length, ...traces, build: 'passed', ...(selection === 'base' ? { runtime: 'passed' } : {}) })
        r.pass(`AS3 ${key} production build and trace isolation`, `${traces.traceFiles} nonempty trace inventories; zero outside or private files`)
      }
    }
    if (build) await writeFile('docs/evidence/module-assembly.json', JSON.stringify({ checkedAt: new Date().toISOString(), testDatabase: new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1), profiles: evidence }, null, 2) + '\n')
    console.log(r.summary())
  } finally { await rm(directory, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })

/** Render the accepted source on this runner before comparing the candidate. */
import './dotenv'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, chmod, constants } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const ACCEPTED_SOURCE = '471833eed9d3c157bee648038bd599cf49a3cd81'

async function main() {
  const root = process.cwd(), test = process.env.TEST_DATABASE_URL, app = process.env.DATABASE_URL
  if (!test || !app || !/^[a-z][a-z0-9_]*_test$/.test(new URL(test).pathname.slice(1))
      || process.env.TEST_DATABASE_CONFIRMATION !== new URL(test).pathname.slice(1)
      || (new URL(app).host === new URL(test).host && new URL(app).pathname === new URL(test).pathname)) {
    throw new Error('Pinned layout replay requires confirmed TEST and distinct application databases.')
  }
  const evidence = join(root, 'docs/evidence/p2')
  await mkdir(evidence, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), 'banyan-p2-pinned-')), source = join(scratch, 'source')
  let added = false
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error('Pinned source Git operation failed: ' + (result.stderr || args[0]))
    return result.stdout.trim()
  }
  async function browser(cwd: string, args: string[], log: string) {
    const result = spawnSync('npm', ['run', 'test:p2-browser', ...args], {
      cwd, env: { ...process.env }, encoding: 'utf8', maxBuffer: 32e6,
    })
    const output = (result.stdout ?? '') + (result.stderr ?? '')
    await writeFile(join(evidence, log), output)
    process.stdout.write(output)
    if (result.status !== 0) throw new Error('P2 browser phase failed; inspect ' + log)
  }
  try {
    if (spawnSync('git', ['cat-file', '-e', ACCEPTED_SOURCE + '^{commit}'], { cwd: root }).status !== 0) {
      git('fetch', '--no-tags', '--depth=1', 'origin', ACCEPTED_SOURCE)
    }
    git('worktree', 'add', '--detach', source, ACCEPTED_SOURCE); added = true
    const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' })
    if (actual.status !== 0 || actual.stdout.trim() !== ACCEPTED_SOURCE) throw new Error('Unexpected layout baseline source.')
    await cp(join(root, 'node_modules'), join(source, 'node_modules'), {
      recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
    })
    await cp(join(root, '.env.local'), join(source, '.env.local'))
    await chmod(join(source, '.env.local'), 0o600)
    // CI's preceding typecheck/build supplies this generated file.
    await cp(join(root, 'next-env.d.ts'), join(source, 'next-env.d.ts'))
    await mkdir(join(source, 'docs/evidence/p2'), { recursive: true })
    await browser(source, ['--', '--capture-current-layout'], 'layout-pinned-capture.log')
    const before = await readFile(join(source, 'docs/evidence/p2/browser-current-layout-measurements.json'))
    const provenance = await readFile(join(source, 'docs/evidence/p2/layout-current-source.json'))
    await writeFile(join(evidence, 'browser-current-layout-measurements.json'), before)
    await writeFile(join(evidence, 'layout-current-source.json'), provenance)
    await writeFile(join(evidence, 'layout-pinned-source.json'), JSON.stringify({
      commit: ACCEPTED_SOURCE, capturedAt: new Date().toISOString(),
      measurementSha256: createHash('sha256').update(before).digest('hex'),
      sourceProvenanceSha256: createHash('sha256').update(provenance).digest('hex'),
      renderer: 'Same runner, Playwright and dependencies as the candidate; source is the fixed accepted commit.',
    }, null, 2) + '\n')
    console.log('PASS P2 immutable accepted-source layout captured: ' + ACCEPTED_SOURCE)
  } finally {
    if (added) git('worktree', 'remove', '--force', source)
    await rm(scratch, { recursive: true, force: true })
  }
  // This is the original complete test, with its 2px and functional assertions.
  await browser(root, [], 'layout-candidate-browser.log')
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })

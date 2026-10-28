import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

type Ast = { type: string; value?: string; nodes?: Ast[] }
type Braces = ((input: string) => unknown) & {
  parse(input: string): Ast
  compile(input: unknown): unknown
  expand(input: unknown): unknown
  stringify(input: unknown): unknown
}

/** Audit cannot assess a private fork; check its installed bytes and behavior. */
export function verifyDependencyPatches(): number {
  const rootRequire = createRequire(join(process.cwd(), 'package.json'))
  const require = createRequire(rootRequire.resolve('micromatch/package.json'))
  const installed = dirname(require.resolve('braces/package.json'))
  const vendor = join(process.cwd(), 'vendor/braces')
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  const provenance = JSON.parse(readFileSync(join(vendor, 'PROVENANCE.json'), 'utf8'))
  assert.equal(pkg.name, '@figtree/braces')
  assert.equal(pkg.version, '3.0.3-figtree.1')
  assert.equal(provenance.advisory, 'GHSA-vfj7-8cjw-p6xm')
  assert.equal(provenance.upstream.version, '3.0.3')
  assert.match(provenance.upstream.integrity, /^sha512-/)
  const files = ['index.js', 'package.json', 'LICENSE', ...['compile', 'expand', 'stringify', 'parse', 'utils', 'constants', 'depth-guard'].map(n => `lib/${n}.js`)]
  for (const file of files) {
    const hash = (root: string) => createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
    assert.equal(hash(installed), hash(vendor), `Installed patch differs: ${file}`)
  }

  const library = require('braces') as Braces
  const guard = require('braces/lib/depth-guard') as { MAX_DEPTH: number; MAX_NODES: number }
  assert.equal(guard.MAX_DEPTH, 128)
  assert.equal(guard.MAX_NODES, 200000)
  const fixtures = JSON.parse(readFileSync(join(process.cwd(), 'scripts/fixtures/braces-compatibility.json'), 'utf8')) as Array<{
    pattern: string; compiled: unknown; expanded: unknown; stringified: unknown; default: unknown
  }>
  let checks = 0
  for (const fixture of fixtures) {
    assert.deepEqual(library(fixture.pattern), fixture.default); checks++
    for (const [method, expected] of [['compile', 'compiled'], ['expand', 'expanded'], ['stringify', 'stringified']] as const) {
      assert.deepEqual(library[method](fixture.pattern), fixture[expected], `${method}: ${fixture.pattern}`); checks++
    }
  }
  const refused = (work: () => unknown, code: string) => {
    assert.throws(work, error => error instanceof Error && !(error instanceof RangeError)
      && 'code' in error && error.code === code)
    checks++
  }
  // All inputs are below the upstream character limit. Partial patterns also
  // reach stringify while parsing, before parse returns its finished AST.
  for (const pattern of ['{'.repeat(4900) + 'x' + '}'.repeat(4900), '{' + '{a,'.repeat(1200) + 'x' + '}'.repeat(1200)]) {
    for (const method of ['parse', 'compile', 'expand', 'stringify'] as const) {
      refused(() => library[method](pattern), 'ERR_BRACES_DEPTH_LIMIT')
    }
  }
  let deep: Ast = { type: 'text', value: 'x' }
  for (let n = 0; n < 5000; n++) deep = { type: 'root', nodes: [deep] }
  const cycle: Ast = { type: 'root', nodes: [] }; cycle.nodes!.push(cycle)
  for (const method of ['compile', 'expand', 'stringify'] as const) {
    refused(() => library[method](deep), 'ERR_BRACES_DEPTH_LIMIT')
    refused(() => library[method](cycle), 'ERR_BRACES_CYCLE')
    refused(() => library[method]({ type: 'root', nodes: Array.from({ length: guard.MAX_NODES + 1 }, () => ({ type: 'text', value: 'x' })) }), 'ERR_BRACES_NODE_LIMIT')
  }
  // Shared children are legal; a global visited-set would wrongly reject them.
  const shared: Ast = { type: 'text', value: 'a' }, graph: Ast = { type: 'root', nodes: [shared, shared] }
  assert.equal(library.compile(graph), 'aa'); checks++
  assert.equal(library.stringify(graph), 'aa'); checks++
  return checks
}

/**
 * THE BASE BUNDLE MAY NOT KNOW THE ADD-ONS — measured, and held to a ratchet.
 *
 * docs/design/48-module-boundaries.md §3 counted every place the base bundle
 * reaches into an add-on, and every add-on that leans on another. The owner
 * revised the base to eleven modules on 2026-10-22; module-map is authoritative. This
 * check makes sure that while it happens no NEW crossing appears — a person or
 * an assistant adding one import is exactly how the tangle grew — and that a
 * crossing taken out is struck from the record, not left as room for the next.
 *
 *   npm run db:verify-modules                  (resets the test database first)
 *   npm run db:verify-modules -- --prune       strike crossings that are gone
 *
 * Four kinds of crossing, each compared with scripts/module-baseline.json:
 *   code     a base business file imports an add-on file (exact generated roots checked separately)
 *   fk       a base table has a foreign key to an add-on table
 *   trigger  a trigger on a base table runs a function that names an add-on table
 *   addon    one add-on depends on another, by import or foreign key
 *
 * Ownership comes from scripts/module-map.ts and nowhere else.
 */
import './env'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { reporter } from './suite'
import { BASE, fileModule, tableModule, type ModuleId } from './module-map'
import { composition, selectedModules } from './module-assembly'

const BASELINE = 'scripts/module-baseline.json'
const KINDS = ['code', 'fk', 'trigger', 'addon'] as const
type Kind = typeof KINDS[number]
type Crossings = Record<Kind, Set<string>>

const r = reporter(66)
const { check } = r
const isBase = (m: ModuleId) => BASE.has(m)

function sources(dir = 'src'): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(e) && !e.endsWith('.d.ts') ? [p] : []
  })
}

/** Comments out, so a sentence that mentions a path is not read as an import. */
const uncommented = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1')

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join('src', spec.slice(2))
    : spec.startsWith('.') ? normalize(join(dirname(from), spec)) : null
  if (!base) return null
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const p = base + ext
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

/** SQL with its comments and string literals taken out: what it touches, not what it says. */
const bareSql = (src: string) =>
  src.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^']|'')*'/g, "''")

async function main() {
  const prune = process.argv.includes('--prune')
  const init = process.argv.includes('--init')
  const snapshotAt = process.argv.indexOf('--snapshot')
  const snapshot = snapshotAt < 0 ? undefined : process.argv[snapshotAt + 1]
  if (snapshotAt >= 0 && (!snapshot || snapshot.startsWith('--'))) throw new Error('--snapshot requires a fresh measurement file.')
  const expected = composition(selectedModules('all'))
  const roots = new Set(Object.entries(expected).filter(([file, contents]) => readFileSync(join('src/assembly', file), 'utf8') === contents).map(([file]) => join('src/assembly', file)))
  const found: Crossings = { code: new Set(), fk: new Set(), trigger: new Set(), addon: new Set() }

  // ---- the code ------------------------------------------------------------
  const files = sources()
  const edges = new Set<string>()
  for (const f of files) {
    const from = fileModule(f)
    for (const m of uncommented(readFileSync(f, 'utf8')).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const t = resolve(f, m[1])
      if (!t || t === f) continue
      edges.add(`${f} -> ${t}`)
      const to = fileModule(t)
      if (from === to) continue
      if (isBase(from) && !isBase(to) && !roots.has(f)) found.code.add(`${f} -> ${t}`)
      if (!isBase(from) && !isBase(to)) found.addon.add(`${from} -> ${to}`)
    }
  }

  // ---- the schema ----------------------------------------------------------
  const tables = (await db.execute<{ name: string }>(raw`
    SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)).map((t) => t.name)
  const unowned = tables.filter((t) => tableModule(t) === null)
  const owner = (t: string) => tableModule(t)

  const fks = await db.execute<{ a: string; b: string }>(raw`
    SELECT DISTINCT conrelid::regclass::text AS a, confrelid::regclass::text AS b
      FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`)
  for (const { a, b } of fks) {
    const ma = owner(a), mb = owner(b)
    if (!ma || !mb || ma === mb) continue
    if (isBase(ma) && !isBase(mb)) found.fk.add(`${a} -> ${b}`)
    if (!isBase(ma) && !isBase(mb)) found.addon.add(`${ma} -> ${mb}`)
  }

  const addonTables = tables.filter((t) => { const m = owner(t); return m !== null && !isBase(m) })
    .sort((x, y) => y.length - x.length)
  const names = new RegExp(`(?<![a-z0-9_])(${addonTables.join('|')})(?![a-z0-9_])`, 'g')
  // A trigger function that only CALLS another function names no table itself:
  // CRM's seeding on `entity` and the operations check on the journal both work
  // that way, so the scan follows every function called, all the way down.
  const bodies = new Map<string, string>()
  for (const { fn, body } of await db.execute<{ fn: string; body: string }>(raw`
    SELECT proname AS fn, prosrc AS body FROM pg_proc WHERE pronamespace = 'public'::regnamespace`)) {
    bodies.set(fn, (bodies.get(fn) ?? '') + '\n' + bareSql(body))
  }
  const reach = (fn: string, seen = new Set<string>()): string => {
    if (seen.has(fn) || !bodies.has(fn)) return ''
    seen.add(fn)
    const body = bodies.get(fn)!
    const called = [...body.matchAll(/(?<![a-z0-9_.])([a-z_][a-z0-9_]*)\s*\(/g)].map((x) => x[1]).filter((c) => bodies.has(c))
    return body + called.map((c) => reach(c, seen)).join('\n')
  }
  const triggers = await db.execute<{ tbl: string; fn: string }>(raw`
    SELECT DISTINCT c.relname AS tbl, p.proname AS fn
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace`)
  for (const { tbl, fn } of triggers) {
    const m = owner(tbl)
    if (!m || !isBase(m)) continue
    for (const hit of new Set([...reach(fn).matchAll(names)].map((x) => owner(x[1])))) {
      found.trigger.add(`${tbl} ${fn} -> ${hit}`)
    }
  }

  if (snapshot) {
    writeFileSync(snapshot, JSON.stringify(Object.fromEntries(KINDS.map(kind => [kind, [...found[kind]].sort()])), null, 2) + '\n', { flag: 'wx' })
    console.log(`Measured crossings in ${snapshot}; no baseline validation was performed.`)
    await conn.end()
    return
  }

  // ---- against the record --------------------------------------------------
  if (init) {
    if (existsSync(BASELINE)) throw new Error(`${BASELINE} exists; --init only writes the first one.`)
    writeBaseline(found)
    console.log(`Wrote ${BASELINE}.`)
  }
  const recorded = readBaseline()
  if (prune) {
    for (const k of KINDS) recorded[k] = new Set([...recorded[k]].filter((x) => found[k].has(x)))
    writeBaseline(recorded)
  }
  const fresh = (k: Kind) => [...found[k]].filter((x) => !recorded[k].has(x)).sort()
  const gone = KINDS.flatMap((k) => [...recorded[k]].filter((x) => !found[k].has(x)).map((x) => `${k} ${x}`)).sort()
  const said = (xs: string[], k: Kind) =>
    xs.length === 0 ? `${found[k].size} recorded, none new` : `${xs.length} new: ${xs.slice(0, 4).join('; ')}`

  check(edges.size >= 1000 && edges.has('src/lib/posting.ts -> src/db/client.ts') && tables.length >= 150 && fks.length >= 100,
    'MV0 the reader sees the code and schema it should',
    `${files.length} files, ${edges.size} imports, ${tables.length} tables, ${fks.length} foreign keys, ${triggers.length} triggers`)
  check(unowned.length === 0,
    'MV1 every table belongs to a module',
    unowned.length === 0 ? `${tables.length} tables, each claimed in scripts/module-map.ts` : `unclaimed: ${unowned.join(', ')}`)
  check(fresh('code').length === 0, 'MV2 no new import from the base bundle into an add-on', said(fresh('code'), 'code'))
  check(fresh('fk').length === 0, 'MV3 no new foreign key from a base table to an add-on', said(fresh('fk'), 'fk'))
  check(fresh('trigger').length === 0, 'MV4 no new trigger on a base table that reads an add-on', said(fresh('trigger'), 'trigger'))
  check(fresh('addon').length === 0, 'MV5 no new dependency between add-ons', said(fresh('addon'), 'addon'))
  check(gone.length === 0,
    'MV6 every recorded crossing still exists',
    gone.length === 0 ? 'the record matches the tree'
      : `${gone.length} taken out — strike them with npm run db:verify-modules -- --prune: ${gone.slice(0, 4).join('; ')}`)

  check(roots.size === Object.keys(expected).length && readFileSync('src/assembly/excluded.ts', 'utf8').includes('= []'),
    'MV7 only canonical generated composition roots may import add-ons',
    `${roots.size}/${Object.keys(expected).length} exact generated roots; business code has no exemption`)

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

function readBaseline(): Crossings {
  const doc = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<Kind, string[]>
  return { code: new Set(doc.code), fk: new Set(doc.fk), trigger: new Set(doc.trigger), addon: new Set(doc.addon) }
}

function writeBaseline(c: Crossings) {
  const doc = {
    note: 'Crossings from the base bundle into add-ons, and between add-ons, that exist today (docs/design/48-module-boundaries.md). '
      + 'Only ever shrinks: db:verify-modules fails on one that is not here, and on one here that is gone (--prune strikes those).',
    ...Object.fromEntries(KINDS.map((k) => [k, [...c[k]].sort()])),
  }
  writeFileSync(BASELINE, JSON.stringify(doc, null, 2) + '\n')
}

main().catch(async (e) => {
  console.error(e)
  await conn.end()
  process.exit(1)
})

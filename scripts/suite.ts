/**
 * What every suite used to carry a copy of.
 *
 * Thirty-four suites each declared `pass`, `fail` and `check`; fourteen
 * carried `errorText`, eleven of them the loop that `src/lib/db-errors.ts`
 * had already named ONE SPELLING; thirteen carried an `expectError` in one of
 * four shapes. None of it is a rule under test — it is how a check speaks —
 * so it lives here once (2026-09-13).
 *
 * THE LINES ARE THE CONTRACT. `scripts/suites.sh` and `scripts/mutations.sh`
 * read what a suite prints: `PASS  <label padded>  <detail>`, `FAIL  …`, and
 * the closing `=== … ===`. The padding differs per suite and the truncation
 * differs per helper, so both are parameters rather than a new common width —
 * a suite moved onto this file prints exactly what it printed before, which
 * `docs/evidence/suites.md` can be diffed to show.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { causesOf } from '../src/lib/db-errors'

export type Reporter = ReturnType<typeof reporter>

/** `pass`, `fail`, `check` and the count, at this suite's label width. */
export function reporter(width: number) {
  const r = {
    failures: 0,
    pass: (l: string, d = '') => { console.log(`PASS  ${l.padEnd(width)}  ${d}`) },
    fail: (l: string, d = '') => { r.failures++; console.log(`FAIL  ${l.padEnd(width)}  ${d}`) },
    check: (ok: boolean, l: string, d = '') => (ok ? r.pass(l, d) : r.fail(l, d)),
    /** The closing line every suite prints. */
    summary: () => (r.failures === 0 ? '\n=== ALL CHECKS PASSED ===' : `\n=== ${r.failures} CHECK(S) FAILED ===`),
  }
  return r
}

/** Every message down the cause chain — the driver's refusal is two levels down. */
export const errorText = (e: unknown, sep = ' | '): string => causesOf(e, 5, sep)

/** Just the message, no chain — for errors a suite raised itself. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Coded = { code?: string; name?: string; message: string }

/**
 * `expectError(label, code, fn, saying?)`: the call must throw an error whose
 * `.code` is the one named, and — when `saying` is given — whose message
 * contains it. Options carry each suite's own truncations and wording.
 */
export function expectCode(r: Reporter, opts: {
  /** Characters of the message shown on PASS; the whole message when unset. */
  passSlice?: number
  /** What the FAIL line shows for a wrong code; the message itself when unset. */
  failText?: (e: unknown) => string
  /** Characters of the message shown when it does not say what was asked. */
  sayingSlice?: number
  /** The FAIL line when the call did not throw at all. */
  succeeded?: (code: string) => string
} = {}) {
  return async (label: string, code: string, fn: () => Promise<unknown>, saying?: string) => {
    try {
      await fn()
      r.fail(label, opts.succeeded ? opts.succeeded(code) : `expected ${code}, it succeeded`)
    } catch (e) {
      const err = e as Coded
      if (err.code !== code) {
        r.fail(label, `expected ${code}, got ${err.code ?? err.name}: ${opts.failText ? opts.failText(e) : err.message}`)
        return
      }
      if (saying !== undefined && !err.message.includes(saying)) {
        r.fail(label, `${code} raised, but it does not say ${saying}: ${err.message.slice(0, opts.sayingSlice ?? 70)}`)
        return
      }
      r.pass(label, `-> ${opts.passSlice === undefined ? err.message : err.message.slice(0, opts.passSlice)}`)
    }
  }
}

/** `expectError(label, needle, fn)`: the call must throw something whose text contains the needle. */
export function expectSaying(r: Reporter, text: (e: unknown) => string, slice: number) {
  return async (label: string, needle: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      r.fail(label, `expected ${needle}, it went through`)
    } catch (e) {
      const msg = text(e)
      r.check(msg.includes(needle), label, msg.slice(0, slice))
    }
  }
}

/**
 * `expectDbError(label, fragment, fn)`: the DATABASE must refuse — the
 * fragment is looked for in each message down the chain, where a trigger's
 * RAISE or a constraint's name sits.
 */
export function expectDbRefusal(r: Reporter, opts: { passSlice: number; failSlice: number; allowed?: string }) {
  return async (label: string, fragment: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      r.fail(label, opts.allowed ?? 'the database allowed it')
    } catch (e) {
      const m = errorText(e)
      const hit = m.split(' | ').find((p) => p.includes(fragment))
      hit ? r.pass(label, `-> ${hit.split('\n')[0].slice(0, opts.passSlice)}`)
          : r.fail(label, `expected "${fragment}", got: ${m.slice(0, opts.failSlice)}`)
    }
  }
}

/** Tidy-up that must not go quiet: a failed cleanup is a FAIL line, not a swallow. */
export function cleanupWith(r: Reporter) {
  return async (what: string, fn: () => Promise<unknown>) => {
    try { await fn() } catch (e) { r.fail(`cleanup: ${what}`, errorText(e).slice(0, 96)) }
  }
}

/** A file that is a PDF to every sniff test and nothing else. */
export const tinyPdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`)

/** Every .ts/.tsx under a directory, for the checks that read source. */
export function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** The six entities React escapes in markup, undone. */
export const unescape = (v: string) => v
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

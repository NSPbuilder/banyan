/**
 * Which mutation blocks turned nothing red.
 *   npm run db:toothless
 *
 * A block that ran, applied its mutation, and left the suite green is a block
 * that proves nothing — and it is indistinguishable from a passing one unless
 * something looks. The usual cause is a LATER migration `CREATE OR REPLACE`-ing
 * the function the block edits: the mutation lands in a file whose definition is
 * overwritten before any check runs.
 *
 * This has now happened nine times in this repository, in three waves:
 *
 *   0026 retired three party blocks
 *   0029 retired two invoice blocks
 *   0032 and 0033 retired four more, all of them mine, in the same round I was
 *   reporting that nothing had been retired
 *
 * The first two waves were caught by a version of this report that lived inside
 * `scripts/mutations.sh`. That version was lost — overwritten by an editing
 * mistake, never committed, and present in no commit — and for several rounds
 * afterwards the thing watching for its output was grepping for a string that
 * could no longer be produced. A check that cannot fail reports success.
 *
 * So it lives here instead: its own file, its own npm script, and a row in the
 * battery (`scripts/suites.sh`). It is checked every time the suites run, not
 * only when the generator happens to finish, and losing it now means deleting a
 * file that something else names.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Blocks that are green ON PURPOSE — they assert that something harmless
 * changes nothing. Each additional control needs an explicit rationale here.
 */
const GREEN_ON_PURPOSE = new Set([
  'The delay alone, transaction intact',
  'openProposals reverses the rows it pairs — harmless, and that is the point',
  // The financial-operations fixture independently supplies/restores payroll;
  // BK0's combined fixture inventory still has real pay_run and pay_stub rows.
  'One payroll fixture can go while another still proves the backup',
])

/**
 * Trailing sections that are not blocks at all. Guarded the same way the
 * allowlist above is: a name here that matches nothing is a name that would
 * silently excuse the next block unlucky enough to be called it.
 */
const NOT_A_BLOCK = new Set(['Not covered here', 'What the blocks span'])

const out = join(process.cwd(), 'docs', 'evidence', 'mutations.md')
const text = readFileSync(out, 'utf8')

const blocks = text.split(/^## /m).slice(1).map((b) => {
  const fence = b.includes('```') ? b.split('```')[1] : ''
  const lines = fence.split('\n')
  return {
    title: b.split('\n')[0].trim(),
    hasFail: lines.some((l) => l.startsWith('FAIL')),
    // A block ran if its fence holds a suite's own summary line. This used to
    // be "the fence is not empty", which stopped meaning anything the moment
    // the generator started writing a suite-name line into the fence: every
    // block would have had output, including one that never ran.
    hasOutput: lines.some((l) => l.startsWith('=== ')),
  }
})

const real = blocks.filter((b) => !NOT_A_BLOCK.has(b.title))

/**
 * And the blocks that were never RUN.
 *
 * Everything below reads the evidence file, so a block added to
 * `mutations.sh` after the last regeneration is invisible here: the file simply
 * does not mention it, and "not mentioned" looked exactly like "not there".
 * That happened — block 364 was written, spot-proved by hand, and the evidence
 * still described 359 blocks while the script held 360 (2026-09-04).
 *
 * The titles are the join, because they are what the evidence records.
 */
const script = readFileSync('scripts/mutations.sh', 'utf8')
const declared = [...script.matchAll(/^section "((?:[^"\\]|\\.)*)"/gm)]
  .map((m) => m[1].replace(/\\(.)/g, '$1'))
const neverRun = declared.filter((t) => !blocks.some((b) => b.title === t))
for (const t of neverRun) {
  console.log(`FAIL  in mutations.sh but not in the evidence: ${t.slice(0, 60)}`)
}
const empty = real.filter((b) => !b.hasOutput)
const toothless = real.filter((b) => b.hasOutput && !b.hasFail && !GREEN_ON_PURPOSE.has(b.title))

for (const b of empty) console.log(`FAIL  no captured output at all: ${b.title}`)
for (const b of toothless) console.log(`FAIL  turned nothing red: ${b.title}`)

const green = real.filter((b) => GREEN_ON_PURPOSE.has(b.title))
if (empty.length === 0 && toothless.length === 0) {
  console.log(`PASS  every mutation block turned something red${' '.repeat(20)}  `
    + `${real.length - green.length} of ${real.length}, ${green.length} green by design`)
}

// The allowlist is only honest if its members are actually there. A renamed or
// deleted block would leave a name here that quietly excuses nothing — and the
// next block to lose its teeth could be given that name by accident.
const missing = [...GREEN_ON_PURPOSE].filter((t) => !real.some((b) => b.title === t))
for (const t of missing) console.log(`FAIL  allowlisted block does not exist: ${t}`)

const absent = [...NOT_A_BLOCK].filter((t) => !blocks.some((b) => b.title === t))
for (const t of absent) console.log(`FAIL  excluded section does not exist: ${t}`)

const failures = empty.length + toothless.length + missing.length + absent.length
  + neverRun.length
console.log(failures === 0
  ? '\n=== ALL CHECKS PASSED ==='
  : `\n=== ${failures} CHECK(S) FAILED ===`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Render the SR&ED allocation table with stand-in doors and read it back —
 * `S24`, `S25` and `S26` run this.
 *
 * A process of its own, like render-quick-form: react-dom/server does not exist
 * under the react-server condition the suites run in, and this screen takes
 * every door as a prop precisely so this file needs nothing that imports
 * `server-only`.
 *
 * What it can and cannot see, said plainly: this is STATIC markup, so it proves
 * what the table shows AT REST — the order, the defaults, how many rows one page
 * holds, and that the search and filter controls are there. IT CANNOT TYPE INTO
 * THEM. What it can do is start the box and the lens somewhere, which is what
 * `query` and `lens` below are for, so a check can see a filtered table without
 * a keystroke. The predicate itself is `matchesCost` in sred-kinds.ts and is
 * called directly, branch by branch, by `S26`.
 *
 * An earlier version of this sentence said the filter "is checked by reading the
 * same list the table is built from". It was not: the predicate was a closure
 * inside the component, both renders used an empty query and the `all` lens, and
 * not one branch of it ever ran. The header of a file whose job is to say what
 * can and cannot be proved is the worst possible place for that
 * (independent critic, 2026-09-11).
 *
 * Nor can it press a row's Claim: `open` is the row (`source_kind:source_id`)
 * to render with its boxes showing, since 2026-09-16 a row is text until then.
 *
 *   npx tsx scripts/render-sred-money.tsx '<json>'
 *   { lines, query?, lens?, open? }  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { Money } from '../src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody'
import type { Allocatable, CostLens, SredClaim } from '../src/lib/sred-kinds'

const input = JSON.parse(process.argv[2]) as {
  lines: Array<Omit<Allocatable, 'amount'> & { amount: string }>
  query?: string
  lens?: CostLens
  open?: string
}
const stub = async () => ({})
const doors = {
  openClaim: stub, saveClaim: stub,
  allocate: stub, unallocate: stub, fileClaim: stub, unfileClaim: stub, deleteClaim: stub,
  updateProject: stub, deleteProject: stub, updateTime: stub, deleteTime: stub,
  updateEvidence: stub, deleteEvidence: stub,
}
const claim: SredClaim = {
  id: 'C'.repeat(36), project_id: 'P'.repeat(36), fiscal_year_id: 'Y'.repeat(36),
  method: 'proxy', uncertainty_text: null, work_done_text: null, advancement_text: null,
  assistance_answered_on: null, assistance_note: null, filed_on: null,
  year_name: 'FY2026', year_start: '2026-01-01', year_end: '2026-12-31',
}

const html = renderToStaticMarkup(
  <Money ledgerId={'L'.repeat(36)} claim={claim} salary={[]}
         lines={input.lines.map((l) => ({ ...l, amount: BigInt(l.amount) }))}
         allocated={new Map()} actions={doors}
         initialQuery={input.query ?? ''} initialLens={input.lens ?? 'all'} initialOpen={input.open ?? null} />,
)
console.log(JSON.stringify({ html }))

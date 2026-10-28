/**
 * Render the three pieces of the record screen that a person now CORRECTS
 * through, and read them back — `S34` runs this.
 *
 * A process of its own, like render-sred-money: react-dom/server does not exist
 * under the react-server condition the suites run in, and every one of these
 * takes its doors as props so this file needs nothing that imports
 * `server-only`.
 *
 * What it can see: STATIC markup. Which row's id each form carries — which is
 * the whole of what "edit this row" means and it lives nowhere else — what the
 * paste box tells a person the format is, and which of the project's columns
 * have a field at all. It cannot type into any of them.
 *
 * Nor can it press Edit. Since 2026-09-16 a row is text until its Edit is
 * pressed, so `editing` says which row (or, for the project, whether) to render
 * open; left out, the markup is the page AT REST, which is what a check of "no
 * boxes until asked" reads.
 *
 *   npx tsx scripts/render-sred-record.tsx '<json>'
 *   { what: 'time',     time: [...] }        → { html }
 *   { what: 'evidence', evidence: [...] }    → { html }
 *   { what: 'paste',    fields: [...], note } → { html }
 *   { what: 'project',  project: {...} }     → { html }
 *   { what: 'claim',    claim: {...} }       → { html }   the three answers and the filing card, at rest
 *   { what: 'years',    years, claims, yearId } → { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ClaimAnswers, EvidenceTable, Filing, PasteBox, ProjectFields, TimeTable, YearStrip,
} from '../src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody'
import { Rates, type RateRow } from '../src/app/ledger/[ledgerId]/sred/Rates'
import type { EvidenceRow, SredClaim, SredProject, SredTimeRow } from '../src/lib/sred-kinds'

const input = JSON.parse(process.argv[2]) as {
  what: 'time' | 'evidence' | 'paste' | 'project' | 'rates' | 'claim' | 'years'
  claim?: SredClaim
  years?: Array<{ id: string; name: string }>
  claims?: Array<{ fiscal_year_id: string }>
  yearId?: string | null
  /** A row id to render open, or `true` for the project. */
  editing?: string | boolean
  rates?: RateRow[]
  time?: SredTimeRow[]
  evidence?: EvidenceRow[]
  project?: SredProject
  fields?: string[]
  note?: string
}
const stub = async () => ({})
const doors = {
  openClaim: stub, saveClaim: stub,
  allocate: stub, unallocate: stub, fileClaim: stub, unfileClaim: stub, deleteClaim: stub,
  updateProject: stub, deleteProject: stub, updateTime: stub, deleteTime: stub,
  updateEvidence: stub, deleteEvidence: stub,
}
const open = typeof input.editing === 'string' ? input.editing : null
const L = 'L'.repeat(36)
const P = 'P'.repeat(36)

const tree =
  input.what === 'time'
    ? <TimeTable ledgerId={L} time={input.time ?? []} actions={doors} initialEditing={open} />
  : input.what === 'evidence'
    ? <EvidenceTable ledgerId={L} evidence={input.evidence ?? []} actions={doors} initialEditing={open} />
  : input.what === 'rates'
    ? <Rates ledgerId={L} rates={input.rates ?? []}
             actions={{ saveRate: stub, deleteRate: stub }} initialEditing={open} />
  : input.what === 'claim'
    ? <>
        <ClaimAnswers ledgerId={L} claim={input.claim as SredClaim} actions={doors} />
        <Filing ledgerId={L} claim={input.claim as SredClaim} actions={doors} />
      </>
  : input.what === 'years'
    ? <YearStrip ledgerId={L} projectId={P} years={input.years ?? []} claims={input.claims ?? []}
                 yearId={input.yearId ?? null} openClaim={stub} />
  : input.what === 'project'
    ? <ProjectFields ledgerId={L} project={input.project as SredProject} actions={doors}
                     initialEditing={input.editing === true} />
  : <PasteBox ledgerId={L} projectId={P} action={stub}
              fields={input.fields ?? []} />

console.log(JSON.stringify({ html: renderToStaticMarkup(tree) }))

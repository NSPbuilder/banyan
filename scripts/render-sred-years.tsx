/**
 * Render the year strip with stand-in doors and read it back — `S30` runs this.
 *
 * A process of its own, like render-sred-money: react-dom/server does not exist
 * under the react-server condition the suites run in, and this strip takes its
 * door as a prop precisely so this file needs nothing that imports `server-only`.
 *
 * What it can see: STATIC markup — which year is marked as the one being looked
 * at, which years are marked as having no claim, whether the opener is on the
 * page, and WHICH YEAR THE OPENER SUBMITS. That last one is the whole reason
 * this exists: the opener used to submit the newest year whatever year you were
 * looking at, and to disappear for good once the project had any claim.
 *
 *   npx tsx scripts/render-sred-years.tsx '<json>'
 *   { years, claims, yearId }  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { YearStrip } from '../src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody'

const input = JSON.parse(process.argv[2]) as {
  years: Array<{ id: string; name: string }>
  claims: Array<{ fiscal_year_id: string }>
  yearId: string | null
}
const stub = async () => ({})

const html = renderToStaticMarkup(
  <YearStrip ledgerId={'L'.repeat(36)} projectId={'P'.repeat(36)}
             years={input.years} claims={input.claims} yearId={input.yearId}
             openClaim={stub} />,
)
console.log(JSON.stringify({ html }))

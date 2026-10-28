/**
 * Render one T4127 edition's figures with no server runtime and read them back
 * — `PR58` runs this. What it can see: every figure cell the payroll screen
 * shows for an edition, by the path it is named from. With a second argument,
 * the note and Remove for an added copy of that edition instead (`PR64`).
 *
 *   npx tsx scripts/render-editions.tsx '<editionId>'                 →  { html }
 *   npx tsx scripts/render-editions.tsx '<editionId>' '<copy json>'   →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { EditionFigures } from '../src/app/ledger/[ledgerId]/payroll/EditionFigures'
import { EditionCopy } from '../src/app/ledger/[ledgerId]/payroll/EditionCopy'
import { EDITIONS } from '../src/lib/payroll/rates'

const id = process.argv[2]
if (process.argv[3]) {
  const copy = JSON.parse(process.argv[3]) as { at: string; by: string; sameFigures: boolean }
  const stub = async () => ({})
  console.log(JSON.stringify({ html: renderToStaticMarkup(<EditionCopy ledgerId={'L'.repeat(36)} editionId={id} copy={copy} remove={stub} />) }))
  process.exit(0)
}
const edition = EDITIONS.find((e) => e.id === id)
if (!edition) { console.log(JSON.stringify({ html: '' })); process.exit(0) }
console.log(JSON.stringify({ html: renderToStaticMarkup(<EditionFigures edition={edition} />) }))

/**
 * Render one entry's lines as the journal list shows them, and read the
 * markup back — `D40` runs this.
 *
 *   npx tsx scripts/render-entry-lines.tsx '<json>'
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { EntryLines } from '../src/app/ledger/[ledgerId]/entries/EntryLines'

const input = JSON.parse(process.argv[2]) as { lines: number }
const n = input.lines
const html = renderToStaticMarkup(
  <EntryLines
    accounts={Array.from({ length: n }, (_, i) => `5${100 + i}`)}
    names={Array.from({ length: n }, (_, i) => `Account ${i + 1}`)}
    debits={Array.from({ length: n }, (_, i) => (i === 0 ? '10000' : '0'))}
    credits={Array.from({ length: n }, (_, i) => (i === 0 ? '0' : '2500'))}
  />,
)
console.log(JSON.stringify({ html }))

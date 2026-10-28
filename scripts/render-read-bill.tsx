/**
 * Render the assistant's read-a-bill section with stand-in actions and read
 * it back — `BR12` runs this for the states a reading can be in.
 *
 * A process of its own, like render-assistant-panel: react-dom/server does
 * not exist under the react-server condition the suites run in, and the
 * section takes its two doors as props precisely so this file needs nothing
 * that imports `server-only`.
 *
 *   npx tsx scripts/render-read-bill.tsx '<json>'
 *   { ledgerId, canRead, chart, readings, sentenceMax? }  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { ReadBill } from '../src/components/ReadBill'
import type { ReadingCard } from '../src/lib/bill-reading'

const input = JSON.parse(process.argv[2]) as {
  ledgerId: string; canRead: boolean; chart: Record<string, string>; readings: ReadingCard[]; sentenceMax?: number
}
const stub = async () => ({})

const html = renderToStaticMarkup(
  <ReadBill ledgerId={input.ledgerId} canRead={input.canRead} chart={input.chart} readings={input.readings}
            sentenceMax={input.sentenceMax ?? 2000} readAction={stub} discardAction={stub} />,
)
console.log(JSON.stringify({ html }))

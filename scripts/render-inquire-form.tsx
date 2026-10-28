/**
 * Render the question form and the Keep looking form with a stand-in action
 * and print the markup — `IQ13` reads the field names from it, so a field
 * added to the real forms is a field the check sees.
 *
 * A process of its own, like render-assistant-panel: react-dom/server does not
 * exist under the react-server condition the suites run in, and both forms
 * take their door as a prop so this file needs nothing that imports
 * `server-only`.
 *
 *   npx tsx scripts/render-inquire-form.tsx  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { InquireForm, KeepLookingForm } from '../src/app/ledger/[ledgerId]/assistant/InquireForm'

const stub = async () => ({})

const html = renderToStaticMarkup(
  <>
    <InquireForm ledgerId={'L'.repeat(36)} action={stub} max={60000} start="Begin from here." />
    <KeepLookingForm ledgerId={'L'.repeat(36)} inquiryId={'Q'.repeat(36)} action={stub} />
  </>,
)
console.log(JSON.stringify({ html }))

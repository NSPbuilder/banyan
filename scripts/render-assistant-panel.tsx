/**
 * Render the assistant's service panel with stand-in actions and read it back
 * — `AI19` runs this for each state the panel can be in.
 *
 * A process of its own, like render-user-admin: react-dom/server does not
 * exist under the react-server condition the suites run in, and the panel
 * takes its two doors as props precisely so this file needs nothing that
 * imports `server-only`.
 *
 *   npx tsx scripts/render-assistant-panel.tsx '<json>'
 *   { state, secretSet }  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { ServicePanel, type PanelState } from '../src/app/ledger/[ledgerId]/assistant/ServicePanel'

const input = JSON.parse(process.argv[2]) as { state: PanelState; secretSet: boolean }
const stub = async () => ({})

const html = renderToStaticMarkup(
  <ServicePanel ledgerId={'L'.repeat(36)} state={input.state} secretSet={input.secretSet}
                saveAction={stub} clearAction={stub} />,
)
console.log(JSON.stringify({ html }))

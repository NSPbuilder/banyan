/**
 * Render the quick expense/income form with a stand-in action and read it
 * back — `Q11` runs this for both kinds.
 *
 * A process of its own, like render-assistant-panel: react-dom/server does
 * not exist under the react-server condition the suites run in, and the form
 * takes its door as a prop precisely so this file needs nothing that imports
 * `server-only`.
 *
 *   npx tsx scripts/render-quick-form.tsx '<json>'
 *   { kind, plAccounts, bankAccounts, gstAccount, pstAccount, initial }  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { QuickForm } from '../src/app/ledger/[ledgerId]/entries/quick/[kind]/QuickForm'
import type { QuickInitial } from '../src/lib/prefill'

type Option = { id: string; code: string; name: string }
const input = JSON.parse(process.argv[2]) as {
  kind: 'expense' | 'income'
  plAccounts: Option[]; bankAccounts: Option[]
  gstAccount: Option | null; pstAccount: Option | null
  initial?: QuickInitial
}
const stub = async () => ({})

const html = renderToStaticMarkup(
  <QuickForm ledgerId={'L'.repeat(36)} kind={input.kind} today="2026-09-07"
             plAccounts={input.plAccounts} bankAccounts={input.bankAccounts}
             gstAccount={input.gstAccount} pstAccount={input.pstAccount}
             initial={input.initial} action={stub} />,
)
console.log(JSON.stringify({ html }))

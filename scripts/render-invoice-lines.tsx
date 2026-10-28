/**
 * Render the invoice line editor and the invoice detail body's attachment
 * decision, and read them back — `V118` runs this.
 *
 * A process of its own, like render-quick-form: react-dom/server does not
 * exist under the react-server condition the suites run in.
 *
 *   npx tsx scripts/render-invoice-lines.tsx '<json>'
 *   { rows }  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { InvoiceLines } from '../src/app/ledger/[ledgerId]/invoices/InvoiceLines'
import { initialRows } from '../src/lib/invoice-rows'

const input = JSON.parse(process.argv[2]) as { rows?: number }
const state = initialRows(input.rows ?? 2)

const html = renderToStaticMarkup(
  <InvoiceLines state={state} setState={() => {}} lineAccounts={[{ id: 'a', label: '5300 — Office' }]}
                fieldClass="w-full" />,
)
console.log(JSON.stringify({ html }))

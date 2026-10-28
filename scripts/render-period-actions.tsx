/**
 * Render the close and reopen panels with stand-in actions and read them
 * back — `P30` runs this for the states a period can be in.
 *
 * A process of its own, like render-quick-form: react-dom/server does not
 * exist under the react-server condition the suites run in, and the panels
 * take their doors as props precisely so this file needs nothing that
 * imports `server-only`.
 *
 *   npx tsx scripts/render-period-actions.tsx '<json>'
 *   { which, periodName, status, readiness }  →  { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { CloseControls, ReopenControls, ReopenYearControls } from '../src/app/ledger/[ledgerId]/periods/PeriodActions'
import type { Readiness } from '../src/lib/periods'

const input = JSON.parse(process.argv[2]) as {
  which: 'close' | 'reopen' | 'reopen-year'
  yearName?: string
  periodName: string
  status: string
  readiness: Readiness[]
}
const stub = async () => ({})
const L = 'L'.repeat(36), P = 'P'.repeat(36)

const html = renderToStaticMarkup(
  input.which === 'close'
    ? <CloseControls ledgerId={L} periodId={P} periodName={input.periodName}
                     readiness={input.readiness} action={stub} />
    : input.which === 'reopen-year'
    ? <ReopenYearControls ledgerId={L} fiscalYearId={'Y'.repeat(36)} yearName={input.yearName ?? 'FY'}
                          action={stub} />
    : <ReopenControls ledgerId={L} periodId={P} periodName={input.periodName}
                      status={input.status} action={stub} />,
)
console.log(JSON.stringify({ html }))

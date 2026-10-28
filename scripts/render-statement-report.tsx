/**
 * Renders one statement's reconciliation report and prints what a person
 * would see, as JSON — the same fetch/render split as `render-reconcile.tsx`,
 * for the same reason: this process cannot reach the database, so the suite
 * fetches the report and this proves the screen actually shows it.
 *
 *   npx tsx scripts/render-statement-report.tsx '<StatementReport json>'
 *
 * `statementReport` deciding the import gap is one thing; a report page that
 * computes it and never prints it would leave the exact unexplained hole the
 * statement feature was built to close.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { parse } from './json-bigint'
import {
  StatementReportView,
} from '../src/app/ledger/[ledgerId]/bank/[accountId]/StatementReportView'
import type { ReconcileView } from '../src/lib/bank'

const report = parse<ReconcileView>(process.argv[2])
const markup = renderToStaticMarkup(
  <StatementReportView report={report} company="Acme Consulting Inc." account="1000 Cash" />)

const text = markup.replace(/<[^>]+>/g, '\n').split('\n')
  .map((l) => l.trim()).filter(Boolean)

/** The printed money, in cents, in page order — what the screen says, not
 *  what the library returned. */
const cents = (raw: string) => {
  const m = /^\(?-?([\d,]+)\.(\d\d)\)?$/.exec(raw)
  if (!m) return null
  const v = BigInt(m[1].replace(/,/g, '')) * 100n + BigInt(m[2])
  return raw.startsWith('-') || raw.startsWith('(') ? -v : v
}
const amounts = text.map(cents).filter((v): v is bigint => v !== null)

process.stdout.write(JSON.stringify({
  lines: text,
  amounts: amounts.map(String),
}))

import { moduleManifests } from './module-manifests'
import { reportQuery as qs } from './report-query'
/**
 * Where each report lives, as addresses a person can open: its page and its
 * downloads, built from the report's name and its dates — never from a path a
 * model typed. The assistant's `report_link` tool reads this, and a link in an
 * answer is clickable only when it came back from a tool, so every address
 * here must be one its route actually reads (`IQ15` requests each of them).
 *
 * The statement and trial-balance CSVs are not here: `/export` takes period
 * ids for those, and the same tables already download as Excel from a date
 * range.
 */

export type ReportKey =
  | 'balance_sheet' | 'profit_loss' | 'cash_flow' | 'equity_changes'
  | 'trial_balance' | 'general_ledger' | 'aging' | 'customer_statement'
  | 'gst_hst' | 'pst' | 'pd7a' | 't4'

export type ReportArgs = { from?: string; to?: string; as_of?: string; party?: string; year?: string }

export type ReportLink = {
  report: ReportKey
  label: string
  page: string
  downloads: Array<{ label: string; href: string }>
}

type Given = { from: string; to: string; asOf: string; party: string; year: string }
type Need = 'range' | 'asOf' | 'party' | 'year'

export type Entry = {
  label: string
  /** The page path under the ledger whose seat opens this report. */
  seatPath: string
  needs: Need[]
  build: (g: Given) => { page: string; downloads: Array<[string, string]> }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const YEAR = /^\d{4}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i


const templated = (template: string, label: string): Entry => ({
  label, seatPath: '/statements', needs: ['range'],
  build: ({ from, to }) => ({
    page: `/statements?${qs({ template, from, to })}`,
    downloads: [
      ['PDF', `/statements/pdf?${qs({ template, from, to })}`],
      ['Excel', `/statements/pdf?${qs({ template, from, to, format: 'xlsx' })}`],
    ],
  }),
})

const ranged = (path: string, label: string): Entry => ({
  label, seatPath: path, needs: ['range'],
  build: ({ from, to }) => ({
    page: `${path}?${qs({ from, to })}`,
    downloads: [
      ['PDF', `${path}/pdf?${qs({ from, to })}`],
      ['Excel', `${path}/pdf?${qs({ from, to, format: 'xlsx' })}`],
    ],
  }),
})

export const REPORTS: Record<string, Entry> = Object.assign({
balance_sheet: templated('IFRS_SFP_EN', 'Statement of financial position'),
profit_loss: templated('IFRS_PL_NATURE_EN', 'Statement of profit or loss'),
cash_flow: templated('CASH_FLOW', 'Statement of cash flows'),
equity_changes: templated('EQUITY_CHANGES', 'Statement of changes in equity'),
trial_balance: ranged('/reports/trial-balance', 'Trial balance'),
general_ledger: ranged('/reports/general-ledger', 'General ledger'),
aging: {
    label: 'Aging', seatPath: '/aging', needs: ['asOf'],
    build: ({ asOf }) => ({
      page: `/aging?${qs({ asOf })}`,
      downloads: [['PDF', `/aging/pdf?${qs({ asOf })}`], ['Excel', `/aging/pdf?${qs({ asOf, format: 'xlsx' })}`]],
    }),
  },
customer_statement: {
    label: 'Customer statement', seatPath: '/parties', needs: ['party', 'asOf'],
    build: ({ party, asOf }) => ({
      page: `/parties/${party}/statement?${qs({ asOf })}`,
      downloads: [
        ['PDF', `/parties/${party}/statement/pdf?${qs({ asOf })}`],
        ['Excel', `/parties/${party}/statement/pdf?${qs({ asOf, format: 'xlsx' })}`],
      ],
    }),
  },
gst_hst: {
    label: 'GST/HST return', seatPath: '/tax', needs: ['range'],
    build: ({ from, to }) => ({
      page: `/tax?${qs({ from, to })}`,
      downloads: [['PDF', `/tax/pdf?${qs({ from, to })}`], ['CSV', `/export?${qs({ what: 'gst-hst', from, to })}`]],
    }),
  },
pst: {
    label: 'PST return', seatPath: '/tax/pst', needs: ['range'],
    build: ({ from, to }) => ({
      page: `/tax/pst?${qs({ from, to })}`,
      downloads: [['PDF', `/tax/pdf?${qs({ from, to, tax: 'pst' })}`], ['CSV', `/export?${qs({ what: 'pst', from, to })}`]],
    }),
  },
} satisfies Record<string, Entry>, ...moduleManifests.map(manifest => manifest.reports ?? {}))

export const REPORT_KEYS = Object.keys(REPORTS) as ReportKey[]

/**
 * The reports that are FINANCIAL STATEMENTS, and the ones that are SALES TAX
 * RETURNS — derived from the seat each already declares, not listed again.
 *
 * The assistant's `statement` and `tax_return` tools each used to carry their
 * own copy of these, typed into the prose the model reads AND into the
 * validation beside it (owner, 2026-09-16: 「尽量不要用硬编码」). A template
 * added here was one the model could not ask for, and nothing said so.
 *
 * `templated()` gives every statement `/statements`, so the seat is already
 * the fact that distinguishes them; the two tax returns are the only entries
 * seated under `/tax`.
 */
export const STATEMENT_KEYS = REPORT_KEYS.filter((k) => REPORTS[k].seatPath === '/statements')
export const TAX_RETURN_KEYS = REPORT_KEYS.filter((k) => REPORTS[k].seatPath.startsWith('/tax'))

export const isReportKey = (k: string): k is ReportKey => Object.hasOwn(REPORTS, k)

/**
 * The addresses for one report, or the sentence saying what is missing. The
 * party id is checked for shape here and for belonging by the caller (`ours`),
 * because a catalogue that reads the database could not be a plain table.
 */
export function reportLink(ledgerId: string, report: string, args: ReportArgs): ReportLink | { error: string } {
  if (!isReportKey(report)) return { error: `There is no report by that name. Use one of: ${REPORT_KEYS.join(', ')}.` }
  const entry = REPORTS[report]
  const g: Given = { from: args.from ?? '', to: args.to ?? '', asOf: args.as_of ?? '', party: args.party ?? '', year: args.year ?? '' }
  for (const need of entry.needs) {
    if (need === 'range' && !(DATE.test(g.from) && DATE.test(g.to) && g.from <= g.to)) {
      return { error: `${entry.label} needs "from" and "to" as YYYY-MM-DD, with "from" not after "to".` }
    }
    if (need === 'asOf' && !DATE.test(g.asOf)) return { error: `${entry.label} needs "as_of" as YYYY-MM-DD.` }
    if (need === 'party' && !UUID.test(g.party)) return { error: `${entry.label} needs "party": a party id from the parties tool.` }
    if (need === 'year' && !YEAR.test(g.year)) return { error: `${entry.label} needs "year" as four digits.` }
  }
  const base = `/ledger/${ledgerId}`
  const built = entry.build(g)
  return {
    report,
    label: entry.label,
    page: `${base}${built.page}`,
    downloads: built.downloads.map(([label, href]) => ({ label, href: `${base}${href}` })),
  }
}

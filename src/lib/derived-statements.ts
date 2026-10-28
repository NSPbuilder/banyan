/**
 * The two statements that are not templates.
 *
 * `statement_template` holds the linear ones — a balance sheet and a P&L are
 * lists of lines, each a balance or a movement. The cash flow statement and
 * the statement of changes in equity are computed from every account's
 * movement (src/lib/movements.ts) and drawn by their own renderers. They are
 * offered beside the templates under codes no template can have, so one URL
 * shape (`?template=…&from=…&to=…`) reaches all five and the PDF/Excel route
 * branches on the code.
 *
 * No `server-only`: the page, the route and the checks all read this list.
 */
export const DERIVED_STATEMENTS = [
  { code: 'CASH_FLOW', name: 'Statement of Cash Flows', statement_type: 'cash_flow' },
  { code: 'EQUITY_CHANGES', name: 'Statement of Changes in Equity', statement_type: 'equity_changes' },
] as const

export type DerivedCode = (typeof DERIVED_STATEMENTS)[number]['code']

export const isDerived = (code: string | undefined | null): code is DerivedCode =>
  DERIVED_STATEMENTS.some((d) => d.code === code)

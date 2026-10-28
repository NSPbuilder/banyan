/**
 * WHAT EACH CAPABILITY NEEDS A ROLE FOR — declared by the capability, not
 * listed for it.
 *
 * NOTHING IS IMPORTED HERE, deliberately. Seven modules name a role — posting,
 * payroll, the two tax paths, quick entry, invoices, registrations — so this is
 * near the bottom of the tree, and anything it reached for would be reached
 * through all seven. The first version imported `accounts.ts` for the seed
 * rows and the production build died on a cycle it could not unwind
 * (`Cannot access 'l' before initialization`, 2026-09-16) — invisible to
 * `tsc`, invisible to every suite, and fatal to `next build`. The seed lives
 * in `setup.ts` now, where the company is actually made.
 *
 * The owner asked whether there should be REQUIRED accounts — retained
 * earnings, AR, AP — 「因为很多功能都基于一些特定account」 (2026-09-16). The
 * dependency is real, and the shape matters as much as the answer: a
 * hand-typed list of required roles would be one more thing to keep in step
 * with the code that needs them, which is the defect the same conversation
 * spent the day removing.
 *
 * So each entry below IS the declaration, and the module that needs a role
 * IMPORTS ITS NAME FROM HERE. There is one string per role in the tree, and a
 * capability added tomorrow declares its need in the same breath as using it.
 *
 * WHAT THIS IS NOT: a gate. Nothing refuses a company for lacking one of
 * these, and no account is created behind anybody's back. Each capability
 * already refuses at the moment of use with a sentence naming the role — the
 * year-end close says there is nowhere to close to, payroll says what to tag.
 * That was never wrong; it was LATE. You found out on payday.
 *
 * This is the same knowledge asked early: a company can be shown what its
 * chart cannot yet do, on a day when fixing it costs a minute.
 */

/** Roles a module names. Imported by the module, so the string exists once. */
export const ROLE = {
  retainedEarnings: 'retained_earnings',
  cash: 'cash_and_cash_equivalents',
  receivables: 'trade_receivables',
  payables: 'trade_payables',
  wages: 'employee_benefits_expense',
  payrollLiability: 'payroll_liabilities',
  gstRecoverable: 'gst_hst_recoverable',
  gstPayable: 'gst_hst_payable',
  pstPayable: 'qst_pst_payable',
  pstRecoverable: 'qst_pst_recoverable',
} as const

export type Capability = {
  /** What stops working, in the words a person would use for it. */
  what: string
  /** The roles it cannot work without. */
  roles: string[]
  /**
   * Whether the books are UNSOUND without it, or merely one feature short.
   *
   * `core` is what double-entry itself rests on — a year that cannot be
   * closed, a debt that cannot be aged. `optional` is a module this company
   * may simply not use: somebody with no employees needs no payroll liability
   * account, and telling them otherwise is noise dressed as rigour.
   */
  weight: 'core' | 'optional'
  /** Where the module lives, so a reader can judge whether they need it. */
  seatPath: string
}

export const CAPABILITIES: Capability[] = [
  { what: 'Closing a fiscal year', roles: [ROLE.retainedEarnings], weight: 'core', seatPath: '/periods' },
  { what: 'Ageing what is owed to you', roles: [ROLE.receivables], weight: 'core', seatPath: '/aging' },
  { what: 'Ageing what you owe', roles: [ROLE.payables], weight: 'core', seatPath: '/aging' },
  { what: 'The cash flow statement, and paying anything from a bank account',
    roles: [ROLE.cash], weight: 'core', seatPath: '/statements' },
  { what: 'Tagging GST/HST on something you buy', roles: [ROLE.gstRecoverable], weight: 'optional', seatPath: '/tax' },
  { what: 'Tagging GST/HST on something you sell', roles: [ROLE.gstPayable], weight: 'optional', seatPath: '/tax' },
  { what: 'Tagging PST or QST on a sale', roles: [ROLE.pstPayable], weight: 'optional', seatPath: '/tax/pst' },
  { what: 'Running payroll', roles: [ROLE.wages, ROLE.payrollLiability], weight: 'optional', seatPath: '/payroll' },
]

/** Every role any capability needs, once. */
export const NEEDED_ROLES: string[] = [...new Set(CAPABILITIES.flatMap((c) => c.roles))]

/** The roles double-entry itself rests on — what a new company is given. */
export const CORE_ROLES: string[] =
  [...new Set(CAPABILITIES.filter((c) => c.weight === 'core').flatMap((c) => c.roles))]

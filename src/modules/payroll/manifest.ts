import { reportQuery as qs } from '@/lib/report-query'
import type { ModuleManifest } from '@/lib/module-contract'

export const manifest: ModuleManifest = {
  id: 'PAYROLL', name: 'Payroll',
  requires: [], seats: ['/payroll'],
  server: '@/modules/payroll/server',
  navigation: [
{ order: 17, label: 'Payroll', path: '/payroll', group: 'manage', flyout: [
    { label: 'Pay runs', path: '/payroll' },
    { label: 'Run payroll', path: '/payroll/new' },
    { label: 'Employees', path: '/payroll/people' },
    { label: 'T4 figures', path: '/payroll/t4' },
    { label: 'PD7A remittances', path: '/payroll/remittances' },
  ] },
  ],
  addMenu: [
{ order: 4, label: 'Pay run', path: '/payroll/new' },
{ order: 6, label: 'Employee', path: '/payroll/people/new' },
  ],
  skills: [
{ order: 16,
    id: 'payroll', label: 'Payroll', paths: ['/payroll'], seats: ['/payroll'],
    entryPaths: ['/payroll'], mode: 'read',
    description: 'Employees, pay runs, pay stubs, remittances, and T4 figures. Read-only and never sends the SIN column.',
    examples: 'What is this month\'s PD7A amount? Show Alice\'s pay stubs.',
    instructions: 'Read payroll only. Never run payroll or change an employee. Never request or expose SIN.',
    tools: ['calendar', 'search', 'employees', 'pay_runs', 'pay_stubs', 'remittances', 't4', 'calculate', 'report_link', 'module_link'],
  },
  ],
  company: {
    first: [
{ order: 52, table: 'pay_run', by: 'ledger' },
    ],
    byEntity: [
{ order: 9, table: 'payroll_employee' },
    ],
  },
  backup: {
    companyData: [
{ order: 41, table: 'payroll_employee', by: 'entity' },
{ order: 42, table: 'pay_run', by: 'ledger' },
{ order: 43, table: 'pay_stub', by: 'payRun' },
    ],
    excluded: {
payroll_rate_edition: 'CRA T4127 editions added in the app (0082) — the law every company is paid under, '
    + 'not one company\'s to carry; the daily whole-database backup keeps them',
    },
    notCarried: {
pay_run: ['idempotency_key'],
    },
    unique: {
pay_run_idempotency_key:
    'nulled on the way in — see NOT_CARRIED_OVER',
    },
  },
  journalPrefixes: { payroll: 'PR' },
  reports: {
pd7a: {
    label: 'PD7A remittances', seatPath: '/payroll/remittances', needs: ['year'],
    build: ({ year }) => ({
      page: `/payroll/remittances?${qs({ year })}`,
      downloads: [['CSV', `/export?${qs({ what: 'pd7a', year })}`], ['Excel', `/export?${qs({ what: 'pd7a', year, format: 'xlsx' })}`]],
    }),
  },
t4: {
    label: 'T4 figures', seatPath: '/payroll/t4', needs: ['year'],
    build: ({ year }) => ({ page: `/payroll/t4?${qs({ year })}`, downloads: [] }),
  },
  },
}

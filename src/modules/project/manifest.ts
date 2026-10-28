import type { ModuleManifest } from '@/lib/module-contract'

export const manifest: ModuleManifest = {
  id: 'PROJECT', name: 'Project',
  requires: [], seats: ['/projects'],
  defaultDisabledSeats: ['/projects'],
  server: '@/modules/project/server',
  navigation: [
{ order: 4, label: 'Project', path: '/projects', group: 'daily' },
  ],
  skills: [
{ order: 3,
    id: 'projects', label: 'Projects', paths: ['/projects'], seats: ['/projects'], entryPaths: ['/projects'], mode: 'read',
    description: 'Projects, operational revenue and costs, and their linked accounting documents. Navigation only.',
    examples: 'Open Projects. Where can I enter project revenue?',
    instructions: 'Provide the Projects module link. Never create, post, pay, edit, or cancel a project transaction. Review and perform those actions in Projects.',
    tools: ['module_link'],
  },
  ],
  company: {
    first: [
{ order: 18, table: 'project_invoice_handoff', by: 'entity' },
{ order: 19, table: 'project_accounting_application', by: 'entity' },
{ order: 20, table: 'project_accounting_payment', by: 'entity' },
{ order: 21, table: 'project_accounting_line', by: 'entity' },
{ order: 22, table: 'project_accounting_link', by: 'entity' },
    ],
    retained: [
{ order: 37, table: 'project' },
{ order: 38, table: 'project_record' },
{ order: 39, table: 'project_record_line' },
{ order: 40, table: 'project_payment' },
{ order: 41, table: 'project_payment_allocation' },
{ order: 42, table: 'project_attachment_blob' },
{ order: 43, table: 'project_attachment' },
    ],
  },
  backup: {
    storage: [{ domain: 'project', table: 'project_attachment_blob', rowOwner: 'project_id', fileOwner: 'projectId', minFormat: 3, mapKey: 'projectMap' }],
    restoredIds: [{ key: 'projectMap', table: 'project' }],
    companyData: [
{ order: 29, table: 'project_category_account', by: 'entity' },
{ order: 98, table: 'project', by: 'entity' },
{ order: 99, table: 'project_record', by: 'entity' },
{ order: 100, table: 'project_record_line', by: 'entity' },
{ order: 101, table: 'project_payment', by: 'entity' },
{ order: 102, table: 'project_payment_allocation', by: 'entity' },
{ order: 103, table: 'project_attachment_blob', by: 'entity' },
{ order: 104, table: 'project_attachment', by: 'entity' },
{ order: 105, table: 'project_invoice_handoff', by: 'entity' },
{ order: 106, table: 'project_accounting_application', by: 'entity' },
{ order: 107, table: 'project_accounting_payment', by: 'entity' },
{ order: 108, table: 'project_accounting_line', by: 'entity' },
{ order: 109, table: 'project_accounting_link', by: 'entity' },
    ],
    notCarried: {
project_record: ['idempotency_key'],
project_payment: ['idempotency_key'],
project_payment_allocation: ['idempotency_key'],
    },
  },
}

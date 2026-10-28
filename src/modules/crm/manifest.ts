import type { ModuleManifest } from '@/lib/module-contract'

export const manifest: ModuleManifest = {
  id: 'CRM', name: 'CRM',
  requires: [], seats: ['/crm'],
  server: '@/modules/crm/server',
  navigation: [
{ order: 2, label: 'CRM', path: '/crm', group: 'daily' },
  ],
  skills: [
{ order: 6,
    id: 'crm', label: 'CRM', paths: ['/crm'], seats: ['/crm'], entryPaths: ['/crm'], mode: 'confirm',
    description: 'Leads, customer accounts, contacts, opportunities, pipeline, activities, tasks, and sales follow-up.',
    examples: 'Which opportunities close this month? Add a lead. Draft a follow-up task.',
    instructions: 'Read CRM records. A crm_draft_* tool creates an immutable proposal only; say plainly that nothing is saved until the person confirms it. Do not handle finance handoff or invoices.',
    tools: [
      'crm_overview', 'crm_leads', 'crm_accounts', 'crm_pipeline', 'crm_tasks', 'crm_activities',
      'crm_draft_lead', 'crm_draft_account', 'crm_draft_contact', 'crm_draft_opportunity',
      'crm_draft_task', 'crm_draft_activity', 'module_link',
    ],
  },
  ],
  company: {
    first: [
{ order: 28, table: 'crm_attachment', by: 'entity' },
{ order: 29, table: 'crm_finance_handoff', by: 'entity' },
{ order: 30, table: 'crm_task', by: 'entity' },
{ order: 31, table: 'crm_activity', by: 'entity' },
{ order: 32, table: 'crm_stage_event', by: 'entity' },
{ order: 33, table: 'crm_opportunity', by: 'entity' },
{ order: 34, table: 'crm_account_contact', by: 'entity' },
{ order: 35, table: 'crm_lead', by: 'entity' },
{ order: 36, table: 'crm_account', by: 'entity' },
{ order: 37, table: 'crm_stage', by: 'entity' },
{ order: 38, table: 'crm_pipeline', by: 'entity' },
    ],
  },
  backup: {
    blobReferences: [{ order: 3, table: 'crm_attachment' }],
    companyData: [
{ order: 87, table: 'crm_pipeline', by: 'entity' },
{ order: 88, table: 'crm_stage', by: 'entity' },
{ order: 89, table: 'crm_account', by: 'entity' },
{ order: 90, table: 'crm_lead', by: 'entity' },
{ order: 91, table: 'crm_account_contact', by: 'entity' },
{ order: 92, table: 'crm_opportunity', by: 'entity' },
{ order: 93, table: 'crm_stage_event', by: 'entity' },
{ order: 94, table: 'crm_activity', by: 'entity' },
{ order: 95, table: 'crm_task', by: 'entity' },
{ order: 96, table: 'crm_finance_handoff', by: 'entity' },
{ order: 97, table: 'crm_attachment', by: 'entity' },
    ],
    notCarried: {
crm_account: ['owner_user_id'],
crm_lead: ['owner_user_id'],
crm_opportunity: ['owner_user_id'],
crm_activity: ['actor_user_id'],
crm_task: ['assigned_user_id'],
crm_account_contact: ['party_contact_id'],
    },
    unique: {
crm_pipeline_name:
    'an expression index over (entity_id, lower(name)); entity_id is remapped, so a restored company cannot collide with another',
    },
  },
}

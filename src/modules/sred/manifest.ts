import type { ModuleManifest } from '@/lib/module-contract'

export const manifest: ModuleManifest = {
  id: 'SRED', name: 'SR&ED',
  requires: ['PAYROLL'], seats: ['/sred'],
  server: '@/modules/sred/server',
  referenceTables: ['sred_rate'],
  navigation: [
{ order: 22, label: 'SR&ED', path: '/sred', group: 'manage' },
  ],
  skills: [
{ order: 20,
    id: 'sred', label: 'SR&ED', paths: ['/sred'], seats: ['/sred'], entryPaths: ['/sred'], mode: 'read',
    description: 'SR&ED projects, claims, time, evidence, and allocations. Search and navigation only.',
    examples: 'Find the SR&ED project for the prototype. Open the claim workspace.',
    instructions: 'Search existing SR&ED records and provide the module link. Never change a project, claim, time record, evidence, or allocation.',
    tools: ['calendar', 'search', 'module_link'],
  },
  ],
  company: {
    first: [
{ order: 39, table: 'sred_project', by: 'entity' },
    ],
  },
  backup: {
    companyData: [
{ order: 81, table: 'sred_project', by: 'entity' },
{ order: 82, table: 'sred_claim', by: 'sredProject' },
{ order: 83, table: 'sred_time', by: 'sredProject' },
{ order: 84, table: 'sred_evidence', by: 'sredProject' },
{ order: 85, table: 'sred_allocation', by: 'sredClaim' },
{ order: 86, table: 'sred_account_category', by: 'account' },
    ],
    excluded: {
sred_rate: 'the credit rates and the expenditure limit — the law, seeded by a migration, '
    + 'and not one company\'s to carry',
    },
  },
}

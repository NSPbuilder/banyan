import type { ModuleManifest } from '@/lib/module-contract'

export const manifest: ModuleManifest = {
  id: 'ESIGN', name: 'Documents and electronic signatures',
  requires: [], seats: ['/documents'],
  routes: ['/api/documenso'],
  publicRoutes: ['^/api/documenso/[0-9a-f-]{36}$'],
  settings: '@/modules/esign/settings',
  navigation: [
{ order: 5, label: 'Documents', path: '/documents', group: 'daily' },
  ],
  skills: [
{ order: 4,
    id: 'documents', label: 'Documents', paths: ['/documents'], seats: ['/documents'], entryPaths: ['/documents'], mode: 'read',
    description: 'Company memos, contracts, PDF versions, and Documenso signing. Navigation only.',
    examples: 'Where can I request a signature? Open company contracts.',
    instructions: 'Provide the Documents module link. Field detection and signing happen in Documenso after human review. Never create, send, sign, change, or claim completion of a request. No document bytes or signing credentials are available to this skill.',
    tools: ['module_link'],
  },
  ],
  server: '@/modules/esign/server',
  company: {
    first: [
{ order: 23, table: 'esign_event', by: 'entity' },
{ order: 24, table: 'esign_file', by: 'entity' },
{ order: 25, table: 'esign_request', by: 'entity' },
{ order: 26, table: 'esign_document', by: 'entity' },
{ order: 27, table: 'esign_connection', by: 'entity' },
    ],
  },
  backup: {
    blobReferences: [{ order: 4, table: 'esign_file' }],
    companyData: [
{ order: 110, table: 'esign_document', by: 'entity' },
{ order: 111, table: 'esign_request', by: 'entity' },
{ order: 112, table: 'esign_file', by: 'entity' },
    ],
    excluded: {
esign_connection: 'installation-local Documenso credentials; a company copy must not inherit a live provider connection',
esign_event: 'provider notification jobs, not portable signing history; copying jobs could reconnect restored data',
    },
    notCarried: {
esign_request: ['connection_id'],
    },
  },
}

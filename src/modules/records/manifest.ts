import type { ModuleManifest } from '@/lib/module-contract'

export const manifest: ModuleManifest = {
  id: 'RECORDS', name: 'Corporate records',
  requires: [], seats: ['/records'],
  server: '@/modules/records/server',
  readings: '@/modules/records/readings',
  referenceTables: ['company_type', 'register_field_visibility'],
  navigation: [
{ order: 19, label: 'Corporate records', path: '/records', group: 'manage', flyout: [
    { label: 'Basic Info', path: '/records' },
    { label: 'Minute book', path: '/records/minute-book' },
    { label: 'Register of Directors', path: '/records/register/directors' },
    { label: 'Central Securities Register', path: '/records/register/central_securities' },
    { label: 'Transparency Register', path: '/records/register/transparency' },
  ] },
  ],
  skills: [
{ order: 17,
    id: 'records', label: 'Corporate records', paths: ['/records'], seats: ['/records'],
    entryPaths: ['/records'], mode: 'read',
    description: 'Directors, securities, transparency register, and statutory records. Read-only.',
    examples: 'Who are the current directors? Show the securities register.',
    instructions: 'Read statutory registers only. Never create, amend, sign, or delete a corporate record.',
    tools: ['calendar', 'search', 'register', 'module_link'],
  },
  ],
  destinations: [
{ order: 5, key: 'company_profile',
    takes: "the company's own registration — a certificate of incorporation, a business number "
         + 'notice, anything stating the incorporation number, business number, recognition date '
         + 'or company type',
    path: '/records/profile', label: 'Check the company profile', prefills: true },
{ order: 6, key: 'minute_book',
    takes: 'a minute book, the minutes of a meeting, or a resolution — and what it records about '
         + 'directors, shares, significant individuals or offices goes in the rows for those too',
    path: '/records/add/minute_book', label: 'Add to the minute book', prefills: true },
{ order: 7, key: 'directors',
    takes: 'a director being appointed or ceasing — a consent to act, a resignation, a notice of change',
    path: '/records/add/directors', label: 'Add to the directors register', prefills: true },
{ order: 8, key: 'shares',
    takes: 'shares issued, transferred or cancelled — a subscription, a share certificate, a transfer form',
    path: '/records/add/shares', label: 'Add to the securities register', prefills: true },
{ order: 9, key: 'transparency',
    takes: 'somebody who controls the company or a significant share of it — the transparency register',
    path: '/records/add/transparency', label: 'Add to the transparency register', prefills: true },
{ order: 10, key: 'offices',
    takes: "a change of the company's registered or records office address",
    path: '/records/add/offices', label: 'Add to the offices', prefills: true },
  ],
  company: {
    first: [
{ order: 59, table: 'share_transaction', by: 'shareClass' },
    ],
    byEntity: [
{ order: 1, table: 'corporate_office' },
{ order: 3, table: 'directorship' },
{ order: 5, table: 'minute_book_entry' },
{ order: 7, table: 'officer_position' },
{ order: 10, table: 'share_class' },
{ order: 11, table: 'significant_individual' },
    ],
  },
  backup: {
    blobReferences: [{ order: 1, table: 'minute_book_attachment' }],
    companyData: [
{ order: 69, table: 'corporate_office', by: 'entity' },
{ order: 72, table: 'directorship', by: 'entity' },
{ order: 74, table: 'minute_book_entry', by: 'entity' },
{ order: 75, table: 'minute_book_attachment', by: 'minuteBook' },
{ order: 77, table: 'officer_position', by: 'entity' },
{ order: 78, table: 'share_class', by: 'entity' },
{ order: 79, table: 'share_transaction', by: 'shareClass' },
{ order: 80, table: 'significant_individual', by: 'entity' },
    ],
    excluded: {
company_type: 'reference data, seeded by a migration',
register_field_visibility: 'reference data, seeded by a migration',
    },
    unique: {
share_class_unique:
    'an expression index over (entity_id, name, series); entity_id is remapped, so a restored company cannot collide with another',
    },
  },
}

/**
 * Typed mirror of db/migrations/0001_schema.sql.
 *
 * The SQL file is authoritative — it carries the constraints and triggers that
 * actually enforce the ledger's invariants, and Drizzle cannot express those.
 * This file exists so queries are type-checked. Never generate migrations from it.
 */
import { sql } from 'drizzle-orm'
import {
  bigint, boolean, char, date, index, integer, jsonb, pgEnum, pgTable,
  smallint, text, timestamp, uniqueIndex, uuid, primaryKey, bigserial,
} from 'drizzle-orm/pg-core'

const money = (name: string) => bigint(name, { mode: 'bigint' })

export const accountTypeEnum = pgEnum('account_type', ['asset', 'liability', 'equity', 'revenue', 'expense'])
export const normalBalanceEnum = pgEnum('normal_balance', ['debit', 'credit'])

export const accountingStandard = pgTable('accounting_standard', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
})

export const entity = pgTable('entity', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  country: char('country', { length: 2 }).notNull().default('CA'),
  province: text('province'),
  businessNumber: text('business_number'),
  functionalCurrency: char('functional_currency', { length: 3 }).notNull().default('CAD'),
  fiscalYearEndMonth: smallint('fiscal_year_end_month').notNull().default(12),
  fiscalYearEndDay: smallint('fiscal_year_end_day').notNull().default(31),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const ledger = pgTable('ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => entity.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  purpose: text('purpose').notNull().default('statutory'),
  accountingStandard: text('accounting_standard').notNull().default('IFRS'),
  currency: char('currency', { length: 3 }).notNull().default('CAD'),
  isPrimary: boolean('is_primary').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('ledger_entity_code_key').on(t.entityId, t.code)])

export const account = pgTable('account', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => entity.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  foreignCurrency: text('foreign_currency'),
  parentId: uuid('parent_id'),
  accountType: accountTypeEnum('account_type').notNull(),
  normalBalance: normalBalanceEnum('normal_balance').notNull(),
  isPostable: boolean('is_postable').notNull().default(true),
  requiredDimensions: text('required_dimensions').array().notNull().default(sql`'{}'`),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('account_entity_code_key').on(t.entityId, t.code),
  index('account_entity_idx').on(t.entityId, t.code),
])

export const roleDefinition = pgTable('role_definition', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  category: accountTypeEnum('category'),
  family: text('family').notNull().default('classification'),
  isContra: boolean('is_contra').notNull().default(false),
  isCore: boolean('is_core').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  description: text('description'),
})

export const accountRole = pgTable('account_role', {
  accountId: uuid('account_id').notNull().references(() => account.id, { onDelete: 'cascade' }),
  role: text('role').notNull().references(() => roleDefinition.code),
}, (t) => [primaryKey({ columns: [t.accountId, t.role] })])

export const dimension = pgTable('dimension', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => entity.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
}, (t) => [uniqueIndex('dimension_entity_code_key').on(t.entityId, t.code)])

export const dimensionValue = pgTable('dimension_value', {
  id: uuid('id').primaryKey().defaultRandom(),
  dimensionId: uuid('dimension_id').notNull().references(() => dimension.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  parentId: uuid('parent_id'),
  isActive: boolean('is_active').notNull().default(true),
}, (t) => [uniqueIndex('dimension_value_key').on(t.dimensionId, t.code)])

export const fiscalYear = pgTable('fiscal_year', {
  id: uuid('id').primaryKey().defaultRandom(),
  ledgerId: uuid('ledger_id').notNull().references(() => ledger.id),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: text('status').notNull().default('open'),
}, (t) => [uniqueIndex('fiscal_year_key').on(t.ledgerId, t.name)])

export const fiscalPeriod = pgTable('fiscal_period', {
  id: uuid('id').primaryKey().defaultRandom(),
  fiscalYearId: uuid('fiscal_year_id').notNull().references(() => fiscalYear.id, { onDelete: 'cascade' }),
  ledgerId: uuid('ledger_id').notNull().references(() => ledger.id),
  periodNo: smallint('period_no').notNull(),
  name: text('name').notNull(),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: text('status').notNull().default('open'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: text('closed_by'),
}, (t) => [
  uniqueIndex('fiscal_period_key').on(t.fiscalYearId, t.periodNo),
  index('fiscal_period_lookup_idx').on(t.ledgerId, t.startDate, t.endDate),
])

export const numberSequence = pgTable('number_sequence', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => entity.id),
  docType: text('doc_type').notNull(),
  fiscalYear: text('fiscal_year').notNull(),
  prefix: text('prefix').notNull().default(''),
  nextNumber: bigint('next_number', { mode: 'bigint' }).notNull().default(1n),
  padding: smallint('padding').notNull().default(5),
}, (t) => [uniqueIndex('number_sequence_key').on(t.entityId, t.docType, t.fiscalYear)])

export const journalEntry = pgTable('journal_entry', {
  id: uuid('id').primaryKey().defaultRandom(),
  ledgerId: uuid('ledger_id').notNull().references(() => ledger.id),
  entryNo: text('entry_no'),
  entryDate: date('entry_date').notNull(),
  periodId: uuid('period_id').references(() => fiscalPeriod.id),
  description: text('description').notNull(),
  memo: text('memo'),
  documentRef: text('document_ref'),
  sourceType: text('source_type').notNull().default('manual'),
  sourceId: uuid('source_id'),
  status: text('status').notNull().default('draft'),
  reversesId: uuid('reverses_id'),
  reversedById: uuid('reversed_by_id'),
  replacesId: uuid('replaces_id'),
  voidReason: text('void_reason'),
  currency: char('currency', { length: 3 }).notNull().default('CAD'),
  totalDebit: money('total_debit').notNull().default(0n),
  totalCredit: money('total_credit').notNull().default(0n),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull().default('system'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  postedBy: text('posted_by'),
}, (t) => [
  index('journal_entry_date_idx').on(t.ledgerId, t.entryDate),
  index('journal_entry_period_idx').on(t.periodId),
  index('journal_entry_source_idx').on(t.sourceType, t.sourceId),
])

/**
 * An organisation or a person. GLOBAL — one row however many of the companies
 * deal with them. Roles are per company and live in `party_role`; this table is
 * identity only. See `docs/design/03-parties.md` and 0025.
 */
export const party = pgTable('party', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<'organisation' | 'person'>().notNull(),
  name: text('name').notNull(),
  tradingName: text('trading_name'),
  taxNumber: text('tax_number'),
  isActive: boolean('is_active').notNull().default(true),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: text('created_by').notNull().default('system'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const journalLine = pgTable('journal_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  entryId: uuid('entry_id').notNull().references(() => journalEntry.id, { onDelete: 'cascade' }),
  lineNo: smallint('line_no').notNull(),
  accountId: uuid('account_id').notNull().references(() => account.id),
  description: text('description'),
  /** Signed cents: positive is a debit, negative a credit. The only source of truth. */
  amount: money('amount').notNull(),
  originalCurrency: text('original_currency'),
  originalAmount: money('original_amount'),
  fxSnapshot: jsonb('fx_snapshot').$type<import('../lib/fx-money').FxSnapshot>(),
  fxInvoiceId: uuid('fx_invoice_id'),
  /** Generated by Postgres from `amount`. Read-only — never insert or update. */
  debit: money('debit').generatedAlwaysAs(sql`CASE WHEN amount > 0 THEN amount ELSE 0 END`),
  credit: money('credit').generatedAlwaysAs(sql`CASE WHEN amount < 0 THEN -amount ELSE 0 END`),
  currency: char('currency', { length: 3 }).notNull().default('CAD'),
  dimensions: jsonb('dimensions').$type<Record<string, string>>().notNull().default({}),
  /**
   * Who the line is about — a customer, a supplier. A column and not a
   * dimension because aging filters on it constantly and dimensions are jsonb.
   * See `docs/design/03-parties.md`.
   */
  partyId: uuid('party_id').references(() => party.id),
}, (t) => [
  uniqueIndex('journal_line_key').on(t.entryId, t.lineNo),
  index('journal_line_account_idx').on(t.accountId),
  index('journal_line_entry_idx').on(t.entryId),
])

export const periodBalance = pgTable('period_balance', {
  ledgerId: uuid('ledger_id').notNull().references(() => ledger.id),
  periodId: uuid('period_id').notNull().references(() => fiscalPeriod.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => account.id),
  openingBalance: money('opening_balance').notNull().default(0n),
  periodDebit: money('period_debit').notNull().default(0n),
  periodCredit: money('period_credit').notNull().default(0n),
  closingBalance: money('closing_balance').notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.ledgerId, t.periodId, t.accountId] })])

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  actor: text('actor').notNull().default('system'),
  action: text('action').notNull(),
  tableName: text('table_name').notNull(),
  recordId: text('record_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  context: jsonb('context'),
  /** Deliberately no FK: deletion must not erase or orphan its own history. */
  entityId: uuid('entity_id'),
  ledgerId: uuid('ledger_id'),
  scope: text('scope').notNull().default('unresolved'),
  reason: text('reason'),
  targetLabel: text('target_label'),
}, (t) => [
  index('audit_log_record_idx').on(t.tableName, t.recordId, t.occurredAt),
  index('audit_log_time_idx').on(t.occurredAt),
  index('audit_log_entity_time_idx').on(t.entityId, t.occurredAt),
  index('audit_log_ledger_time_idx').on(t.ledgerId, t.occurredAt),
  index('audit_log_scope_time_idx').on(t.scope, t.occurredAt),
])

export const statementTemplate = pgTable('statement_template', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  statementType: text('statement_type').notNull(),
  accountingStandard: text('accounting_standard').notNull(),
  locale: text('locale').notNull().default('en-CA'),
  isActive: boolean('is_active').notNull().default(true),
})

export const statementLine = pgTable('statement_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').notNull().references(() => statementTemplate.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull(),
  indent: smallint('indent').notNull().default(0),
  code: text('code'),
  label: text('label').notNull(),
  lineType: text('line_type').notNull(),
  roles: text('roles').array().notNull().default(sql`'{}'`),
  valueBasis: text('value_basis').notNull().default('closing_balance'),
  formula: text('formula'),
  signFlip: boolean('sign_flip').notNull().default(false),
}, (t) => [uniqueIndex('statement_line_key').on(t.templateId, t.sortOrder)])

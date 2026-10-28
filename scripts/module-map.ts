/**
 * WHICH MODULE OWNS WHAT — tables and source files, written down once.
 *
 * docs/design/48-module-boundaries.md measured where the base bundle reaches
 * into the add-ons; this is that measurement's map, kept as code so the check
 * that guards it (`verify-modules.ts`) and the module manifests that will
 * replace it read the same answer. It says where a thing BELONGS, not where it
 * happens to sit: `online-payments.ts` lives among the AR/AP files and is
 * collection-portal code, so it is PORTAL here, and every base file that
 * imports it is a crossing the check counts.
 *
 * A table no rule claims fails the check (MV1): a new table is a decision about
 * ownership, not something to fall through to a default. Source files do fall
 * through to FW, because most framework files have no shared prefix — a
 * misfiled add-on file shows up as a crossing in the baseline, where it can be
 * read and corrected.
 */

import { BASE_MODULES, type ModuleId } from '../src/lib/module-contract'
export type { ModuleId } from '../src/lib/module-contract'

/** The base bundle, revised by the owner on 2026-10-22 (doc 48). */
export const BASE: ReadonlySet<ModuleId> = new Set(BASE_MODULES)

/** First match wins. Appendix A of doc 48 is this list, spelled out. */
const TABLES: Array<[ModuleId, RegExp]> = [
  ['FX', /^fx_.+$/],
  ['FW', /^(_migration|entity|company_profile|company_module_access|app_user|user_session|user_entity_access|user_entity_module_access|user_module_access|auth_.+|webdav_credential|party|party_address|party_address_purpose|party_contact|party_role|party_role_definition|audit_.+|number_sequence|attachment|attachment_blob|receipt_waiver|document_edit_lease)$/],
  ['GL', /^(accounting_standard|account|account_role|role_definition|statement_template|statement_line|ledger|fiscal_year|fiscal_period|journal_entry|journal_line|period_balance|dimension|dimension_value)$/],
  ['ARAP', /^(invoice.*|cheque.*)$/],
  ['BANK', /^bank_.+$/],
  ['TAX', /^(entity_tax_registration|gst_return_adjustment)$/],
  ['PAYROLL', /^(payroll_.+|pay_run|pay_stub)$/],
  ['RECORDS', /^(corporate_office|directorship|officer_position|share_class|share_transaction|significant_individual|register_field_visibility|minute_book_.+|company_type)$/],
  ['CRM', /^crm_.+$/],
  ['ESIGN', /^esign_.+$/],
  ['PROJECT', /^project.*$/],
  ['OPS', /^(asset_.+|fixed_asset.*|inventory_.+|production_.+|operations_.+)$/],
  ['SRED', /^sred_.+$/],
  ['AI', /^(ai_.+|user_ai_service)$/],
  ['MCP', /^mcp_.+$/],
  ['AUTO', /^(automation_.+|background_job|email_message|inbox_item|recurring_.+|reminder_rule)$/],
  ['IMPORT', /^migration_.+$/],
  ['BUDGET', /^budget.*$/],
  ['PORTAL', /^(checkout_request|payment_connection|payment_event|portal_.+|processor_transaction|inbound_.+)$/],
]

export function tableModule(table: string): ModuleId | null {
  for (const [id, rule] of TABLES) if (rule.test(table)) return id
  return null
}

/** `src/lib` and `src/components` by file name; first match wins. */
const NAMES: Array<[ModuleId, RegExp]> = [
  ['FX', /(^|\/)fx(?:-|\.)/],
  ['PROJECT', /project/i],
  ['CRM', /(^|\/)crm/],
  ['ESIGN', /(^|\/)(esign|documenso)/i],
  ['SRED', /sred/],
  ['OPS', /(^|\/)production-/i],
  ['PAYROLL', /payroll|pay-run|paystub|(^|\/)(t4|roe)\b/],
  ['OPS', /(^|\/)(asset|assets|fixed-asset|depreciation|deferred-tax|cca|inventory|production|operations)/i],
  ['MCP', /(^|\/)mcp/],
  ['AI', /assistant|inquiry|ai-service|bill-reading|reading|skills|prefill|(^|\/)(ReadBill|AiModeNav|AiServiceStatus)\b/i],
  ['PORTAL', /processor-ledger|portal|payment-provider|online-payment|payment-events|checkout|inbound|stripe|postmark|integration/i],
  ['AUTO', /automation|recurring|recurrence|inbox|reminder|(^|\/)mail\b|email|worker|(^|\/)jobs?\b|smtp/i],
  ['IMPORT', /ledger-import|import-csv|import-types|migration-|planning|(^|\/)SourcePapers\b/i],
  ['BUDGET', /budget/],
  ['RECORDS', /records|record-|registers|certificate|minute-book|directorship|(^|\/)share/],
  ['TAX', /(^|\/)tax|gst|pst|registrations/],
  ['BANK', /bank|reconcil|statement-files|match-forms|recon-display/],
  ['ARAP', /(^|\/)quick|invoice|(^|\/)bill|payment|aging|cheque|customer-docs|customer-activity|receipt|credit-note|doc-number|(^|\/)(ChequePayeeFields|LineTaxes|ReceiptLinks)\b/i],
  ['GL', /movements|posting|accounts?\b|account-|chart|period|balances|statements|reports|breakdown|compare|opening|entries|entry-|journal|cash-flow|equity|derived|exports?\b|excel|pdf|money|numbers|fiscal|trial|line-order|tagged-line|needed-roles|report-catalogue|reporting-view/],
]

/** Add-on screens that sit under a base segment; checked before SEGMENTS. */
const SUBPATHS: Array<[string, ModuleId]> = [
  ['income/email/', 'AUTO'], ['opening/migration/', 'IMPORT'], ['reports/budgets/', 'BUDGET'],
]

/** A ledger route segment — `src/app/ledger/[ledgerId]/<segment>/…`. */
const SEGMENTS: Record<string, ModuleId> = {
  accounts: 'GL', breakdown: 'GL', entries: 'GL', export: 'GL', opening: 'GL', periods: 'GL',
  reports: 'GL', statements: 'GL',
  aging: 'ARAP', bills: 'ARAP', cheques: 'ARAP', expenses: 'ARAP', income: 'ARAP', invoices: 'ARAP',
  bank: 'BANK', tax: 'TAX', fx: 'FX',
  attachments: 'FW', backup: 'FW', 'getting-started': 'FW', parties: 'FW', search: 'FW',
  assets: 'OPS', inventory: 'OPS', assistant: 'AI', readings: 'AI', automation: 'AUTO', crm: 'CRM',
  documents: 'ESIGN', payroll: 'PAYROLL', projects: 'PROJECT', records: 'RECORDS', sred: 'SRED',
}

/** A top-level `src/app/<entry>`; anything else is read by file name, then framework. */
const APP: Record<string, ModuleId> = {
  'automation-actions.ts': 'AUTO', 'integration-actions.ts': 'PORTAL', 'planning-actions.ts': 'IMPORT',
  'records-actions.ts': 'RECORDS', api: 'ESIGN', integrations: 'PORTAL', mcp: 'MCP', pay: 'PORTAL',
}

/** `path` relative to the repository root, forward slashes. */
export function fileModule(path: string): ModuleId {
  const owned = /^src\/modules\/([^/]+)\//.exec(path)
  if (owned) return owned[1].toUpperCase() as ModuleId
  const ledger = /^src\/app\/ledger\/\[ledgerId\]\/(?:@modal\/\(\.\))?(([^/]+)\/.*)$/.exec(path)
  if (ledger) {
    for (const [prefix, id] of SUBPATHS) if (ledger[1].startsWith(prefix)) return id
    return SEGMENTS[ledger[2]] ?? 'FW'
  }
  if (path.startsWith('src/app/ledger/')) return /Party/.test(path) ? 'FW' : 'GL'
  const app = /^src\/app\/([^/]+)/.exec(path)
  if (app && APP[app[1]]) return APP[app[1]]
  const name = path.replace(/^src\/(lib|components|app)\//, '')
  if (name !== path) for (const [id, rule] of NAMES) if (rule.test(name)) return id
  return 'FW'
}

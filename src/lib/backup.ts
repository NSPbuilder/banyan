import { moduleManifests, orderedModuleItems } from './module-manifests'
import 'server-only'
import { currencyDigits, validateSnapshot, toFunctional, type FxSnapshot } from './fx-money'
import { createHash, randomUUID } from 'crypto'
import { gzip, gunzipSync } from 'zlib'
import { promisify } from 'node:util'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { localMoment } from './today'
import { actingAs, type Tx } from './acting'
import { exportAuditProof } from './audit-chain'
import { canonicalAudit,verifyAuditProof, type AuditProof } from './audit-chain-types'
import { folderTakenBy, readBlobBytes, rebuildAttachmentTree, writeBlobBytes } from './attachments'
import { rebindRestoredImports } from './ledger-import'
import { moduleBackupScope, moduleBackupParties, moduleBackupFiles, moduleRestoredRow, afterModuleRestore, restoreModuleFile } from './module-extensions'

/**
 * ONE COMPANY IN ONE FILE, and back again.
 *
 * The owner asked for a backup menu inside the application: the current
 * company only, saved as a `.fig` file, and a restore that reads one
 * back (2026-09-07). `pg_dump` already backs up the DATABASE — every
 * company, every person, every session — and `docs/RESTORE.md` is about
 * putting that back on a machine. This is the other thing entirely: one
 * company, portable, and restorable beside the original rather than over it.
 *
 * WHAT A .fig IS: gzipped JSON. A header saying what made it and which
 * schema it came from, a `rows` object of table → rows, company-scoped audit
 * history, an optional `files` array of attachment bytes, and a sha256 of the
 * body computed before the gzip. No new dependency — `zlib` and `crypto` are
 * Node's own.
 *
 * WHAT A RESTORE DOES: makes a NEW company. Every id in the file is remapped
 * to a fresh one, so a company can be restored beside the one it came from
 * without either knowing about the other. It never writes over anything, and
 * there is deliberately no "restore in place": a backup that can silently
 * replace the live books is a backup that can destroy them.
 *
 * THE ONE THING IT DOES NOT REMAP: parties. The address book is shared by
 * every company by design, and the database refuses two active parties with
 * the same name — so a party in the file is matched to the one already here,
 * by id and then by name, and only created when neither finds it.
 */

export class BackupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

/** The file format's own version. Bumped when the SHAPE changes, not the schema. */
export const FIGTREE_FORMAT = 4
const READABLE_FIGTREE_FORMATS = new Set([1, 2, 3, FIGTREE_FORMAT])

/**
 * Every table holding one company's own rows, parents first — the order rows
 * are written in and the order they are read back in.
 *
 * `by` says how a row reaches the company it belongs to. Nothing here is
 * guessed at run time: a table that appears in the database and in neither
 * this list nor `NOT_COMPANY_DATA` fails `BK1`, so the next table somebody
 * adds is a decision rather than an omission.
 */
export const COMPANY_DATA: Array<{ table: string; by: string }> = orderedModuleItems<{ table: string; by: string }>([
{ order: 0, table: 'party_role', by: 'entity' },
{ order: 1, table: 'ledger', by: 'entity' },
{ order: 1.5, table: 'fx_company_currency', by: 'entity' },
{ order: 2, table: 'gst_return_adjustment', by: 'ledger' },
{ order: 27, table: 'account', by: 'entity' },
{ order: 28, table: 'account_role', by: 'account' },
{ order: 30, table: 'fiscal_year', by: 'ledger' },
{ order: 31, table: 'fiscal_period', by: 'ledger' },
{ order: 32, table: 'journal_entry', by: 'ledger' },
{ order: 33, table: 'journal_line', by: 'entry' },
{ order: 34, table: 'invoice', by: 'ledger' },
{ order: 35, table: 'invoice_line', by: 'invoice' },
{ order: 36, table: 'invoice_application', by: 'invoice' },
{ order: 37, table: 'bank_statement', by: 'account' },
{ order: 38, table: 'bank_statement_attachment', by: 'bankStatement' },
{ order: 39, table: 'bank_transaction', by: 'account' },
{ order: 40, table: 'bank_match', by: 'bankRow' },
{ order: 57, table: 'cheque_sequence', by: 'ledger' },
{ order: 58, table: 'cheque', by: 'ledger' },
{ order: 59, table: 'period_balance', by: 'ledger' },
{ order: 60, table: 'ai_exchange', by: 'ledger' },
{ order: 61, table: 'ai_bill_reading', by: 'ledger' },
{ order: 62, table: 'ai_inquiry', by: 'ledger' },
{ order: 63, table: 'ai_inquiry_skill', by: 'inquiry' },
{ order: 64, table: 'ai_inquiry_step', by: 'inquiry' },
{ order: 65, table: 'ai_skill_command_execution', by: 'inquiry' },
{ order: 66, table: 'attachment', by: 'entry' },
{ order: 67, table: 'receipt_waiver', by: 'entry' },
{ order: 68, table: 'company_profile', by: 'entity' },
{ order: 70, table: 'dimension', by: 'entity' },
{ order: 71, table: 'dimension_value', by: 'dimension' },
{ order: 73, table: 'entity_tax_registration', by: 'entity' },
{ order: 76, table: 'number_sequence', by: 'entity' },
{ order: 113,table:'payment_connection',by:'entity'},
{ order: 114,table:'checkout_request',by:'entity'},
{ order: 115,table:'payment_event',by:'entity'},
{ order: 116,table:'processor_transaction',by:'entity'},
{ order: 117,table:'inbound_connection',by:'entity'},
{ order: 118,table:'inbound_message',by:'entity'},
{ order: 119,table:'inbound_attachment',by:'entity'},
{ order: 120, table: 'automation_setting', by: 'entity' },
{ order: 121, table: 'recurring_template', by: 'entity' },
{ order: 122, table: 'recurring_occurrence', by: 'entity' },
{ order: 123, table: 'inbox_item', by: 'entity' },
{ order: 124, table: 'reminder_rule', by: 'entity' },
{ order: 125, table: 'email_message', by: 'entity' },
{ order: 126, table: 'background_job', by: 'entity' },
{ order: 127,table:'migration_run',by:'entity'},
{ order: 128,table:'migration_file',by:'migrationRun'},
{ order: 129,table:'migration_stage',by:'migrationFile'},
{ order: 130,table:'migration_account_map',by:'migrationRun'},
{ order: 131,table:'migration_party_map',by:'migrationRun'},
{ order: 132,table:'migration_reference',by:'entity'},
{ order: 133,table:'budget',by:'entity'},
{ order: 134,table:'budget_line',by:'budget'},
  ...moduleManifests.flatMap(manifest => manifest.backup?.companyData ?? []),
])

/**
 * And every table that is NOT one company's rows, with the reason. A list of
 * exclusions without reasons is a list nobody can audit.
 */
export const NOT_COMPANY_DATA: Record<string, string> = Object.assign({
fx_currency: 'BOC currency reference catalog; transaction snapshots retain precision and provenance',
fx_rate: 'BOC reference cache; immutable company transaction rates travel with their documents',
mcp_credential: 'installation-bound AI access credentials; never copied with company books',
audit_scope_source: 'installation schema metadata: which column gives each add-on table\'s audit rows a company',
portal_invitation:'ephemeral single-invoice capabilities; excluded from portable copies and revoked after whole restore',
portal_session:'ephemeral portal sessions; excluded from portable copies and revoked after whole restore',
automation_worker: 'installation worker heartbeats, not portable company books',
document_edit_lease: 'ephemeral editor/session ownership; excluded from company copies and never restored as active',
auth_rate_bucket: 'installation authentication attempt windows, not company books',
audit_chain_head: 'installation chain heads; original company scopes and bytes travel in auditProof, new copies open new chains',
audit_legacy_seal: 'installation-wide cutover seal; includes shared/system rows excluded from a company copy',
audit_verification_run: 'installation verification status; copies must run their own verification',
audit_checkpoint: 'installation checkpoints; company chain checkpoints travel in auditProof; same-database storage is not independent',
audit_origin_proof: 'company provenance carried recursively in dedicated auditProof.origins, preserving source scopes and bytes',
auth_recovery_code: 'personal authentication credentials; excluded from company copies',
auth_passkey: 'personal WebAuthn public keys and revocation state; company copies never carry identity credentials',
auth_webauthn_challenge: 'short-lived browser/session-bound challenges, never portable or resumable after restore',
company_module_access: 'installation-managed module permissions; whole-database backups preserve them, company copies require an explicit access review',
invoice_template: 'installation-wide template resources; company invoice snapshots carry the historical layout, whole-database backups preserve editable templates',
invoice_template_version: 'immutable installation template versions; saved invoice snapshots are portable without resource ids or grants',
invoice_template_access: 'superadmin-managed company permissions; a restored company must not inherit access to shared templates',
invoice_template_assignment: 'defaults for installation-local template resources; reassign explicitly for a restored company, whose posted invoices retain their snapshots',
_migration: 'which migrations this database has run — a fact about the database',
accounting_standard: 'reference data, seeded by a migration',
party_role_definition: 'reference data, seeded by a migration',
party_address_purpose: 'reference data, seeded by a migration',
role_definition: 'the 86 roles, frozen and seeded by a migration',
statement_template: 'reference data, seeded by a migration',
statement_line: 'reference data, seeded by a migration',
app_user: 'people, not companies — a backup of the books is not a backup of who reads them',
user_session: 'who is signed in right now',
webdav_credential: 'a person\'s revocable access password, not company books; restoring it could grant file access',
user_ai_service: "a person's own service and key",
user_module_access: 'which modules a person holds',
user_entity_access: 'who may open this company — restored beside it, that would name people who may not exist',
user_entity_module_access: 'the authoritative company × module grants — restored users may not exist',
audit_log: 'company-scope history is carried in the file\'s dedicated `audit` section; '
    + 'shared, system and unresolved events are excluded because one company cannot own them',
attachment_blob: 'shared by hash across every company, like a party — carried in `blobs` and '
    + 'matched, with the bytes themselves in `files` when they were asked for',
entity: 'the company itself, which is the root of the file rather than a row in it',
party: 'the address book is shared by every company; carried in `parties` and matched, never duplicated',
party_address: 'part of a shared party',
party_contact: 'part of a shared party',
}, ...moduleManifests.map(manifest => manifest.backup?.excluded ?? {}))

/**
 * Values that must NOT travel: unique across the whole table, and meaningless
 * in a copy.
 *
 * `journal_entry.idempotency_key` is how a double-click is caught — it says
 * "this exact submission already happened". Carried into a restored company
 * it collides with the entry it was copied from
 * (`journal_entry_idempotency_key_key`, which is what the owner met on their
 * second real restore, 2026-09-07) and, if it did not collide, it would make
 * the copy claim to be the same submission as the original. Nulled, which
 * the column allows.
 */
export const NOT_CARRIED_OVER: Record<string, string[]> = Object.assign({
automation_setting:['smtp_password_ciphertext'],
payment_connection:['authorized_by','key_ciphertext','webhook_ciphertext'],
inbound_connection:['authorized_by','username_ciphertext','password_ciphertext'],
migration_run:['actor_user_id'],
recurring_template:['actor_user_id'],
inbox_item:['actor_user_id'],
reminder_rule:['actor_user_id'],
email_message:['actor_user_id'],
background_job:['actor_user_id','worker_id'],
journal_entry: ['idempotency_key'],
invoice: ['fx_request_key'],
}, ...moduleManifests.map(manifest => manifest.backup?.notCarried ?? {}))

/**
 * Every unique index on a carried table is either made unique by a value the
 * restore REMAPS — an id, or a foreign key to something carried — or it is
 * named here with what is done about it instead.
 *
 * This exists because the same defect reached the owner twice: a value copied
 * verbatim that the whole table has to agree on. `BK1b` holds every unique
 * index in the database to one of those two answers, so the next one is a
 * decision rather than a stack trace on somebody's first restore.
 */
export const UNIQUE_HANDLED: Record<string, string> = Object.assign({
payment_merchant_binding:'portable merchant binding is false; restore requires an actual merchant re-verification',
inbound_provider_binding:'portable provider binding is false; explicit rebind requires fresh credentials',
inbound_alias_binding:'portable aliases are null and bindings false; rebind rotates a fresh alias',
payment_event_delivery:'portable event facts are detached; original provider IDs remain historical',
processor_economic_event:'portable economic facts are detached; original provider IDs remain historical',
journal_entry_idempotency_key_key:
    'nulled on the way in — see NOT_CARRIED_OVER',
entity_code_key:
    'the person is asked for a code, and a code already here is refused in words before anything is written',
party_one_active_name:
    'parties are matched by name and never inserted under a name already here (BK7, BK7b)',
one_live_entry_per_invoice:
    "over (source_type, source_id); `source_id` holds an invoice's id with no foreign key "
    + 'declaring it, and it is remapped anyway because ids are rewritten BY VALUE rather than '
    + 'by column — which `BK4d` proves rather than assumes',
}, ...moduleManifests.map(manifest => manifest.backup?.unique ?? {}))

/** How each table's rows are found, from the company's id. */
const FROM: Record<string, (t: string, id: string) => ReturnType<typeof sql>> = {
migrationRun:(t,id)=>sql`SELECT * FROM ${sql.raw(t)} WHERE run_id IN (SELECT id FROM migration_run WHERE entity_id=${id}::uuid)`,
migrationFile:(t,id)=>sql`SELECT * FROM ${sql.raw(t)} WHERE file_id IN (SELECT f.id FROM migration_file f JOIN migration_run r ON r.id=f.run_id WHERE r.entity_id=${id}::uuid)`,
budget:(t,id)=>sql`SELECT * FROM ${sql.raw(t)} WHERE budget_id IN (SELECT id FROM budget WHERE entity_id=${id}::uuid)`,
entity: (t, id) => sql`SELECT * FROM ${sql.raw(t)} WHERE entity_id = ${id}::uuid`,
ledger: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE ledger_id IN (SELECT id FROM ledger WHERE entity_id = ${id}::uuid)`,
account: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE account_id IN (SELECT id FROM account WHERE entity_id = ${id}::uuid)`,
entry: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE entry_id IN (
      SELECT e.id FROM journal_entry e JOIN ledger l ON l.id = e.ledger_id WHERE l.entity_id = ${id}::uuid)`,
invoice: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE invoice_id IN (
      SELECT i.id FROM invoice i WHERE i.entity_id = ${id}::uuid)`,
bankRow: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE bank_transaction_id IN (
      SELECT b.id FROM bank_transaction b JOIN account a ON a.id = b.account_id
       WHERE a.entity_id = ${id}::uuid)`,
bankStatement: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE statement_id IN (
      SELECT s.id FROM bank_statement s JOIN account a ON a.id = s.account_id
       WHERE a.entity_id = ${id}::uuid)`,
inquiry: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE inquiry_id IN (
      SELECT q.id FROM ai_inquiry q JOIN ledger l ON l.id = q.ledger_id WHERE l.entity_id = ${id}::uuid)`,
dimension: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE dimension_id IN (
      SELECT d.id FROM dimension d WHERE d.entity_id = ${id}::uuid)`,
}

export type FigtreeFile = {
  figtree: number
  app: string
  /** How many migrations the database that made this had run, and the last one's name. */
  schema: { count: number; last: string }
  entity: Record<string, unknown>
  parties: { party: Row[]; party_address: Row[]; party_contact: Row[] }
  /**
   * The `attachment_blob` rows this company's receipts name. Shared by hash,
   * so they are matched rather than copied — but they have to be IN the file,
   * because an attachment row whose blob row is missing is an attachment
   * pointing at nothing, and the load does not check foreign keys.
   */
  blobs: Row[]
  rows: Record<string, Row[]>
  fxCurrencies?: Array<{code:string;name:string;minor_digits:number;boc_series:string;historical:boolean}>
  /**
   * Format 2 carries only history proven to belong to this company. Shared,
   * system and unresolved events cannot honestly be assigned to one portable
   * company, so their exclusion is part of the file rather than an omission.
   * Format 1 files have no `audit` member and remain readable.
   */
  audit?: {
    includedScope: 'company'
    excludedScopes: Array<'shared' | 'system' | 'unresolved'>
    rows: Row[]
  }
  /** Format 4: immutable source chain bytes, original scopes and restore hops. */
  auditProof?: AuditProof
  files: Array<{ sha256: string; bytes: string; mime: string; size: number; storageDomain?: string; projectId?: string; [key: string]: unknown }>
  exportedAt: string
  counts: Record<string, number>
  /** sha256 of everything above, as JSON with sorted keys. */
  checksum: string
}

const BACKUP_STORAGE = moduleManifests.flatMap(manifest => manifest.backup?.storage ?? [])

export function assertInstalledBackupData(doc: FigtreeFile, checkFiles = false) {
  const tables = new Set(COMPANY_DATA.map(item => item.table))
  for (const [table, rows] of Object.entries(doc.rows ?? {})) {
    if (!Array.isArray(rows)) throw new BackupError('BAD_ROWS', 'The backup has an invalid table inventory.')
    if (!tables.has(table) && rows.length) throw new BackupError('MISSING_MODULE', `The backup contains data for unavailable table ${table}. Install its module before restoring. Nothing was restored.`)
  }
  if (checkFiles && doc.files.some(file => (file.storageDomain ?? 'accounting') !== 'accounting' && !BACKUP_STORAGE.some(storage => storage.domain === file.storageDomain))) {
    throw new BackupError('MISSING_MODULE', 'The backup contains paper for an unavailable module. Nothing was restored.')
  }
}

function backupFileKey(file: FigtreeFile['files'][number]) {
  const domain = file.storageDomain ?? 'accounting', storage = BACKUP_STORAGE.find(item => item.domain === domain)
  return storage ? `${domain}:${String(file[storage.fileOwner])}:${file.sha256}` : `accounting:${file.sha256}`
}

type Row = Record<string, unknown>

/**
 * JSON that survives the round trip.
 *
 * Money is `bigint` in this system and `JSON.stringify` refuses one outright;
 * a date arrives from the driver as a `Date`. Both become strings, which is
 * what goes back in as a parameter — Postgres casts a string to the column's
 * own type, so nothing has to remember which columns were which.
 */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
}

/** The body, hashed the same way at both ends. */
function bodyOf(doc: FigtreeFile): string {
  const rest = { ...doc }
  delete (rest as Partial<FigtreeFile>).checksum
  const ordered: Record<string, unknown> = {}
  for (const k of Object.keys(rest).sort()) ordered[k] = (rest as Record<string, unknown>)[k]
  return stringify(ordered)
}

const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

/**
 * Columns the database computes for itself, per table.
 *
 * `entity.is_active` became `archived_at IS NULL` in 0065 so that one fact
 * had one source; a generated column cannot be written, so it is left out of
 * the file AND skipped on the way back in. Read from the database rather than
 * listed here: the next generated column is somebody's migration, not an
 * entry in a list they would have to remember.
 */
async function generatedColumns(): Promise<Map<string, Set<string>>> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND is_generated = 'ALWAYS'`)
  const out = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Set())
    out.get(r.table_name)!.add(r.column_name)
  }
  return out
}

/**
 * And the JSON ones, for the same reason and from the same place.
 *
 * The driver binds a string, not the object a jsonb column comes back as.
 * Which columns those are is the database's answer rather than a list here
 * that the next migration could get ahead of.
 */
async function jsonColumns(): Promise<Map<string, Set<string>>> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')`)
  const out = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Set())
    out.get(r.table_name)!.add(r.column_name)
  }
  return out
}

/**
 * And every column, so a file can name only columns that exist.
 *
 * A row's keys become the column list of its INSERT. The checksum is a plain
 * SHA-256 anybody can recompute, so those keys are the file's to choose: a key
 * carrying a quote and a statement was SQL run with the triggers off
 * (security review, 2026-10-20). Checked before the load, and quoted in
 * `insert` regardless.
 */
async function tableColumns(): Promise<Map<string, Set<string>>> {
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`)
  const out = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, new Set())
    out.get(r.table_name)!.add(r.column_name)
  }
  return out
}

/** `table.column` for every key in the file that names no column here. */
function unknownColumns(doc: FigtreeFile, columns: Map<string, Set<string>>): string[] {
  const sets: Array<[string, Row[]]> = [
    ['entity', [doc.entity]],
    ['party', doc.parties.party], ['party_address', doc.parties.party_address],
    ['party_contact', doc.parties.party_contact],
    ['attachment_blob', doc.blobs],
    ...COMPANY_DATA.map(({ table }): [string, Row[]] => [table, doc.rows[table] ?? []]),
  ]
  const out = new Set<string>()
  for (const [table, rows] of sets) {
    const known = columns.get(table) ?? new Set<string>()
    for (const row of rows) for (const key of Object.keys(row)) {
      if (!known.has(key)) out.add(`${table}.${key}`)
    }
  }
  return [...out]
}

/**
 * What the triggers would have refused, asked of the loaded books.
 *
 * The load runs with every trigger off, so nothing checked an entry's balance,
 * its period or the balance cache on the way in, and the cache is loaded as the
 * file says. Asked here, inside the restore's transaction, so a file whose
 * books do not hold together rolls back whole.
 */
async function restoredLedgerProblems(tx: Tx, ledgerId: string): Promise<string[]> {
  const entries = await tx.execute<{ entry_no: string | null; why: string }>(sql`
    SELECT je.entry_no,
           CASE WHEN l.n = 0 THEN 'has no lines'
                WHEN l.total <> 0 THEN 'is out of balance by ' || l.total || ' cents'
                ELSE 'has header totals its lines do not add up to' END AS why
      FROM journal_entry je
      CROSS JOIN LATERAL (
        SELECT count(*) AS n, COALESCE(sum(amount), 0) AS total,
               COALESCE(sum(debit), 0) AS debit, COALESCE(sum(credit), 0) AS credit
          FROM journal_line WHERE entry_id = je.id) l
     WHERE je.ledger_id = ${ledgerId}::uuid AND je.status <> 'draft'
       AND (l.n = 0 OR l.total <> 0 OR je.total_debit <> l.debit OR je.total_credit <> l.credit)
     LIMIT 3`)
  const periods = await tx.execute<{ entry_no: string; reason: string }>(sql`
    SELECT entry_no, reason FROM check_period_assignments(${ledgerId}::uuid) LIMIT 3`)
  const cache = await tx.execute<{ check_name: string; account_code: string | null; period_name: string | null }>(sql`
    SELECT check_name, account_code, period_name FROM check_balance_integrity(${ledgerId}::uuid) LIMIT 3`)
  return [
    ...entries.map((e) => `entry ${e.entry_no ?? '(unnumbered)'} ${e.why}`),
    ...periods.map((p) => `entry ${p.entry_no}: ${p.reason}`),
    ...cache.map((c) => `balance ${c.check_name} for ${c.account_code ?? 'the ledger'} in ${c.period_name ?? 'a period'}`),
  ]
}

const without = (row: Row, drop: Set<string> | undefined): Row => {
  if (!drop || drop.size === 0) return row
  return Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k)))
}

async function schemaOf(): Promise<{ count: number; last: string }> {
  const rows = await db.execute<{ filename: string }>(sql`
    SELECT filename FROM _migration ORDER BY filename`)
  return { count: rows.length, last: rows[rows.length - 1]?.filename ?? '' }
}

/**
 * Everything this company is, as a document.
 *
 * `withFiles` decides whether the receipts themselves ride along. They are
 * the only part that can make the file large, so the screen shows what they
 * weigh and the person chooses — rather than this deciding for them and one
 * of the two answers being wrong.
 */
export async function exportCompany(
  entityId: string, opts: { withFiles?: boolean } = {},
): Promise<FigtreeFile> {
  return db.transaction(async tx=>{
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
    return exportCompanySnapshot(tx,entityId,opts)
  })
}
async function exportCompanySnapshot(tx:Tx,entityId:string,opts:{withFiles?:boolean}):Promise<FigtreeFile> {
  const [entityRow] = await tx.execute<Row>(sql`SELECT * FROM entity WHERE id = ${entityId}::uuid`)
  if (!entityRow) throw new BackupError('NO_COMPANY', 'That company is not in these books.')
  const generated = await generatedColumns()
  const entity = without(entityRow, generated.get('entity'))

  const rows: Record<string, Row[]> = {}
  const counts: Record<string, number> = {}
  for (const { table, by } of COMPANY_DATA) {
    const got = await tx.execute<Row>(FROM[by]?.(table, entityId) ?? await moduleBackupScope(by, table, entityId))
    rows[table] = got.map((r) => portableIntegration(table,without(r, generated.get(table))))
    counts[table] = got.length
  }

  const partyReferences = await moduleBackupParties(entityId)
  // The parties this company actually names — not the whole address book,
  // which belongs to every company at once.
  const party = await tx.execute<Row>(sql`
    SELECT * FROM party WHERE id IN (
      SELECT party_id FROM party_role WHERE entity_id = ${entityId}::uuid
      UNION SELECT party_id FROM journal_line jl
              JOIN journal_entry e ON e.id = jl.entry_id
              JOIN ledger l ON l.id = e.ledger_id
             WHERE l.entity_id = ${entityId}::uuid AND jl.party_id IS NOT NULL
      UNION SELECT party_id FROM invoice WHERE entity_id = ${entityId}::uuid AND party_id IS NOT NULL
      ${sql.join(partyReferences.map(query => sql`UNION ${query}`), sql` `)})
     ORDER BY name`)
  const ids = party.map((p) => String(p.id))
  const partyRows = async (t: string) => ids.length === 0 ? [] : tx.execute<Row>(sql`
    SELECT * FROM ${sql.raw(t)} WHERE party_id IN (
      SELECT id FROM party WHERE id::text = ANY(string_to_array(${ids.join(',')}, ',')))`)

  // Every blob this company's paper names — its receipts and its minute book's documents (0081).
  const references = orderedModuleItems<{ table: string; column?: string; notNull?: boolean }>([
    { order: 0, table: 'attachment' }, { order: 2, table: 'bank_statement_attachment' },
    { order: 5, table: 'inbox_item' }, { order: 6, table: 'email_message', column: 'attachment_sha256' },
    { order: 7, table: 'migration_file' }, { order: 8, table: 'inbound_attachment', notNull: true },
    ...moduleManifests.flatMap(manifest => manifest.backup?.blobReferences ?? []),
  ])
  const shas = [...new Set(references.flatMap(reference => (rows[reference.table] ?? [])
    .filter(row => !reference.notNull || row[reference.column ?? 'sha256'])
    .map(row => String(row[reference.column ?? 'sha256']))))]
  const blobs = shas.length === 0 ? [] : await tx.execute<Row>(sql`
    SELECT * FROM attachment_blob
     WHERE sha256 IN (SELECT unnest(string_to_array(${shas.join(',')}, ',')))`)

  const files: FigtreeFile['files'] = []
  if (opts.withFiles) {
    const mime = new Map(blobs.map(b => [String(b.sha256), String(b.mime)]))
    for (const sha of shas) {
      const bytes = await readBlobBytes(String(entity.name), sha)
      // A blob the store has lost is not a reason to refuse the whole backup:
      // the books are the point, the paper is the extra. `missingPaper` says
      // how many, and the screen repeats it.
      if (!bytes) continue
      files.push({
        sha256: sha, bytes: bytes.toString('base64'), storageDomain:'accounting',
        mime: mime.get(sha) ?? 'application/octet-stream', size: bytes.length,
      })
    }
    files.push(...await moduleBackupFiles(rows, entityId))
  }

  // A portable company owns only the audit events whose stored attribution
  // says exactly that. Shared address-book/access events, installation events
  // and old unresolved rows are deliberately not guessed into a company.
  // Redact again while exporting so a pre-0086 row with a sensitive key is
  // safe without rewriting the historical row in place.
  const audit = await tx.execute<Row>(sql`
    SELECT id::text, to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, actor, action, table_name, record_id,
           audit_canonical_v1(audit_redact(before))::jsonb AS before, audit_canonical_v1(audit_redact(after))::jsonb AS after,
           audit_canonical_v1(audit_redact(context))::jsonb AS context, entity_id::text, ledger_id::text,
           scope, reason, target_label
      FROM audit_log
     WHERE scope = 'company' AND entity_id = ${entityId}::uuid
     ORDER BY occurred_at, id`)

  const doc: FigtreeFile = {
    figtree: FIGTREE_FORMAT,
    app: 'FigTree',
    schema: await schemaOf(),
    entity,
    parties: {
      party,
      party_address: await partyRows('party_address'),
      party_contact: await partyRows('party_contact'),
    },
    blobs,
    rows,
    audit: {
      includedScope: 'company',
      excludedScopes: ['shared', 'system', 'unresolved'],
      rows: audit,
    },
    auditProof: await exportAuditProof(entityId,tx),
    files,
    exportedAt: localMoment(),
    counts,
    checksum: '',
  }
  const referenced = [...referencedFxCurrencies(doc)]
  if (referenced.length) doc.fxCurrencies = await tx.execute<{code:string;name:string;minor_digits:number;boc_series:string;historical:boolean}>(sql`
    SELECT code,name,minor_digits,boc_series,historical FROM fx_currency WHERE code IN (${sql.join(referenced.map(c=>sql`${c}`),sql`,`)}) ORDER BY code`)
  doc.checksum = hash(bodyOf(doc))
  if(doc.figtree>=4){
    if(!doc.auditProof)throw new BackupError('AUDIT_PROOF','This backup is missing its source audit proof.')
    verifyAuditProof(doc.auditProof)
  }
  return doc
}

const gzipAsync = promisify(gzip)

/** Same portable bytes; compression yields to the event loop. */
export async function packFigtree(doc: FigtreeFile): Promise<Buffer> {
  return gzipAsync(Buffer.from(stringify(doc), 'utf8'))
}

/** And back — every refusal in words, because a person chose this file. */
export function readFigtree(bytes: Buffer): FigtreeFile {
  let text: string
  try {
    text = gunzipSync(bytes).toString('utf8')
  } catch {
    throw new BackupError('NOT_A_FIGTREE',
      'That is not a Banyan/FigTree-compatible backup — it could not be unpacked.')
  }
  let doc: FigtreeFile
  try {
    doc = JSON.parse(text) as FigtreeFile
  } catch {
    throw new BackupError('NOT_A_FIGTREE', 'That file is damaged: what it holds is not readable.')
  }
  if (!READABLE_FIGTREE_FORMATS.has(doc?.figtree)) {
    throw new BackupError('WRONG_FORMAT',
      `This reads compatible backups of formats 1, 2 and ${FIGTREE_FORMAT}; that file says ${doc?.figtree ?? 'nothing'}.`)
  }
  if (typeof doc.checksum !== 'string' || doc.checksum !== hash(bodyOf(doc))) {
    throw new BackupError('CHANGED',
      'That file has been changed since it was saved — its checksum does not match what is in it.')
  }
  if(!Array.isArray(doc.files))throw new BackupError('BAD_FILES','The backup has no valid file inventory.')
  assertInstalledBackupData(doc)
  validateFxCatalog(doc)
  const fileKeys=new Set<string>()
  for(const f of doc.files) {
    const domain=f.storageDomain??'accounting',storage=BACKUP_STORAGE.find(item=>item.domain===domain),key=backupFileKey(f)
    const bytes=typeof f.bytes==='string'?Buffer.from(f.bytes,'base64'):Buffer.alloc(0)
    const ownedBlob=storage&&(doc.rows[storage.table]??[]).find(row=>row[storage.rowOwner]===f[storage.fileOwner]&&row.sha256===f.sha256&&row.entity_id===doc.entity.id)
    if(!(domain==='accounting'||storage)||fileKeys.has(key)||!Number.isSafeInteger(f.size)||f.size<1||bytes.length!==f.size
      ||typeof f.sha256!=='string'||hash(bytes)!==f.sha256
      ||(domain!=='accounting'&&(!storage||doc.figtree<storage.minFormat||!ownedBlob||String(ownedBlob.byte_size)!==String(f.size)))
      ||(domain==='accounting'&&f.projectId))throw new BackupError('BAD_FILES','A file has invalid bytes, storage domain or Project ownership. Nothing was restored.')
    fileKeys.add(key)
  }
  if (doc.figtree >= 2) {
    const sourceEntityId = typeof doc.entity?.id === 'string' ? doc.entity.id : null
    const audit = doc.audit
    const valid = sourceEntityId !== null
      && audit?.includedScope === 'company'
      && Array.isArray(audit.excludedScopes)
      && ['shared', 'system', 'unresolved'].every((scope) => audit.excludedScopes.includes(
        scope as 'shared' | 'system' | 'unresolved'))
      && Array.isArray(audit.rows)
      && audit.rows.every((row) => row.scope === 'company'
        && row.entity_id === sourceEntityId
        && typeof row.id === 'string'
        && typeof row.occurred_at === 'string'
        && typeof row.actor === 'string'
        && typeof row.action === 'string'
        && typeof row.table_name === 'string'
        && typeof row.record_id === 'string')
    if (!valid) {
      throw new BackupError('BAD_AUDIT',
        'That backup does not contain a valid company audit history. Nothing was restored.')
    }
  }
  assertCompanyAuditProof(doc)
  return doc
}

function assertCompanyAuditProof(doc:FigtreeFile){
  if(doc.figtree>=4&&!doc.auditProof)throw new BackupError('AUDIT_PROOF','This backup is missing its source audit proof.')
  if(doc.auditProof){
    verifyAuditProof(doc.auditProof)
    if(doc.auditProof.checkpoint.heads.some(h=>h.entityId!==doc.entity.id))
      throw new BackupError('AUDIT_PROOF','The source audit proof belongs to another company.')
    const rows=new Map((doc.audit?.rows??[]).map(r=>[String(r.id),r]))
    for(const e of doc.auditProof.events){
      const v=JSON.parse(e.canonical),r=rows.get(v.target.auditId)
      if(!r||v.occurredAt!==r.occurred_at||v.actor!==r.actor||v.action!==r.action
        ||v.target.table!==r.table_name||v.target.id!==r.record_id||v.target.label!==(r.target_label??null)
        ||v.scope.kind!==r.scope||v.scope.entityId!==r.entity_id||v.scope.ledgerId!==(r.ledger_id??null)
        ||canonicalAudit(v.payload)!==canonicalAudit({before:r.before??null,after:r.after??null,context:r.context??null,reason:r.reason??null}))
        throw new BackupError('AUDIT_PROOF','The displayed source history does not match its original audit proof.')
    }
  }
}

/**
 * What a restore would be walking into, without doing it. The screen shows
 * this before the button, because "restore" is a word people press quickly.
 */
export async function inspectFigtree(doc: FigtreeFile) {
  const here = await schemaOf()
  const [clash] = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM entity WHERE code = ${String(doc.entity.code)}`)
  const included=new Set(doc.files.map(backupFileKey))
  const expected=[...doc.blobs.map(b=>`accounting:${b.sha256}`),...BACKUP_STORAGE.flatMap(storage=>(doc.rows[storage.table]??[]).map(row=>`${storage.domain}:${String(row[storage.rowOwner])}:${String(row.sha256)}`))]
  return {
    company: { code: String(doc.entity.code), name: String(doc.entity.name) },
    exportedAt: doc.exportedAt,
    schema: doc.schema,
    here,
    /** Newer means rows this database has nowhere to put. */
    tooNew: doc.schema.count > here.count,
    codeTaken: Number(clash.n) > 0,
    entries: doc.counts.journal_entry ?? 0,
    accounts: doc.counts.account ?? 0,
    parties: doc.parties.party.length,
    paper: doc.files.length,
    missingPaper: expected.filter(key=>!included.has(key)).length,
    paperBytes: doc.files.reduce((n, f) => n + f.size, 0),
    audit: doc.figtree >= 2 ? doc.audit?.rows.length ?? 0 : 0,
    auditIncluded: doc.figtree >= 2,
  }
}

/**
 * A company back out of a file — ALWAYS AS A NEW ONE.
 *
 * Every id in the document is remapped before a single row is written, so
 * self-references (an account's parent, an entry's reversal) land on the new
 * ids without a second pass, and the same file can be restored twice.
 *
 * Two things are put back the way they were only AFTER everything is in:
 * a period's status and the company's archived state. Both are gates — a
 * closed period refuses entries and an archived company refuses everything —
 * so restoring in the order the rows were written would have the books
 * refusing their own restore.
 */
export async function restoreCompany(
  doc: FigtreeFile, actor: string, opts: { code?: string; name?: string } = {},
) {
  assertInstalledBackupData(doc, true)
  validateFxCatalog(doc)
  assertCompanyAuditProof(doc)
  const here = await schemaOf()
  if (doc.schema.count > here.count) {
    throw new BackupError('TOO_NEW',
      `That backup was made by a newer compatible application (${doc.schema.count} migrations against this `
      + `database's ${here.count}). Update this one first — restoring it here would silently `
      + 'drop whatever the newer version knows about.')
  }

  const code = (opts.code ?? String(doc.entity.code)).trim()
  const name = (opts.name ?? String(doc.entity.name)).trim()
  if (!code) throw new BackupError('NO_CODE', 'The restored company needs a code.')
  if (!name) throw new BackupError('NO_NAME', 'The restored company needs a name.')
  const [taken] = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM entity WHERE code = ${code}`)
  if (Number(taken.n) > 0) {
    throw new BackupError('CODE_TAKEN',
      `A company with the code ${code} is already here. Give the restored one a different code — `
      + 'a restore never writes over a company that exists.')
  }
  const sharing = await folderTakenBy(name)
  if (sharing) {
    throw new BackupError('NAME_TAKEN',
      `A company called ${sharing} is already here. Give the restored one a different name — the two would `
      + 'share one folder of papers, and rebuilding either would wipe the other\'s.')
  }

  const generated = await generatedColumns()
  const jsonCols = await jsonColumns()
  const unknown = unknownColumns(doc, await tableColumns())
  if (unknown.length > 0) {
    throw new BackupError('UNKNOWN_COLUMN',
      `That backup names columns this database does not have: ${unknown.slice(0, 3).join(', ')}`
      + `${unknown.length > 3 ? `, and ${unknown.length - 3} more` : ''}. Nothing was restored.`)
  }

  return actingAs(actor, async (tx) => {
    /*
     * A RESTORE IS A LOAD, NOT A SEQUENCE OF EDITS.
     *
     * Five restores in a row died on a different trigger — a closed period
     * refusing its own entries, a posted invoice refusing raw SQL, a payroll
     * record arriving before the role it depends on, a share transfer refused
     * half-written — and each was answered by deferring one more thing
     * (owner, 2026-09-07: 「太多错了」). They were right to stop. The guards
     * are written to protect LIVE books from a hand at a psql prompt and from
     * a door that forgot something; this is neither. It is rows this system
     * produced, checksummed, going into a company that did not exist a moment
     * ago, all or nothing.
     *
     * So it loads the way `pg_restore` loads: user triggers off, foreign keys
     * unchecked, and the whole thing VERIFIED afterwards — inside the same
     * transaction, so a file that would leave a dangling reference rolls back
     * instead of landing. Turning the checks off during a load is only
     * honest if something checks the result.
     *
     * What is still enforced, because none of it is a trigger: primary keys,
     * unique indexes, NOT NULL and CHECK. Those are what `BK1b` is about.
     */
    try {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`)
    } catch {
      throw new BackupError('NEEDS_SUPERUSER',
        'Restoring needs the current database user to load without firing triggers '
        + '(session_replication_role). This connection cannot, so nothing was restored.')
    }

    for (const c of doc.fxCurrencies ?? []) {
      await tx.execute(sql`INSERT INTO fx_currency(code,name,minor_digits,boc_series,historical)
        VALUES(${c.code},${c.name},${c.minor_digits},${c.boc_series},${c.historical}) ON CONFLICT(code) DO NOTHING`)
      const [local]=await tx.execute<{minor_digits:number;boc_series:string}>(sql`SELECT minor_digits,boc_series FROM fx_currency WHERE code=${c.code} FOR SHARE`)
      if (!local || local.minor_digits!==c.minor_digits || local.boc_series!==c.boc_series) throw new BackupError('FX_CATALOG','The local currency definition conflicts with the backup. Nothing was restored.')
    }

    // ---- every id, mapped, before anything is written ---------------------
    const map = new Map<string, string>()
    const entityId = randomUUID()
    map.set(String(doc.entity.id), entityId)
    for (const { table } of COMPANY_DATA) {
      for (const row of doc.rows[table] ?? []) {
        if (typeof row.id === 'string') map.set(row.id, randomUUID())
      }
    }

    // Parties are NOT given new rows by default: the address book is one list
    // for every company, and the database refuses two active parties with the
    // same name — a UNIQUE index, so it is enforced even here. Match by id,
    // then by name, then create.
    for (const p of doc.parties.party) {
      const old = String(p.id)
      const [byId] = await tx.execute<{ id: string }>(sql`
        SELECT id::text FROM party WHERE id = ${old}::uuid`)
      if (byId) { map.set(old, byId.id); continue }
      const [byName] = await tx.execute<{ id: string }>(sql`
        SELECT id::text FROM party WHERE name = ${String(p.name)} AND is_active`)
      if (byName) { map.set(old, byName.id); continue }
      const fresh = randomUUID()
      map.set(old, fresh)
      await insert(tx, 'party', { ...p, id: fresh }, map, generated.get('party'), jsonCols.get('party'))
      for (const t of ['party_address', 'party_contact'] as const) {
        for (const child of doc.parties[t]) {
          if (String(child.party_id) !== old) continue
          await insert(tx, t, { ...child, id: randomUUID() }, map, generated.get(t), jsonCols.get(t))
        }
      }
    }

    // ---- does the file hold everything it points at? ---------------------
    //
    // Before a single row is written, and inside the transaction anyway, so
    // there is nothing to undo. Every id the file carries is in `map` by now,
    // including the parties — so anything not in it is a reference this file
    // cannot honour.
    const unresolved = await unresolvedReferences(doc)
    if (unresolved.length > 0) {
      throw new BackupError('INCOMPLETE',
        'That backup does not hold everything it points at: '
        + `${unresolved.slice(0, 3).join('; ')}`
        + `${unresolved.length > 3 ? `, and ${unresolved.length - 3} more` : ''}. Nothing was restored.`)
    }

    // ---- the blob rows a receipt names, shared by hash like a party -------
    for (const b of doc.blobs) {
      const [already] = await tx.execute<{ sha256: string }>(sql`
        SELECT sha256 FROM attachment_blob WHERE sha256 = ${String(b.sha256)}`)
      if (already) continue
      await insert(tx, 'attachment_blob', b, map,
        generated.get('attachment_blob'), jsonCols.get('attachment_blob'))
    }

    // ---- the company, then every row, exactly as they were ----------------
    //
    // No nulling, no second pass, no order that has to be got right: with the
    // foreign keys unchecked, a row may name one that is not in yet, and by
    // the end they are all in. The verification below is what makes that safe.
    await insert(tx, 'entity', { ...doc.entity, id: entityId, code, name },
      map, generated.get('entity'), jsonCols.get('entity'))
    for (const { table } of COMPANY_DATA) {
      for (const row of doc.rows[table] ?? []) {
        let value: Row = portableIntegration(table,{ ...row })
        // Values unique across the WHOLE table, which a copy must not carry.
        for (const col of NOT_CARRIED_OVER[table] ?? []) {
          if (col in value) value = { ...value, [col]: null }
        }
        // Evidence and provider IDs remain historical. Live capabilities and
        // retry jobs do not cross a company-copy boundary, even on this server.
        if(table==='migration_run')value={...value,status:['active','cancelled','draft'].includes(String(value.status))?value.status:'restored_paused',validation:remapPlanningLocators(value.validation,map),reconciliation:remapPlanningLocators(value.reconciliation,map),last_error:['active','cancelled'].includes(String(value.status))?value.last_error:'Restored copy: review current source and reauthorize before continuing.'}
        if(table==='migration_reference')value={...value,source_rows:remapPlanningLocators(value.source_rows,map)}
        if(table==='automation_setting')value={...value,enabled:false,mail_enabled:false}
        if(table==='recurring_template')value={...value,active:false,snapshot:remapAutomationSnapshot(value.snapshot,map),last_error:'Restored copy: review source and authorize this template again.'}
        if(table==='recurring_occurrence')value={...value,template_snapshot:remapAutomationSnapshot(value.template_snapshot,map)}
        if(table==='reminder_rule')value={...value,enabled:false,paused:true,pause_reason:'Restored copy: review customer and authorize reminders again.'}
        if(table==='inbox_item'&&value.status==='processing')value={...value,status:'needs_review',last_error:'Restored copy: extraction was interrupted; manual review is available.'}
        if(table==='background_job'&&['queued','running','paused'].includes(String(value.status)))value={...value,status:value.job_type==='email_send'&&value.status==='running'?'delivery_unknown':'paused',generation:String(BigInt(String(value.generation))+1n),locked_until:null,last_error:'Restored copy: execution is paused; review authorization.'}
        if(table==='email_message'&&['preview','queued','sending','paused'].includes(String(value.status)))value={...value,status:value.status==='sending'?'delivery_unknown':'paused',last_error:'Restored copy: sending is paused; create a new approved preview.'}
        value = await moduleRestoredRow(table, value, map)
        await insert(tx, table, value, map, generated.get(table), jsonCols.get(table))
      }
    }
    await afterModuleRestore(tx, { rows: doc.rows, map, entityId })

    // ---- and the books, the way the triggers would have checked them ------
    for (const row of doc.rows.ledger ?? []) {
      await validateRestoredFx(tx, map.get(String(row.id))!)
      const problems = await restoredLedgerProblems(tx, map.get(String(row.id))!)
      if (problems.length > 0) {
        throw new BackupError('NOT_BALANCED',
          `That backup's books do not hold together: ${problems.join('; ')}. Nothing was restored.`)
      }
    }

    const ledgerId = map.get(String(doc.rows.ledger?.[0]?.id ?? '')) ?? null
    if(ledgerId)await rebindRestoredImports(tx,ledgerId)
    const restoredAt = new Date().toISOString()

    if(doc.auditProof)await tx.execute(sql`INSERT INTO audit_origin_proof(entity_id,source_checksum,proof,mapping,restored_by)
      VALUES(${entityId}::uuid,${doc.checksum},${JSON.stringify(doc.auditProof)}::jsonb,
      ${JSON.stringify(Object.fromEntries(map))}::jsonb,${actor})`)

    // Format 2 carries the source company's proven company-scope history.
    // The evidence itself (actor, time and before/after/context values) stays
    // as it was. Locator columns for rows which were recreated are remapped;
    // a deleted/absent target keeps its source record id because inventing a
    // fresh id would imply a row exists. The old ids and file checksum are
    // appended as a provenance hop so the two identities are never confused.
    for (const row of doc.figtree >= 2 ? doc.audit?.rows ?? [] : []) {
      const sourceRecordId = String(row.record_id)
      const sourceLedgerId = typeof row.ledger_id === 'string' ? row.ledger_id : null
      const recordId = map.get(sourceRecordId) ?? sourceRecordId
      const mappedLedgerId = sourceLedgerId ? map.get(sourceLedgerId) ?? null : null
      const context = restoredAuditContext(row.context, {
        sourceAuditId: String(row.id),
        sourceEntityId: String(row.entity_id),
        sourceLedgerId,
        sourceRecordId,
        sourceFileChecksum: doc.checksum,
        sourceExportedAt: doc.exportedAt,
        restoredAt,
        restoredBy: actor,
      })
      await tx.execute(sql`
        INSERT INTO audit_log
          (occurred_at, actor, action, table_name, record_id, before, after, context,
           entity_id, ledger_id, scope, reason, target_label, source)
        VALUES
          (${String(row.occurred_at)}::timestamptz, ${String(row.actor)}, ${String(row.action)},
           ${String(row.table_name)}, ${recordId}, audit_redact(${jsonText(row.before)}::jsonb),
           audit_redact(${jsonText(row.after)}::jsonb),
           audit_redact(${JSON.stringify(context)}::jsonb),
           ${entityId}::uuid, ${mappedLedgerId}::uuid, 'company',
           ${nullableText(row.reason)}, ${nullableText(row.target_label)}, 'portable_history_import')`)
    }

    // The arrival itself is a new event, distinct from the source history.
    // Every attribution column is explicit because load mode also disables
    // the trigger that would normally derive them.
    await tx.execute(sql`
      INSERT INTO audit_log
        (table_name, record_id, action, actor, after, context,
         entity_id, ledger_id, scope, reason, target_label)
      VALUES ('entity', ${entityId}, 'restore', ${actor},
              ${JSON.stringify({ code, name })}::jsonb,
              ${JSON.stringify({
                from: { code: doc.entity.code, name: doc.entity.name },
                exportedAt: doc.exportedAt,
                schema: doc.schema,
                rows: Object.values(doc.counts).reduce((a, b) => a + b, 0),
                paper: doc.files.length,
                audit: {
                  included: doc.figtree >= 2,
                  rows: doc.figtree >= 2 ? doc.audit?.rows.length ?? 0 : 0,
                  sourceFileChecksum: doc.checksum,
                  sourceChainCheckpoint: doc.auditProof?.checkpoint??null,
                  mapping: Object.fromEntries(map),
                },
                restoredAt,
              })}::jsonb,
              ${entityId}::uuid, ${ledgerId}::uuid, 'company',
              'Restored from a portable .fig backup', ${name})`)

    const moduleMaps = Object.fromEntries(moduleManifests.flatMap(manifest => manifest.backup?.restoredIds ?? [])
      .map(spec => [spec.key, Object.fromEntries((doc.rows[spec.table] ?? []).map(row => [String(row.id), map.get(String(row.id))!]))]))
    // Keep the public v3 restore hint while providers own its contents.
    return { entityId, code, name, ledgerId, moduleMaps, projectMap: moduleMaps.projectMap ?? {} }
  })
}

const jsonText = (value: unknown): string => JSON.stringify(value ?? null)

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

function restoredAuditContext(context: unknown, hop: Row): Row {
  const restored: Row = context && typeof context === 'object' && !Array.isArray(context)
    ? { ...(context as Row) }
    : context === null || context === undefined
      ? {}
      : { _figtree_original_context: context }
  const prior = restored._figtree_restore_chain
  if (prior !== undefined && !Array.isArray(prior)) {
    restored._figtree_original_restore_chain = prior
  }
  restored._figtree_restore_chain = [...(Array.isArray(prior) ? prior : []), hop]
  return restored
}

/**
 * EVERY REFERENCE THE FILE MAKES, CHECKED — BEFORE ANYTHING IS WRITTEN.
 *
 * The load runs with foreign keys unenforced, which is what makes the order
 * of the tables stop mattering. This is the other half of that bargain.
 *
 * It asks a stronger question than "does it exist". An id that is not in the
 * file is not remapped, so it goes in unchanged — and unchanged it names the
 * row it was copied FROM, which does exist. A restored company quietly
 * reading another company's rows is worse than one that fails to load. So
 * the question is: does everything this file points at come WITH it?
 *
 * Each foreign key is checked as a column group against the parent rows the
 * file carries. Grouping matters: checking `(stage_id, pipeline_id,
 * entity_id)` as three unrelated values would accept a combination that no
 * parent row owns. Shared parties are still present in `doc.parties`, even
 * when restore later matches them to an existing address-book row.
 *
 * Derived from the schema, not listed. A migration that adds a foreign key
 * adds it here too.
 */
async function unresolvedReferences(doc: FigtreeFile): Promise<string[]> {
  const keys = await db.execute<{
    constraint_name: string; child: string; child_cols: string[]
    parent: string; parent_cols: string[]
  }>(sql`
    SELECT k.conname AS constraint_name, c.relname AS child, cf.relname AS parent,
           array_agg(ca.attname ORDER BY cols.n) AS child_cols,
           array_agg(pa.attname ORDER BY cols.n) AS parent_cols
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_class cf ON cf.oid = k.confrelid
      CROSS JOIN LATERAL unnest(k.conkey, k.confkey) WITH ORDINALITY
        AS cols(child_attnum, parent_attnum, n)
      JOIN pg_attribute ca ON ca.attrelid = c.oid AND ca.attnum = cols.child_attnum
      JOIN pg_attribute pa ON pa.attrelid = cf.oid AND pa.attnum = cols.parent_attnum
     WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace
     GROUP BY k.conname, c.relname, cf.relname`)

  const carried = new Set([
    ...COMPANY_DATA.map((c) => c.table), 'entity', 'party', 'attachment_blob',
  ])
  const out: string[] = []

  const rowsOf = (table: string): Row[] =>
    table === 'party' ? doc.parties.party
    : table === 'party_address' ? doc.parties.party_address
    : table === 'party_contact' ? doc.parties.party_contact
    : table === 'attachment_blob' ? doc.blobs
    : table === 'entity' ? [doc.entity]
    : doc.rows[table] ?? []

  for (const k of keys) {
    // Reference data and local installation data (standards, roles, users)
    // are not company rows in a portable file. Local user references are
    // nulled by NOT_CARRIED_OVER before insertion.
    if (!carried.has(k.parent)) continue
    const rows = rowsOf(k.child)
    if (rows.length === 0) continue
    const parents = rowsOf(k.parent)
    let missing = 0
    for (const row of rows) {
      const values = k.child_cols.map((col) => row[col])
      // PostgreSQL's ordinary MATCH SIMPLE foreign keys do not ask a question
      // when any component is null. Every composite company boundary has a
      // non-null entity_id, while its optional target may legitimately be null.
      if (values.some((v) => v === null || v === undefined || v === '')) continue
      const found = parents.some((parent) => k.parent_cols.every(
        (parentCol, i) => String(parent[parentCol]) === String(values[i]),
      ))
      if (!found) missing++
    }
    if (missing > 0) {
      out.push(`${missing} ${k.child} row(s) break ${k.constraint_name} to ${k.parent}`)
    }
  }
  return out
}

/** One row, with every mapped id rewritten and every column named explicitly. */
async function insert(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  table: string, row: Row, map: Map<string, string>,
  generated?: Set<string>, jsonCols?: Set<string>,
) {
  const cols = Object.keys(row).filter((c) => !generated?.has(c))
  if (cols.length === 0) return
  const values = cols.map((c) => {
    const v = row[c]
    // A string that IS one of the old ids becomes the new one. Every id was
    // mapped before anything was written, so this needs no second pass and
    // no knowledge of which columns are foreign keys — which is what keeps
    // it right when the schema grows a new one.
    if(table==='checkout_request'&&c==='source_request_key')return v
    if (typeof v === 'string' && map.has(v)) return map.get(v)!
    // A jsonb column wants the text: the driver can bind a string, not the
    // object the row came back as.
    if (jsonCols?.has(c) && v !== null && typeof v === 'object') return JSON.stringify(v)
    return v
  })
  // `sql.param`, not bare interpolation: drizzle reads a plain array as a
  // LIST of parameters, so `required_dimensions: []` became `VALUES (…, (), …)`
  // and Postgres refused the statement. Every value here is one parameter.
  await tx.execute(sql`
    INSERT INTO ${sql.raw(table)} (${sql.raw(cols.map((c) => `"${c.replaceAll('"', '""')}"`).join(', '))})
    VALUES (${sql.join(values.map((v) => sql`${sql.param(v)}`), sql`, `)})`)
}

/** The paper, once the books are in. Separate because a store that refuses
 *  must not lose the restore that already succeeded. */
export async function restorePaper(doc: FigtreeFile, company: string, ledgerId: string | null, hints?: { entityId: string; moduleMaps?: Record<string, Record<string, string>> } & Record<string, unknown>) {
  assertInstalledBackupData(doc, true)
  const maps = hints?.moduleMaps ?? Object.fromEntries(BACKUP_STORAGE.map(storage => {
    const legacy = hints?.[storage.mapKey]
    return [storage.mapKey, legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? legacy as Record<string, string> : {}]
  }))
  let written = 0
  for (const file of doc.files) {
    if ((file.storageDomain ?? 'accounting') === 'accounting') {
      await writeBlobBytes(company, file.sha256, Buffer.from(file.bytes, 'base64'))
    } else if (!await restoreModuleFile(file, hints ? { entityId: hints.entityId, maps } : undefined)) {
      throw new BackupError('MISSING_MODULE', 'Install the module for this file storage before restoring its paper.')
    }
    written++
  }
  if (ledgerId && doc.files.some(file => (file.storageDomain ?? 'accounting') === 'accounting')) await rebuildAttachmentTree(ledgerId, 'system')
  return written
}

/** Only reference fields inside recurring business snapshots are rebound. */
function remapAutomationSnapshot(value:unknown,map:Map<string,string>):unknown {
  if(Array.isArray(value))return value.map(v=>remapAutomationSnapshot(v,map))
  if(!value||typeof value!=='object')return value
  return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,
    ['accountId','controlAccountId','partyId'].includes(key)&&typeof v==='string'?(map.get(v)??v)
    :key==='dimensions'&&v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,id])=>[k,typeof id==='string'?(map.get(id)??id):id]))
    :Array.isArray(v)||v&&typeof v==='object'?remapAutomationSnapshot(v,map):v]))
}

/** Only target locators move. Source IDs and descriptions are never rewritten. */
function remapPlanningLocators(value:unknown,map:Map<string,string>):unknown {
 if(Array.isArray(value))return value.map(v=>remapPlanningLocators(v,map))
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,['accountId','invoiceId','fileId'].includes(k)&&typeof v==='string'?map.get(v)??v:remapPlanningLocators(v,map)]))
 return value
}

/** Portable files carry evidence, never usable provider credentials or capabilities. */
function portableIntegration(table:string,row:Row):Row {
  if(table==='automation_setting')return {...row,smtp_password_ciphertext:null,smtp_username:null,smtp_host:null,enabled:false,mail_enabled:false}
  if(table==='payment_connection')return {...row,authorized_by:null,key_ciphertext:null,webhook_ciphertext:null,enabled:false,verified_at:null,binding_attached:false}
  if(table==='inbound_connection')return {...row,authorized_by:null,username_ciphertext:null,password_ciphertext:null,enabled:false,binding_attached:false,alias_address:null}
  if(table==='checkout_request')return {...row,status:'detached',checkout_url:null,last_error:'Restored evidence: verify the original provider binding and current state before any processing.'}
  if(table==='payment_event'||table==='processor_transaction')return {...row,detached:true}
  if(table==='inbound_message')return {...row,status:'detached'}
  return row
}

/** Only referenced BOC catalog rows travel; downloaded rate caches do not. */
function referencedFxCurrencies(doc: Pick<FigtreeFile, 'rows'>): Set<string> {
  return new Set([
    ...(doc.rows.fx_company_currency ?? []).map(r => r.currency),
    ...(doc.rows.account ?? []).map(r => r.foreign_currency),
    ...(doc.rows.invoice ?? []).map(r => r.fx_currency),
    ...(doc.rows.journal_line ?? []).map(r => r.original_currency),
  ].filter((c): c is string => typeof c === 'string' && c !== 'CAD'))
}

function validateFxCatalog(doc: FigtreeFile) {
  const currencies = doc.fxCurrencies ?? []
  if (!Array.isArray(currencies) || currencies.length > 200) throw new BackupError('FX_CATALOG', 'The backup has an invalid currency catalog.')
  const codes = new Set<string>()
  for (const c of currencies) {
    if (!c || typeof c.code !== 'string' || codes.has(c.code) || c.boc_series !== `FX${c.code}CAD`
      || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 1000 || typeof c.historical !== 'boolean'
      || c.minor_digits !== currencyDigits(c.code)) throw new BackupError('FX_CATALOG', 'The backup has invalid currency precision or BOC series metadata.')
    codes.add(c.code)
  }
  for (const code of referencedFxCurrencies(doc)) if (!codes.has(code)) throw new BackupError('FX_CATALOG', `The backup is missing the ${code} currency definition.`)
}

/** Restore disables triggers, so validate FX scope and evidence explicitly. */
async function validateRestoredFx(tx: Tx, ledgerId: string) {
  const invalidBank=await tx.execute(sql`SELECT 1 FROM account a JOIN ledger l ON l.entity_id=a.entity_id
    WHERE l.id=${ledgerId}::uuid AND a.foreign_currency IS NOT NULL AND (a.foreign_currency='CAD'
      OR NOT EXISTS(SELECT 1 FROM fx_currency WHERE code=a.foreign_currency)
      OR NOT EXISTS(SELECT 1 FROM account_role WHERE account_id=a.id AND role='cash_and_cash_equivalents')) LIMIT 1`)
  if(invalidBank.length)throw new BackupError('FX_TRUTH','The backup has an invalid foreign bank currency binding.')
  const invalid = await tx.execute(sql`
    SELECT 1 FROM journal_line j JOIN journal_entry e ON e.id=j.entry_id JOIN ledger l ON l.id=e.ledger_id
    JOIN account a ON a.id=j.account_id LEFT JOIN invoice i ON i.id=j.fx_invoice_id
    WHERE e.ledger_id=${ledgerId}::uuid AND (
      (a.foreign_currency IS NOT NULL AND (a.foreign_currency='CAD' OR NOT EXISTS(SELECT 1 FROM account_role WHERE account_id=a.id AND role='cash_and_cash_equivalents')))
      OR (e.status<>'draft' AND a.foreign_currency IS NOT NULL AND j.original_currency IS DISTINCT FROM a.foreign_currency)
      OR (j.original_currency IS NOT NULL AND (l.currency<>'CAD' OR a.entity_id<>l.entity_id
        OR (a.foreign_currency IS NULL AND EXISTS(SELECT 1 FROM account_role WHERE account_id=a.id AND role='cash_and_cash_equivalents'))
        OR (j.fx_invoice_id IS NULL AND EXISTS(SELECT 1 FROM account_role WHERE account_id=a.id AND role IN ('trade_receivables','trade_payables')))
        OR (j.fx_invoice_id IS NOT NULL AND (i.id IS NULL OR i.ledger_id<>e.ledger_id OR i.party_id IS DISTINCT FROM j.party_id
          OR i.control_account_id<>j.account_id OR i.fx_currency IS DISTINCT FROM j.original_currency))
        OR (j.original_amount<>0 AND j.amount<>0 AND sign(j.original_amount)<>sign(j.amount))
        OR (e.source_type='fx_revaluation' AND (j.original_amount<>0 OR (j.fx_invoice_id IS NULL AND a.foreign_currency IS NULL)))
        OR NOT EXISTS(SELECT 1 FROM fx_currency WHERE code=j.original_currency)))
    ) LIMIT 1`)
  if (invalid.length) throw new BackupError('FX_TRUTH', 'The backup has foreign-currency lines outside their bank, document or ledger scope.')
  const reversals=await tx.execute<{id:string}>(sql`SELECT id::text FROM journal_entry WHERE ledger_id=${ledgerId}::uuid AND reverses_id IS NOT NULL`)
  for(const reversal of reversals)await tx.execute(sql`SELECT fx_validate_reversal(${reversal.id}::uuid)`)
  const lines = await tx.execute<{original_currency:string;original_amount:bigint;amount:bigint;fx_snapshot:FxSnapshot;entry_date:string;fx_invoice_id:string|null;source_type:string;reverses_id:string|null}>(sql`
    SELECT j.original_currency,j.original_amount,j.amount,j.fx_snapshot,e.entry_date::text,j.fx_invoice_id::text,e.source_type,e.reverses_id::text
    FROM journal_line j JOIN journal_entry e ON e.id=j.entry_id WHERE e.ledger_id=${ledgerId}::uuid AND j.original_currency IS NOT NULL`)
  for (const line of lines) {
    const quote = validateSnapshot(line.fx_snapshot)
    if (quote.currency!==line.original_currency || quote.observedOn>line.entry_date
      || (quote.source!=='carrying' && line.original_amount!==0n && !line.fx_invoice_id && !line.reverses_id
        && line.amount!==toFunctional(line.original_amount,line.original_currency,quote.rate))) {
      throw new BackupError('FX_TRUTH', 'The backup has a foreign amount that disagrees with its saved rate.')
    }
  }
  const docs = await tx.execute<{id:string;fx_currency:string|null;fx_snapshot:FxSnapshot|null;issued_on:string}>(sql`
    SELECT id::text,fx_currency,fx_snapshot,issued_on::text FROM invoice WHERE ledger_id=${ledgerId}::uuid`)
  for (const doc of docs) {
    const detail=await tx.execute<{amount:bigint;original_amount:bigint|null}>(sql`SELECT amount,original_amount FROM invoice_line WHERE invoice_id=${doc.id}::uuid`)
    for (const line of detail) {
      if (doc.fx_currency) {
        const quote=validateSnapshot(doc.fx_snapshot!)
        if (quote.observedOn>doc.issued_on || line.original_amount===null || line.amount!==toFunctional(line.original_amount,doc.fx_currency,quote.rate)) throw new BackupError('FX_TRUTH','The backup has a document line that disagrees with its original currency and rate.')
      } else if (line.original_amount!==null) throw new BackupError('FX_TRUTH','A functional-currency document cannot contain foreign line amounts.')
    }
    await tx.execute(sql`SELECT fx_check_invoice(${doc.id}::uuid)`)
  }
  const apps=await tx.execute(sql`
    SELECT 1 FROM invoice_application app JOIN invoice i ON i.id=app.invoice_id JOIN journal_entry e ON e.id=app.entry_id
    WHERE i.ledger_id=${ledgerId}::uuid AND (
      e.ledger_id<>i.ledger_id OR (i.fx_currency IS NULL AND (app.original_amount IS NOT NULL OR app.carrying_amount IS NOT NULL))
      OR (i.fx_currency IS NOT NULL AND (app.original_amount IS NULL OR app.carrying_amount IS DISTINCT FROM app.amount
        OR app.amount IS DISTINCT FROM (SELECT abs(sum(j.amount))::bigint FROM journal_line j WHERE j.entry_id=e.id AND j.fx_invoice_id=i.id)
        OR app.original_amount IS DISTINCT FROM (SELECT abs(sum(j.original_amount))::bigint FROM journal_line j WHERE j.entry_id=e.id AND j.fx_invoice_id=i.id)
        OR e.entry_date<i.issued_on))) LIMIT 1`)
  if (apps.length) throw new BackupError('FX_TRUTH','The backup has settlement applications that disagree with their foreign control entries.')
}

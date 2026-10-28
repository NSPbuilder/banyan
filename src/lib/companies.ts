import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting } from './acting'
import { moduleManifests, orderedModuleItems } from './module-manifests'
import { moduleCompanyActivity, beforeModuleCompanyDelete, deleteModuleCompanyRows } from './module-extensions'
import { promises as fs } from 'fs'
import path from 'path'
import { attachmentsDir } from './backup-paths'
import { folderName, folderTakenBy } from './attachments'
import { CANADIAN_PROVINCES } from './provinces'

/**
 * Putting a company away, and removing one that was a mistake.
 *
 * The owner asked for both in one breath (2026-09-07: 「删除/archive公司」),
 * and they are not the same thing:
 *
 *   ARCHIVE  the books exist and are finished with. Nothing may be posted
 *            into them again; every figure stays exactly where it is. This is
 *            what a dissolved company gets, and what anything with a posted
 *            entry gets, because books are kept in order to still be there.
 *
 *   DELETE   the company was a mistake — wrong name, wrong year end, created
 *            twice — and nothing was ever posted into it. Then there is
 *            nothing to keep, and keeping it is clutter that looks like a
 *            company.
 *
 * The line between them is not a judgment: `deleteCompany` counts every entry,
 * invoice and imported bank row, and every question put to the assistant, and
 * refuses at one. There is no door in this system that removes posted books.
 */

export class CompanyError extends Error {
  constructor(readonly code: 'NO_COMPANY' | 'ALREADY_ARCHIVED' | 'NOT_ARCHIVED' | 'HAS_BOOKS' | 'HAS_AI_RECORDS' | 'NO_REASON'
                | 'NO_NAME' | 'BAD_PROVINCE' | 'NAME_TAKEN' | 'FOLDER_SHARED' | 'FOLDER_STRANDED',
              message: string) {
    super(message)
    this.name = 'CompanyError'
  }
}

export type CompanyRecord = {
  id: string
  code: string
  name: string
  archived_at: string | null
  archived_by: string | null
  archived_reason: string | null
  /**
   * Everything in this company's books that a delete would take away: every
   * journal entry of any status, every invoice, every imported bank row. Not
   * "posted entries" — the question is whether anything is there, and a
   * draft somebody typed is something.
   */
  entries: string
  /**
   * Questions put to the assistant — the old form's and the books' — and bills
   * it read. Counted apart from
   * `entries`: an exchange is never deleted (0061's trigger refuses it), so a
   * company holding any is archived, and the refusal says so in its own words.
   */
  ai_records: string
}

async function companyHead() {
  const activity = await moduleCompanyActivity(sql`e.id`)
  return sql`
  SELECT e.id::text, e.code, e.name, e.archived_at::text, e.archived_by, e.archived_reason,
         -- ANY entry, and any document that could become one: a draft, an
         -- unposted invoice. The first version
         -- counted only posted and reversed rows, so "nothing was ever
         -- posted" was true while the press removed a company's drafts,
         -- invoices, directors and imported bank rows (critic, 2026-09-07).
         ((SELECT count(*) FROM journal_entry je JOIN ledger l ON l.id = je.ledger_id
            WHERE l.entity_id = e.id)
          + (SELECT count(*) FROM invoice i WHERE i.entity_id = e.id)
          + (SELECT count(*) FROM invoice_template t WHERE t.entity_id = e.id)
          + (SELECT count(*) FROM bank_transaction b JOIN account a ON a.id = b.account_id
              WHERE a.entity_id = e.id)
          + (SELECT count(*) FROM bank_statement s JOIN account a ON a.id = s.account_id
              WHERE a.entity_id = e.id)
          + (SELECT count(*) FROM gst_return_adjustment x JOIN ledger l ON l.id=x.ledger_id WHERE l.entity_id=e.id)











          + (SELECT count(*) FROM inbox_item x WHERE x.entity_id = e.id)
          + (SELECT count(*) FROM recurring_template x WHERE x.entity_id = e.id)
          + (SELECT count(*) FROM recurring_occurrence x WHERE x.entity_id = e.id)
          + (SELECT count(*) FROM reminder_rule x WHERE x.entity_id = e.id)
          + (SELECT count(*) FROM email_message x WHERE x.entity_id = e.id)
          + (SELECT count(*) FROM migration_run x WHERE x.entity_id=e.id)
          + (SELECT count(*) FROM budget x WHERE x.entity_id=e.id)
          + (SELECT count(*) FROM checkout_request x WHERE x.entity_id=e.id)
          + (SELECT count(*) FROM payment_event x WHERE x.entity_id=e.id)
          + (SELECT count(*) FROM processor_transaction x WHERE x.entity_id=e.id)
          + (SELECT count(*) FROM inbound_message x WHERE x.entity_id=e.id) + ${activity})::text AS entries,
         ((SELECT count(*) FROM ai_exchange x JOIN ledger l ON l.id = x.ledger_id
            WHERE l.entity_id = e.id)
          + (SELECT count(*) FROM ai_bill_reading br JOIN ledger l ON l.id = br.ledger_id
              WHERE l.entity_id = e.id)
          + (SELECT count(*) FROM ai_inquiry q JOIN ledger l ON l.id = q.ledger_id
              WHERE l.entity_id = e.id))::text AS ai_records
    FROM entity e`
}

export async function companyById(entityId: string, on: import('./acting').Runner = db): Promise<CompanyRecord | null> {
  const [row] = await on.execute<CompanyRecord>(sql`${await companyHead()} WHERE e.id = ${entityId}::uuid`)
  return row ?? null
}

/** Every company, archived ones last, for the list that offers both doors. */
export async function companiesWithState(): Promise<CompanyRecord[]> {
  return db.execute<CompanyRecord>(sql`${await companyHead()} ORDER BY e.archived_at IS NOT NULL, e.code`)
}

/**
 * Put a company away. The reason is required for the same purpose it is
 * required when a period is reopened: in three years the only thing that can
 * explain a company nobody remembers is the sentence somebody typed.
 */
export async function archiveCompany(entityId: string, reason: string, actor: string): Promise<CompanyRecord> {
  const why = reason.trim()
  if (!why) {
    throw new CompanyError('NO_REASON',
      'Say why this company is being put away — it is the only thing that will explain it later.')
  }
  const company = await companyById(entityId)
  if (!company) throw new CompanyError('NO_COMPANY', 'There is no such company.')
  if (company.archived_at !== null) {
    throw new CompanyError('ALREADY_ARCHIVED', `${company.name} is already archived.`)
  }
  return db.transaction(async (tx) => {
    await acting(tx, actor)
    const [row] = await tx.execute<CompanyRecord>(sql`
      UPDATE entity SET archived_at = now(), archived_by = ${actor}, archived_reason = ${why},
                        updated_at = now()
       WHERE id = ${entityId}::uuid
      RETURNING id::text, code, name, archived_at::text, archived_by, archived_reason, '0' AS entries`)
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
      VALUES (${actor}, 'archive_company', 'entity', ${entityId},
              ${JSON.stringify({ archivedBy: actor, reason: why })}::jsonb,
              ${JSON.stringify({ code: company.code, name: company.name, entries: company.entries })}::jsonb)`)
    return { ...row, entries: company.entries, ai_records: company.ai_records }
  })
}

/** And bring one back, which is the same act read the other way. */
export async function unarchiveCompany(entityId: string, actor: string): Promise<CompanyRecord> {
  const company = await companyById(entityId)
  if (!company) throw new CompanyError('NO_COMPANY', 'There is no such company.')
  if (company.archived_at === null) {
    throw new CompanyError('NOT_ARCHIVED', `${company.name} is not archived.`)
  }
  return db.transaction(async (tx) => {
    await acting(tx, actor)
    await tx.execute(sql`
      UPDATE entity SET archived_at = NULL, archived_by = NULL, archived_reason = NULL,
                        updated_at = now()
       WHERE id = ${entityId}::uuid`)
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, context)
      VALUES (${actor}, 'unarchive_company', 'entity', ${entityId},
              ${JSON.stringify({ archivedAt: company.archived_at, reason: company.archived_reason })}::jsonb,
              ${JSON.stringify({ code: company.code, name: company.name })}::jsonb)`)
    return (await companyById(entityId))!
  })
}

/**
 * Everything that hangs off a company, in the order it has to go.
 *
 * Written out rather than left to ON DELETE CASCADE, and that is deliberate:
 * a cascade is invisible at the call site, so the day somebody adds a table
 * the delete silently takes more with it than anybody meant. This list is
 * read by `deleteCompany` and by `CO7`, which walks the database's foreign
 * keys OUTWARD from `entity` and `ledger` — not just the tables that point
 * at them directly, but everything reachable — and names any table that is
 * neither listed here nor removed by a cascade of its own. The first version
 * looked only one hop out and missed five tables (critic, 2026-09-07).
 */
export const COMPANY_TABLES = {
  first: orderedModuleItems<{ table: string; by: string }>([
{ order: 0, table: 'background_job', by: 'entity' },
{ order: 1,table:'inbound_attachment',by:'entity'},
{ order: 2,table:'inbound_message',by:'entity'},
{ order: 3,table:'processor_transaction',by:'entity'},
{ order: 4,table:'payment_event',by:'entity'},
{ order: 5,table:'checkout_request',by:'entity'},
{ order: 6,table:'portal_session',by:'entity'},
{ order: 7,table:'portal_invitation',by:'entity'},
{ order: 8,table:'payment_connection',by:'entity'},
{ order: 9,table:'inbound_connection',by:'entity'},
{ order: 10, table: 'email_message', by: 'entity' },
{ order: 11, table: 'reminder_rule', by: 'entity' },
{ order: 12, table: 'inbox_item', by: 'entity' },
{ order: 13, table: 'recurring_occurrence', by: 'entity' },
{ order: 14, table: 'recurring_template', by: 'entity' },
{ order: 15, table: 'automation_setting', by: 'entity' },
{ order: 16, table: 'invoice_template_assignment', by: 'entity' },
{ order: 17, table: 'invoice_template_access', by: 'entity' },
{ order: 40, table: 'bank_match', by: 'bankRow' },
{ order: 41, table: 'invoice_application', by: 'invoice' },
{ order: 42, table: 'ai_bill_reading', by: 'ledger' },
{ order: 43, table: 'ai_skill_command_execution', by: 'inquiry' },
{ order: 44, table: 'ai_inquiry_step', by: 'inquiry' },
{ order: 45, table: 'ai_inquiry_skill', by: 'inquiry' },
{ order: 46, table: 'ai_inquiry', by: 'ledger' },
{ order: 47, table: 'ai_exchange', by: 'ledger' },
{ order: 48, table: 'period_balance', by: 'ledger' },
{ order: 49, table: 'gst_return_adjustment', by: 'ledger' },
{ order: 50, table: 'cheque', by: 'ledger' },
{ order: 51, table: 'cheque_sequence', by: 'ledger' },
{ order: 53, table: 'invoice', by: 'ledger' },
{ order: 54, table: 'journal_entry', by: 'ledger' },
{ order: 55, table: 'fiscal_period', by: 'ledger' },
{ order: 56, table: 'fiscal_year', by: 'ledger' },
{ order: 57, table: 'bank_statement', by: 'account' },
{ order: 58, table: 'bank_transaction', by: 'account' },
    ...moduleManifests.flatMap(manifest => manifest.company?.first ?? []),
  ]),
  byEntity: orderedModuleItems<{ table: string }>([
{ order: 0, table: 'company_profile' },
{ order: 1, table: 'fx_company_currency' },
{ order: 2, table: 'dimension' },
{ order: 4, table: 'entity_tax_registration' },
{ order: 6, table: 'number_sequence' },
{ order: 8, table: 'party_role' },
{ order: 12, table: 'webdav_credential' },
{ order: 13, table: 'user_entity_module_access' },
{ order: 14, table: 'user_entity_access' },
{ order: 15, table: 'account' },
{ order: 16, table: 'ledger' },
    ...moduleManifests.flatMap(manifest => manifest.company?.byEntity ?? []),
  ]).map(item => item.table),
}

/** HEAD refuses deletion when a company owns templates, projects or bank
 * statements. Their supporting records are retained with those roots. */
export const COMPANY_RETAINED_TABLES = orderedModuleItems<{ table: string }>([
{ order: 35, table: 'invoice_template' },
{ order: 36, table: 'invoice_template_version' },
{ order: 44, table: 'bank_statement_attachment' },
{ order: 45, table: 'migration_run' },
{ order: 46, table: 'migration_file' },
{ order: 47, table: 'migration_stage' },
{ order: 48, table: 'migration_account_map' },
{ order: 49, table: 'migration_party_map' },
{ order: 50, table: 'migration_reference' },
{ order: 51, table: 'budget' },
{ order: 52, table: 'budget_line' },
  ...moduleManifests.flatMap(manifest => manifest.company?.retained ?? []),
]).map(item => item.table)

/** How each of the first group finds its way back to the company. */
const REACH = {
  entity: (t: string, id: string) => sql`
    DELETE FROM ${sql.raw(t)} WHERE entity_id = ${id}::uuid`,
  ledger: (t: string, id: string) => sql`
    DELETE FROM ${sql.raw(t)} WHERE ledger_id IN (SELECT id FROM ledger WHERE entity_id = ${id}::uuid)`,
  account: (t: string, id: string) => sql`
    DELETE FROM ${sql.raw(t)} WHERE account_id IN (SELECT id FROM account WHERE entity_id = ${id}::uuid)`,
  bankRow: (t: string, id: string) => sql`
    DELETE FROM ${sql.raw(t)} WHERE bank_transaction_id IN (
      SELECT b.id FROM bank_transaction b JOIN account a ON a.id = b.account_id WHERE a.entity_id = ${id}::uuid)`,
  invoice: (t: string, id: string) => sql`
    DELETE FROM ${sql.raw(t)} WHERE invoice_id IN (SELECT id FROM invoice WHERE entity_id = ${id}::uuid)`,
  inquiry: (t: string, id: string) => sql`
    DELETE FROM ${sql.raw(t)} WHERE inquiry_id IN (
      SELECT q.id FROM ai_inquiry q JOIN ledger l ON l.id = q.ledger_id WHERE l.entity_id = ${id}::uuid)`,
} as const

/**
 * A company's name and province, put right (0084; owner, 2026-09-16:
 * 「所有的紀錄儘量都可以編輯刪除」). The code stays: it is what a delete is
 * confirmed by and what people type.
 *
 * THE NAME IS ALSO A FOLDER. The attachment store keeps each company's blobs
 * and its Finder tree under a folder named for the company, and finds a
 * receipt's bytes by that name — so renaming the company without moving the
 * folder would leave every receipt unreadable. The folder moves first; if the
 * database then refuses, it moves back. A name another company's folder
 * already has is refused: two companies would share one folder.
 */
export async function renameCompany(input: {
  entityId: string; name: string; province: string; actor: string
}): Promise<{ name: string; province: string | null; movedFolder: boolean }> {
  const company = await companyById(input.entityId)
  if (!company) throw new CompanyError('NO_COMPANY', 'There is no such company.')
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (!name) throw new CompanyError('NO_NAME', 'A company needs a name.')
  const province = input.province.trim().toUpperCase() || null
  if (province && !CANADIAN_PROVINCES.some(([code]) => code === province)) {
    throw new CompanyError('BAD_PROVINCE', `"${input.province}" is not a Canadian province or territory.`)
  }
  const same = (a: string, b: string) => folderName(a).toLowerCase() === folderName(b).toLowerCase()
  // The folder being moved must be THIS company's alone. A restored copy that
  // kept its original's name shares the original's folder, and moving it would
  // take the original's receipts and minute book with it.
  const sharing = await folderTakenBy(company.name, input.entityId)
  if (sharing) {
    throw new CompanyError('FOLDER_SHARED',
      `${sharing} has the same name, so the two companies keep their papers in one folder, and renaming this `
      + 'one would move the other\'s papers too. Nothing was changed. Separating them needs the folder split by hand first.')
  }
  const clash = await folderTakenBy(name, input.entityId)
  if (clash) {
    throw new CompanyError('NAME_TAKEN',
      `Another company is called ${clash}; the two would share one folder of papers. Choose another name.`)
  }
  const oldDir = path.join(attachmentsDir(), folderName(company.name))
  const newDir = path.join(attachmentsDir(), folderName(name))
  const exists = (p: string) => fs.access(p).then(() => true, () => false)
  let movedFolder = false
  if (oldDir !== newDir && await exists(oldDir)) {
    if (!same(company.name, name) && await exists(newDir)) {
      throw new CompanyError('NAME_TAKEN',
        `The attachment store already has a folder called ${folderName(name)}. Move it aside or choose another name.`)
    }
    await fs.rename(oldDir, newDir)
    movedFolder = true
  }
  try {
    await db.transaction(async (tx) => {
      await acting(tx, input.actor)
      const [before] = await tx.execute<{ province: string | null }>(sql`
        SELECT province FROM entity WHERE id = ${input.entityId}::uuid FOR UPDATE`)
      await tx.execute(sql`UPDATE entity SET name = ${name}, province = ${province} WHERE id = ${input.entityId}::uuid`)
      await tx.execute(sql`
        INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
        VALUES (${input.actor}, 'rename_company', 'entity', ${input.entityId},
                ${JSON.stringify({ name: company.name, province: before?.province ?? null })}::jsonb,
                ${JSON.stringify({ name, province })}::jsonb)`)
    })
  } catch (e) {
    if (movedFolder) {
      // Said, not swallowed: a folder that cannot go back leaves every receipt
      // of this company unreadable until somebody moves it by hand.
      try {
        await fs.rename(newDir, oldDir)
      } catch (back) {
        throw new CompanyError('FOLDER_STRANDED',
          `The new name was not saved (${String((e as Error)?.message ?? e).split('\n')[0]}), and the folder of papers `
          + `could not be moved back from "${newDir}" to "${oldDir}" (${String((back as Error)?.message ?? back).split('\n')[0]}). `
          + 'Move it back by hand before opening this company\'s receipts.')
      }
    }
    throw e
  }
  return { name, province, movedFolder }
}

/**
 * Remove a company that was a mistake. Refused the moment anything was put
 * into its books, or the assistant was asked about it — and the sentence says
 * to archive it instead.
 */
export async function deleteCompany(entityId: string, actor: string): Promise<{ code: string; name: string }> {
  const company = await companyById(entityId)
  if (!company) throw new CompanyError('NO_COMPANY', 'There is no such company.')
  if (company.entries !== '0') {
    throw new CompanyError('HAS_BOOKS',
      `${company.name} has ${company.entries} thing${company.entries === '1' ? '' : 's'} in its books `
      + '— accounting, CRM, signing records, or invoice templates — so it cannot be removed. Archive it instead: '
      + 'nothing more can go into it and everything already there stays where it is.')
  }
  if (company.ai_records !== '0') {
    throw new CompanyError('HAS_AI_RECORDS',
      `${company.name} has asked the assistant questions, and those are kept for good, so it cannot be `
      + 'removed. Archive it instead: nothing more can go into it and everything already there stays '
      + 'where it is.')
  }
  return db.transaction(async (tx) => {
    await acting(tx, actor)
    // The audit row goes in FIRST, while the company is still there to name.
    // Written last, a delete that succeeded would leave a trail that mentioned
    // an id and nothing a person could read.
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, context)
      VALUES (${actor}, 'delete_company', 'entity', ${entityId},
              ${JSON.stringify({ code: company.code, name: company.name })}::jsonb,
              ${JSON.stringify({ entries: 0, archivedAt: company.archived_at })}::jsonb)`)
    // The securities register changes only through a door that opens it for
    // its own transaction (0083) — and removing the whole company is one.
    await beforeModuleCompanyDelete(tx, entityId, actor)
    for (const { table, by } of COMPANY_TABLES.first) {
      const reach = REACH[by as keyof typeof REACH]
      if (reach) await tx.execute(reach(table, entityId))
      else await deleteModuleCompanyRows(tx, table, by, entityId)
    }
    for (const table of COMPANY_TABLES.byEntity) {
      await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE entity_id = ${entityId}::uuid`)
    }
    await tx.execute(sql`DELETE FROM entity WHERE id = ${entityId}::uuid`)
    return { code: company.code, name: company.name }
  })
}

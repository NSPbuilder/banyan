import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Tx } from './acting'
import { auditRow } from './audit-row'
import { refuseForLedger } from './access'
import type { UserRecord } from './users'
import { causesOf } from './db-errors'
import { InvoiceBrandingError, normalizeInvoiceContact, parseInvoiceLogo } from './invoice-branding'
import { standardInvoiceSnapshot, type AvailableInvoiceTemplate, type InvoiceTemplate, type InvoiceTemplateAssignment, type InvoiceTemplateSettings, type InvoiceTemplateSnapshot, type TemplateCompanyAccess } from './invoice-template-types'

export class InvoiceTemplateError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'InvoiceTemplateError' }
}
const uuid = (id: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new InvoiceTemplateError('BAD_ID', 'Choose a valid company, customer or template.')
  return id.toLowerCase()
}
const admin = (me: UserRecord) => { if (me.kind !== 'superadmin') throw new InvoiceTemplateError('SUPERADMIN_ONLY', 'Only the superadmin can manage templates and company access.') }
async function activeCompany(tx: Tx, entityId: string, allowArchived = false) {
  const [company] = await tx.execute<{ id: string; name: string; archived_at: string | null }>(sql`SELECT id::text, name, archived_at::text FROM entity WHERE id = ${uuid(entityId)}::uuid FOR SHARE`)
  if (!company) throw new InvoiceTemplateError('NO_COMPANY', 'That company does not exist.')
  if (company.archived_at && !allowArchived) throw new InvoiceTemplateError('ARCHIVED', 'Archived companies are read-only.')
  return company
}
const clean = async (name: string, settings: InvoiceTemplateSettings) => {
  const label = name.trim()
  if (!label || label.length > 100) throw new InvoiceTemplateError('BAD_NAME', 'Enter a template name of up to 100 characters.')
  if (!['standard', 'compact'].includes(settings.layout)) throw new InvoiceTemplateError('BAD_LAYOUT', 'Choose Standard or Compact.')
  if (settings.paymentInstructions.length > 4000 || settings.footer.length > 2000) throw new InvoiceTemplateError('TOO_LONG', 'Payment instructions allow 4,000 characters; the footer allows 2,000.')
  try {
    const contact = normalizeInvoiceContact(settings.contact), logo = await parseInvoiceLogo(settings.logoDataUrl)
    return { name: label, settings: { layout: settings.layout, paymentInstructions: settings.paymentInstructions.trim(), footer: settings.footer.trim(), ...(contact ? {contact} : {}), ...(logo ? {logoDataUrl: settings.logoDataUrl} : {}) } }
  } catch (error) {
    if (error instanceof InvoiceBrandingError) throw new InvoiceTemplateError(error.code, error.message)
    throw error
  }
}
const SELECT_TEMPLATE = sql`SELECT t.id::text, t.entity_id::text, e.name AS owner_name, t.name, t.is_active, t.current_version, v.settings
  FROM invoice_template t JOIN entity e ON e.id = t.entity_id
  JOIN invoice_template_version v ON v.template_id = t.id AND v.version = t.current_version`

export async function allInvoiceTemplates(me: UserRecord) {
  admin(me)
  return db.execute<InvoiceTemplate>(sql`${SELECT_TEMPLATE} ORDER BY t.name, t.id`)
}
export async function templateCompanies(me: UserRecord) {
  admin(me)
  return db.execute<{ id: string; name: string }>(sql`SELECT id::text, name FROM entity WHERE archived_at IS NULL ORDER BY code, name`)
}
export async function templateAccess(me: UserRecord, templateId: string) {
  admin(me)
  return db.execute<TemplateCompanyAccess>(sql`SELECT a.entity_id::text, e.name, a.can_use, a.can_edit FROM invoice_template_access a JOIN entity e ON e.id = a.entity_id WHERE a.template_id = ${uuid(templateId)}::uuid ORDER BY e.name`)
}
export async function invoiceTemplateChoices(entityId: string) {
  const templates = await db.execute<AvailableInvoiceTemplate>(sql`SELECT t.id::text, t.entity_id::text, e.name AS owner_name, t.name, t.is_active, t.current_version, v.settings, a.can_edit
    FROM invoice_template t JOIN entity e ON e.id = t.entity_id
    JOIN invoice_template_version v ON v.template_id = t.id AND v.version = t.current_version
    JOIN invoice_template_access a ON a.template_id = t.id AND a.entity_id = ${uuid(entityId)}::uuid
    WHERE a.can_use AND t.is_active ORDER BY t.name, t.id`)
  const assignments = await db.execute<InvoiceTemplateAssignment>(sql`SELECT x.party_id::text, p.name AS party_name, x.template_id::text, t.name AS template_name
    FROM invoice_template_assignment x JOIN invoice_template t ON t.id = x.template_id
    JOIN invoice_template_access a ON a.template_id = t.id AND a.entity_id = x.entity_id
    LEFT JOIN party p ON p.id = x.party_id WHERE x.entity_id = ${uuid(entityId)}::uuid AND a.can_use AND t.is_active
    ORDER BY p.name NULLS FIRST`)
  return { templates, assignments }
}

export async function createInvoiceTemplate(me: UserRecord, input: { entityId: string; name: string; settings: InvoiceTemplateSettings }) {
  admin(me)
  const value = await clean(input.name, input.settings)
  try { return await db.transaction(async tx => {
    await acting(tx, me.email); await activeCompany(tx, input.entityId)
    const [template] = await tx.execute<{ id: string }>(sql`INSERT INTO invoice_template(entity_id, name, created_by) VALUES (${uuid(input.entityId)}::uuid, ${value.name}, ${me.email}) RETURNING id::text`)
    await tx.execute(sql`INSERT INTO invoice_template_version(template_id, version, name, settings, created_by) VALUES (${template.id}::uuid, 1, ${value.name}, ${JSON.stringify(value.settings)}::jsonb, ${me.email})`)
    await tx.execute(sql`INSERT INTO invoice_template_access(template_id, entity_id, can_use, can_edit, updated_by) VALUES (${template.id}::uuid, ${uuid(input.entityId)}::uuid, true, true, ${me.email})`)
    await auditRow(tx, { actor: me.email, action: 'create', table: 'invoice_template', recordId: template.id, after: value, entityId: input.entityId, scope: 'company', targetLabel: value.name })
    return template.id
  }) } catch (e) { if (causesOf(e).includes('invoice_template_entity_id_name_key')) throw new InvoiceTemplateError('DUPLICATE_NAME', 'That company already has a template with this name.'); throw e }
}

export async function reviseInvoiceTemplate(me: UserRecord, input: { templateId: string; version: number; name: string; settings: InvoiceTemplateSettings; isActive: boolean; ledgerId?: string }) {
  if (me.kind !== 'superadmin') {
    if (!input.ledgerId || await refuseForLedger(me, input.ledgerId, '/invoices')) throw new InvoiceTemplateError('NO_ACCESS', 'You cannot edit templates in that company.')
  }
  const value = await clean(input.name, input.settings)
  try { return await db.transaction(async tx => {
    await acting(tx, me.email)
    const [old] = await tx.execute<InvoiceTemplate>(sql`${SELECT_TEMPLATE} WHERE t.id = ${uuid(input.templateId)}::uuid FOR UPDATE OF t`)
    if (!old) throw new InvoiceTemplateError('NO_TEMPLATE', 'That template does not exist.')
    if (old.current_version !== input.version) throw new InvoiceTemplateError('CONFLICT', 'This template changed. Reload it before saving.')
    await activeCompany(tx, old.entity_id, me.kind === 'superadmin' && !input.isActive)
    if (me.kind !== 'superadmin') {
      const [grant] = await tx.execute<{ ok: boolean; entity_id: string }>(sql`SELECT a.can_edit AS ok, a.entity_id::text FROM invoice_template_access a JOIN ledger l ON l.entity_id = a.entity_id WHERE a.template_id = ${old.id}::uuid AND l.id = ${uuid(input.ledgerId!)}::uuid AND a.can_use FOR SHARE OF a`)
      if (grant) await activeCompany(tx, grant.entity_id)
      if (!grant?.ok || !old.is_active || input.isActive !== old.is_active) throw new InvoiceTemplateError('NO_EDIT', 'This company has no permission to edit this template.')
    }
    const next = old.current_version + 1
    await tx.execute(sql`INSERT INTO invoice_template_version(template_id, version, name, settings, created_by) VALUES (${old.id}::uuid, ${next}, ${value.name}, ${JSON.stringify(value.settings)}::jsonb, ${me.email})`)
    await tx.execute(sql`UPDATE invoice_template SET name = ${value.name}, is_active = ${input.isActive}, current_version = ${next}, updated_at = now() WHERE id = ${old.id}::uuid`)
    if (!input.isActive) await tx.execute(sql`DELETE FROM invoice_template_assignment WHERE template_id = ${old.id}::uuid`)
    await auditRow(tx, { actor: me.email, action: 'revise', table: 'invoice_template', recordId: old.id, before: old, after: { ...value, version: next, isActive: input.isActive }, entityId: old.entity_id, scope: 'company', targetLabel: value.name })
    return next
  }) } catch (e) { if (causesOf(e).includes('invoice_template_entity_id_name_key')) throw new InvoiceTemplateError('DUPLICATE_NAME', 'That company already has a template with this name.'); throw e }
}

export async function setInvoiceTemplateAccess(me: UserRecord, input: { templateId: string; entityId: string; canUse: boolean; canEdit: boolean; revoke?: boolean }) {
  admin(me)
  if (input.canEdit && !input.canUse && !input.revoke) throw new InvoiceTemplateError('EDIT_NEEDS_USE', 'Can edit requires Can use.')
  await db.transaction(async tx => {
    await acting(tx, me.email); await activeCompany(tx, input.entityId, Boolean(input.revoke || !input.canUse))
    const [template] = await tx.execute<{ id: string; name: string }>(sql`SELECT id::text, name FROM invoice_template WHERE id = ${uuid(input.templateId)}::uuid FOR UPDATE`)
    if (!template) throw new InvoiceTemplateError('NO_TEMPLATE', 'That template does not exist.')
    const [before] = await tx.execute(sql`SELECT can_use, can_edit FROM invoice_template_access WHERE template_id = ${template.id}::uuid AND entity_id = ${uuid(input.entityId)}::uuid`)
    if (input.revoke) await tx.execute(sql`DELETE FROM invoice_template_access WHERE template_id = ${template.id}::uuid AND entity_id = ${uuid(input.entityId)}::uuid`)
    else await tx.execute(sql`INSERT INTO invoice_template_access(template_id, entity_id, can_use, can_edit, updated_by) VALUES (${template.id}::uuid, ${uuid(input.entityId)}::uuid, ${input.canUse}, ${input.canEdit}, ${me.email})
      ON CONFLICT(template_id, entity_id) DO UPDATE SET can_use = EXCLUDED.can_use, can_edit = EXCLUDED.can_edit, updated_by = EXCLUDED.updated_by, updated_at = now()`)
    if (input.revoke || !input.canUse) await tx.execute(sql`DELETE FROM invoice_template_assignment WHERE template_id = ${template.id}::uuid AND entity_id = ${uuid(input.entityId)}::uuid`)
    await auditRow(tx, { actor: me.email, action: input.revoke ? 'revoke' : 'grant', table: 'invoice_template_access', recordId: template.id, before, after: input.revoke ? null : { canUse: input.canUse, canEdit: input.canEdit }, entityId: input.entityId, scope: 'company', targetLabel: template.name })
  })
}

/** Explicit selection refuses; automatic selection falls back through customer/company/system. */
export async function resolveInvoiceTemplate(tx: Tx, entityId: string, partyId: string | null, selection = 'auto'): Promise<InvoiceTemplateSnapshot> {
  if (selection === 'system') return standardInvoiceSnapshot()
  let templateId = selection
  if (selection === 'auto') {
    const [choice] = await tx.execute<{ id: string }>(sql`SELECT x.template_id::text AS id FROM invoice_template_assignment x JOIN invoice_template t ON t.id = x.template_id
      JOIN invoice_template_access a ON a.template_id = t.id AND a.entity_id = x.entity_id
      WHERE x.entity_id = ${uuid(entityId)}::uuid AND (x.party_id IS NULL OR x.party_id = ${partyId ? uuid(partyId) : null}::uuid) AND a.can_use AND t.is_active
      ORDER BY (x.party_id IS NOT NULL) DESC LIMIT 1`)
    if (!choice) return standardInvoiceSnapshot()
    templateId = choice.id
  }
  const [template] = await tx.execute<InvoiceTemplate>(sql`${SELECT_TEMPLATE} WHERE t.id = ${uuid(templateId)}::uuid AND t.is_active FOR SHARE OF t`)
  const [grant] = await tx.execute<{ can_use: boolean }>(sql`SELECT can_use FROM invoice_template_access WHERE template_id = ${uuid(templateId)}::uuid AND entity_id = ${uuid(entityId)}::uuid FOR SHARE`)
  if (!template || !grant?.can_use) throw new InvoiceTemplateError('NOT_GRANTED', 'This template is not available to this company. Choose another template.')
  return { templateId: template.id, name: template.name, version: template.current_version, settings: template.settings }
}

export async function setInvoiceTemplateAssignment(me: UserRecord, input: { ledgerId: string; partyId?: string; templateId?: string }) {
  if (await refuseForLedger(me, input.ledgerId, '/invoices')) throw new InvoiceTemplateError('NO_ACCESS', 'You cannot manage invoice templates in that company.')
  await db.transaction(async tx => {
    await acting(tx, me.email)
    const [ledger] = await tx.execute<{ entity_id: string }>(sql`SELECT entity_id::text FROM ledger WHERE id = ${uuid(input.ledgerId)}::uuid`)
    if (!ledger) throw new InvoiceTemplateError('NO_COMPANY', 'That company does not exist.')
    await activeCompany(tx, ledger.entity_id)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('invoice_templates:' || ${ledger.entity_id}, 0))`)
    const partyId = input.partyId ? uuid(input.partyId) : null
    if (partyId) {
      const [party] = await tx.execute(sql`SELECT 1 FROM party_role WHERE party_id = ${partyId}::uuid AND entity_id = ${ledger.entity_id}::uuid AND role = 'customer' LIMIT 1`)
      if (!party) throw new InvoiceTemplateError('NO_CUSTOMER', 'Choose a customer of this company.')
    }
    if (input.templateId) await resolveInvoiceTemplate(tx, ledger.entity_id, partyId ?? ledger.entity_id, uuid(input.templateId))
    const [before] = await tx.execute(sql`SELECT id::text, template_id::text FROM invoice_template_assignment WHERE entity_id = ${ledger.entity_id}::uuid AND party_id IS NOT DISTINCT FROM ${partyId}::uuid`)
    await tx.execute(sql`DELETE FROM invoice_template_assignment WHERE entity_id = ${ledger.entity_id}::uuid AND party_id IS NOT DISTINCT FROM ${partyId}::uuid`)
    let recordId = before?.id as string | undefined
    if (input.templateId) {
      const [after] = await tx.execute<{ id: string }>(sql`INSERT INTO invoice_template_assignment(entity_id, party_id, template_id, updated_by) VALUES (${ledger.entity_id}::uuid, ${partyId}::uuid, ${uuid(input.templateId)}::uuid, ${me.email}) RETURNING id::text`)
      recordId = after.id
    }
    if (recordId) await auditRow(tx, { actor: me.email, action: 'assign', table: 'invoice_template_assignment', recordId, before, after: input.templateId ? { templateId: input.templateId, partyId } : null, entityId: ledger.entity_id, ledgerId: input.ledgerId, scope: 'company' })
  })
}

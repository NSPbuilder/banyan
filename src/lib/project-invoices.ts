import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs, type Runner } from './acting'
import { auditRow } from './audit-row'
import { refuseForLedger } from './access'
import type { UserRecord } from './users'
import { openProject, projectHead, projectId, projectDate, ProjectError } from './project'
import { createInvoice, InvoiceError, type InvoiceLineInput } from './invoices'
import { ensureProjectAccountsCore, projectCategoryAccounts,projectTaxAccounts,resolveProjectTaxAccounts } from './project-accounts'
import type { TaxCode } from './tax-rates'

export type ProjectInvoiceLink = {
  record_id: string; invoice_id: string; ledger_id: string; number: string | null
  status: 'draft' | 'posted' | 'void'; source_version: number
}
type RevenueSource = {
  id: string; party_id: string; record_date: string; due_date: string | null
  reference: string | null; description: string; version: number
}
export type ProjectInvoiceLine = { description: string; base: string; gst: string; pst: string;taxCode?:TaxCode|null }
type AccountChoice = { id: string; label: string }
type MappingAccount = { id: string; code: string; name: string; account_type: string; roles: string[] }

/** Both seats are required. An array passed to the normal gate means ANY seat. */
export async function requireProjectInvoiceAccess(me: UserRecord, ledgerId: string) {
  projectId(ledgerId)
  const results = await Promise.all(['/projects', '/invoices'].map(module => refuseForLedger(me, ledgerId, module)))
  if (results.some(Boolean)) throw new ProjectError('NO_ACCESS', 'Project and Invoices access are both required for this company.')
}

export async function projectInvoiceLinks(entityId: string, project: string, on: Runner = db) {
  return on.execute<ProjectInvoiceLink>(sql`
    SELECT h.record_id::text, h.invoice_id::text, i.ledger_id::text, i.number, i.status, h.source_version
    FROM project_invoice_handoff h JOIN invoice i ON i.id=h.invoice_id
    WHERE h.entity_id=${entityId}::uuid AND h.project_id=${project}::uuid`)
}

export async function projectInvoiceOrigin(entityId: string, invoiceId: string) {
  const [origin] = await db.execute<{ project_id: string; record_id: string; code: string; source_version: number; version: number; state: string; deleted: boolean }>(sql`
    SELECT h.project_id::text,h.record_id::text,p.code,h.source_version,r.version,r.state,(p.deleted_at IS NOT NULL) AS deleted
    FROM project_invoice_handoff h JOIN project p ON p.id=h.project_id JOIN project_record r ON r.id=h.record_id
    WHERE h.entity_id=${entityId}::uuid AND h.invoice_id=${invoiceId}::uuid`)
  return origin || null
}

async function revenueSource(entityId: string, project: string, record: string, on: Runner) {
  projectId(record)
  const [source] = await on.execute<RevenueSource>(sql`
    SELECT id::text, party_id::text, record_date::text, due_date::text, reference, description, version
    FROM project_record WHERE id=${record}::uuid AND project_id=${project}::uuid
      AND entity_id=${entityId}::uuid AND kind='revenue' AND state='active'`)
  if (!source) throw new ProjectError('NO_REVENUE', 'That active revenue record is not in this project.')
  const lines = await on.execute<ProjectInvoiceLine>(sql`
    SELECT description, base_cents::text AS base, gst_cents::text AS gst, pst_cents::text AS pst,tax_code AS "taxCode"
    FROM project_record_line WHERE record_id=${record}::uuid ORDER BY position`)
  return { source, lines }
}

async function mappingAccounts(entityId: string, on: Runner = db) {
  return on.execute<MappingAccount>(sql`
    SELECT a.id::text, a.code, a.name, a.account_type::text,
      ARRAY(SELECT role FROM account_role ar WHERE ar.account_id=a.id ORDER BY role) AS roles
    FROM account a WHERE a.entity_id=${entityId}::uuid AND a.is_active AND a.is_postable ORDER BY a.code`)
}
const choices = (accounts: MappingAccount[], role: string): AccountChoice[] => accounts
  .filter(a => a.roles.includes(role)).map(a => ({ id: a.id, label: `${a.code} — ${a.name}` }))

async function nextNumber(entityId: string, code: string, on: Runner) {
  const rows = await on.execute<{ number: string }>(sql`
    SELECT number FROM invoice WHERE entity_id=${entityId}::uuid AND direction='sales'
      AND document_kind='invoice' AND (number=${code} OR starts_with(number,${code+'-'}))`)
  const used = new Set(rows.map(r => r.number))
  if (!used.has(code)) return code
  for (let n = 2; n <= 100000; n++) {
    const number = `${code}-${String(n).padStart(2, '0')}`
    if (!used.has(number)) return number
  }
  throw new ProjectError('NUMBER', 'This project has exhausted its invoice number sequence.')
}

export async function projectInvoiceReview(entityId: string, project: string, record: string) {
  const head = await projectHead(entityId, project)
  const [{ source, lines }, accounts, links, mapped,taxAccounts] = await Promise.all([
    revenueSource(entityId, project, record, db), mappingAccounts(entityId), projectInvoiceLinks(entityId, project),projectCategoryAccounts(entityId),projectTaxAccounts(entityId),
  ])
  const [role] = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS(SELECT 1 FROM party_role WHERE party_id=${source.party_id}::uuid AND entity_id=${entityId}::uuid
      AND role='customer' AND (held_to IS NULL OR held_to>=${source.record_date}::date)) AS present`)
  const [managed]=await db.execute<ProjectInvoiceLink>(sql`SELECT h.record_id::text,h.invoice_id::text,i.ledger_id::text,i.number,i.status,r.version AS source_version
    FROM project_accounting_link h JOIN invoice i ON i.id=h.invoice_id JOIN project_record r ON r.id=h.record_id
    WHERE h.record_id=${record}::uuid AND h.entity_id=${entityId}::uuid AND h.project_id=${project}::uuid AND h.state='active'`)
  return { head, source, lines, link: managed||links.find(l => l.record_id === record),
    number: await nextNumber(entityId, head.code, db), customerAtSourceDate: role.present,taxAccounts,
    accounts: { receivable: choices(accounts, 'trade_receivables'), revenue: mapped.revenue?[mapped.revenue]:[],
      gst: choices(accounts, 'gst_hst_payable'), pst: choices(accounts, 'qst_pst_payable') } }
}
export type ProjectInvoiceReview = Awaited<ReturnType<typeof projectInvoiceReview>>

/** Draft and source link commit together. Ordinary Project mutations never call this. */
export async function generateProjectInvoice(me: UserRecord, input: {
  ledgerId: string; projectId: string; recordId: string; version: number
  issuedOn: string; dueOn: string; controlAccountId: string; revenueAccountIds?: string[]
  gstAccountId?: string; pstAccountId?: string; template?: string
}) {
  await requireProjectInvoiceAccess(me, input.ledgerId)
  projectId(input.projectId); projectId(input.recordId)
  return actingAs(me.email, async tx => {
    const [ledger] = await tx.execute<{ entity_id: string; currency: string }>(sql`
      SELECT entity_id::text, currency FROM ledger WHERE id=${input.ledgerId}::uuid`)
    if (!ledger) throw new ProjectError('NO_COMPANY', 'Those books do not exist.')
    const project = await openProject(tx, ledger.entity_id, input.projectId)
    // Project lock serializes edits, cancellation and simultaneous handoffs.
    const [existing] = await tx.execute<ProjectInvoiceLink>(sql`
      SELECT h.record_id::text,h.invoice_id::text,i.ledger_id::text,i.number,i.status,h.source_version
      FROM project_invoice_handoff h JOIN invoice i ON i.id=h.invoice_id
      WHERE h.record_id=${input.recordId}::uuid AND h.entity_id=${ledger.entity_id}::uuid
        AND h.project_id=${project.id}::uuid FOR SHARE OF i`)
    if (existing) return existing
    const [managed]=await tx.execute<ProjectInvoiceLink>(sql`SELECT h.record_id::text,h.invoice_id::text,i.ledger_id::text,i.number,i.status,r.version AS source_version
      FROM project_accounting_link h JOIN invoice i ON i.id=h.invoice_id JOIN project_record r ON r.id=h.record_id
      WHERE h.record_id=${input.recordId}::uuid AND h.entity_id=${ledger.entity_id}::uuid AND h.project_id=${project.id}::uuid AND h.state='active'`)
    if(managed)return managed
    if (project.currency !== ledger.currency) throw new ProjectError('CURRENCY', 'Project and accounting book currencies must match.')
    const { source, lines } = await revenueSource(ledger.entity_id, project.id, input.recordId, tx)
    if (!Number.isSafeInteger(input.version) || source.version !== input.version)
      throw new ProjectError('STALE', 'The revenue record changed. Reload it before generating an invoice.')
    projectDate(input.issuedOn); projectDate(input.dueOn)
    if (input.dueOn < input.issuedOn) throw new ProjectError('DUE_DATE', 'Due date cannot precede the invoice date.')
    const [party] = await tx.execute<{ active: boolean; customer: boolean }>(sql`
      SELECT p.is_active AS active, EXISTS(SELECT 1 FROM party_role r WHERE r.party_id=p.id
        AND r.entity_id=${ledger.entity_id}::uuid AND r.role='customer'
        AND (r.held_to IS NULL OR r.held_to>=${input.issuedOn}::date)) AS customer
      FROM party p WHERE p.id=${source.party_id}::uuid FOR SHARE OF p`)
    if (!party?.active || !party.customer) throw new ProjectError('CUSTOMER_ROLE', 'This Party needs an active customer role for this company on the invoice date. Update the role in Parties, or choose a date covered by its customer role.')
    await ensureProjectAccountsCore(tx,ledger.entity_id,me.email)
    const mapped=await projectCategoryAccounts(ledger.entity_id,tx)
    const tax=resolveProjectTaxAccounts(await projectTaxAccounts(ledger.entity_id,tx),'revenue',lines)
    const accounts = await mappingAccounts(ledger.entity_id, tx)
    const control = accounts.find(a => a.id === input.controlAccountId && a.roles.includes('trade_receivables'))
    if (!control) throw new ProjectError('RECEIVABLE', 'Choose an active trade receivables account for this company.')
    const invoiceLines: InvoiceLineInput[] = []
    // A tax-only source row has no nonzero revenue line to hold its editable
    // source metadata. Keep all accounting lines explicit in that case.
    const plainLines = lines.some(l => BigInt(l.base) === 0n && BigInt(l.gst) + BigInt(l.pst) > 0n)
    const gst = lines.reduce((total, l) => total + BigInt(l.gst), 0n)
    const pst = lines.reduce((total, l) => total + BigInt(l.pst), 0n)
    for (const line of lines) {
      const account = accounts.find(a => a.id === mapped.revenue?.id && a.account_type === 'revenue')
      if (!account) throw new ProjectError('REVENUE_ACCOUNT', 'Review the company’s Project revenue account before creating this invoice.')
      if (BigInt(line.base) !== 0n) invoiceLines.push({ accountId: account.id, amount: -BigInt(line.base),
        description: line.description || source.description, ...(!plainLines ? {
          inputAmount: BigInt(line.base), inputInclusive: false,
          gstOverride: BigInt(line.gst), pstOverride: BigInt(line.pst),
          taxCode: BigInt(line.gst) > 0n ? (BigInt(line.pst) > 0n ? 'GST_PST' : 'GST')
            : BigInt(line.pst) > 0n ? 'PST' : 'OUT_OF_SCOPE',
        } : {}) })
    }
    for (const [value, id, role, label, tag] of [
      [gst, tax.gstAccountId, 'gst_hst_payable', 'GST/HST', 'GST'],
      [pst, tax.pstAccountId, 'qst_pst_payable', 'PST/QST', 'PST'],
    ] as const) {
      if (value === 0n) continue
      const account = accounts.find(a => a.id === id && a.roles.includes(role))
      if (!account) throw new ProjectError('TAX_ACCOUNT', `Choose an active ${label} payable account for this company.`)
      invoiceLines.push({ accountId: account.id, amount: -value, description: label,
        ...(!plainLines ? { taxCode: 'OUT_OF_SCOPE', generatedFor: tag } : {}) })
    }
    // Company numbering is shared across all its ledgers. Manual invoice
    // creation does not take this lock; a unique-index race retries a savepoint.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`project-invoice:${ledger.entity_id}`},0))`)
    for (let attempt = 0; attempt < 10; attempt++) {
      const number = await nextNumber(ledger.entity_id, project.code, tx)
      try {
        const invoice = await createInvoice({ ledgerId: input.ledgerId, direction: 'sales', partyId: source.party_id,
          issuedOn: input.issuedOn, dueOn: input.dueOn, number, theirRef: source.reference || undefined,
          controlAccountId: control.id, template: input.template || 'auto', lines: invoiceLines, actor: me.email }, tx)
        const snapshot = { projectCode: project.code, customer: project.customer, date: source.record_date,
          dueDate: source.due_date, reference: source.reference, description: source.description, lines }
        const [handoff] = await tx.execute<{ id: string }>(sql`
          INSERT INTO project_invoice_handoff(entity_id,project_id,record_id,invoice_id,source_version,source_snapshot,created_by)
          VALUES(${ledger.entity_id}::uuid,${project.id}::uuid,${source.id}::uuid,${invoice.id}::uuid,
            ${source.version},${JSON.stringify(snapshot)}::jsonb,${me.email}) RETURNING id::text`)
        await auditRow(tx, { actor: me.email, action: 'generate_invoice', table: 'project_invoice_handoff', recordId: handoff.id,
          entityId: ledger.entity_id, ledgerId: input.ledgerId, scope: 'company', targetLabel: number,
          after: { projectId: project.id, recordId: source.id, sourceVersion: source.version, invoiceId: invoice.id, number } })
        return { record_id: source.id, invoice_id: invoice.id, ledger_id: invoice.ledger_id, number,
          status: invoice.status, source_version: source.version } satisfies ProjectInvoiceLink
      } catch (error) {
        if (error instanceof InvoiceError && error.code === 'DUPLICATE_NUMBER') continue
        throw error
      }
    }
    throw new ProjectError('NUMBER_BUSY', 'Invoice numbering changed repeatedly. Try generating this draft again.')
  })
}

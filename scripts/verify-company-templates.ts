/** Isolated database required. Exercises company switches and invoice template permission/version boundaries. */
import './env'
import assert from 'node:assert/strict'
import { sql as q } from 'drizzle-orm'
import { db, sql } from '../src/db/client'
import { createFirstOwner, createUser } from '../src/lib/users'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { deleteCompany } from '../src/lib/companies'
import { MODULE_PATHS } from '../src/lib/nav'
import { accessFor, refuseFor, refuseForLedger, setGrants, seatsForEntity } from '../src/lib/access'
import { companyModulePolicies, setCompanyModules } from '../src/lib/company-modules'
import { DEFAULT_COMPANY_MODULES } from '../src/lib/company-module-defaults'
import { allInvoiceTemplates, createInvoiceTemplate, invoiceTemplateChoices, reviseInvoiceTemplate, setInvoiceTemplateAccess, setInvoiceTemplateAssignment } from '../src/lib/invoice-templates'
import { createInvoice, invoiceDetail, postInvoice } from '../src/lib/invoices'
import { renderInvoiceDocument } from '../src/lib/customer-docs'
import { invoicePdf } from '../src/lib/pdf-reports'
import { pdfText } from './pdf-text'

let count = 0
const check = (value: unknown, label: string) => { assert(value, label); console.log(`PASS ${++count} ${label}`) }
const refuses = async (fn: () => Promise<unknown>, code: string) => {
  try { await fn() } catch (e) { check((e as { code?: string }).code === code, `refused ${code}`); return }
  throw Error(`Expected ${code}`)
}
async function main() {
  const admin = await createFirstOwner({ email: 'admin@templates.test', firstName: 'Admin', password: 'Templates-Test-123!' })
  const owner = await createUser({ email: 'owner@templates.test', firstName: 'Owner', password: 'Templates-Test-123!', kind: 'owner', actor: admin.email })
  const user = await createUser({ email: 'user@templates.test', firstName: 'User', password: 'Templates-Test-123!', actor: admin.email })
  const a = await createCompany({ code: 'TPLA', name: 'Template A Ltd.' }, admin.email)
  const b = await createCompany({ code: 'TPLB', name: 'Template B Ltd.' }, admin.email)
  await createFiscalYear(a.ledger.id, '2026-12-31', admin.email)
  await createFiscalYear(b.ledger.id, '2026-12-31', admin.email)
  const chart = '1200,Receivables,asset,,trade_receivables\n2000,Payables,liability,,trade_payables\n4000,Revenue,revenue,,revenue_from_contracts\n5000,Expense,expense,,other_operating_expenses'
  const accounts = await importAccounts(a.company.id, parseAccountsCsv(chart).map(r => ({ ...r, entityId: a.company.id })), admin.email)
  const acct = (code: string) => accounts.find(r => r.code === code)!.id
  const party = await createParty({ kind: 'organisation', name: 'Shared customer', roles: [a,b].map(c => ({ entityId: c.company.id, role: 'customer' as const, heldFrom: '2026-01-01' })), actor: admin.email })
  await setGrants({ userId: user.id, entityIds: [a.company.id], modules: ['/invoices', '/entries'], actor: admin.email })
  check((await refuseForLedger(owner, a.ledger.id, '/invoices')) === null, 'existing company starts with every module enabled')
  await refuses(() => setCompanyModules(owner, { entityId: a.company.id, modules: [] }), 'SUPERADMIN_ONLY')
  await refuses(() => setCompanyModules(user, { entityId: a.company.id, modules: [] }), 'SUPERADMIN_ONLY')
  await refuses(() => setCompanyModules(admin, { entityId: a.company.id, modules: ['/invented'] }), 'NO_SUCH_MODULE')
  const withoutInvoices = MODULE_PATHS.filter(m => m !== '/invoices')
  await setCompanyModules(admin, { entityId: a.company.id, modules: withoutInvoices, expectedModules: DEFAULT_COMPANY_MODULES })
  for (const who of [admin, owner, user]) {
    check((await refuseForLedger(who, a.ledger.id, '/invoices'))?.code === 'NO_MODULE', `${who.kind} form body cannot bypass company switch`)
    check((await refuseFor(who, `/ledger/${a.ledger.id}/invoices/new`))?.code === 'NO_MODULE', `${who.kind} direct URL cannot bypass company switch`)
    check(!seatsForEntity(await accessFor(who), a.company.id, MODULE_PATHS).includes('/invoices'), `${who.kind} company rail follows switch`)
  }
  check((await refuseFor(owner, '/settings/company-access')) === null, 'global administrative route remains outside company modules')
  check((await refuseForLedger(admin, b.ledger.id, '/invoices')) === null, 'switch affects only its company')
  await refuses(() => setCompanyModules(admin, { entityId: a.company.id, modules: MODULE_PATHS, expectedModules: MODULE_PATHS }), 'CONFLICT')
  await setCompanyModules(admin, { entityId: a.company.id, modules: [], expectedModules: withoutInvoices })
  check((await companyModulePolicies())[a.company.id].length === 0, 'all modules can be disabled without deleting the company')
  await setCompanyModules(admin, { entityId: a.company.id, modules: MODULE_PATHS, expectedModules: [] })
  check((await refuseForLedger(user, a.ledger.id, '/invoices')) === null, 'reenabling restores saved user grant')
  check((await refuseForLedger(user, a.ledger.id, '/payroll'))?.code === 'NO_MODULE', 'company enablement does not grant extra user seats')
  check((await refuseForLedger(user, b.ledger.id, '/invoices'))?.code === 'NO_COMPANY', 'company enablement does not grant another company')
  check((await refuseFor(user, `/ledger/${a.ledger.id}/invented`))?.code === 'NO_MODULE', 'unknown routes fail closed')

  const settings = { layout: 'compact' as const, paymentInstructions: 'Pay by transfer. REF-TEMPLATE-V1', footer: 'Thank you. FOOTER-TEMPLATE-V1' }
  await refuses(() => createInvoiceTemplate(owner, { entityId: a.company.id, name: 'Private', settings }), 'SUPERADMIN_ONLY')
  const privateId = await createInvoiceTemplate(admin, { entityId: a.company.id, name: 'Private compact', settings })
  const standardId = await createInvoiceTemplate(admin, { entityId: a.company.id, name: 'Company standard', settings: { ...settings, layout: 'standard', footer: 'DEFAULT-FOOTER' } })
  check((await invoiceTemplateChoices(a.company.id)).templates.length === 2, 'creating grants owner company use and edit')
  check((await invoiceTemplateChoices(b.company.id)).templates.length === 0, 'templates are private to their owner company initially')
  await refuses(() => allInvoiceTemplates(owner), 'SUPERADMIN_ONLY')
  await refuses(() => setInvoiceTemplateAccess(owner, { templateId: privateId, entityId: b.company.id, canUse: true, canEdit: false }), 'SUPERADMIN_ONLY')
  await refuses(() => setInvoiceTemplateAccess(admin, { templateId: privateId, entityId: b.company.id, canUse: false, canEdit: true }), 'EDIT_NEEDS_USE')
  await setInvoiceTemplateAccess(admin, { templateId: privateId, entityId: b.company.id, canUse: true, canEdit: false })
  check((await invoiceTemplateChoices(b.company.id)).templates[0].can_edit === false, 'use-only company gets no edit permission')
  await refuses(() => reviseInvoiceTemplate(owner, { templateId: privateId, ledgerId: b.ledger.id, version: 1, name: 'Stolen', isActive: true, settings }), 'NO_EDIT')
  await setInvoiceTemplateAssignment(user, { ledgerId: a.ledger.id, templateId: standardId })
  await setInvoiceTemplateAssignment(user, { ledgerId: a.ledger.id, partyId: party.id, templateId: privateId })
  await refuses(() => setInvoiceTemplateAssignment(user, { ledgerId: b.ledger.id, templateId: privateId }), 'NO_ACCESS')
  await refuses(() => setInvoiceTemplateAssignment(admin, { ledgerId: a.ledger.id, templateId: 'system' }), 'BAD_ID')
  check((await invoiceTemplateChoices(b.company.id)).assignments.length === 0, 'same party in another company does not inherit a customer rule')
  const make = (number: string, template?: string) => createInvoice({ ledgerId: a.ledger.id, direction: 'sales', partyId: party.id, controlAccountId: acct('1200'), issuedOn: '2026-10-01', dueOn: '2026-10-31', number, template, lines: [{ accountId: acct('4000'), amount: -123456n, description: 'Service' }], actor: admin.email })
  const first = await make('TPL-001'); await postInvoice(first.id, admin.email)
  let doc = await renderInvoiceDocument(first.id)
  check(doc.template?.templateId === privateId && doc.template.version === 1, 'customer default precedes company default and freezes at posting')
  check(doc.template?.settings.layout === 'compact' && doc.total === 123456n, 'template changes presentation without altering accounting amounts')
  const text = pdfText((await invoicePdf(first.id)).buffer)
  check(text.includes('REF-TEMPLATE-V1') && text.includes('FOOTER-TEMPLATE-V1') && text.includes('1,234.56'), 'actual invoice PDF includes instructions, footer and exact formatted amount')
  await refuses(() => reviseInvoiceTemplate(admin, { templateId: privateId, version: 99, name: 'Conflict', settings, isActive: true }), 'CONFLICT')
  await reviseInvoiceTemplate(user, { templateId: privateId, ledgerId: a.ledger.id, version: 1, name: 'Private compact v2', settings: { ...settings, footer: 'FOOTER-V2' }, isActive: true })
  doc = await renderInvoiceDocument(first.id)
  check(doc.template?.version === 1 && doc.template.settings.footer === settings.footer, 'later revision preserves posted invoice layout')
  const second = await make('TPL-002', privateId); await postInvoice(second.id, admin.email)
  check((await renderInvoiceDocument(second.id)).template?.version === 2, 'new invoice resolves latest authorized version')
  const draft = await make('TPL-DRAFT', privateId)
  await setInvoiceTemplateAccess(admin, { templateId: privateId, entityId: a.company.id, canUse: false, canEdit: false, revoke: true })
  await refuses(() => postInvoice(draft.id, admin.email), 'NOT_GRANTED')
  check((await invoiceDetail(draft.id))!.invoice.status === 'draft', 'revoked explicit template refuses atomically and leaves draft intact')
  await refuses(() => make('TPL-FORGED', privateId), 'NOT_GRANTED')
  check((await renderInvoiceDocument(first.id)).template?.version === 1, 'revocation preserves historical invoice')
  const fallback = await make('TPL-003'); await postInvoice(fallback.id, admin.email)
  check((await renderInvoiceDocument(fallback.id)).template?.templateId === standardId, 'revocation removes invalid customer default and falls back to company default')
  const system = await make('TPL-004', 'system'); await postInvoice(system.id, admin.email)
  check((await renderInvoiceDocument(system.id)).template?.templateId === null, 'explicit system standard overrides customer/company defaults')
  await setInvoiceTemplateAccess(admin, { templateId: privateId, entityId: b.company.id, canUse: true, canEdit: true })
  await db.execute(q`UPDATE entity SET archived_at = now(), archived_by = ${admin.email}, archived_reason = 'Template verification' WHERE id = ${b.company.id}::uuid`)
  await refuses(() => reviseInvoiceTemplate(owner, { templateId: privateId, ledgerId: b.ledger.id, version: 2, name: 'Archived receiver edit', settings, isActive: true }), 'ARCHIVED')
  await setInvoiceTemplateAccess(admin, { templateId: privateId, entityId: b.company.id, canUse: false, canEdit: false, revoke: true })
  check((await invoiceTemplateChoices(b.company.id)).templates.length === 0, 'superadmin can revoke an archived company grant')
  try { await db.execute(q`UPDATE invoice_template_version SET name = 'tampered' WHERE template_id = ${privateId}::uuid AND version = 1`); throw Error('Version mutation allowed') }
  catch(e) { check(String((e as Error).cause ?? e).includes('TEMPLATE_VERSION_IMMUTABLE'), 'database freezes template versions') }
  try { await db.execute(q`UPDATE invoice SET print_template_snapshot = '{}'::jsonb WHERE id = ${first.id}::uuid`); throw Error('Snapshot mutation allowed') }
  catch(e) { check(String((e as Error).cause ?? e).includes('TEMPLATE_SNAPSHOT_FROZEN'), 'database freezes posted invoice snapshot') }
  const trail = await db.execute<{ actor: string }>(q`SELECT actor FROM audit_log WHERE table_name IN ('company_module_access', 'invoice_template', 'invoice_template_access', 'invoice_template_assignment')`)
  const archivedOwner = await createCompany({ code: 'TPLOLD', name: 'Archived template owner' }, admin.email)
  const owned = await createInvoiceTemplate(admin, { entityId: archivedOwner.company.id, name: 'Kept template', settings })
  await refuses(() => deleteCompany(archivedOwner.company.id, admin.email), 'HAS_BOOKS')
  await db.execute(q`UPDATE entity SET archived_at = now(), archived_by = ${admin.email}, archived_reason = 'Test archive' WHERE id = ${archivedOwner.company.id}::uuid`)
  await reviseInvoiceTemplate(admin, { templateId: owned, version: 1, name: 'Kept template', settings, isActive: false })
  check((await allInvoiceTemplates(admin)).find(t => t.id === owned)?.is_active === false, 'superadmin can deactivate an archived owner template')
  const empty = await createCompany({ code: 'TPLEMPTY', name: 'Empty switched company' }, admin.email)
  await setCompanyModules(admin, { entityId: empty.company.id, modules: [] })
  await setInvoiceTemplateAccess(admin, { templateId: standardId, entityId: empty.company.id, canUse: true, canEdit: false })
  await deleteCompany(empty.company.id, admin.email)
  check(!(await invoiceTemplateChoices(empty.company.id)).templates.length, 'deleting an empty recipient removes template grants')
  check(!(await companyModulePolicies())[empty.company.id], 'deleting an empty company removes its module switches')
  check(trail.length > 8 && trail.every(r => [admin.email, user.email].includes(r.actor)), 'access and template changes name the acting person in the audit trail')
  console.log(`Company/template checks passed: ${count}`)
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => sql.end())

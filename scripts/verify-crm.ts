/**
 * Company-scoped relationship work.
 *   npm run db:verify-crm   (resets the TEST database first)
 *
 * This suite is deliberately about boundaries, not screenshots: CRM in one
 * company must not grant finance there or CRM elsewhere; a refused operation
 * must leave neither data nor a success-looking audit row; and the portable
 * company file must bring the relationship graph and its history back intact.
 */
import './env'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { reporter } from './suite'
import { createCompanyWithYear } from '../src/lib/setup'
import { createFirstOwner, createUser } from '../src/lib/users'
import { accessFor, refuseForLedger, setGrantMatrix } from '../src/lib/access'
import { createParty } from '../src/lib/parties'
import { archiveCompany, companyById, unarchiveCompany } from '../src/lib/companies'
import {
  CrmError, convertLead, createAccount, createActivity, createLead, createOpportunity,
  createTask, crmCsv, crmWorkspace, moveOpportunity, reviewHandoff,
} from '../src/lib/crm'
import { exportCompany, restoreCompany } from '../src/lib/backup'

const r = reporter(62)
const { check, fail } = r
const ACTOR = 'owner@example.test'

async function crmRefusal(code: string, work: () => Promise<unknown>) {
  try {
    await work()
    return 'accepted'
  } catch (error) {
    return error instanceof CrmError ? error.code : `other:${String(error).slice(0, 80)}`
  }
}

async function count(table: string, entityId: string) {
  const [row] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM ${raw.raw(table)} WHERE entity_id = ${entityId}::uuid`)
  return Number(row.n)
}

async function main() {
  const owner = await createFirstOwner({
    email: ACTOR, firstName: 'Owner', password: 'a long owner password',
  })
  const sales = await createUser({
    email: 'sales@example.test', firstName: 'Sales', password: 'a long sales password', actor: ACTOR,
  })
  const finance = await createUser({
    email: 'finance@example.test', firstName: 'Finance', password: 'a long finance password', actor: ACTOR,
  })
  const a = await createCompanyWithYear({ code: 'CRMA', name: 'CRM Alpha Ltd.' }, ACTOR)
  const b = await createCompanyWithYear({ code: 'CRMB', name: 'CRM Beta Ltd.' }, ACTOR)
  const A = a.company.id
  const B = b.company.id
  const LA = a.ledger.id
  const LB = b.ledger.id

  const seeded = await db.execute<{ entity_id: string; stages: number }>(raw`
    SELECT p.entity_id::text, count(s.id)::int AS stages
      FROM crm_pipeline p JOIN crm_stage s ON s.pipeline_id = p.id
     WHERE p.entity_id IN (${A}::uuid, ${B}::uuid) AND p.is_default
     GROUP BY p.entity_id ORDER BY p.entity_id`)
  check(seeded.length === 2 && seeded.every((row) => row.stages === 6),
    'CRM1 every company starts with one usable six-stage pipeline',
    seeded.map((row) => `${row.entity_id === A ? 'A' : 'B'}:${row.stages}`).join(', '))

  await setGrantMatrix({
    userId: sales.id, actor: ACTOR,
    grants: [{ entityId: A, module: '/crm' }, { entityId: B, module: '/entries' }],
  })
  await setGrantMatrix({
    userId: finance.id, actor: ACTOR,
    grants: [{ entityId: B, module: '/entries' }],
  })
  const salesAccess = await accessFor(sales)
  const matrix = [
    await refuseForLedger(sales, LA, '/crm'),
    await refuseForLedger(sales, LA, '/entries'),
    await refuseForLedger(sales, LB, '/crm'),
    await refuseForLedger(sales, LB, '/entries'),
  ]
  check(matrix[0] === null && matrix[1]?.code === 'NO_MODULE'
      && matrix[2]?.code === 'NO_MODULE' && matrix[3] === null
      && salesAccess.byEntity?.get(A)?.has('/crm') === true
      && salesAccess.byEntity?.get(B)?.has('/crm') !== true,
    'CRM2 a grant is one module in one company, never a Cartesian product',
    'A/CRM opens; A/Entries and B/CRM refuse; B/Entries opens')

  const customer = await createParty({
    kind: 'organisation', name: 'Maple Customer Ltd.', actor: ACTOR,
    roles: [{ entityId: A, role: 'customer', heldFrom: '2026-01-01' }],
  })
  const account = await createAccount({
    ledgerId: LA, partyId: customer.id, lifecycle: 'active', ownerUserId: sales.id,
    source: 'Existing relationship', actor: ACTOR,
  })
  const lead = await createLead({
    ledgerId: LA, organisationName: 'Fresh Prospect Ltd.', personName: 'Pat Prospect',
    email: 'pat@example.test', ownerUserId: sales.id, source: 'Referral', actor: ACTOR,
  })
  const converted = await convertLead({
    ledgerId: LA, leadId: lead.id, version: 1, actor: ACTOR, actorUserId: owner.id,
  })
  const [conversion] = await db.execute<{
    status: string; roles: string; contacts: string; audits: string
  }>(raw`
    SELECT l.status,
           (SELECT count(*)::text FROM party_role pr WHERE pr.party_id = l.converted_party_id) AS roles,
           (SELECT count(*)::text FROM crm_account_contact c
             WHERE c.account_id = l.converted_account_id) AS contacts,
           (SELECT count(*)::text FROM audit_log x WHERE x.entity_id = ${A}::uuid
             AND x.record_id = l.id::text AND x.action = 'convert_crm_lead') AS audits
      FROM crm_lead l WHERE l.id = ${lead.id}::uuid`)
  check(conversion.status === 'converted' && conversion.roles === '0'
      && conversion.contacts === '1' && conversion.audits === '1'
      && converted.madeParty && converted.madeAccount,
    'CRM3 conversion is atomic: shared Party, company account/contact, no accounting role',
    `status ${conversion.status}; ${conversion.contacts} contact; ${conversion.roles} accounting role(s); ${conversion.audits} audit`)

  const beforeBadOwner = await count('crm_lead', A)
  const badOwner = await crmRefusal('BAD_OWNER', () => createLead({
    ledgerId: LA, organisationName: 'Wrong owner', ownerUserId: finance.id, actor: ACTOR,
  }))
  check(badOwner === 'BAD_OWNER' && await count('crm_lead', A) === beforeBadOwner,
    'CRM4 an assignee must hold CRM in this company, and refusal writes nothing',
    `${badOwner}; ${beforeBadOwner} lead(s) before and after`)

  const betaLead = await createLead({ ledgerId: LB, organisationName: 'Beta-only Lead', actor: ACTOR })
  const auditBeforeCross = await count('audit_log', A)
  const cross = await crmRefusal('NOT_OURS', () => createActivity({
    ledgerId: LA, targetKind: 'lead', targetId: betaLead.id, kind: 'note',
    subject: 'Must not land', actor: ACTOR, actorUserId: owner.id,
  }))
  const alpha = await crmWorkspace(LA)
  check(cross === 'NOT_OURS' && await count('audit_log', A) === auditBeforeCross
      && !alpha.leads.some((row) => row.id === betaLead.id),
    'CRM5 a record from another company is neither accepted nor exposed',
    `${cross}; company A audit stayed at ${auditBeforeCross}`)

  const opportunity = await createOpportunity({
    ledgerId: LA, accountId: converted.account.id, name: 'Annual advisory engagement',
    ownerUserId: sales.id, expectedAmount: 240000n, probabilityBp: 6000,
    expectedCloseOn: '2026-12-15', actor: ACTOR,
  })
  const [createdHistory] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM crm_stage_event WHERE opportunity_id = ${opportunity.id}::uuid`)
  check(createdHistory.n === '1',
    'CRM6 an opportunity begins with append-only stage history',
    `${createdHistory.n} event at creation`)

  const stages = await db.execute<{ id: string; kind: 'open' | 'won' | 'lost'; name: string }>(raw`
    SELECT id::text, kind, name FROM crm_stage WHERE entity_id = ${A}::uuid ORDER BY sort_order`)
  const next = stages.find((stage) => stage.kind === 'open' && stage.name !== 'Qualifying')!
  await moveOpportunity({
    ledgerId: LA, opportunityId: opportunity.id, stageId: next.id, version: 1, actor: ACTOR,
  })
  const eventsBeforeStale = await count('crm_stage_event', A)
  const auditBeforeStale = await count('audit_log', A)
  const stale = await crmRefusal('STALE', () => moveOpportunity({
    ledgerId: LA, opportunityId: opportunity.id, stageId: stages[0].id, version: 1, actor: ACTOR,
  }))
  check(stale === 'STALE' && await count('crm_stage_event', A) === eventsBeforeStale
      && await count('audit_log', A) === auditBeforeStale,
    'CRM7 an old version cannot move the pipeline or leave a success audit',
    `${stale}; ${eventsBeforeStale} event(s), ${auditBeforeStale} audit row(s) unchanged`)

  const won = stages.find((stage) => stage.kind === 'won')!
  await moveOpportunity({
    ledgerId: LA, opportunityId: opportunity.id, stageId: won.id, version: 2,
    reason: 'Customer accepted the proposal', actor: ACTOR,
  })
  const [handoff] = await db.execute<{ id: string; status: string; version: number; audits: string }>(raw`
    SELECT h.id::text, h.status, h.version,
           (SELECT count(*)::text FROM audit_log x WHERE x.record_id = h.id::text
             AND x.action = 'request_crm_finance_handoff') AS audits
      FROM crm_finance_handoff h WHERE h.opportunity_id = ${opportunity.id}::uuid`)
  await reviewHandoff({
    ledgerId: LA, handoffId: handoff.id, version: handoff.version,
    decision: 'accepted', actor: ACTOR,
  })
  const [reviewed] = await db.execute<{ status: string; audits: string; roles: string }>(raw`
    SELECT h.status,
           (SELECT count(*)::text FROM audit_log x WHERE x.record_id = h.id::text
             AND x.action = 'review_crm_finance_handoff') AS audits,
           (SELECT count(*)::text FROM party_role pr
             WHERE pr.id = h.customer_role_id AND pr.role = 'customer'
               AND pr.entity_id = h.entity_id) AS roles
      FROM crm_finance_handoff h WHERE h.id = ${handoff.id}::uuid`)
  check(handoff.status === 'pending' && handoff.audits === '1'
      && reviewed.status === 'accepted' && reviewed.audits === '1' && reviewed.roles === '1',
    'CRM8 Won requests finance work; acceptance creates the accounting role and is audited',
    `pending ${handoff.audits} audit → ${reviewed.status}, ${reviewed.roles} customer role, ${reviewed.audits} audit`)

  const historyChange = await crmRefusal('history', async () => {
    try {
      await db.execute(raw`UPDATE crm_stage_event SET reason = 'rewritten' WHERE opportunity_id = ${opportunity.id}::uuid`)
    } catch (error) {
      if (String(error).includes('CRM_HISTORY_APPEND_ONLY')
          || String((error as { cause?: unknown }).cause).includes('CRM_HISTORY_APPEND_ONLY')) {
        throw new CrmError('history', 'history refused')
      }
      throw error
    }
  })
  check(historyChange === 'history',
    'CRM9 pipeline history cannot be rewritten at the database boundary',
    historyChange)

  await createTask({
    ledgerId: LA, targetKind: 'account', targetId: account.id,
    assignedUserId: sales.id, title: 'Prepare kickoff', actor: ACTOR,
  })
  const books = await companyById(A)
  check(Number(books?.entries ?? 0) >= 5,
    'CRM10 a company with relationship history cannot be deleted as empty',
    `${books?.entries} accounting/CRM record(s)`)

  await archiveCompany(A, 'CRM read-only check', ACTOR)
  const auditBeforeArchived = await count('audit_log', A)
  const archived = await crmRefusal('ARCHIVED', () => createLead({
    ledgerId: LA, organisationName: 'Late lead', actor: ACTOR,
  }))
  check(archived === 'ARCHIVED' && await count('audit_log', A) === auditBeforeArchived,
    'CRM11 an archived company stays readable and refuses new CRM work atomically',
    `${archived}; audit stayed at ${auditBeforeArchived}`)
  await unarchiveCompany(A, ACTOR)

  await createLead({ ledgerId: LA, organisationName: '=2+2', actor: ACTOR })
  const csv = await crmCsv(LA, 'leads')
  check(csv.startsWith('\uFEFF') && csv.includes('"\t=2+2"') && !csv.includes('Beta-only Lead'),
    'CRM12 CSV is company-scoped, UTF-8, and formula-safe',
    'BOM present; a formula-like name is text; company B absent')

  const doc = await exportCompany(A)
  const crmRows = [
    'crm_pipeline', 'crm_stage', 'crm_account', 'crm_lead', 'crm_account_contact',
    'crm_opportunity', 'crm_stage_event', 'crm_activity', 'crm_task', 'crm_finance_handoff',
    'crm_attachment',
  ]
  const restored = await restoreCompany(doc, ACTOR, {
    code: 'CRMR', name: 'CRM Alpha Ltd. (restored)',
  })
  const restoredDoc = await exportCompany(restored.entityId)
  const differing = crmRows.filter((table) => doc.rows[table].length !== restoredDoc.rows[table].length)
  const [localIds] = await db.execute<{ owners: string; assignees: string }>(raw`
    SELECT
      (SELECT count(*)::text FROM crm_account WHERE entity_id = ${restored.entityId}::uuid
        AND owner_user_id IS NOT NULL) AS owners,
      (SELECT count(*)::text FROM crm_task WHERE entity_id = ${restored.entityId}::uuid
        AND assigned_user_id IS NOT NULL) AS assignees`)
  check(differing.length === 0 && (doc.audit?.rows.length ?? 0) > 0
      && localIds.owners === '0' && localIds.assignees === '0'
      && restoredDoc.audit?.rows.some((row) => row.action === 'convert_crm_lead') === true,
    'CRM13 .fig restores the CRM graph and audit, without importing local user assignments',
    `${crmRows.length - differing.length}/${crmRows.length} table counts match; owner ids ${localIds.owners}; task assignees ${localIds.assignees}`)

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (error) => {
  fail('CRM0 suite completed', error instanceof Error ? error.stack ?? error.message : String(error))
  console.log(r.summary())
  await conn.end()
  process.exit(1)
})

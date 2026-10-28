import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Tx } from './acting'
import { auditRow } from './audit-row'
import { causesOf } from './db-errors'
import { csvFile, csvMoney } from './csv'
import { localToday } from './today'

export class CrmError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CrmError'
  }
}

/** The immutable Assistant proposal whose confirmation is executing this write. */
export type CrmAssistantCommand = { inquiryId: string; stepN: number; tool: string }

export type CrmLead = {
  id: string; organisation_name: string | null; person_name: string | null
  email: string | null; phone: string | null; source: string | null
  status: string; owner_user_id: string | null; version: number; created_at: string
}
export type CrmAccount = {
  id: string; party_id: string; name: string; trading_name: string | null
  lifecycle: string; owner_user_id: string | null; source: string | null
  segment: string | null; territory: string | null; rating: string | null
  version: number; opportunity_count: number; last_touch: string | null
}
export type CrmStage = {
  id: string; pipeline_id: string; name: string; sort_order: number
  kind: 'open' | 'won' | 'lost'; default_probability_bp: number
}
export type CrmOpportunity = {
  id: string; account_id: string; account_name: string; pipeline_id: string; stage_id: string
  stage_name: string; stage_kind: 'open' | 'won' | 'lost'; name: string
  owner_user_id: string | null; expected_amount: string | null; currency: string
  expected_close_on: string | null; probability_bp: number | null; version: number
}
export type CrmTask = {
  id: string; title: string; due_at: string | null; priority: string; status: string
  version: number; subject: string; assigned_name: string | null
  target_ref?: string | null; assigned_user_id?: string | null
}
export type CrmActivity = {
  id: string; kind: string; direction: string | null; subject: string; body: string | null
  occurred_at: string; related_to: string; actor_name: string | null
  target_ref?: string | null
}
export type CrmContact = {
  id: string; account_id: string; account_name: string; name: string
  job_title: string | null; decision_role: string | null; work_email: string | null
  work_phone: string | null; consent_status: string; is_primary: boolean; version: number
}
export type CrmHandoff = {
  id: string; opportunity_id: string; opportunity_name: string; account_name: string
  status: string; requested_at: string; requested_by: string; reviewed_at: string | null
  review_reason: string | null; invoice_created: boolean; version: number
  customer_role_ready: boolean
}

export type CrmWorkspace = {
  entity: { id: string; name: string; archived: boolean }
  stats: { pipeline: string; weighted: string; open_opportunities: number; overdue_tasks: number }
  leads: CrmLead[]
  accounts: CrmAccount[]
  contacts: CrmContact[]
  stages: CrmStage[]
  opportunities: CrmOpportunity[]
  tasks: CrmTask[]
  activities: CrmActivity[]
  handoffs: CrmHandoff[]
  users: Array<{ id: string; name: string }>
  partyChoices: Array<{ id: string; name: string }>
}

type Company = { id: string; name: string; archived_at: string | null }

async function companyForLedger(on: typeof db | Tx, ledgerId: string, lock = false): Promise<Company> {
  const [company] = await on.execute<Company>(sql`
    SELECT e.id::text, e.name, e.archived_at::text
      FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid ${lock ? sql`FOR SHARE OF e` : sql``}`)
  if (!company) throw new CrmError('NO_COMPANY', 'That company is not on file.')
  return company
}

function open(company: Company) {
  if (company.archived_at) {
    throw new CrmError('ARCHIVED', `${company.name} is archived. Its CRM history is read-only.`)
  }
}

const clean = (value: string | undefined): string | null => value?.trim() || null
const required = (value: string, what: string): string => {
  const out = value.trim()
  if (!out) throw new CrmError('REQUIRED', `${what} is required.`)
  return out
}
const versionOf = (value: number): number => {
  if (!Number.isInteger(value) || value < 1) throw new CrmError('STALE', 'Reload this page and try again.')
  return value
}

async function assignedCrmUser(tx: Tx, entityId: string, userId?: string): Promise<string | null> {
  const id = clean(userId)
  if (!id) return null
  const [user] = await tx.execute<{ id: string }>(sql`
    SELECT u.id::text FROM app_user u
     WHERE u.id = ${id}::uuid AND u.is_active AND (
       u.is_owner OR EXISTS (
         SELECT 1 FROM user_entity_module_access g
          WHERE g.user_id = u.id AND g.entity_id = ${entityId}::uuid AND g.module = '/crm'
       )
     )`)
  if (!user) throw new CrmError('BAD_OWNER', 'Choose an active person with CRM access to this company.')
  return user.id
}

export async function crmWorkspace(ledgerId: string): Promise<CrmWorkspace> {
  const entity = await companyForLedger(db, ledgerId)
  const entityId = entity.id
  const [stat] = await db.execute<{
    pipeline: string; weighted: string; open_opportunities: number; overdue_tasks: number
  }>(sql`
    SELECT
      COALESCE(sum(o.expected_amount) FILTER (WHERE s.kind = 'open'), 0)::text AS pipeline,
      COALESCE(sum(o.expected_amount * COALESCE(o.probability_bp, s.default_probability_bp) / 10000)
        FILTER (WHERE s.kind = 'open'), 0)::text AS weighted,
      count(*) FILTER (WHERE s.kind = 'open')::int AS open_opportunities,
      (SELECT count(*)::int FROM crm_task t
        WHERE t.entity_id = ${entityId}::uuid AND t.status = 'open' AND t.due_at < now()) AS overdue_tasks
      FROM crm_opportunity o JOIN crm_stage s ON s.id = o.stage_id
     WHERE o.entity_id = ${entityId}::uuid AND o.archived_at IS NULL`)

  const [leads, accounts, contacts, stages, opportunities, tasks, activities, handoffs, users, partyChoices] =
    await Promise.all([
      db.execute<CrmLead>(sql`
        SELECT id::text, organisation_name, person_name, email, phone, source, status,
               owner_user_id::text, version, created_at::text
          FROM crm_lead WHERE entity_id = ${entityId}::uuid
         ORDER BY status IN ('converted','disqualified'), created_at DESC LIMIT 200`),
      db.execute<CrmAccount>(sql`
        SELECT a.id::text, a.party_id::text, p.name, p.trading_name, a.lifecycle,
               a.owner_user_id::text, a.source, a.segment, a.territory, a.rating, a.version,
               (SELECT count(*)::int FROM crm_opportunity o
                 WHERE o.account_id = a.id AND o.archived_at IS NULL) AS opportunity_count,
               (SELECT max(x.occurred_at)::text FROM crm_activity x
                 WHERE x.account_id = a.id OR x.opportunity_id IN
                   (SELECT o.id FROM crm_opportunity o WHERE o.account_id = a.id)) AS last_touch
          FROM crm_account a JOIN party p ON p.id = a.party_id
         WHERE a.entity_id = ${entityId}::uuid AND a.archived_at IS NULL
         ORDER BY p.name LIMIT 300`),
      db.execute<CrmContact>(sql`
        SELECT c.id::text, c.account_id::text, p.name AS account_name, c.name,
               c.job_title, c.decision_role, c.work_email, c.work_phone,
               c.consent_status, c.is_primary, c.version
          FROM crm_account_contact c JOIN crm_account a ON a.id = c.account_id
          JOIN party p ON p.id = a.party_id
         WHERE c.entity_id = ${entityId}::uuid ORDER BY c.is_primary DESC, c.name LIMIT 300`),
      db.execute<CrmStage>(sql`
        SELECT s.id::text, s.pipeline_id::text, s.name, s.sort_order, s.kind,
               s.default_probability_bp
          FROM crm_stage s JOIN crm_pipeline p ON p.id = s.pipeline_id
         WHERE s.entity_id = ${entityId}::uuid AND s.is_active AND p.is_active
         ORDER BY p.is_default DESC, s.sort_order`),
      db.execute<CrmOpportunity>(sql`
        SELECT o.id::text, o.account_id::text, p.name AS account_name,
               o.pipeline_id::text, o.stage_id::text, s.name AS stage_name, s.kind AS stage_kind,
               o.name, o.owner_user_id::text, o.expected_amount::text, o.currency,
               o.expected_close_on::text, o.probability_bp, o.version
          FROM crm_opportunity o JOIN crm_account a ON a.id = o.account_id
          JOIN party p ON p.id = a.party_id JOIN crm_stage s ON s.id = o.stage_id
         WHERE o.entity_id = ${entityId}::uuid AND o.archived_at IS NULL
         ORDER BY s.kind <> 'open', o.expected_close_on NULLS LAST, o.created_at DESC LIMIT 300`),
      db.execute<CrmTask>(sql`
        SELECT t.id::text, t.title, t.due_at::text, t.priority, t.status, t.version,
               t.assigned_user_id::text,
               CASE WHEN t.account_id IS NOT NULL THEN 'account|' || t.account_id::text
                    WHEN t.lead_id IS NOT NULL THEN 'lead|' || t.lead_id::text
                    WHEN t.opportunity_id IS NOT NULL THEN 'opportunity|' || t.opportunity_id::text
                    ELSE NULL END AS target_ref,
               COALESCE(pa.name, pl.organisation_name, pl.person_name, o.name, 'CRM record') AS subject,
               NULLIF(concat_ws(' ', u.first_name, u.last_name), '') AS assigned_name
          FROM crm_task t
          LEFT JOIN crm_account a ON a.id = t.account_id LEFT JOIN party pa ON pa.id = a.party_id
          LEFT JOIN crm_lead pl ON pl.id = t.lead_id LEFT JOIN crm_opportunity o ON o.id = t.opportunity_id
          LEFT JOIN app_user u ON u.id = t.assigned_user_id
         WHERE t.entity_id = ${entityId}::uuid
         ORDER BY t.status <> 'open', t.due_at NULLS LAST, t.created_at DESC LIMIT 300`),
      db.execute<CrmActivity>(sql`
        SELECT x.id::text, x.kind, x.direction, x.subject, x.body, x.occurred_at::text,
               CASE WHEN x.account_id IS NOT NULL THEN 'account|' || x.account_id::text
                    WHEN x.lead_id IS NOT NULL THEN 'lead|' || x.lead_id::text
                    WHEN x.opportunity_id IS NOT NULL THEN 'opportunity|' || x.opportunity_id::text
                    ELSE NULL END AS target_ref,
               COALESCE(pa.name, l.organisation_name, l.person_name, o.name, 'CRM record') AS related_to,
               NULLIF(concat_ws(' ', u.first_name, u.last_name), '') AS actor_name
          FROM crm_activity x
          LEFT JOIN crm_account a ON a.id = x.account_id LEFT JOIN party pa ON pa.id = a.party_id
          LEFT JOIN crm_lead l ON l.id = x.lead_id LEFT JOIN crm_opportunity o ON o.id = x.opportunity_id
          LEFT JOIN app_user u ON u.id = x.actor_user_id
         WHERE x.entity_id = ${entityId}::uuid ORDER BY x.occurred_at DESC LIMIT 200`),
      db.execute<CrmHandoff>(sql`
        SELECT h.id::text, h.opportunity_id::text, o.name AS opportunity_name,
               p.name AS account_name, h.status, h.requested_at::text, h.requested_by,
               h.reviewed_at::text, h.review_reason, (h.invoice_id IS NOT NULL) AS invoice_created,
               (h.customer_role_id IS NOT NULL) AS customer_role_ready,
               h.version
          FROM crm_finance_handoff h JOIN crm_opportunity o ON o.id = h.opportunity_id
          JOIN crm_account a ON a.id = o.account_id JOIN party p ON p.id = a.party_id
         WHERE h.entity_id = ${entityId}::uuid ORDER BY h.status <> 'pending', h.requested_at DESC`),
      db.execute<{ id: string; name: string }>(sql`
        SELECT u.id::text, concat_ws(' ', u.first_name, u.last_name) AS name
          FROM app_user u
         WHERE u.is_active AND (u.is_owner OR EXISTS (
           SELECT 1 FROM user_entity_module_access g
            WHERE g.user_id = u.id AND g.entity_id = ${entityId}::uuid AND g.module = '/crm'))
         ORDER BY u.first_name, u.last_name`),
      db.execute<{ id: string; name: string }>(sql`
        SELECT DISTINCT p.id::text, p.name FROM party p JOIN party_role r ON r.party_id = p.id
         WHERE r.entity_id = ${entityId}::uuid AND p.is_active
           AND NOT EXISTS (SELECT 1 FROM crm_account a
                            WHERE a.entity_id = ${entityId}::uuid AND a.party_id = p.id)
         ORDER BY p.name`),
    ])

  return {
    entity: { id: entity.id, name: entity.name, archived: entity.archived_at !== null },
    stats: stat ?? { pipeline: '0', weighted: '0', open_opportunities: 0, overdue_tasks: 0 },
    leads, accounts, contacts, stages, opportunities, tasks, activities, handoffs, users, partyChoices,
  }
}

async function withCompany<T>(
  ledgerId: string,
  actor: string,
  work: (tx: Tx, company: Company) => Promise<T>,
  assistantCommand?: CrmAssistantCommand,
) {
  return db.transaction(async (tx) => {
    await acting(tx, actor)
    const company = await companyForLedger(tx, ledgerId, true)
    open(company)
    if (assistantCommand) {
      const inserted = await tx.execute<{ inquiry_id: string }>(sql`
        INSERT INTO ai_skill_command_execution
          (inquiry_id, step_n, entity_id, executed_by, tool)
        SELECT q.id, s.n, ${company.id}::uuid, ${actor}, s.tool
          FROM ai_inquiry q
          JOIN ai_inquiry_step s ON s.inquiry_id = q.id
          JOIN ai_inquiry_skill r ON r.inquiry_id = q.id
         WHERE q.id = ${assistantCommand.inquiryId}::uuid
           AND q.ledger_id = ${ledgerId}::uuid
           AND q.asked_by = ${actor}
           AND s.n = ${assistantCommand.stepN}
           AND s.outcome = 'call'
           AND s.tool = ${assistantCommand.tool}
           AND r.skill = 'crm'
        ON CONFLICT DO NOTHING
        RETURNING inquiry_id::text`)
      if (inserted.length !== 1) {
        throw new CrmError('ALREADY', 'That Assistant proposal was already used or is no longer valid.')
      }
    }
    return work(tx, company)
  })
}

export async function createLead(input: {
  ledgerId: string; organisationName?: string; personName?: string; email?: string; phone?: string
  source?: string; ownerUserId?: string; actor: string; assistantCommand?: CrmAssistantCommand
}) {
  const organisation = clean(input.organisationName)
  const person = clean(input.personName)
  if (!organisation && !person) throw new CrmError('NO_NAME', 'Enter an organisation or person name.')
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    const ownerUserId = await assignedCrmUser(tx, company.id, input.ownerUserId)
    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO crm_lead
        (entity_id, organisation_name, person_name, email, phone, source, owner_user_id, created_by, updated_by)
      VALUES (${company.id}::uuid, ${organisation}, ${person}, ${clean(input.email)}, ${clean(input.phone)},
              ${clean(input.source)}, ${ownerUserId}::uuid, ${input.actor}, ${input.actor})
      RETURNING id::text`)
    await auditRow(tx, {
      actor: input.actor, action: 'create_crm_lead', table: 'crm_lead', recordId: row.id,
      entityId: company.id, scope: 'company', targetLabel: organisation ?? person,
      after: { organisationName: organisation, personName: person, email: clean(input.email), source: clean(input.source) },
    })
    return row
  }, input.assistantCommand)
}

export async function createAccount(input: {
  ledgerId: string; partyId: string; lifecycle?: string; ownerUserId?: string
  source?: string; segment?: string; actor: string; assistantCommand?: CrmAssistantCommand
}) {
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    const [party] = await tx.execute<{ id: string; name: string }>(sql`
      SELECT p.id::text, p.name FROM party p
       WHERE p.id = ${input.partyId}::uuid AND p.is_active AND EXISTS (
         SELECT 1 FROM party_role r WHERE r.party_id = p.id AND r.entity_id = ${company.id}::uuid)`)
    if (!party) throw new CrmError('NO_PARTY', 'Choose a Party already related to this company.')
    const ownerUserId = await assignedCrmUser(tx, company.id, input.ownerUserId)
    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO crm_account
        (entity_id, party_id, lifecycle, owner_user_id, source, segment, created_by, updated_by)
      VALUES (${company.id}::uuid, ${party.id}::uuid, ${input.lifecycle ?? 'active'},
              ${ownerUserId}::uuid, ${clean(input.source)}, ${clean(input.segment)},
              ${input.actor}, ${input.actor}) RETURNING id::text`)
    await auditRow(tx, {
      actor: input.actor, action: 'create_crm_account', table: 'crm_account', recordId: row.id,
      entityId: company.id, scope: 'company', targetLabel: party.name,
      after: { partyId: party.id, lifecycle: input.lifecycle ?? 'active', source: clean(input.source) },
    })
    return row
  }, input.assistantCommand)
}

export async function convertLead(input: {
  ledgerId: string; leadId: string; version: number; actor: string; actorUserId: string
}) {
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    const [lead] = await tx.execute<CrmLead>(sql`
      SELECT id::text, organisation_name, person_name, email, phone, source, status,
             owner_user_id::text, version, created_at::text
        FROM crm_lead WHERE id = ${input.leadId}::uuid AND entity_id = ${company.id}::uuid FOR UPDATE`)
    if (!lead) throw new CrmError('NO_LEAD', 'That lead is not in this company.')
    if (lead.status === 'converted') throw new CrmError('CONVERTED', 'That lead has already been converted.')
    if (lead.version !== versionOf(input.version)) throw new CrmError('STALE', 'Someone changed that lead. Reload and try again.')
    const name = required(lead.organisation_name ?? lead.person_name ?? '', 'A Party name')
    let [party] = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id::text, name FROM party
       WHERE is_active AND party_name_key(name) = party_name_key(${name})`)
    let madeParty = false
    if (!party) {
      ;[party] = await tx.execute<{ id: string; name: string }>(sql`
        INSERT INTO party (kind, name, created_by)
        VALUES (${lead.organisation_name ? 'organisation' : 'person'}, ${name}, ${input.actor})
        RETURNING id::text, name`)
      madeParty = true
    }
    let [account] = await tx.execute<{ id: string }>(sql`
      SELECT id::text FROM crm_account WHERE entity_id = ${company.id}::uuid AND party_id = ${party.id}::uuid`)
    let madeAccount = false
    if (!account) {
      ;[account] = await tx.execute<{ id: string }>(sql`
        INSERT INTO crm_account
          (entity_id, party_id, lifecycle, owner_user_id, source, created_by, updated_by)
        VALUES (${company.id}::uuid, ${party.id}::uuid, 'prospect',
                ${lead.owner_user_id ?? input.actorUserId}::uuid, ${lead.source}, ${input.actor}, ${input.actor})
        RETURNING id::text`)
      madeAccount = true
    }
    if ((lead.email || lead.phone) && madeAccount) {
      await tx.execute(sql`
        INSERT INTO crm_account_contact
          (entity_id, account_id, name, work_email, work_phone, is_primary, created_by, updated_by)
        VALUES (${company.id}::uuid, ${account.id}::uuid, ${lead.person_name ?? name},
                ${lead.email}, ${lead.phone}, true, ${input.actor}, ${input.actor})`)
    }
    const changed = await tx.execute(sql`
      UPDATE crm_lead SET status = 'converted', converted_party_id = ${party.id}::uuid,
             converted_account_id = ${account.id}::uuid, version = version + 1,
             updated_at = now(), updated_by = ${input.actor}
       WHERE id = ${lead.id}::uuid AND entity_id = ${company.id}::uuid AND version = ${lead.version}`)
    if (changed.count !== 1) throw new CrmError('STALE', 'Someone changed that lead. Reload and try again.')
    if (madeAccount) await auditRow(tx, {
      actor: input.actor, action: 'create_crm_account', table: 'crm_account', recordId: account.id,
      entityId: company.id, scope: 'company', targetLabel: party.name,
      after: { partyId: party.id, lifecycle: 'prospect', source: lead.source, createdFromLead: lead.id },
    })
    await auditRow(tx, {
      actor: input.actor, action: 'convert_crm_lead', table: 'crm_lead', recordId: lead.id,
      entityId: company.id, scope: 'company', targetLabel: name,
      before: { status: lead.status, version: lead.version },
      after: { status: 'converted', partyId: party.id, accountId: account.id, partyCreated: madeParty },
    })
    return { party, account, madeParty, madeAccount }
  })
}

export async function createContact(input: {
  ledgerId: string; accountId: string; name: string; jobTitle?: string; decisionRole?: string
  email?: string; phone?: string; preferredChannel?: string; consentStatus?: string
  isPrimary?: boolean; actor: string; assistantCommand?: CrmAssistantCommand
}) {
  const name = required(input.name, 'Contact name')
  if (!clean(input.email) && !clean(input.phone)) throw new CrmError('NO_CONTACT', 'Enter an email or phone number.')
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    const [account] = await tx.execute<{ id: string; name: string }>(sql`
      SELECT a.id::text, p.name FROM crm_account a JOIN party p ON p.id = a.party_id
       WHERE a.id = ${input.accountId}::uuid AND a.entity_id = ${company.id}::uuid`)
    if (!account) throw new CrmError('NO_ACCOUNT', 'That account is not in this company.')
    if (input.isPrimary) {
      const previous = await tx.execute<{ id: string; name: string; version: number }>(sql`
        SELECT id::text, name, version FROM crm_account_contact
         WHERE account_id = ${account.id}::uuid AND is_primary FOR UPDATE`)
      await tx.execute(sql`
        UPDATE crm_account_contact SET is_primary = false, version = version + 1,
               updated_at = now(), updated_by = ${input.actor}
         WHERE account_id = ${account.id}::uuid AND is_primary`)
      for (const contact of previous) await auditRow(tx, {
        actor: input.actor, action: 'change_crm_primary_contact', table: 'crm_account_contact',
        recordId: contact.id, entityId: company.id, scope: 'company', targetLabel: contact.name,
        before: { isPrimary: true, version: contact.version },
        after: { isPrimary: false, version: contact.version + 1 },
      })
    }
    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO crm_account_contact
        (entity_id, account_id, name, job_title, decision_role, work_email, work_phone,
         preferred_channel, consent_status, consent_recorded_at, is_primary, created_by, updated_by)
      VALUES (${company.id}::uuid, ${account.id}::uuid, ${name}, ${clean(input.jobTitle)},
              ${clean(input.decisionRole)}, ${clean(input.email)}, ${clean(input.phone)},
              ${clean(input.preferredChannel)}, ${input.consentStatus ?? 'unknown'},
              ${input.consentStatus && input.consentStatus !== 'unknown' ? sql`now()` : sql`NULL`},
              ${!!input.isPrimary}, ${input.actor}, ${input.actor}) RETURNING id::text`)
    await auditRow(tx, {
      actor: input.actor, action: 'create_crm_contact', table: 'crm_account_contact', recordId: row.id,
      entityId: company.id, scope: 'company', targetLabel: name,
      after: { accountId: account.id, name, email: clean(input.email), phone: clean(input.phone) },
    })
    return row
  }, input.assistantCommand)
}

export async function createOpportunity(input: {
  ledgerId: string; accountId: string; name: string; ownerUserId?: string
  expectedAmount?: bigint; currency?: string; expectedCloseOn?: string
  probabilityBp?: number; source?: string; description?: string; actor: string
  assistantCommand?: CrmAssistantCommand
}) {
  const name = required(input.name, 'Opportunity name')
  if (input.expectedAmount !== undefined && input.expectedAmount < 0n) {
    throw new CrmError('BAD_AMOUNT', 'Expected amount cannot be negative.')
  }
  if (input.probabilityBp !== undefined
      && (!Number.isInteger(input.probabilityBp) || input.probabilityBp < 0 || input.probabilityBp > 10000)) {
    throw new CrmError('BAD_PROBABILITY', 'Probability must be from 0 to 100 percent.')
  }
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    const [base] = await tx.execute<{
      account_id: string; account_name: string; pipeline_id: string; stage_id: string
    }>(sql`
      SELECT a.id::text AS account_id, pa.name AS account_name, p.id::text AS pipeline_id,
             s.id::text AS stage_id
        FROM crm_account a JOIN party pa ON pa.id = a.party_id
        JOIN crm_pipeline p ON p.entity_id = a.entity_id AND p.is_default AND p.is_active
        JOIN LATERAL (SELECT id FROM crm_stage WHERE pipeline_id = p.id AND kind = 'open'
                       AND is_active ORDER BY sort_order LIMIT 1) s ON true
       WHERE a.id = ${input.accountId}::uuid AND a.entity_id = ${company.id}::uuid
         AND a.archived_at IS NULL`)
    if (!base) throw new CrmError('NO_ACCOUNT', 'That account is not in this company.')
    const ownerUserId = await assignedCrmUser(tx, company.id, input.ownerUserId)
    const currency = (input.currency ?? 'CAD').trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(currency)) throw new CrmError('BAD_CURRENCY', 'Currency must be a three-letter code.')
    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO crm_opportunity
        (entity_id, account_id, pipeline_id, stage_id, name, owner_user_id, expected_amount,
         currency, expected_close_on, probability_bp, source, description, created_by, updated_by)
      VALUES (${company.id}::uuid, ${base.account_id}::uuid, ${base.pipeline_id}::uuid,
              ${base.stage_id}::uuid, ${name}, ${ownerUserId}::uuid,
              ${input.expectedAmount ?? null}, ${currency}, ${clean(input.expectedCloseOn)}::date,
              ${input.probabilityBp ?? null}, ${clean(input.source)}, ${clean(input.description)},
              ${input.actor}, ${input.actor}) RETURNING id::text`)
    await tx.execute(sql`
      INSERT INTO crm_stage_event (entity_id, opportunity_id, to_stage_id, moved_by, reason)
      VALUES (${company.id}::uuid, ${row.id}::uuid, ${base.stage_id}::uuid, ${input.actor}, 'Created')`)
    await auditRow(tx, {
      actor: input.actor, action: 'create_crm_opportunity', table: 'crm_opportunity', recordId: row.id,
      entityId: company.id, scope: 'company', targetLabel: name,
      after: { accountId: base.account_id, stageId: base.stage_id,
        expectedAmount: input.expectedAmount?.toString() ?? null, currency },
    })
    return row
  }, input.assistantCommand)
}

export async function moveOpportunity(input: {
  ledgerId: string; opportunityId: string; stageId: string; version: number
  reason?: string; actor: string
}) {
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    const [before] = await tx.execute<{
      id: string; name: string; stage_id: string; stage_name: string; stage_kind: string
      pipeline_id: string; version: number
    }>(sql`
      SELECT o.id::text, o.name, o.stage_id::text, s.name AS stage_name, s.kind AS stage_kind,
             o.pipeline_id::text, o.version
        FROM crm_opportunity o JOIN crm_stage s ON s.id = o.stage_id
       WHERE o.id = ${input.opportunityId}::uuid AND o.entity_id = ${company.id}::uuid FOR UPDATE OF o`)
    if (!before) throw new CrmError('NO_OPPORTUNITY', 'That opportunity is not in this company.')
    if (before.version !== versionOf(input.version)) throw new CrmError('STALE', 'Someone moved that opportunity. Reload and try again.')
    const [after] = await tx.execute<{ id: string; name: string; kind: string }>(sql`
      SELECT id::text, name, kind FROM crm_stage
       WHERE id = ${input.stageId}::uuid AND entity_id = ${company.id}::uuid
         AND pipeline_id = ${before.pipeline_id}::uuid AND is_active`)
    if (!after) throw new CrmError('NO_STAGE', 'That stage is not in this pipeline.')
    const reason = clean(input.reason)
    if (before.stage_kind !== 'open' && after.kind === 'open' && !reason) {
      throw new CrmError('NO_REASON', 'Say why this closed opportunity is being reopened.')
    }
    if (after.kind === 'lost' && !reason) throw new CrmError('NO_REASON', 'Say why this opportunity was lost.')
    await tx.execute(sql`
      UPDATE crm_opportunity SET stage_id = ${after.id}::uuid,
             closed_at = ${after.kind === 'open' ? sql`NULL` : sql`now()`},
             lost_reason = ${after.kind === 'lost' ? reason : null}, version = version + 1,
             updated_at = now(), updated_by = ${input.actor}
       WHERE id = ${before.id}::uuid AND version = ${before.version}`)
    await tx.execute(sql`
      INSERT INTO crm_stage_event (entity_id, opportunity_id, from_stage_id, to_stage_id, moved_by, reason)
      VALUES (${company.id}::uuid, ${before.id}::uuid, ${before.stage_id}::uuid,
              ${after.id}::uuid, ${input.actor}, ${reason})`)
    if (after.kind === 'won') {
      const [handoff] = await tx.execute<{ id: string }>(sql`
        INSERT INTO crm_finance_handoff (entity_id, opportunity_id, requested_by)
        VALUES (${company.id}::uuid, ${before.id}::uuid, ${input.actor})
        ON CONFLICT (opportunity_id) DO NOTHING RETURNING id::text`)
      if (handoff) await auditRow(tx, {
        actor: input.actor, action: 'request_crm_finance_handoff', table: 'crm_finance_handoff',
        recordId: handoff.id, entityId: company.id, scope: 'company', targetLabel: before.name,
        after: { opportunityId: before.id, status: 'pending' },
      })
    }
    await auditRow(tx, {
      actor: input.actor, action: 'move_crm_opportunity', table: 'crm_opportunity', recordId: before.id,
      entityId: company.id, scope: 'company', targetLabel: before.name, reason,
      before: { stageId: before.stage_id, stage: before.stage_name, version: before.version },
      after: { stageId: after.id, stage: after.name, version: before.version + 1 },
    })
  })
}

async function targetInCompany(tx: Tx, entityId: string, kind: 'account' | 'lead' | 'opportunity', id: string) {
  const table = { account: 'crm_account', lead: 'crm_lead', opportunity: 'crm_opportunity' }[kind]
  const [row] = await tx.execute<{ id: string }>(sql`
    SELECT id::text FROM ${sql.raw(table)} WHERE id = ${id}::uuid AND entity_id = ${entityId}::uuid`)
  if (!row) throw new CrmError('NOT_OURS', 'That CRM record is not in this company.')
}

const targets = (kind: 'account' | 'lead' | 'opportunity', id: string) => ({
  accountId: kind === 'account' ? id : null,
  leadId: kind === 'lead' ? id : null,
  opportunityId: kind === 'opportunity' ? id : null,
})

export async function createActivity(input: {
  ledgerId: string; targetKind: 'account' | 'lead' | 'opportunity'; targetId: string
  kind: 'note' | 'call' | 'email' | 'meeting'; direction?: string
  subject: string; body?: string; occurredAt?: string; actor: string; actorUserId: string
  assistantCommand?: CrmAssistantCommand
}) {
  const subject = required(input.subject, 'Activity subject')
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    await targetInCompany(tx, company.id, input.targetKind, input.targetId)
    const t = targets(input.targetKind, input.targetId)
    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO crm_activity
        (entity_id, account_id, lead_id, opportunity_id, kind, direction, subject, body,
         occurred_at, actor_user_id, created_by, updated_by)
      VALUES (${company.id}::uuid, ${t.accountId}::uuid, ${t.leadId}::uuid,
              ${t.opportunityId}::uuid, ${input.kind}, ${clean(input.direction)}, ${subject},
              ${clean(input.body)}, COALESCE(${clean(input.occurredAt)}::timestamptz, now()),
              ${input.actorUserId}::uuid, ${input.actor}, ${input.actor}) RETURNING id::text`)
    await auditRow(tx, {
      actor: input.actor, action: 'create_crm_activity', table: 'crm_activity', recordId: row.id,
      entityId: company.id, scope: 'company', targetLabel: subject,
      after: { targetKind: input.targetKind, targetId: input.targetId, kind: input.kind, subject },
    })
    return row
  }, input.assistantCommand)
}

export async function createTask(input: {
  ledgerId: string; targetKind: 'account' | 'lead' | 'opportunity'; targetId: string
  assignedUserId?: string; title: string; dueAt?: string; priority?: string; actor: string
  assistantCommand?: CrmAssistantCommand
}) {
  const title = required(input.title, 'Task title')
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    await targetInCompany(tx, company.id, input.targetKind, input.targetId)
    const assignedUserId = await assignedCrmUser(tx, company.id, input.assignedUserId)
    const t = targets(input.targetKind, input.targetId)
    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO crm_task
        (entity_id, account_id, lead_id, opportunity_id, assigned_user_id, title, due_at,
         priority, created_by, updated_by)
      VALUES (${company.id}::uuid, ${t.accountId}::uuid, ${t.leadId}::uuid,
              ${t.opportunityId}::uuid, ${assignedUserId}::uuid, ${title},
              ${clean(input.dueAt)}::timestamptz, ${input.priority ?? 'normal'}, ${input.actor}, ${input.actor})
      RETURNING id::text`)
    await auditRow(tx, {
      actor: input.actor, action: 'create_crm_task', table: 'crm_task', recordId: row.id,
      entityId: company.id, scope: 'company', targetLabel: title,
      after: { targetKind: input.targetKind, targetId: input.targetId, dueAt: clean(input.dueAt) },
    })
    return row
  }, input.assistantCommand)
}

export async function completeTask(input: {
  ledgerId: string; taskId: string; version: number; actor: string
}) {
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    const [before] = await tx.execute<{ id: string; title: string; status: string; version: number }>(sql`
      SELECT id::text, title, status, version FROM crm_task
       WHERE id = ${input.taskId}::uuid AND entity_id = ${company.id}::uuid FOR UPDATE`)
    if (!before) throw new CrmError('NO_TASK', 'That task is not in this company.')
    if (before.version !== versionOf(input.version)) throw new CrmError('STALE', 'Someone changed that task. Reload and try again.')
    if (before.status !== 'open') throw new CrmError('CLOSED', 'That task is already closed.')
    await tx.execute(sql`
      UPDATE crm_task SET status = 'done', completed_at = now(), completed_by = ${input.actor},
             version = version + 1, updated_at = now(), updated_by = ${input.actor}
       WHERE id = ${before.id}::uuid AND version = ${before.version}`)
    await auditRow(tx, {
      actor: input.actor, action: 'complete_crm_task', table: 'crm_task', recordId: before.id,
      entityId: company.id, scope: 'company', targetLabel: before.title,
      before: { status: before.status, version: before.version },
      after: { status: 'done', version: before.version + 1 },
    })
  })
}

export async function reviewHandoff(input: {
  ledgerId: string; handoffId: string; version: number; decision: 'accepted' | 'rejected'
  reason?: string; invoiceId?: string; actor: string
}) {
  const reason = clean(input.reason)
  const today = localToday()
  if (input.decision === 'rejected' && !reason) throw new CrmError('NO_REASON', 'Say why finance rejected this handoff.')
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    const [before] = await tx.execute<{
      id: string; status: string; version: number; opportunity_id: string; party_id: string; label: string
    }>(sql`
      SELECT h.id::text, h.status, h.version, h.opportunity_id::text, a.party_id::text,
             o.name AS label
        FROM crm_finance_handoff h JOIN crm_opportunity o ON o.id = h.opportunity_id
        JOIN crm_account a ON a.id = o.account_id
       WHERE h.id = ${input.handoffId}::uuid AND h.entity_id = ${company.id}::uuid FOR UPDATE OF h`)
    if (!before) throw new CrmError('NO_HANDOFF', 'That handoff is not in this company.')
    if (before.version !== versionOf(input.version)) throw new CrmError('STALE', 'Someone reviewed that handoff. Reload and try again.')
    if (before.status !== 'pending') throw new CrmError('REVIEWED', 'That handoff has already been reviewed.')
    if (clean(input.invoiceId)) {
      const [invoice] = await tx.execute<{ id: string }>(sql`
        SELECT id::text FROM invoice WHERE id = ${input.invoiceId!}::uuid
         AND entity_id = ${company.id}::uuid AND direction = 'sales'
         AND party_id = ${before.party_id}::uuid`)
      if (!invoice) throw new CrmError('BAD_INVOICE', 'Choose a sales invoice for this same account.')
    }
    let customerRoleId: string | null = null
    if (input.decision === 'accepted') {
      const [current] = await tx.execute<{ id: string }>(sql`
        SELECT id::text FROM party_role
         WHERE party_id = ${before.party_id}::uuid AND entity_id = ${company.id}::uuid
           AND role = 'customer'
           AND (held_to IS NULL OR held_to >= ${today}::date)
         ORDER BY held_from DESC LIMIT 1 FOR UPDATE`)
      if (current) customerRoleId = current.id
      else {
        const [made] = await tx.execute<{ id: string }>(sql`
          INSERT INTO party_role (party_id, entity_id, role, created_by)
          VALUES (${before.party_id}::uuid, ${company.id}::uuid, 'customer', ${input.actor})
          RETURNING id::text`)
        customerRoleId = made.id
      }
    }
    await tx.execute(sql`
      UPDATE crm_finance_handoff SET status = ${input.decision}, reviewed_at = now(),
             reviewed_by = ${input.actor}, review_reason = ${reason},
             customer_role_id = ${customerRoleId}::uuid,
             invoice_id = ${clean(input.invoiceId)}::uuid, version = version + 1
       WHERE id = ${before.id}::uuid AND version = ${before.version}`)
    await auditRow(tx, {
      actor: input.actor, action: 'review_crm_finance_handoff', table: 'crm_finance_handoff',
      recordId: before.id, entityId: company.id, scope: 'company', targetLabel: before.label,
      reason, before: { status: before.status, version: before.version },
      after: { status: input.decision, customerRoleId,
        invoiceId: clean(input.invoiceId), version: before.version + 1 },
    })
  })
}

export async function linkHandoffInvoice(input: {
  ledgerId: string; handoffId: string; version: number; invoiceId: string; actor: string
}) {
  return withCompany(input.ledgerId, input.actor, async (tx, company) => {
    const [before] = await tx.execute<{
      id: string; status: string; version: number; party_id: string; label: string; invoice_id: string | null
    }>(sql`
      SELECT h.id::text, h.status, h.version, a.party_id::text, o.name AS label, h.invoice_id::text
        FROM crm_finance_handoff h JOIN crm_opportunity o ON o.id = h.opportunity_id
        JOIN crm_account a ON a.id = o.account_id
       WHERE h.id = ${input.handoffId}::uuid AND h.entity_id = ${company.id}::uuid FOR UPDATE OF h`)
    if (!before) throw new CrmError('NO_HANDOFF', 'That handoff is not in this company.')
    if (before.version !== versionOf(input.version)) throw new CrmError('STALE', 'Someone changed that handoff. Reload and try again.')
    if (before.status !== 'accepted') throw new CrmError('NOT_ACCEPTED', 'Accept the finance handoff before linking an invoice.')
    if (before.invoice_id) throw new CrmError('HAS_INVOICE', 'That handoff already has an invoice linked.')
    const [invoice] = await tx.execute<{ id: string }>(sql`
      SELECT id::text FROM invoice WHERE id = ${input.invoiceId}::uuid
       AND entity_id = ${company.id}::uuid AND direction = 'sales'
       AND party_id = ${before.party_id}::uuid`)
    if (!invoice) throw new CrmError('BAD_INVOICE', 'Choose a sales invoice for this same account.')
    await tx.execute(sql`
      UPDATE crm_finance_handoff SET invoice_id = ${invoice.id}::uuid, version = version + 1
       WHERE id = ${before.id}::uuid AND version = ${before.version}`)
    await auditRow(tx, {
      actor: input.actor, action: 'link_crm_handoff_invoice', table: 'crm_finance_handoff',
      recordId: before.id, entityId: company.id, scope: 'company', targetLabel: before.label,
      before: { invoiceId: null, version: before.version },
      after: { invoiceId: invoice.id, version: before.version + 1 },
    })
  })
}

export async function financeInvoiceChoices(ledgerId: string) {
  const company = await companyForLedger(db, ledgerId)
  return db.execute<{ id: string; label: string }>(sql`
    SELECT i.id::text, concat(COALESCE(i.number, i.their_ref, 'Draft'), ' — ', p.name) AS label
      FROM invoice i JOIN party p ON p.id = i.party_id
     WHERE i.entity_id = ${company.id}::uuid AND i.direction = 'sales' AND i.status = 'draft'
     ORDER BY i.issued_on DESC, p.name`)
}

export async function crmCsv(ledgerId: string, what: 'accounts' | 'leads' | 'opportunities' | 'tasks') {
  const data = await crmWorkspace(ledgerId)
  if (what === 'accounts') return csvFile([
    ['Name', 'Lifecycle', 'Owner', 'Source', 'Segment', 'Territory', 'Rating', 'Last touch'],
    ...data.accounts.map((a) => [a.name, a.lifecycle,
      data.users.find((u) => u.id === a.owner_user_id)?.name ?? '', a.source, a.segment,
      a.territory, a.rating, a.last_touch]),
  ])
  if (what === 'leads') return csvFile([
    ['Organisation', 'Person', 'Email', 'Phone', 'Source', 'Status', 'Created'],
    ...data.leads.map((l) => [l.organisation_name, l.person_name, l.email, l.phone, l.source, l.status, l.created_at]),
  ])
  if (what === 'opportunities') return csvFile([
    ['Opportunity', 'Account', 'Stage', 'Amount', 'Currency', 'Expected close', 'Probability %'],
    ...data.opportunities.map((o) => [o.name, o.account_name, o.stage_name,
      o.expected_amount === null ? '' : csvMoney(o.expected_amount), o.currency,
      o.expected_close_on, (o.probability_bp ?? data.stages.find((s) => s.id === o.stage_id)?.default_probability_bp ?? 0) / 100]),
  ])
  return csvFile([
    ['Task', 'Related to', 'Assigned to', 'Due', 'Priority', 'Status'],
    ...data.tasks.map((t) => [t.title, t.subject, t.assigned_name, t.due_at, t.priority, t.status]),
  ])
}

export function crmSentence(error: unknown): string {
  if (error instanceof CrmError) return error.message
  const text = causesOf(error)
  if (text.includes('ENTITY_ARCHIVED')) return text.split('ENTITY_ARCHIVED: ')[1]?.split('\n')[0] ?? 'That company is archived.'
  if (text.includes('crm_account_entity_id_party_id_key')) return 'That Party already has a CRM account in this company.'
  if (text.includes('crm_one_primary_account_contact')) return 'That account already has a primary contact. Reload and try again.'
  return text
}

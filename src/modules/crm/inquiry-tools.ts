import 'server-only'
import { parseMoney } from '@/lib/money'
import { money, text, date, oneOf, table, choices, ArgError, type Tool, type Args } from '@/lib/inquiry-tool-runtime'
import { crmWorkspace, type CrmWorkspace } from '@/lib/crm'
import { CRM_PROPOSAL_PREFIX } from '@/lib/assistant-skills'
const CRM_TARGET_KINDS = ['account', 'lead', 'opportunity'] as const

const CRM_ACTIVITY_KINDS = ['note', 'call', 'email', 'meeting'] as const

const CRM_LEAD_STATUSES = ['new', 'working', 'qualified', 'disqualified', 'converted'] as const

const CRM_TASK_STATUSES = ['open', 'done', 'cancelled'] as const

const CRM_LIFECYCLES = ['prospect', 'active', 'dormant', 'lost'] as const

const CRM_CONSENT_STATUSES = ['unknown', 'consented', 'declined', 'withdrawn'] as const

const CRM_PRIORITIES = ['low', 'normal', 'high'] as const

const crmProposal = (lines: string[]): string => [
  `${CRM_PROPOSAL_PREFIX} Confirm it in Banyan to make this change.`, ...lines,
].join('\n')

const crmTarget = (
  workspace: CrmWorkspace, args: Args,
): { kind: 'account' | 'lead' | 'opportunity'; id: string; label: string } => {
  const kind = oneOf(args, 'target_kind', CRM_TARGET_KINDS) as typeof CRM_TARGET_KINDS[number]
  const id = text(args, 'target_id')
  if (kind === 'account') {
    const row = workspace.accounts.find((x) => x.id === id)
    if (!row) throw new ArgError('That CRM target is not in this company.')
    return { kind, id, label: row.name }
  }
  if (kind === 'lead') {
    const row = workspace.leads.find((x) => x.id === id)
    if (!row) throw new ArgError('That CRM target is not in this company.')
    return { kind, id, label: row.organisation_name ?? row.person_name ?? 'Lead' }
  }
  const row = workspace.opportunities.find((x) => x.id === id)
  if (!row) throw new ArgError('That CRM target is not in this company.')
  return { kind, id, label: row.name }
}

const crmOwner = (workspace: CrmWorkspace, args: Args, key: string): string => {
  const id = text(args, key, false)
  if (!id) return ''
  const user = workspace.users.find((x) => x.id === id)
  if (!user) throw new ArgError('That CRM owner is not an active person with CRM access to this company.')
  return user.name
}

export const inquiryTools: Tool[] = [
{
    order: 21,
    name: 'crm_overview', args: '{}', does: 'CRM pipeline value, weighted value, open opportunities and overdue tasks',
    seats: () => ['/crm'],
    run: async (ctx) => {
      const w = await crmWorkspace(ctx.ledgerId)
      return table(
        [`CRM overview — ${ctx.entityName}`, `Pipeline: ${money(w.stats.pipeline)}. Weighted: ${money(w.stats.weighted)}.`,
         `Open opportunities: ${w.stats.open_opportunities}. Overdue tasks: ${w.stats.overdue_tasks}.`],
        ['kind', 'count'],
        [['leads', String(w.leads.length)], ['accounts', String(w.accounts.length)],
         ['contacts', String(w.contacts.length)], ['activities', String(w.activities.length)]])
    },
  },
{
    order: 22,
    name: 'crm_leads', args: `{text?, status?: ${choices(CRM_LEAD_STATUSES)}}`, does: 'CRM leads with contact details, status, source and owner',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const q = text(args, 'text', false).toLowerCase()
      const status = oneOf(args, 'status', CRM_LEAD_STATUSES, false)
      const w = await crmWorkspace(ctx.ledgerId)
      const owner = new Map(w.users.map((u) => [u.id, u.name]))
      const rows = w.leads.filter((lead) => (!status || lead.status === status)
        && (!q || [lead.organisation_name, lead.person_name, lead.email, lead.phone, lead.source]
          .some((v) => (v ?? '').toLowerCase().includes(q))))
      return table([`CRM leads — ${ctx.entityName}`],
        ['id', 'organisation', 'person', 'email', 'phone', 'status', 'source', 'owner'],
        rows.map((lead) => [lead.id, lead.organisation_name ?? '', lead.person_name ?? '', lead.email ?? '',
          lead.phone ?? '', lead.status, lead.source ?? '', lead.owner_user_id ? owner.get(lead.owner_user_id) ?? '' : '']))
    },
  },
{
    order: 23,
    name: 'crm_accounts', args: '{text?}', does: 'CRM customer accounts and contacts, including lifecycle, owner and recent touch',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const q = text(args, 'text', false).toLowerCase()
      const w = await crmWorkspace(ctx.ledgerId)
      const owner = new Map(w.users.map((u) => [u.id, u.name]))
      const rows = w.accounts.filter((account) => !q
        || [account.name, account.trading_name, account.segment, account.territory]
          .some((v) => (v ?? '').toLowerCase().includes(q)))
      return table([`CRM accounts — ${ctx.entityName}`, 'Use an account id when drafting a contact or opportunity.'],
        ['id', 'party', 'trading as', 'lifecycle', 'segment', 'territory', 'rating', 'owner', 'opportunities', 'last touch'],
        rows.map((account) => [account.id, account.name, account.trading_name ?? '', account.lifecycle,
          account.segment ?? '', account.territory ?? '', account.rating ?? '',
          account.owner_user_id ? owner.get(account.owner_user_id) ?? '' : '', String(account.opportunity_count),
          account.last_touch ?? '']))
    },
  },
{
    order: 24,
    name: 'crm_pipeline', args: '{stage?, closes_from?, closes_to?}', does: 'CRM opportunities with stage, expected amount, probability and expected close date',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const stage = text(args, 'stage', false).toLowerCase()
      const from = date(args, 'closes_from', false)
      const to = date(args, 'closes_to', false)
      if (from && to && from > to) throw new ArgError('"closes_from" is after "closes_to".')
      const w = await crmWorkspace(ctx.ledgerId)
      const rows = w.opportunities.filter((o) => (!stage || o.stage_name.toLowerCase().includes(stage))
        && (!from || (o.expected_close_on !== null && o.expected_close_on >= from))
        && (!to || (o.expected_close_on !== null && o.expected_close_on <= to)))
      return table([`CRM pipeline — ${ctx.entityName}`, 'Expected amounts are entered estimates, not posted revenue.'],
        ['id', 'account', 'opportunity', 'stage', 'expected', 'currency', 'probability', 'expected close'],
        rows.map((o) => [o.id, o.account_name, o.name, o.stage_name, money(o.expected_amount), o.currency,
          o.probability_bp === null ? '' : `${(o.probability_bp / 100).toFixed(2)}%`, o.expected_close_on ?? '']))
    },
  },
{
    order: 25,
    name: 'crm_tasks', args: `{status?: ${choices(CRM_TASK_STATUSES)}, text?}`, does: 'CRM tasks with subject, assignee, due time, priority and status',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const status = oneOf(args, 'status', CRM_TASK_STATUSES, false)
      const q = text(args, 'text', false).toLowerCase()
      const w = await crmWorkspace(ctx.ledgerId)
      const rows = w.tasks.filter((task) => (!status || task.status === status)
        && (!q || task.title.toLowerCase().includes(q) || task.subject.toLowerCase().includes(q)))
      return table([`CRM tasks — ${ctx.entityName}`], ['id', 'title', 'subject', 'assigned', 'due', 'priority', 'status'],
        rows.map((task) => [task.id, task.title, task.subject, task.assigned_name ?? '', task.due_at ?? '',
          task.priority, task.status]))
    },
  },
{
    order: 26,
    name: 'crm_activities', args: `{kind?: ${choices(CRM_ACTIVITY_KINDS)}, text?}`, does: 'recent CRM notes, calls, email and meetings',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const kind = oneOf(args, 'kind', CRM_ACTIVITY_KINDS, false)
      const q = text(args, 'text', false).toLowerCase()
      const w = await crmWorkspace(ctx.ledgerId)
      const rows = w.activities.filter((activity) => (!kind || activity.kind === kind)
        && (!q || [activity.subject, activity.body, activity.related_to]
          .some((v) => (v ?? '').toLowerCase().includes(q))))
      return table([`CRM activity — ${ctx.entityName}`],
        ['id', 'when', 'kind', 'direction', 'subject', 'related to', 'body', 'actor'],
        rows.map((activity) => [activity.id, activity.occurred_at, activity.kind, activity.direction ?? '',
          activity.subject, activity.related_to, activity.body ?? '', activity.actor_name ?? '']))
    },
  },
{
    order: 27,
    name: 'crm_draft_lead',
    args: '{organisation_name?, person_name?, email?, phone?, source?, owner_user_id?}',
    does: 'validates and proposes one new CRM lead; it saves nothing until the person confirms in Banyan',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const organisation = text(args, 'organisation_name', false)
      const person = text(args, 'person_name', false)
      if (!organisation && !person) throw new ArgError('An organisation_name or person_name is needed.')
      const w = await crmWorkspace(ctx.ledgerId)
      const owner = crmOwner(w, args, 'owner_user_id')
      return crmProposal([`Add lead: ${organisation || person}.`, `Person: ${person || '—'}. Email: ${text(args, 'email', false) || '—'}.`,
        `Phone: ${text(args, 'phone', false) || '—'}. Source: ${text(args, 'source', false) || '—'}. Owner: ${owner || 'unassigned'}.`])
    },
  },
{
    order: 28,
    name: 'crm_draft_account', args: `{party_id, lifecycle?: ${choices(CRM_LIFECYCLES)}, owner_user_id?, source?, segment?}`,
    does: 'validates and proposes making an existing Party a CRM account; it saves nothing until confirmed',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const w = await crmWorkspace(ctx.ledgerId)
      const partyId = text(args, 'party_id')
      const party = w.partyChoices.find((p) => p.id === partyId)
      if (!party) throw new ArgError('That Party is not available to become a CRM account in this company.')
      const lifecycle = oneOf(args, 'lifecycle', CRM_LIFECYCLES, false) || 'active'
      const owner = crmOwner(w, args, 'owner_user_id')
      return crmProposal([`Add CRM account for Party: ${party.name}.`,
        `Lifecycle: ${lifecycle}. Segment: ${text(args, 'segment', false) || '—'}. Source: ${text(args, 'source', false) || '—'}. Owner: ${owner || 'unassigned'}.`])
    },
  },
{
    order: 29,
    name: 'crm_draft_contact',
    args: `{account_id, name, job_title?, decision_role?, email?, phone?, preferred_channel?, consent_status?: ${choices(CRM_CONSENT_STATUSES)}, is_primary?}`,
    does: 'validates and proposes one contact on a CRM account; it saves nothing until confirmed',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const w = await crmWorkspace(ctx.ledgerId)
      const account = w.accounts.find((a) => a.id === text(args, 'account_id'))
      if (!account) throw new ArgError('That CRM account is not in this company.')
      const email = text(args, 'email', false)
      const phone = text(args, 'phone', false)
      if (!email && !phone) throw new ArgError('An email or phone number is needed.')
      const consent = oneOf(args, 'consent_status', CRM_CONSENT_STATUSES, false) || 'unknown'
      return crmProposal([`Add contact ${text(args, 'name')} to ${account.name}.`,
        `Email: ${email || '—'}. Phone: ${phone || '—'}. Job title: ${text(args, 'job_title', false) || '—'}.`,
        `Consent: ${consent}. Primary contact: ${args.is_primary === true ? 'yes' : 'no'}.`])
    },
  },
{
    order: 30,
    name: 'crm_draft_opportunity',
    args: '{account_id, name, owner_user_id?, expected_amount?, currency?, expected_close_on?, probability_percent?, source?, description?}',
    does: 'validates and proposes one CRM opportunity; it saves nothing until confirmed',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const w = await crmWorkspace(ctx.ledgerId)
      const account = w.accounts.find((a) => a.id === text(args, 'account_id'))
      if (!account) throw new ArgError('That CRM account is not in this company.')
      const owner = crmOwner(w, args, 'owner_user_id')
      const rawAmount = text(args, 'expected_amount', false)
      let amount = ''
      if (rawAmount) {
        try {
          const cents = parseMoney(rawAmount)
          if (cents < 0n) throw new Error('negative')
          amount = money(cents)
        } catch { throw new ArgError('"expected_amount" must be a non-negative amount with at most two decimals.') }
      }
      const probability = text(args, 'probability_percent', false)
      if (probability && (!Number.isFinite(Number(probability)) || Number(probability) < 0 || Number(probability) > 100)) {
        throw new ArgError('"probability_percent" must be from 0 to 100.')
      }
      const close = date(args, 'expected_close_on', false)
      const currency = (text(args, 'currency', false) || 'CAD').toUpperCase()
      if (!/^[A-Z]{3}$/.test(currency)) throw new ArgError('"currency" must be a three-letter code.')
      return crmProposal([`Add opportunity ${text(args, 'name')} for ${account.name}.`,
        `Expected: ${amount || '—'} ${currency}. Close: ${close || '—'}. Probability: ${probability ? `${probability}%` : 'default'}.`,
        `Owner: ${owner || 'unassigned'}. Source: ${text(args, 'source', false) || '—'}.`])
    },
  },
{
    order: 31,
    name: 'crm_draft_task',
    args: `{target_kind: ${choices(CRM_TARGET_KINDS)}, target_id, title, assigned_user_id?, due_at?, priority?: ${choices(CRM_PRIORITIES)}}`,
    does: 'validates and proposes one CRM follow-up task; it saves nothing until confirmed',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const w = await crmWorkspace(ctx.ledgerId)
      const target = crmTarget(w, args)
      const owner = crmOwner(w, args, 'assigned_user_id')
      const priority = oneOf(args, 'priority', CRM_PRIORITIES, false) || 'normal'
      return crmProposal([`Add task: ${text(args, 'title')}.`, `Related to: ${target.label} (${target.kind}).`,
        `Assigned: ${owner || 'unassigned'}. Due: ${text(args, 'due_at', false) || '—'}. Priority: ${priority}.`])
    },
  },
{
    order: 32,
    name: 'crm_draft_activity',
    args: `{target_kind: ${choices(CRM_TARGET_KINDS)}, target_id, kind: ${choices(CRM_ACTIVITY_KINDS)}, subject, direction?, body?, occurred_at?}`,
    does: 'validates and proposes one CRM activity; it saves nothing until confirmed',
    seats: () => ['/crm'],
    run: async (ctx, args) => {
      const w = await crmWorkspace(ctx.ledgerId)
      const target = crmTarget(w, args)
      const kind = oneOf(args, 'kind', CRM_ACTIVITY_KINDS)
      return crmProposal([`Record ${kind}: ${text(args, 'subject')}.`, `Related to: ${target.label} (${target.kind}).`,
        `Direction: ${text(args, 'direction', false) || '—'}. When: ${text(args, 'occurred_at', false) || 'now'}.`,
        `Notes: ${text(args, 'body', false) || '—'}.`])
    },
  },
]

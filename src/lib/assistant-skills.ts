import { moduleManifests, orderedModuleItems } from './module-manifests'
import 'server-only'
import { moduleSkillCommand } from './module-extensions'
import { SkillCommandError } from './skill-command-error'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { accessFor, entityOfLedger, refuseForLedger } from './access'

import type { UserRecord } from './users'

/**
 * Skills are the Assistant's routing boundary.  The router sees descriptions;
 * the selected module sees only its own tools; the server still checks the
 * person's seat on every call.  A prompt is discovery, never authority.
 */
const KNOWN_SKILL_IDS = [
  'books', 'crm', 'transactions', 'invoices', 'banking', 'cheques', 'journal', 'parties', 'accounts',
  'reports', 'tax', 'payroll', 'records', 'periods', 'opening', 'sred', 'backup', 'documents', 'projects', 'automation', 'inventory', 'assets',
] as const
export type SkillId = typeof KNOWN_SKILL_IDS[number]

export type AssistantSkill = {
  id: SkillId
  label: string
  /** Every top-level navigation path this skill owns. */
  paths: readonly string[]
  /** Any one of these seats makes the skill available. Null is company-wide. */
  seats: readonly string[] | null
  /** First permitted path is the destination returned by module_link. */
  entryPaths: readonly string[]
  mode: 'read' | 'confirm'
  description: string
  examples: string
  instructions: string
  tools: readonly string[]
}

const BOOK_TOOLS = [
  'calendar', 'search', 'totals', 'accounts', 'parties', 'balances', 'account_activity',
  'statement', 'owed', 'open_documents', 'party_activity', 'journal', 'bank_lines',
  'bank_accounts', 'tax_return', 'employees', 'pay_runs', 'pay_stubs', 'remittances',
  't4', 'register', 'calculate', 'report_link',
] as const

export const ASSISTANT_SKILLS: readonly AssistantSkill[] = orderedModuleItems<AssistantSkill>([
{ order: 2,
    id:'automation',label:'Automation',paths:['/automation'],seats:['/automation'],entryPaths:['/automation'],mode:'read',
    description:'Receipt Inbox, recurring drafts, approved customer email, reminders and background job status. Navigation only.',
    examples:'Open the receipt Inbox. Where can I review recurring drafts or queued email?',
    instructions:'Provide the Automation module link. Never create, convert, generate, send, retry, enable or claim completion of any task. Review and authorize actions in the workspace.',
    tools:['module_link'],
  },
{ order: 5,
    id: 'books', label: 'Books', paths: ['', '/search'], seats: null, entryPaths: ['', '/search'], mode: 'read',
    description: 'Cross-module accounting questions, search, accounts, journals, balances, or a request spanning several modules. Read-only.',
    examples: 'What changed this quarter? Find INV-104. Compare payroll and revenue.',
    instructions: 'Read the company books. Never propose or perform a write. Use module readers and calculate rather than mental arithmetic.',
    tools: [...BOOK_TOOLS, 'module_link'],
  },
{ order: 7,
    id: 'transactions', label: 'Money in & out', paths: ['/expenses', '/income'],
    seats: ['/expenses', '/income'], entryPaths: ['/expenses', '/income'], mode: 'read',
    description: 'Expenses, income, payments, and Party activity. Read-only.',
    examples: 'What did we spend with Maple Supply? Show income from Acme.',
    instructions: 'Read money-in and money-out activity only. Never create, post, edit, or delete a transaction.',
    tools: ['calendar', 'search', 'parties', 'party_activity', 'journal', 'calculate', 'module_link'],
  },
{ order: 8,
    id: 'invoices', label: 'Invoices', paths: ['/invoices'], seats: ['/invoices'],
    entryPaths: ['/invoices'], mode: 'read',
    description: 'Sales and purchase invoices, credit notes, open documents, and amounts still owed. Read-only.',
    examples: 'Which invoices are unpaid? Find invoice 104.',
    instructions: 'Read invoices and credit notes only. Never create, post, settle, edit, or delete a document.',
    tools: ['calendar', 'search', 'parties', 'owed', 'open_documents', 'journal', 'calculate', 'report_link', 'module_link'],
  },
{ order: 9,
    id: 'banking', label: 'Banking', paths: ['/bank'], seats: ['/bank'], entryPaths: ['/bank'], mode: 'read',
    description: 'Imported bank rows, matching state, account standing, and reconciliations. Read-only.',
    examples: 'Which bank rows are still unmatched? What is the latest statement balance?',
    instructions: 'Read bank data only. Never match, post, exclude, import, undo, or reconcile a row.',
    tools: ['calendar', 'search', 'bank_lines', 'bank_accounts', 'journal', 'calculate', 'module_link'],
  },
{ order: 10,
    id: 'cheques', label: 'Cheques', paths: ['/cheques'], seats: ['/cheques'],
    entryPaths: ['/cheques'], mode: 'read',
    description: 'Issued and void cheques. Navigation only.',
    examples: 'Open the cheque register. Where do I print a cheque?',
    instructions: 'Provide the Cheques module link. Never create, print, void, or change a cheque.',
    tools: ['module_link'],
  },
{ order: 11,
    id: 'journal', label: 'Journal entries', paths: ['/entries'], seats: ['/entries'],
    entryPaths: ['/entries'], mode: 'read',
    description: 'Posted and reversed journal entries and their lines. Read-only.',
    examples: 'Find the entry for year-end fees. Show entries posted last week.',
    instructions: 'Read journal entries only. Never draft, post, reverse, edit, or delete an entry.',
    tools: ['calendar', 'search', 'accounts', 'parties', 'journal', 'calculate', 'module_link'],
  },
{ order: 12,
    id: 'parties', label: 'Parties', paths: ['/parties'], seats: ['/parties'],
    entryPaths: ['/parties'], mode: 'read',
    description: 'Customers, suppliers, their roles, balances, open documents, and activity. Read-only.',
    examples: 'What does Acme owe us? Show everything involving Maple Supply.',
    instructions: 'Read Party identity and this company\'s relationship only. Never alter shared identity or accounting roles.',
    tools: ['search', 'parties', 'owed', 'open_documents', 'party_activity', 'calculate', 'module_link'],
  },
{ order: 13,
    id: 'accounts', label: 'Accounts', paths: ['/accounts'], seats: ['/accounts'],
    entryPaths: ['/accounts'], mode: 'read',
    description: 'Chart of accounts, classifications, roles, balances, and account activity. Read-only.',
    examples: 'Find the software expense account. Show activity in account 1000.',
    instructions: 'Read the chart and account activity only. Never create, reclassify, deactivate, or delete an account.',
    tools: ['calendar', 'search', 'accounts', 'balances', 'account_activity', 'journal', 'calculate', 'module_link'],
  },
{ order: 14,
    id: 'reports', label: 'Reports', paths: ['/reports'], seats: ['/reports'],
    entryPaths: ['/reports'], mode: 'read',
    description: 'Financial statements, trial balance, general ledger, aging, totals, and report links. Read-only.',
    examples: 'Show last year profit and loss. Who owes us the most?',
    instructions: 'Use database totals and report readers. Never create or change a ledger row.',
    tools: ['calendar', 'search', 'totals', 'balances', 'account_activity', 'statement', 'owed', 'journal', 'calculate', 'report_link', 'module_link'],
  },
{ order: 15,
    id: 'tax', label: 'Sales tax', paths: ['/tax'], seats: ['/tax'], entryPaths: ['/tax'], mode: 'read',
    description: 'GST/HST and PST registrations, return figures, supporting entries, and exports. Read-only.',
    examples: 'What are the GST/HST return figures for Q2?',
    instructions: 'Read return figures and their entries only. Never file or alter a registration.',
    tools: ['calendar', 'search', 'tax_return', 'journal', 'calculate', 'report_link', 'module_link'],
  },
{ order: 18,
    id: 'periods', label: 'Periods & year-end', paths: ['/periods'], seats: ['/periods'],
    entryPaths: ['/periods'], mode: 'read',
    description: 'Fiscal years, accounting periods, close status, and the year-end workspace. Navigation and calendar reading only.',
    examples: 'Which periods are closed? Take me to year-end.',
    instructions: 'Read the fiscal calendar and provide the module link. Never close, reopen, add, or delete a period.',
    tools: ['calendar', 'module_link'],
  },
{ order: 19,
    id: 'opening', label: 'Opening balances', paths: ['/opening'], seats: ['/opening'],
    entryPaths: ['/opening'], mode: 'read',
    description: 'The opening-balance workspace. Navigation only.',
    examples: 'Where do I enter opening balances?',
    instructions: 'Provide the opening-balance module link and explain that entries must be reviewed there. Never change an opening balance.',
    tools: ['accounts', 'module_link'],
  },
{ order: 21,
    id: 'backup', label: 'Backup', paths: ['/backup'], seats: ['/backup'], entryPaths: ['/backup'], mode: 'read',
    description: 'Company backup, restore preparation, and backup status. Navigation only; never starts a restore.',
    examples: 'Where can I download this company backup? Open backup status.',
    instructions: 'Provide the Backup module link. Never claim a backup exists or is complete without a dedicated result, and never initiate a restore.',
    tools: ['module_link'],
  },
  ...moduleManifests.flatMap(manifest => manifest.skills ?? []),
])

export const SKILL_IDS: readonly SkillId[] = KNOWN_SKILL_IDS.filter(id => ASSISTANT_SKILLS.some(skill => skill.id === id))

const BY_ID = new Map(ASSISTANT_SKILLS.map((skill) => [skill.id, skill]))

export function isSkillId(value: unknown): value is SkillId {
  return typeof value === 'string' && (SKILL_IDS as readonly string[]).includes(value)
}

export function skillById(id: SkillId): AssistantSkill {
  const skill = BY_ID.get(id)
  if (!skill) throw new Error(`Unknown Assistant skill: ${id}`)
  return skill
}

export const toolNamesForSkill = (id: SkillId): ReadonlySet<string> => new Set(skillById(id).tools)

/** The registry is also the ownership map for every top-level ERP door. */
export function skillForNavPath(path: string): AssistantSkill | null {
  return ASSISTANT_SKILLS.find((skill) => skill.paths.includes(path)) ?? null
}

/** Only advertise modules the person can actually open in this company. */
export async function availableSkills(ledgerId: string, user: UserRecord): Promise<AssistantSkill[]> {
  const access = await accessFor(user)
  if (access.byEntity === null) return [...ASSISTANT_SKILLS]
  const entityId = await entityOfLedger(ledgerId)
  if (!entityId || (access.entities !== null && !access.entities.has(entityId))) return []
  const held = access.byEntity.get(entityId) ?? new Set<string>()
  return ASSISTANT_SKILLS.filter((skill) => skill.seats === null
    || skill.seats.some((seat) => held.has(seat)))
}

/** A server-chosen destination: the model can select a skill, never a URL. */
export async function moduleDestination(
  ledgerId: string, user: UserRecord, id: SkillId,
): Promise<{ label: string; path: string; href: string }> {
  const skill = skillById(id)
  for (const path of skill.entryPaths) {
    if (await refuseForLedger(user, ledgerId, path) === null) {
      return { label: skill.label, path, href: `/ledger/${ledgerId}${path || '/'}` }
    }
  }
  throw new SkillCommandError(`You no longer have access to ${skill.label} in this company.`)
}

export function routerSystem(skills: readonly AssistantSkill[]): string {
  return [
    'You route one request inside Banyan. Do not answer the request and do not invent a module.',
    'Only the skills listed below are available to this person in this company.',
    'If the intended module is ambiguous, reply with exactly one JSON object:',
    '{"clarify":"<one concise question in the user\'s language>","choices":["<skill>","<skill>"]}',
    'If it is clear, reply with exactly one JSON object:',
    '{"route":{"skill":"<skill>","request":"<precise normalized request in the user\'s language>","reason":"<short reason>"}}',
    'Choose books for a genuinely cross-module accounting request, not merely because it is broad.',
    '',
    'Available skills:',
    ...skills.map((skill) => `- ${skill.id} (${skill.label}; ${skill.mode === 'confirm' ? 'drafts require confirmation' : 'read-only'}): ${skill.description} Examples: ${skill.examples}`),
  ].join('\n')
}

export type SkillRouteReply =
  | { kind: 'route'; skill: SkillId; request: string; reason: string }
  | { kind: 'clarify'; question: string; choices: SkillId[] }
  | { kind: 'unreadable' }

const objectFrom = (text: string): Record<string, unknown> | null => {
  const bare = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const candidates = [bare]
  const first = bare.indexOf('{')
  const last = bare.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(bare.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* another candidate may still be the object */ }
  }
  return null
}

export function parseSkillRoute(text: string | null, allowed: ReadonlySet<SkillId>): SkillRouteReply {
  if (text === null) return { kind: 'unreadable' }
  const value = objectFrom(text)
  if (!value) return { kind: 'unreadable' }
  if (typeof value.clarify === 'string' && !Object.hasOwn(value, 'route')) {
    const choices = Array.isArray(value.choices)
      ? value.choices.filter((choice): choice is SkillId => isSkillId(choice) && allowed.has(choice))
      : []
    const question = value.clarify.trim()
    return question ? { kind: 'clarify', question, choices: [...new Set(choices)] } : { kind: 'unreadable' }
  }
  if (value.route && typeof value.route === 'object' && !Array.isArray(value.route) && !Object.hasOwn(value, 'clarify')) {
    const route = value.route as Record<string, unknown>
    if (!isSkillId(route.skill) || !allowed.has(route.skill)) return { kind: 'unreadable' }
    const request = typeof route.request === 'string' ? route.request.trim() : ''
    const reason = typeof route.reason === 'string' ? route.reason.trim() : ''
    if (request && reason) return { kind: 'route', skill: route.skill, request, reason }
  }
  return { kind: 'unreadable' }
}

export const isCrmDraftTool = (tool: string | null): boolean => !!tool && !!BY_ID.get('crm')?.tools.includes(tool) && tool.startsWith('crm_draft_')
export const CRM_PROPOSAL_PREFIX = 'CRM proposal — not saved.'

export type SkillCommandExecution = {
  inquiry_id: string; step_n: number; entity_id: string
  executed_at: string; executed_by: string; tool: string
}



/** Dispatch by the persisted capability. The owning module rechecks its proposal. */
export async function confirmSkillCommand(input: {
  ledgerId: string; inquiryId: string; stepN: number; user: UserRecord
}): Promise<string> {
  const [route] = await db.execute<{ skill: string }>(sql`
    SELECT r.skill FROM ai_inquiry_skill r JOIN ai_inquiry q ON q.id=r.inquiry_id
    WHERE q.id=${input.inquiryId}::uuid AND q.ledger_id=${input.ledgerId}::uuid`)
  const result = route ? await moduleSkillCommand(route.skill, input) : null
  if (result === null) throw new SkillCommandError('The module for this proposal is unavailable. Nothing was saved.')
  return result
}

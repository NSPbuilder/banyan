'use server'

import { revalidatePath } from 'next/cache'
import type { FormState } from '@/app/actions'
import { actorOf, requireLedger } from '@/lib/gate'
import { parseMoney } from '@/lib/money'
import {
  completeTask, convertLead, createAccount, createActivity, createContact, createLead,
  createOpportunity, createTask, crmSentence, linkHandoffInvoice, moveOpportunity, reviewHandoff,
} from '@/lib/crm'

const s = (f: FormData, name: string) => String(f.get(name) ?? '')
const optional = (f: FormData, name: string) => s(f, name).trim() || undefined
const integer = (f: FormData, name: string) => Number.parseInt(s(f, name), 10)
const target = (f: FormData): { targetKind: 'account' | 'lead' | 'opportunity'; targetId: string } => {
  const [targetKind, targetId] = s(f, 'targetRef').split('|')
  if ((targetKind === 'account' || targetKind === 'lead' || targetKind === 'opportunity') && targetId) {
    return { targetKind, targetId }
  }
  throw new Error('Choose what this belongs to.')
}

async function crmAction(
  f: FormData,
  work: (input: { ledgerId: string; actor: string; actorUserId: string }) => Promise<unknown>,
  ok: string,
): Promise<FormState> {
  const ledgerId = s(f, 'ledgerId')
  const who = await requireLedger(ledgerId, '/crm')
  try {
    await work({ ledgerId, actor: actorOf(who), actorUserId: who.id })
  } catch (error) {
    return { error: crmSentence(error) }
  }
  revalidatePath(`/ledger/${ledgerId}/crm`)
  return { ok }
}

export async function createLeadAction(_prev: FormState, f: FormData): Promise<FormState> {
  return crmAction(f, (base) => createLead({
    ...base,
    organisationName: optional(f, 'organisationName'),
    personName: optional(f, 'personName'),
    email: optional(f, 'email'), phone: optional(f, 'phone'),
    source: optional(f, 'source'), ownerUserId: optional(f, 'ownerUserId'),
  }), 'Lead added.')
}

export async function createCrmAccountAction(_prev: FormState, f: FormData): Promise<FormState> {
  return crmAction(f, (base) => createAccount({
    ...base, partyId: s(f, 'partyId'), lifecycle: optional(f, 'lifecycle'),
    ownerUserId: optional(f, 'ownerUserId'), source: optional(f, 'source'),
    segment: optional(f, 'segment'),
  }), 'Account added.')
}

export async function convertLeadAction(_prev: FormState, f: FormData): Promise<FormState> {
  return crmAction(f, (base) => convertLead({
    ...base, leadId: s(f, 'leadId'), version: integer(f, 'version'),
  }), 'Lead converted. Its shared Party identity and this company’s CRM account are ready.')
}

export async function createContactAction(_prev: FormState, f: FormData): Promise<FormState> {
  return crmAction(f, (base) => createContact({
    ...base, accountId: s(f, 'accountId'), name: s(f, 'name'),
    jobTitle: optional(f, 'jobTitle'), decisionRole: optional(f, 'decisionRole'),
    email: optional(f, 'email'), phone: optional(f, 'phone'),
    preferredChannel: optional(f, 'preferredChannel'),
    consentStatus: optional(f, 'consentStatus'), isPrimary: s(f, 'isPrimary') === 'on',
  }), 'Contact added.')
}

export async function createOpportunityAction(_prev: FormState, f: FormData): Promise<FormState> {
  return crmAction(f, (base) => {
    let expectedAmount: bigint | undefined
    const raw = optional(f, 'expectedAmount')
    if (raw) expectedAmount = parseMoney(raw)
    const probability = optional(f, 'probability')
    const probabilityBp = probability === undefined ? undefined : Math.round(Number(probability) * 100)
    return createOpportunity({
      ...base, accountId: s(f, 'accountId'), name: s(f, 'name'),
      ownerUserId: optional(f, 'ownerUserId'), expectedAmount,
      currency: optional(f, 'currency'), expectedCloseOn: optional(f, 'expectedCloseOn'),
      probabilityBp, source: optional(f, 'source'), description: optional(f, 'description'),
    })
  }, 'Opportunity added.')
}

export async function moveOpportunityAction(_prev: FormState, f: FormData): Promise<FormState> {
  return crmAction(f, (base) => moveOpportunity({
    ...base, opportunityId: s(f, 'opportunityId'), stageId: s(f, 'stageId'),
    version: integer(f, 'version'), reason: optional(f, 'reason'),
  }), 'Opportunity moved.')
}

export async function createActivityAction(_prev: FormState, f: FormData): Promise<FormState> {
  return crmAction(f, (base) => createActivity({
    ...base, ...target(f),
    kind: s(f, 'kind') as 'note' | 'call' | 'email' | 'meeting',
    direction: optional(f, 'direction'), subject: s(f, 'subject'), body: optional(f, 'body'),
    occurredAt: optional(f, 'occurredAt'),
  }), 'Activity recorded.')
}

export async function createTaskAction(_prev: FormState, f: FormData): Promise<FormState> {
  return crmAction(f, (base) => createTask({
    ...base, ...target(f), title: s(f, 'title'),
    assignedUserId: optional(f, 'assignedUserId'), dueAt: optional(f, 'dueAt'),
    priority: optional(f, 'priority'),
  }), 'Task added.')
}

export async function completeTaskAction(_prev: FormState, f: FormData): Promise<FormState> {
  return crmAction(f, (base) => completeTask({
    ...base, taskId: s(f, 'taskId'), version: integer(f, 'version'),
  }), 'Task completed.')
}

export async function reviewHandoffAction(_prev: FormState, f: FormData): Promise<FormState> {
  const ledgerId = s(f, 'ledgerId')
  // Both doors, deliberately. requireLedger's array form means ANY seat, not
  // both, so two checks express the cross-module handoff boundary.
  const who = await requireLedger(ledgerId, '/crm')
  await requireLedger(ledgerId, '/invoices')
  try {
    await reviewHandoff({
      ledgerId, handoffId: s(f, 'handoffId'), version: integer(f, 'version'),
      decision: s(f, 'decision') === 'rejected' ? 'rejected' : 'accepted',
      reason: optional(f, 'reason'), invoiceId: optional(f, 'invoiceId'), actor: actorOf(who),
    })
  } catch (error) {
    return { error: crmSentence(error) }
  }
  revalidatePath(`/ledger/${ledgerId}/crm`)
  return { ok: 'Finance handoff reviewed.' }
}

export async function linkHandoffInvoiceAction(_prev: FormState, f: FormData): Promise<FormState> {
  const ledgerId = s(f, 'ledgerId')
  const who = await requireLedger(ledgerId, '/crm')
  await requireLedger(ledgerId, '/invoices')
  try {
    await linkHandoffInvoice({
      ledgerId, handoffId: s(f, 'handoffId'), version: integer(f, 'version'),
      invoiceId: s(f, 'invoiceId'), actor: actorOf(who),
    })
  } catch (error) {
    return { error: crmSentence(error) }
  }
  revalidatePath(`/ledger/${ledgerId}/crm`)
  return { ok: 'Draft invoice linked.' }
}

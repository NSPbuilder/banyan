import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { refuseForLedger } from '@/lib/access'
import { parseMoney } from '@/lib/money'
import { SkillCommandError } from '@/lib/skill-command-error'
import { isCrmDraftTool, CRM_PROPOSAL_PREFIX } from '@/lib/assistant-skills'
import { createAccount, createActivity, createContact, createLead, createOpportunity, createTask, type CrmAssistantCommand } from '@/lib/crm'
import type { UserRecord } from '@/lib/users'

const requiredText = (args: Record<string, unknown>, key: string): string => {
  const value = typeof args[key] === 'string' || typeof args[key] === 'number' ? String(args[key]).trim() : ''
  if (!value) throw new SkillCommandError(`${key} is required.`)
  return value
}
const optionalText = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = typeof args[key] === 'string' || typeof args[key] === 'number' ? String(args[key]).trim() : ''
  return value || undefined
}
const targetFrom = (args: Record<string, unknown>) => {
  const targetKind = requiredText(args, 'target_kind')
  if (!['account', 'lead', 'opportunity'].includes(targetKind)) {
    throw new SkillCommandError('target_kind must be account, lead, or opportunity.')
  }
  return { targetKind: targetKind as 'account' | 'lead' | 'opportunity', targetId: requiredText(args, 'target_id') }
}

/**
 * Re-read an immutable draft, re-check both seats and company ownership, then
 * call the ordinary CRM service.  That service records the command execution,
 * business row and audit row in one transaction.
 */
export async function confirmCrmCommand(input: {
  ledgerId: string; inquiryId: string; stepN: number; user: UserRecord
}): Promise<string> {
  const assistantSeat = await refuseForLedger(input.user, input.ledgerId, '/assistant')
  if (assistantSeat) throw new SkillCommandError(assistantSeat.message)
  const crmSeat = await refuseForLedger(input.user, input.ledgerId, '/crm')
  if (crmSeat) throw new SkillCommandError(crmSeat.message)

  const [draft] = await db.execute<{
    asked_by: string; tool: string | null; args: Record<string, unknown> | null; result: string | null
    outcome: string; skill: string | null
  }>(sql`
    SELECT q.asked_by, s.tool, s.args, s.result, s.outcome, r.skill
      FROM ai_inquiry q
      JOIN ai_inquiry_step s ON s.inquiry_id = q.id
      LEFT JOIN ai_inquiry_skill r ON r.inquiry_id = q.id
     WHERE q.id = ${input.inquiryId}::uuid AND q.ledger_id = ${input.ledgerId}::uuid
       AND s.n = ${input.stepN}`)
  if (!draft || draft.asked_by !== input.user.email || draft.skill !== 'crm'
      || draft.outcome !== 'call' || !isCrmDraftTool(draft.tool) || draft.args === null
      || !draft.result?.startsWith(CRM_PROPOSAL_PREFIX)) {
    throw new SkillCommandError('That CRM proposal is not yours to confirm.')
  }
  const command: CrmAssistantCommand = {
    inquiryId: input.inquiryId, stepN: input.stepN, tool: draft.tool!,
  }
  const base = { ledgerId: input.ledgerId, actor: input.user.email, assistantCommand: command }
  const args = draft.args

  switch (draft.tool) {
    case 'crm_draft_lead':
      await createLead({
        ...base, organisationName: optionalText(args, 'organisation_name'),
        personName: optionalText(args, 'person_name'), email: optionalText(args, 'email'),
        phone: optionalText(args, 'phone'), source: optionalText(args, 'source'),
        ownerUserId: optionalText(args, 'owner_user_id'),
      })
      return 'Lead added from the confirmed CRM proposal.'
    case 'crm_draft_account':
      await createAccount({
        ...base, partyId: requiredText(args, 'party_id'), lifecycle: optionalText(args, 'lifecycle'),
        ownerUserId: optionalText(args, 'owner_user_id'), source: optionalText(args, 'source'),
        segment: optionalText(args, 'segment'),
      })
      return 'CRM account added from the confirmed proposal.'
    case 'crm_draft_contact':
      await createContact({
        ...base, accountId: requiredText(args, 'account_id'), name: requiredText(args, 'name'),
        jobTitle: optionalText(args, 'job_title'), decisionRole: optionalText(args, 'decision_role'),
        email: optionalText(args, 'email'), phone: optionalText(args, 'phone'),
        preferredChannel: optionalText(args, 'preferred_channel'),
        consentStatus: optionalText(args, 'consent_status'), isPrimary: args.is_primary === true,
      })
      return 'Contact added from the confirmed CRM proposal.'
    case 'crm_draft_opportunity': {
      const amount = optionalText(args, 'expected_amount')
      const probability = optionalText(args, 'probability_percent')
      const probabilityNumber = probability === undefined ? undefined : Number(probability)
      if (probabilityNumber !== undefined && (!Number.isFinite(probabilityNumber)
          || probabilityNumber < 0 || probabilityNumber > 100)) {
        throw new SkillCommandError('probability_percent must be between 0 and 100.')
      }
      await createOpportunity({
        ...base, accountId: requiredText(args, 'account_id'), name: requiredText(args, 'name'),
        ownerUserId: optionalText(args, 'owner_user_id'),
        expectedAmount: amount ? parseMoney(amount) : undefined,
        currency: optionalText(args, 'currency'), expectedCloseOn: optionalText(args, 'expected_close_on'),
        probabilityBp: probabilityNumber === undefined ? undefined : Math.round(probabilityNumber * 100),
        source: optionalText(args, 'source'), description: optionalText(args, 'description'),
      })
      return 'Opportunity added from the confirmed CRM proposal.'
    }
    case 'crm_draft_task':
      await createTask({
        ...base, ...targetFrom(args), title: requiredText(args, 'title'),
        assignedUserId: optionalText(args, 'assigned_user_id'), dueAt: optionalText(args, 'due_at'),
        priority: optionalText(args, 'priority'),
      })
      return 'Task added from the confirmed CRM proposal.'
    case 'crm_draft_activity': {
      const kind = requiredText(args, 'kind')
      if (!['note', 'call', 'email', 'meeting'].includes(kind)) {
        throw new SkillCommandError('kind must be note, call, email, or meeting.')
      }
      await createActivity({
        ...base, ...targetFrom(args), kind: kind as 'note' | 'call' | 'email' | 'meeting',
        direction: optionalText(args, 'direction'), subject: requiredText(args, 'subject'),
        body: optionalText(args, 'body'), occurredAt: optionalText(args, 'occurred_at'),
        actorUserId: input.user.id,
      })
      return 'Activity recorded from the confirmed CRM proposal.'
    }
    default:
      throw new SkillCommandError('That proposal type is not supported.')
  }
}

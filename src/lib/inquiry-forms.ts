import 'server-only'
import { type FormResult, g, ASSISTANT_FIELDS as F } from './forms'
import { AssistantError, sendToRelay, type Send } from './assistant'
import { serviceState } from './ai-service'
import { answerOf, inquireRouted, keepLooking, offersKeepLooking, type Inquiry } from './inquiry'
import { confirmSkillCommand } from './assistant-skills'
import type { UserRecord } from './users'

export type { FormResult }

/**
 * The question form and the Keep looking press, read the way every other
 * *-forms.ts reads its form: a check can call these and cannot call a server
 * action. The service is the person's saved one, decrypted for this question;
 * the form carries the question and nothing secret. The sender is a parameter
 * so a suite hands a stand-in through and nothing reaches the network.
 */

async function savedService(user: UserRecord) {
  const state = await serviceState(user.id)
  if (state.kind === 'ready') return { service: state.saved.service, prices: state.saved.prices }
  return {
    error: state.kind === 'none'
      ? 'Save your service first — its address, your key and a model name, in the box above.'
      : `Your saved key (ending …${state.hint}) can no longer be read; the application's secret has changed. Enter it again.`,
  }
}

/** What the person is told once the question has run; the page shows the rest. */
function outcomeSentence(q: Inquiry): FormResult {
  if (answerOf(q.steps)) return { ok: 'Answered.' }
  const last = q.steps.at(-1)
  switch (last?.outcome) {
    case 'clarify': return { ok: 'The Assistant needs one detail before it can choose the right ERP module.' }
    case 'refusal': return { error: `The model declined: ${last.error ?? 'no reason given'}` }
    case 'error': return { error: `The assistant could not answer: ${last.error ?? 'the call failed'}` }
    case 'cut_off': return { error: 'The reply was cut off before it finished. Ask a narrower question.' }
    case 'call_after_limit':
    case 'too_slow': return offersKeepLooking(q.steps)
      ? { ok: 'It stopped at the limit before answering. You can let it keep looking.' }
      // Past the character limit a question is never offered another round.
      : { error: 'This question looked up too much to go on. Ask a narrower one.' }
    case 'unreadable': return { error: 'The Assistant could not choose one permitted ERP module. Name the module and ask again.' }
    default: return { error: 'The question did not finish.' }
  }
}

export async function inquireFromForm(f: FormData, user: UserRecord, send: Send = sendToRelay): Promise<FormResult> {
  try {
    const saved = await savedService(user)
    if ('error' in saved) return { error: saved.error }
    const q = await inquireRouted({
      ledgerId: g(f, F.ledgerId), question: g(f, F.question), user, service: saved.service, prices: saved.prices,
    }, send)
    return outcomeSentence(q)
  } catch (e) {
    return { error: e instanceof AssistantError ? e.message : (e instanceof Error ? e.message : String(e)) }
  }
}

export async function confirmSkillCommandFromForm(f: FormData, user: UserRecord): Promise<FormResult> {
  try {
    const stepN = Number(g(f, F.stepN))
    if (!Number.isInteger(stepN) || stepN < 1) return { error: 'That Assistant proposal is not valid.' }
    const ok = await confirmSkillCommand({
      ledgerId: g(f, F.ledgerId), inquiryId: g(f, F.inquiryId), stepN, user,
    })
    return { ok }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export async function keepLookingFromForm(f: FormData, user: UserRecord, send: Send = sendToRelay): Promise<FormResult> {
  try {
    const saved = await savedService(user)
    if ('error' in saved) return { error: saved.error }
    const q = await keepLooking({
      ledgerId: g(f, F.ledgerId), inquiryId: g(f, F.inquiryId), user, service: saved.service,
    }, send)
    return outcomeSentence(q)
  } catch (e) {
    return { error: e instanceof AssistantError ? e.message : (e instanceof Error ? e.message : String(e)) }
  }
}

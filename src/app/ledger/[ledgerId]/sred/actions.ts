'use server'

/**
 * SR&ED's doors, in SR&ED's own folder (doc 48, 2026-10-20). They were in
 * src/app/actions.ts, which made the framework's action file import the
 * SR&ED module; moved as they were, nothing reworded.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { entityOfLedger } from '@/lib/access'
import { messageFor } from '@/lib/action-messages'
import { currentActor, requireLedger, requireUser } from '@/lib/gate'
import { formatNumber } from '@/lib/numbers'
import { refuseUnlessOurs, type Owned } from '@/lib/ours'
import type { FormState } from '@/app/actions'
import { SRED_FIELDS } from '@/lib/sred-fields'
import {
  SredError, addEvidence as addSredEvidence, addSredEvidenceBatch, allocate as allocateSred,
  createSredProject, deleteSredEvidence, deleteSredProject, deleteSredTime,
  fileClaim as fileSredClaim, logSredTime, logSredTimeBatch, openClaim as openSredClaim,
  saveClaim as saveSredClaim, unallocate as unallocateSred, unfileClaim as unfileSredClaim, deleteSredClaim,
  deleteSredRate, saveSredRate, setSredAccountCategory,
  updateSredEvidence, updateSredProject, updateSredTime,
  type SredCategory,
} from '@/lib/sred'

/**
 * SR&ED — every door, behind the `/sred` seat.
 *
 * They all go through `sred.ts`, which is where the refusals are worded and
 * where the rules live. Nothing here computes anything.
 */
const SRED_OWNED: Array<[Owned, string]> = [
  ['sred_project', SRED_FIELDS.projectId], ['sred_claim', SRED_FIELDS.claimId],
  ['sred_time', SRED_FIELDS.timeId], ['sred_evidence', SRED_FIELDS.evidenceId],
  ['sred_allocation', SRED_FIELDS.allocationId], ['fiscal_year', SRED_FIELDS.fiscalYearId],
  ['employee', SRED_FIELDS.employeeId], ['account', SRED_FIELDS.categoryAccountId],
]

async function sredAction(
  formData: FormData, run: (actor: string) => Promise<unknown>,
): Promise<FormState> {
  const ledgerId = String(formData.get(SRED_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/sred')
  // Every id an SR&ED form can carry, judged against the ledger it came from —
  // here once, for the sixteen doors behind this function.
  const nope = await refuseUnlessOurs(SRED_OWNED.map(([kind, field]) => [kind, String(formData.get(field) ?? '')]), ledgerId)
  if (nope) return nope
  // The allocation's source is a pay stub or a journal line, as the form says.
  const sourceId = String(formData.get(SRED_FIELDS.sourceId) ?? '')
  const sourceKind: Owned = String(formData.get(SRED_FIELDS.sourceKind) ?? '') === 'pay_stub' ? 'pay_stub' : 'journal_line'
  const noSource = sourceId ? await refuseUnlessOurs([[sourceKind, sourceId]], ledgerId) : null
  if (noSource) return noSource
  try {
    await run(await currentActor())
    revalidatePath(`/ledger/${ledgerId}/sred`, 'layout')
    return { ok: 'Saved.' }
  } catch (e) {
    if (e instanceof SredError) return { error: e.message }
    return { error: messageFor(e) }
  }
}

export async function createSredProjectAction(_p: FormState, f: FormData): Promise<FormState> {
  const ledgerId = String(f.get(SRED_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/sred')
  const entityId = await entityOfLedger(ledgerId)
  if (!entityId) return { error: 'That ledger belongs to no company.' }
  try {
    const made = await createSredProject({
      entityId,
      code: String(f.get(SRED_FIELDS.code) ?? ''),
      title: String(f.get(SRED_FIELDS.title) ?? ''),
      startedOn: String(f.get(SRED_FIELDS.startedOn) ?? ''),
      fieldOfScience: String(f.get(SRED_FIELDS.fieldOfScience) ?? '') || undefined,
      actor: await currentActor(),
    })
    revalidatePath(`/ledger/${ledgerId}/sred`, 'layout')
    return { ok: 'Project opened.', madeId: made.id }
  } catch (e) {
    if (e instanceof SredError) return { error: e.message }
    return { error: messageFor(e) }
  }
}

export async function openSredClaimAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => openSredClaim({
    projectId: String(f.get(SRED_FIELDS.projectId) ?? ''),
    fiscalYearId: String(f.get(SRED_FIELDS.fiscalYearId) ?? ''),
    actor,
  }))
}

export async function saveSredClaimAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => saveSredClaim({
    claimId: String(f.get(SRED_FIELDS.claimId) ?? ''),
    method: (String(f.get(SRED_FIELDS.method) ?? 'proxy') === 'traditional' ? 'traditional' : 'proxy'),
    uncertainty: String(f.get(SRED_FIELDS.uncertainty) ?? '') || undefined,
    workDone: String(f.get(SRED_FIELDS.workDone) ?? '') || undefined,
    advancement: String(f.get(SRED_FIELDS.advancement) ?? '') || undefined,
    assistanceNote: String(f.get(SRED_FIELDS.assistanceNote) ?? '') || undefined,
    assistanceAnswered: f.get(SRED_FIELDS.assistanceAnswered) === 'yes',
    actor,
  }))
}

export async function logSredTimeAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => logSredTime({
    projectId: String(f.get(SRED_FIELDS.projectId) ?? ''),
    employeeId: String(f.get(SRED_FIELDS.employeeId) ?? ''),
    onDate: String(f.get(SRED_FIELDS.onDate) ?? ''),
    hours: String(f.get(SRED_FIELDS.hours) ?? ''),
    activity: String(f.get(SRED_FIELDS.activity) ?? ''),
    actor,
  }))
}

export async function addSredEvidenceAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => addSredEvidence({
    projectId: String(f.get(SRED_FIELDS.projectId) ?? ''),
    kind: String(f.get(SRED_FIELDS.kind) ?? ''),
    title: String(f.get(SRED_FIELDS.title) ?? ''),
    onDate: String(f.get(SRED_FIELDS.onDate) ?? ''),
    note: String(f.get(SRED_FIELDS.note) ?? '') || undefined,
    actor,
  }))
}

export async function allocateSredAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => allocateSred({
    claimId: String(f.get(SRED_FIELDS.claimId) ?? ''),
    sourceKind: String(f.get(SRED_FIELDS.sourceKind) ?? '') === 'pay_stub' ? 'pay_stub' : 'journal_line',
    sourceId: String(f.get(SRED_FIELDS.sourceId) ?? ''),
    category: String(f.get(SRED_FIELDS.category) ?? 'materials') as SredCategory,
    percent: String(f.get(SRED_FIELDS.percent) ?? ''),
    basis: String(f.get(SRED_FIELDS.basis) ?? ''),
    actor,
  }))
}

export async function unallocateSredAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) =>
    unallocateSred(String(f.get(SRED_FIELDS.allocationId) ?? ''), actor))
}

export async function fileSredClaimAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => fileSredClaim({
    claimId: String(f.get(SRED_FIELDS.claimId) ?? ''),
    filedOn: String(f.get(SRED_FIELDS.filedOn) ?? ''),
    actor,
  }))
}

/** A year's claim opened by mistake, deleted while it is not filed (0084). */
export async function deleteSredClaimAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => deleteSredClaim({
    claimId: String(f.get(SRED_FIELDS.claimId) ?? ''),
    actor,
  }))
}

export async function unfileSredClaimAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => unfileSredClaim({
    claimId: String(f.get(SRED_FIELDS.claimId) ?? ''),
    reason: String(f.get(SRED_FIELDS.reason) ?? ''),
    actor,
  }))
}

/**
 * A pasted batch, said back. ALL OR NOTHING, so there are exactly two answers:
 * how many went in, or which lines to fix and nothing went in. The refusals are
 * printed line by line because a batch of forty that says only "3 bad rows"
 * makes the person diff two documents by eye.
 */
function batchState(r: { added: number; refused: Array<{ line: number; text: string; why: string }> }): FormState {
  if (r.refused.length === 0) return { ok: `${r.added} row(s) added.` }
  return {
    error: `Nothing went in. ${formatNumber(r.refused.length)} line(s) to fix:\n`
      + r.refused.map((x) => `line ${x.line}: ${x.why}  —  ${x.text}`).join('\n'),
  }
}

export async function updateSredProjectAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => updateSredProject({
    projectId: String(f.get(SRED_FIELDS.projectId) ?? ''),
    code: String(f.get(SRED_FIELDS.code) ?? ''),
    title: String(f.get(SRED_FIELDS.title) ?? ''),
    startedOn: String(f.get(SRED_FIELDS.startedOn) ?? ''),
    fieldOfScience: String(f.get(SRED_FIELDS.fieldOfScience) ?? '') || undefined,
    status: String(f.get(SRED_FIELDS.status) ?? 'active'),
    endedOn: String(f.get(SRED_FIELDS.endedOn) ?? '') || undefined,
    actor,
  }))
}

export async function deleteSredProjectAction(_p: FormState, f: FormData): Promise<FormState> {
  // `sredAction` holds the gate; this one is here because the door does not
  // `return` its delegate, and `N14` reads for a gate it can see.
  await requireUser()
  const ledgerId = String(f.get(SRED_FIELDS.ledgerId) ?? '')
  const state = await sredAction(f, (actor) => deleteSredProject({
    projectId: String(f.get(SRED_FIELDS.projectId) ?? ''), actor,
  }))
  // The project's own page is gone with it, so going back to the list is the
  // only place left to be. The redirect is OUTSIDE the try in `sredAction`,
  // where Next's control-flow throw would have been caught and shown as an error.
  if (state.ok) redirect(`/ledger/${ledgerId}/sred`)
  return state
}

export async function updateSredTimeAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => updateSredTime({
    timeId: String(f.get(SRED_FIELDS.timeId) ?? ''),
    onDate: String(f.get(SRED_FIELDS.onDate) ?? ''),
    hours: String(f.get(SRED_FIELDS.hours) ?? ''),
    activity: String(f.get(SRED_FIELDS.activity) ?? ''),
    actor,
  }))
}

export async function deleteSredTimeAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => deleteSredTime({
    timeId: String(f.get(SRED_FIELDS.timeId) ?? ''), actor,
  }))
}

export async function updateSredEvidenceAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => updateSredEvidence({
    evidenceId: String(f.get(SRED_FIELDS.evidenceId) ?? ''),
    kind: String(f.get(SRED_FIELDS.kind) ?? ''),
    title: String(f.get(SRED_FIELDS.title) ?? ''),
    onDate: String(f.get(SRED_FIELDS.onDate) ?? ''),
    // Present means "this is the note", blank included; a form without the box leaves it alone.
    note: f.has(SRED_FIELDS.note) ? String(f.get(SRED_FIELDS.note) ?? '') : undefined,
    actor,
  }))
}

export async function deleteSredEvidenceAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => deleteSredEvidence({
    evidenceId: String(f.get(SRED_FIELDS.evidenceId) ?? ''), actor,
  }))
}

export async function logSredTimeBatchAction(_p: FormState, f: FormData): Promise<FormState> {
  const ledgerId = String(f.get(SRED_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/sred')
  const nope = await refuseUnlessOurs([['sred_project', String(f.get(SRED_FIELDS.projectId) ?? '')]], ledgerId)
  if (nope) return nope
  const entityId = await entityOfLedger(ledgerId)
  if (!entityId) return { error: 'That ledger belongs to no company.' }
  try {
    const r = await logSredTimeBatch({
      projectId: String(f.get(SRED_FIELDS.projectId) ?? ''), entityId,
      text: String(f.get(SRED_FIELDS.paste) ?? ''), actor: await currentActor(),
    })
    revalidatePath(`/ledger/${ledgerId}/sred`, 'layout')
    return batchState(r)
  } catch (e) {
    if (e instanceof SredError) return { error: e.message }
    return { error: messageFor(e) }
  }
}

export async function addSredEvidenceBatchAction(_p: FormState, f: FormData): Promise<FormState> {
  const ledgerId = String(f.get(SRED_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/sred')
  const nope = await refuseUnlessOurs([['sred_project', String(f.get(SRED_FIELDS.projectId) ?? '')]], ledgerId)
  if (nope) return nope
  try {
    const r = await addSredEvidenceBatch({
      projectId: String(f.get(SRED_FIELDS.projectId) ?? ''),
      text: String(f.get(SRED_FIELDS.paste) ?? ''), actor: await currentActor(),
    })
    revalidatePath(`/ledger/${ledgerId}/sred`, 'layout')
    return batchState(r)
  } catch (e) {
    if (e instanceof SredError) return { error: e.message }
    return { error: messageFor(e) }
  }
}

export async function saveSredRateAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => saveSredRate({
    rateId: String(f.get(SRED_FIELDS.rateId) ?? '') || undefined,
    jurisdiction: String(f.get(SRED_FIELDS.jurisdiction) ?? ''),
    name: String(f.get(SRED_FIELDS.rateName) ?? ''),
    value: String(f.get(SRED_FIELDS.value) ?? ''),
    effectiveFrom: String(f.get(SRED_FIELDS.effectiveFrom) ?? ''),
    effectiveTo: String(f.get(SRED_FIELDS.effectiveTo) ?? '') || undefined,
    authority: String(f.get(SRED_FIELDS.authority) ?? ''),
    confidence: String(f.get(SRED_FIELDS.confidence) ?? ''),
    note: String(f.get(SRED_FIELDS.note) ?? '') || undefined,
    actor,
  }))
}

export async function deleteSredRateAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => deleteSredRate({
    rateId: String(f.get(SRED_FIELDS.rateId) ?? ''), actor,
  }))
}

/** An account's T661 line, tagged from the SR&ED screen (0156). */
export async function setSredAccountCategoryAction(_p: FormState, f: FormData): Promise<FormState> {
  return sredAction(f, (actor) => setSredAccountCategory({
    accountId: String(f.get(SRED_FIELDS.categoryAccountId) ?? ''),
    category: String(f.get(SRED_FIELDS.accountCategory) ?? '') || null, actor,
  }))
}

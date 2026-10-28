import 'server-only'
import { type FormResult, sentenceOf, g, COMPANY_FIELDS as F } from './forms'
import { CompanyError, archiveCompany, deleteCompany, renameCompany, unarchiveCompany } from './companies'

/**
 * Reading the archive/delete forms. Separate from `app/actions.ts` for the
 * reason every *-forms.ts is: a check can call this and cannot call a server
 * action.
 */

export type { FormResult }

const sentence = (e: unknown) => sentenceOf(e, CompanyError)

export async function archiveCompanyFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    const company = await archiveCompany(g(f, F.entityId), g(f, F.reason), actor)
    return {
      ok: `${company.name} is archived. Its books stay exactly as they are; nothing more can be `
        + 'posted into it until you bring it back.',
    }
  } catch (e) {
    return { error: sentence(e) }
  }
}

export async function unarchiveCompanyFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    const company = await unarchiveCompany(g(f, F.entityId), actor)
    return { ok: `${company.name} is back. It can be posted into again.` }
  } catch (e) {
    return { error: sentence(e) }
  }
}

/**
 * Removing a company for good. The typed confirmation is the screen's half of
 * the rule the library enforces: `deleteCompany` refuses a company with
 * anything in its books or a question to the assistant, whatever the form says, and this asks the person to type the
 * code so the irreversible half is never one stray click.
 */
export async function deleteCompanyFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    const typed = g(f, F.confirm)
    const expected = g(f, F.code)
    if (!expected || typed !== expected) {
      return { error: `Type ${expected || 'the company code'} to confirm — this cannot be undone.` }
    }
    const gone = await deleteCompany(g(f, F.entityId), actor)
    return { ok: `${gone.name} (${gone.code}) is gone. The audit trail keeps that it existed and who removed it.` }
  } catch (e) {
    return { error: sentence(e) }
  }
}

/** A company's name and province put right; its papers' folder moves with the name (0084). */
export async function renameCompanyFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    const done = await renameCompany({ entityId: g(f, F.entityId), name: g(f, F.name), province: g(f, F.province), actor })
    return {
      ok: `Saved: ${done.name}${done.province ? `, ${done.province}` : ''}.`
        + (done.movedFolder ? ' Its folder of papers was renamed with it.' : ''),
    }
  } catch (e) {
    return { error: sentence(e) }
  }
}

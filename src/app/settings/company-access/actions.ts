'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/gate'
import { AccessError } from '@/lib/access'
import { setCompanyModules } from '@/lib/company-modules'
import type { FormState } from '@/app/actions'
import { moduleInputError } from '@/lib/module-extensions'

export async function companyModulesAction(_previous: FormState, form: FormData): Promise<FormState> {
  const me = await requireUser()
  try {
    let expected: unknown
    try { expected = JSON.parse(String(form.get('expectedModules') ?? '')) } catch { throw new AccessError('BAD_STATE', 'Reload this page before saving.') }
    if (!Array.isArray(expected) || expected.some(m => typeof m !== 'string')) throw new AccessError('BAD_STATE', 'Reload this page before saving.')
    await setCompanyModules(me, {
      entityId: String(form.get('entityId') ?? ''),
      modules: form.getAll('module').map(String),
      expectedModules: expected,
    })
    revalidatePath('/', 'layout')
    return { ok: 'Company access saved.' }
  } catch (e) {
    if (e instanceof AccessError || (e instanceof Error && await moduleInputError(e))) return { error: e.message }
    throw e
  }
}

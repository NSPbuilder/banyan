'use server'

import { revalidatePath } from 'next/cache'
import type { FormState } from '@/app/actions'
import { requireOwner, requireLedger, actorOf } from '@/lib/gate'
import { signingCompany, saveSigningConnection, signingSentence } from '@/lib/esign'

export async function connectDocumensoAction(_previous: FormState, form: FormData): Promise<FormState> {
  const owner = await requireOwner(), ledgerId = String(form.get('ledgerId') ?? '')
  await requireLedger(ledgerId, '/documents')
  try {
    const company = await signingCompany(ledgerId)
    await saveSigningConnection({ entityId: company.id, actor: actorOf(owner), apiKey: String(form.get('apiKey') ?? ''), webhookSecret: String(form.get('webhookSecret') ?? '') })
    revalidatePath('/settings')
    revalidatePath(`/ledger/${ledgerId}/documents`, 'layout')
    return { ok: 'Documenso connected.' }
  } catch (error) { return { error: signingSentence(error) } }
}

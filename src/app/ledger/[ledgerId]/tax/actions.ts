'use server'
import { requireLedger } from '@/lib/gate'
import { revalidatePath } from 'next/cache'
import { GstAdjustmentError, saveGstAdjustment } from '@/lib/gst-adjustments'
import type { FormState } from '@/app/actions'

export async function saveGstAdjustmentsAction(_previous: FormState, form: FormData): Promise<FormState> {
  const ledgerId = String(form.get('ledgerId') ?? '')
  const me = await requireLedger(ledgerId, '/tax')
  try {
    const result = await saveGstAdjustment(ledgerId, me.email, {
      from: String(form.get('from') ?? ''), to: String(form.get('to') ?? ''),
      version: Number(form.get('version')), reason: String(form.get('reason') ?? ''),
      sales: String(form.get('sales') ?? ''), collected: String(form.get('collected') ?? ''),
      itcs: String(form.get('itcs') ?? ''), reset: form.get('intent') === 'reset',
    })
    revalidatePath(`/ledger/${ledgerId}/tax`)
    return { ok: form.get('intent') === 'reset' ? 'Book figures restored.' : 'Return figures saved.', version: String(result.version) }
  } catch (e) {
    if (e instanceof GstAdjustmentError) return { error: e.message }
    throw e
  }
}

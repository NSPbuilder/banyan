import 'server-only'
import { type FormResult, g, ASSISTANT_FIELDS as F } from './forms'
import { AiServiceError, clearService, saveService } from './ai-service'

export type { FormResult }


/** The person the form is acting for: enough to find their service and to sign the row. */
export type Asker = { id: string; email: string }

/** Save (or change) the person's service. A blank key keeps the one already saved. */
export async function saveServiceFromForm(f: FormData, who: Asker): Promise<FormResult> {
  try {
    const saved = await saveService({
      userId: who.id, actor: who.email,
      baseUrl: g(f, F.baseUrl), apiKey: g(f, F.apiKey), model: g(f, F.model),
      priceInput: g(f, F.priceInput), priceOutput: g(f, F.priceOutput),
      priceCached: g(f, F.priceCached), priceUnit: g(f, F.priceUnit),
    })
    return { ok: `Saved: ${saved.service.model} at ${new URL(saved.service.baseUrl).host}, key ending …${saved.hint}.` }
  } catch (e) {
    return { error: e instanceof AiServiceError ? e.message : (e instanceof Error ? e.message : String(e)) }
  }
}

export async function clearServiceFromForm(who: Asker): Promise<FormResult> {
  try {
    await clearService(who.id, who.email)
    return { ok: 'Forgotten. Your askings stay on record; the key was never in them.' }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

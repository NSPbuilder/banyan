import 'server-only'
import { sentenceOf, g, BILL_FIELDS as F } from './forms'
import { sendToRelay, type Send } from './assistant'
import { serviceState } from './ai-service'
import { BillReadingError, discardReading, readBill, readingById, readingLabel } from './bill-reading'
import type { Asker } from './assistant-forms'

/**
 * Reading the read-a-bill form, the way every other *-forms.ts reads its
 * form: a check can call this and cannot call a server action. The service
 * is the person's saved one (0063), as it is for a question; the form carries
 * the company and the file, nothing secret. The sender is a parameter so a
 * suite can hand in a stand-in and nothing reaches the network.
 */

export type FormResult = { ok?: string; error?: string; readingId?: string }


const sentence = (e: unknown) => sentenceOf(e, BillReadingError)

export async function readBillFromForm(f: FormData, who: Asker, send: Send = sendToRelay): Promise<FormResult> {
  try {
    const state = await serviceState(who.id)
    if (state.kind !== 'ready') {
      return {
        error: state.kind === 'none'
          ? 'Save your service first — its address, your key and a model name, in the box above.'
          : `Your saved key (ending …${state.hint}) can no longer be read; the application's secret has changed. Enter it again.`,
      }
    }
    // A file box left empty still arrives: an unnamed file of no bytes. That is no file.
    const file = f.get(F.file)
    const chosen = file instanceof File && file.size > 0 ? file : null
    const sentence = g(f, F.sentence)
    if (!chosen && !sentence) {
      // A file that was chosen and is empty says so; a form with nothing in it asks for something.
      const empty = file instanceof File && file.name !== ''
      return { error: empty ? `${file.name} is empty — nothing arrived to read.` : 'Write what happened, or choose the document — nothing arrived to read.' }
    }
    const reading = await readBill({
      ledgerId: g(f, F.ledgerId),
      ...(chosen ? { filename: chosen.name, mime: chosen.type, bytes: Buffer.from(await chosen.arrayBuffer()) } : {}),
      sentence: sentence || undefined,
      actor: who.email, service: state.saved.service, prices: state.saved.prices,
    }, send)
    const label = chosen ? chosen.name : 'Your sentence'
    if (reading.error !== null) {
      return { error: `${label} was kept, but the model could not read it: ${reading.error}`, readingId: reading.id }
    }
    const n = reading.proposal?.lines.length ?? 0
    return {
      ok: `${label} read: ${n} line${n === 1 ? '' : 's'}. Choose how to enter it below, then review.`,
      readingId: reading.id,
    }
  } catch (e) {
    return { error: sentence(e) }
  }
}

export async function discardReadingFromForm(f: FormData): Promise<FormResult> {
  try {
    const ledgerId = g(f, F.ledgerId)
    const id = g(f, F.readingId)
    const reading = await readingById(ledgerId, id)
    if (!reading) return { error: 'That reading is not in these books.' }
    if (reading.used_entry_id !== null) {
      return { error: 'That bill has been entered; it stays on record with its entry.' }
    }
    await discardReading(ledgerId, id)
    return { ok: `${readingLabel(reading)} discarded. The asking itself stays on record.` }
  } catch (e) {
    return { error: sentence(e) }
  }
}

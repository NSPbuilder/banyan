import 'server-only'
import { AttachmentError, deleteAttachment, saveAttachment, unwaiveReceipt, waiveReceipt } from './attachments'
import { type FormResult, sentenceOf, ATTACH_FIELD } from './forms'

/**
 * Reading the attachment forms. Separate from `app/actions.ts` for the reason
 * every *-forms.ts is: a check can call this and cannot call a server action.
 */

export type { FormResult }

/**
 * The file a create form carried, filed against the entry it just made.
 *
 * AFTER the posting, never before, and never fatal: the entry IS in the books
 * by the time this runs, so a store that refuses must not be reported as a
 * failed posting — that reads as "nothing happened" and invites a second one
 * (the same rule the bill reading follows, `quick-forms.ts`). It returns a
 * sentence to add to what the door already said.
 */
export async function attachIfAny(
  f: FormData, input: { ledgerId: string; entryId: string; actor: string },
): Promise<string> {
  const file = f.get(ATTACH_FIELD)
  if (!(file instanceof File) || file.size === 0) return ''
  try {
    await saveAttachment({
      ledgerId: input.ledgerId, entryId: input.entryId,
      filename: file.name, bytes: Buffer.from(await file.arrayBuffer()),
      mime: file.type, actor: input.actor,
    })
    return ' The file is filed against it.'
  } catch (e) {
    return ` The file could not be filed against it (${sentence(e)}); attach it from the entry by hand.`
  }
}

const sentence = (e: unknown) => sentenceOf(e, AttachmentError)

export async function uploadAttachmentFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    const file = f.get('file')
    if (!(file instanceof File) || file.size === 0) {
      return { error: 'Choose a file first — nothing arrived to keep.' }
    }
    await saveAttachment({
      ledgerId: String(f.get('ledgerId') ?? ''),
      entryId: String(f.get('entryId') ?? ''),
      filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
      mime: file.type,
      actor,
    })
    return { ok: `${file.name} filed — it now sits in every touched account's folder.` }
  } catch (e) {
    return { error: sentence(e) }
  }
}

export async function deleteAttachmentFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    await deleteAttachment(String(f.get('ledgerId') ?? ''), String(f.get('attachmentId') ?? ''), actor,
      String(f.get('reason') ?? ''))
    return { ok: 'Unfiled. The file itself stays in the store.' }
  } catch (e) {
    return { error: sentence(e) }
  }
}

export async function waiveReceiptFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    const lift = String(f.get('lift') ?? '') === 'yes'
    const ledgerId = String(f.get('ledgerId') ?? '')
    const entryId = String(f.get('entryId') ?? '')
    if (lift) {
      await unwaiveReceipt(ledgerId, entryId, actor)
      return { ok: 'Back on the list — it will be chased until paper arrives.' }
    }
    await waiveReceipt(ledgerId, entryId, actor)
    return { ok: 'Marked as needing no supporting document.' }
  } catch (e) {
    return { error: sentence(e) }
  }
}

import 'server-only'
import { AttachmentError } from './attachments'
import { fileMinuteBookDocument } from '@/modules/records/attachments'
import { minuteKinds } from './record-forms'
import { rowProblems } from './record-entry'
import { g, sentenceOf } from './forms'
import { type MinuteDocumentMetadata, type MinuteUploadResult } from './minute-book'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The URL company is authoritative; ledger/entity fields in a form cannot
 * redirect storage into another company. The route authenticates first. */
export async function uploadMinuteBookFromForm(ledgerId: string, f: FormData, actor: string): Promise<MinuteUploadResult> {
  const minuteId = g(f, 'minuteId'), mode = g(f, 'mode')
  if (!UUID.test(ledgerId) || !UUID.test(minuteId)) return { error: 'Choose a valid company and record.' }
  if (mode !== 'create' && mode !== 'append') return { error: 'Choose whether to add or attach documents.' }
  const file = f.get('file')
  if (!(file instanceof File) || !file.size) return { error: 'Choose a file first.' }
  let create: MinuteDocumentMetadata | undefined
  if (mode === 'create') {
    create = {
      recordKind: g(f, 'recordKind'), onDate: g(f, 'onDate'), title: g(f, 'title'),
      keptAt: g(f, 'keptAt') || 'FigTree', note: g(f, 'note'),
    }
    const errors = rowProblems('minute_book', [{ line: 1, values: create }], await minuteKinds())
      .map(p => p.replace(/^Row 1: /, ''))
    if (create.title.length > 255) errors.push('Keep the title within 255 characters.')
    if (create.keptAt.length > 500 || create.note.length > 10000) errors.push('The location or note is too long.')
    // Regex validation alone accepts 2026-02-30. Never let PostgreSQL silently
    // interpret a different date or reduce an invalid request to a generic error.
    const date = new Date(`${create.onDate}T12:00:00Z`)
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== create.onDate) errors.push('Enter a valid record date.')
    if (errors.length) return { error: errors.join(' ') }
  }
  try {
    const result = await fileMinuteBookDocument({
      ledgerId, minuteId, filename: file.name, bytes: Buffer.from(await file.arrayBuffer()),
      mime: file.type, actor, create, idempotent: true,
    })
    return { ok: result.alreadyFiled ? 'Already attached.' : 'Document attached.', minuteId, paperId: result.id, alreadyFiled: result.alreadyFiled }
  } catch (error) {
    return { error: sentenceOf(error, AttachmentError) }
  }
}

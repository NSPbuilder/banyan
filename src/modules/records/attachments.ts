import 'server-only'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs } from '@/lib/acting'
import { ledgerHead } from '@/lib/ledger-head'
import { auditRow } from '@/lib/audit-row'
import { ATTACHMENT_MAX_BYTES } from '@/lib/forms'
import { AttachmentError, attachmentStorage, writeBlobBytes } from '@/lib/attachments'
import { minuteFileMime, type MinuteDocumentMetadata } from '@/lib/minute-book'
import type { ModulePaper } from '@/lib/module-extensions'
const { root, blobPath, findBlob, linkInto, assertDocument, folderName } = attachmentStorage

type MinuteHead = {
  id: string; on_date: string; record_kind: string; title: string
  entity_id: string; entity: string
}

async function minuteHead(ledgerId: string, minuteId: string): Promise<MinuteHead | null> {
  const [row] = await db.execute<MinuteHead>(sql`
    SELECT m.id::text, m.on_date::text, m.record_kind, m.title, e.id::text AS entity_id, e.name AS entity
      FROM minute_book_entry m
      JOIN entity e ON e.id = m.entity_id
      JOIN ledger l ON l.entity_id = e.id
     WHERE m.id = ${minuteId}::uuid AND l.id = ${ledgerId}::uuid`)
  return row ?? null
}

export function minuteBookName(m: Pick<MinuteHead, 'on_date' | 'record_kind' | 'title'>, uploaded: string): string {
  const ext = path.extname(uploaded).toLowerCase().slice(0, 10)
  return `${m.on_date} ${m.record_kind.replaceAll('_', ' ')} ${m.title}`.slice(0, 160).trim() + ext
}

function minuteBookPath(m: MinuteHead, sha: string, uploaded: string): string {
  const ext = path.extname(uploaded).toLowerCase().slice(0, 10)
  const base = minuteBookName(m, '').slice(0, 150)
  return path.join(root(), folderName(m.entity), 'Minute book', m.on_date.slice(0, 4),
    folderName(`${base} ${sha.slice(0, 8)}${ext}`))
}

export type MinuteBookPaper = {
  id: string; minute_book_entry_id: string; sha256: string
  /** What it is filed as — derived from the record, every time. */
  filename: string
  uploaded: string; mime: string; byte_size: string; created_at: string
}

export async function minuteBookPaperOf(entityId: string): Promise<MinuteBookPaper[]> {
  const rows = await db.execute<Omit<MinuteBookPaper, 'filename'> & Pick<MinuteHead, 'on_date' | 'record_kind' | 'title'>>(sql`
    SELECT p.id::text, p.minute_book_entry_id::text, p.sha256, p.filename AS uploaded, b.mime,
           b.byte_size::text, p.created_at::text, m.on_date::text, m.record_kind, m.title
      FROM minute_book_attachment p
      JOIN attachment_blob b ON b.sha256 = p.sha256
      JOIN minute_book_entry m ON m.id = p.minute_book_entry_id
     WHERE m.entity_id = ${entityId}::uuid
     ORDER BY p.created_at, p.id`)
  return rows.map((r) => ({ ...r, filename: minuteBookName(r, r.uploaded) }))
}

async function minuteBookPaperWithContext(entityId: string) {
  return db.execute<MinuteHead & {
    paper_id: string; sha256: string; uploaded: string
    mime: string; byte_size: string; created_at: string
  }>(sql`
    SELECT m.id::text, m.on_date::text, m.record_kind, m.title, e.id::text AS entity_id, e.name AS entity,
           p.id::text AS paper_id, p.sha256, p.filename AS uploaded,
           b.mime, b.byte_size::text, p.created_at::text
      FROM minute_book_attachment p
      JOIN minute_book_entry m ON m.id = p.minute_book_entry_id
      JOIN entity e ON e.id = m.entity_id
      JOIN attachment_blob b ON b.sha256 = p.sha256
     WHERE e.id = ${entityId}::uuid
     ORDER BY m.on_date, p.created_at, p.id`)
}

export async function attachToMinuteBook(input: {
  ledgerId: string; minuteId: string; filename: string; bytes: Buffer; mime: string; actor?: string
}): Promise<{ id: string; sha256: string }> {
  assertDocument(input)
  return fileMinuteBookDocument(input)
}

export async function fileMinuteBookDocument(input: {
  ledgerId: string; minuteId: string; filename: string; bytes: Buffer; mime: string; actor?: string
  create?: MinuteDocumentMetadata; idempotent?: boolean
}): Promise<{ id: string; sha256: string; alreadyFiled: boolean }> {
  const actor = input.actor ?? 'system'
  if (!input.bytes.length) throw new AttachmentError('EMPTY_FILE', 'The file is empty.')
  if (input.bytes.length > ATTACHMENT_MAX_BYTES) throw new AttachmentError('TOO_BIG', 'The limit is 25 MB per file.')
  if (!input.filename || input.filename.length > 255 || /[\r\n\0]/.test(input.filename)) {
    throw new AttachmentError('BAD_NAME', 'Use a filename of 1–255 characters without line breaks.')
  }
  // Existing AI/legacy filing accepted an extensionless PDF or image by MIME.
  // Keep that contract; the new browser endpoint uses the extension allowlist.
  const mime = minuteFileMime(input.filename) ?? (!input.create && !input.idempotent && attachmentStorage.mimeAllowed(input.mime) ? input.mime : null)
  if (!mime) throw new AttachmentError('NOT_A_DOCUMENT', 'Choose a PDF, image, DOCX, XLSX, PPTX or TXT file.')
  const company = await ledgerHead(input.ledgerId)
  if (!company) throw new AttachmentError('NO_SUCH_RECORD', 'There is no such company.')
  const existing = await minuteHead(input.ledgerId, input.minuteId)
  if (!existing && !input.create) throw new AttachmentError('NO_SUCH_RECORD', 'There is no such minute-book record in these books.')
  const digest = createHash('sha256').update(input.bytes).digest('hex')
  await writeBlobBytes(company.entity, digest, input.bytes)
  let made: { id: string; alreadyFiled: boolean; head: MinuteHead; uploaded: string }
  try {
    made = await actingAs(actor, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('minute_book:' || ${input.minuteId}, 0))`)
      let [head] = await tx.execute<MinuteHead>(sql`
        SELECT id::text, on_date::text, record_kind, title, entity_id::text, ${company.entity} AS entity
          FROM minute_book_entry WHERE id = ${input.minuteId}::uuid FOR UPDATE`)
      if (head && head.entity_id !== company.entity_id) {
        throw new AttachmentError('NO_SUCH_RECORD', 'There is no such minute-book record in these books.')
      }
      if (head) {
        const [paper] = await tx.execute<{ id: string; filename: string }>(sql`
          SELECT id::text, filename FROM minute_book_attachment
           WHERE minute_book_entry_id = ${input.minuteId}::uuid AND sha256 = ${digest}`)
        if (paper && input.idempotent) return { id: paper.id, alreadyFiled: true, head, uploaded: paper.filename }
        if (input.create) throw new AttachmentError('RECORD_EXISTS', 'That record already exists. Open it to add documents.')
      } else if (input.create) {
        const c = input.create
        ;[head] = await tx.execute<MinuteHead>(sql`
          INSERT INTO minute_book_entry (id, entity_id, record_kind, on_date, title, kept_at, note, created_by)
          VALUES (${input.minuteId}::uuid, ${company.entity_id}::uuid, ${c.recordKind}, ${c.onDate}::date,
                  ${c.title}, ${c.keptAt}, ${c.note || null}, ${actor})
          RETURNING id::text, entity_id::text, on_date::text, record_kind, title, ${company.entity} AS entity`)
      } else throw new AttachmentError('NO_SUCH_RECORD', 'There is no such minute-book record in these books.')
      await tx.execute(sql`
        INSERT INTO attachment_blob (sha256, byte_size, mime, created_by)
        VALUES (${digest}, ${input.bytes.length}, ${mime}, ${actor})
        ON CONFLICT (sha256) DO NOTHING`)
      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO minute_book_attachment (minute_book_entry_id, sha256, filename, created_by)
        VALUES (${input.minuteId}::uuid, ${digest}, ${input.filename}, ${actor})
        RETURNING id::text`)
      await auditRow(tx, {
        actor, action: 'attach', table: 'minute_book_attachment', recordId: row.id,
        entityId: head.entity_id, ledgerId: input.ledgerId, scope: 'company',
        targetLabel: input.filename,
        after: { sha256: digest, filename: input.filename, bytes: input.bytes.length },
        context: { minuteBookEntryId: head.id, onDate: head.on_date, title: head.title },
      })
      return { ...row, alreadyFiled: false, head, uploaded: input.filename }
    })
  } catch (e) {
    const text = `${String(e)} ${String((e as { cause?: unknown }).cause ?? '')}`
    if (text.includes('minute_book_attachment_once')) {
      throw new AttachmentError('ALREADY_ATTACHED',
        'This exact file is already on this minute-book record — same bytes, same document.')
    }
    throw e
  }

  // A retry also repairs a missing derived link, without duplicating audit rows.
  await linkInto(minuteBookPath(made.head, digest, made.uploaded), blobPath(company.entity, digest))
  return { id: made.id, sha256: digest, alreadyFiled: made.alreadyFiled }
}

export async function detachFromMinuteBook(
  ledgerId: string, paperId: string, actor: string, reason: string,
) {
  const why = reason.trim()
  if (!why) throw new AttachmentError('NO_REASON', 'Say why this minute-book document is being unfiled.')
  const paper = await actingAs(actor, async (tx) => {
    const [held] = await tx.execute<{
      minute_id: string; sha256: string; uploaded: string; entity_id: string; title: string
    }>(sql`
      SELECT p.minute_book_entry_id::text AS minute_id, p.sha256, p.filename AS uploaded,
             m.entity_id::text, m.title
        FROM minute_book_attachment p
        JOIN minute_book_entry m ON m.id = p.minute_book_entry_id
        JOIN ledger l ON l.entity_id = m.entity_id
       WHERE p.id = ${paperId}::uuid AND l.id = ${ledgerId}::uuid
       FOR UPDATE OF p`)
    if (!held) throw new AttachmentError('NO_SUCH_ATTACHMENT', 'There is no such attachment.')
    await tx.execute(sql`DELETE FROM minute_book_attachment WHERE id = ${paperId}::uuid`)
    await auditRow(tx, {
      actor, action: 'detach', table: 'minute_book_attachment', recordId: paperId,
      entityId: held.entity_id, ledgerId, scope: 'company', targetLabel: held.uploaded,
      before: { sha256: held.sha256, filename: held.uploaded },
      context: { minuteBookEntryId: held.minute_id, title: held.title, reason: why, note: 'blob kept' },
      reason: why,
    })
    return held
  })
  const m = (await minuteHead(ledgerId, paper.minute_id))!
  await fs.rm(minuteBookPath(m, paper.sha256, paper.uploaded), { force: true })
}

export type MinuteLinks = { head: MinuteHead; papers: Array<{ sha256: string; uploaded: string }> }

export async function minuteBookLinks(ledgerId: string, minuteId: string): Promise<MinuteLinks | null> {
  const head = await minuteHead(ledgerId, minuteId)
  if (!head) return null
  const papers = await db.execute<{ sha256: string; uploaded: string }>(sql`
    SELECT sha256, filename AS uploaded FROM minute_book_attachment
     WHERE minute_book_entry_id = ${minuteId}::uuid ORDER BY created_at, id`)
  return { head, papers: [...papers] }
}

export async function refileMinuteBookLinks(ledgerId: string, before: MinuteLinks): Promise<void> {
  const after = await minuteHead(ledgerId, before.head.id)
  if (!after) return
  for (const p of before.papers) {
    const was = minuteBookPath(before.head, p.sha256, p.uploaded)
    const is = minuteBookPath(after, p.sha256, p.uploaded)
    if (was === is) continue
    await fs.rm(was, { force: true })
    await linkInto(is, await findBlob(after.entity, p.sha256, p.uploaded))
  }
}

export async function unlinkMinuteBookLinks(before: MinuteLinks): Promise<void> {
  for (const p of before.papers) {
    await fs.rm(minuteBookPath(before.head, p.sha256, p.uploaded), { force: true })
  }
}

export async function minuteBookPaperFile(ledgerId: string, paperId: string) {
  const [row] = await db.execute<Pick<MinuteHead, 'on_date' | 'record_kind' | 'title' | 'entity'> & {
    sha256: string; uploaded: string; mime: string
  }>(sql`
    SELECT m.on_date::text, m.record_kind, m.title, e.name AS entity, p.sha256, p.filename AS uploaded, b.mime
      FROM minute_book_attachment p
      JOIN attachment_blob b ON b.sha256 = p.sha256
      JOIN minute_book_entry m ON m.id = p.minute_book_entry_id
      JOIN entity e ON e.id = m.entity_id
      JOIN ledger l ON l.entity_id = e.id
     WHERE p.id = ${paperId}::uuid AND l.id = ${ledgerId}::uuid`)
  if (!row) return null
  const bytes = await fs.readFile(await findBlob(row.entity, row.sha256, row.uploaded))
  return { bytes, filename: minuteBookName(row, row.uploaded), uploaded: row.uploaded, mime: row.mime }
}
export async function paperFiles(entityId: string): Promise<ModulePaper[]> {
  return (await minuteBookPaperWithContext(entityId)).map(paper => ({
    id: paper.paper_id, entity: paper.entity, sha256: paper.sha256, uploaded: paper.uploaded,
    filename: minuteBookName(paper, paper.uploaded), mime: paper.mime, byte_size: paper.byte_size, created_at: paper.created_at,
    destination: minuteBookPath(paper, paper.sha256, paper.uploaded), folderLabel: 'Minute book', seat: '/records',
  }))
}

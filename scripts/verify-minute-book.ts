import './env'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql as query } from 'drizzle-orm'
import { db, sql } from '../src/db/client'
import { createCompany } from '../src/lib/setup'
import { uploadMinuteBookFromForm } from '../src/lib/minute-book-forms'
import { webdavFilesOf } from '../src/lib/attachments'
import { attachToMinuteBook, fileMinuteBookDocument, minuteBookPaperFile, minuteBookPaperOf } from '../src/modules/records/attachments'
import { minuteKinds, correctRowFromForm, removeRowFromForm, detachMinuteBookFromForm } from '../src/lib/record-forms'
import { RECORD_FIELDS as F, rowField } from '../src/lib/forms'
import { exportCompany } from '../src/lib/backup'

const actor = 'minute-book-test@example.test'
let checks = 0
const check = (value: unknown, label: string) => { assert(value, label); checks++; console.log(`PASS  ${label}`) }

async function main() {
  const [{ name }] = await db.execute<{ name: string }>(query`SELECT current_database() AS name`)
  assert(name.startsWith('figtree_') && name.endsWith('_test') && name === new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1) && name !== new URL(process.env.APP_DATABASE_URL!).pathname.slice(1) && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.TEST_DATABASE_URL!).hostname), 'Use a fresh isolated minute-book test database')
  const scratch = await mkdtemp(path.join(tmpdir(), 'figtree-minute-book-paper-'))
  process.env.ATTACHMENTS_DIR = scratch
  try {
    const a = await createCompany({ code: 'MB-A', name: 'Minute Book Test A' }, actor)
    const b = await createCompany({ code: 'MB-B', name: 'Minute Book Test B' }, actor)
    const L = a.ledger.id, M = randomUUID()
    const bytes = Buffer.from('%PDF-1.7\nSigned test bytes /ByteRange [0 1 2 3]\n%%EOF')
    const form = (minuteId: string, mode = 'create', filename = 'Signed incorporation.pdf', content = bytes) => {
      const f = new FormData()
      for (const [k, v] of Object.entries({ minuteId, mode, recordKind: 'incorporation', onDate: '2026-01-05', title: 'Incorporation package', note: 'Fictitious files', file: '' })) f.set(k, v)
      f.set('file', new File([content], filename, { type: 'application/pdf' }))
      return f
    }
    const kinds = await minuteKinds()
    check(kinds.includes('memo') && kinds.includes('incorporation') && kinds.includes('articles'), 'New and existing kinds coexist')
    const badDate = form(randomUUID()); badDate.set('onDate', '2026-02-30')
    check((await uploadMinuteBookFromForm(L, badDate, actor)).error?.includes('valid record date'), 'Impossible date refused before creation')
    const badKind = form(randomUUID()); badKind.set('recordKind', 'invented')
    check((await uploadMinuteBookFromForm(L, badKind, actor)).error, 'Unknown kind refused')
    const empty = form(randomUUID(), 'create', 'empty.pdf', Buffer.alloc(0))
    check((await uploadMinuteBookFromForm(L, empty, actor)).error, 'Empty file refused')
    const html = form(randomUUID(), 'create', 'unsafe.html')
    check((await uploadMinuteBookFromForm(L, html, actor)).error, 'HTML refused despite forged PDF MIME')
    const tooBig = form(randomUUID(), 'create', 'large.pdf', Buffer.alloc(25 * 1024 * 1024 + 1))
    check((await uploadMinuteBookFromForm(L, tooBig, actor)).error?.includes('25 MB'), 'Per-file limit independently enforced')
    const [{ count: before }] = await db.execute<{ count: number }>(query`SELECT count(*)::int AS count FROM minute_book_entry`)
    check(before === 0, 'Invalid requests leave no metadata records')
    const first = await uploadMinuteBookFromForm(L, form(M), actor)
    check(first.ok && first.minuteId === M && first.paperId, 'First file and metadata stored together')
    const [{ location }] = await db.execute<{ location: string }>(query`SELECT kept_at AS location FROM minute_book_entry WHERE id = ${M}::uuid`)
    check(location === 'FigTree', 'No mandatory external storage location')
    const returned = await minuteBookPaperFile(L, first.paperId!)
    check(returned?.bytes.equals(bytes), 'Signed PDF bytes preserved exactly')
    check(returned?.uploaded === 'Signed incorporation.pdf', 'Original filename preserved for retrieval')
    const retry = await uploadMinuteBookFromForm(L, form(M), actor)
    check(retry.alreadyFiled && retry.paperId === first.paperId, 'Lost first response can be retried without another record or binding')
    const second = await uploadMinuteBookFromForm(L, form(M, 'append', 'Articles.pdf', Buffer.from('%PDF Articles')), actor)
    check(second.ok && second.paperId !== first.paperId, 'A record keeps multiple distinct documents')
    const [r1, r2] = await Promise.all([
      uploadMinuteBookFromForm(L, form(M, 'append', 'Memo.docx', Buffer.from('fictitious docx')), actor),
      uploadMinuteBookFromForm(L, form(M, 'append', 'Memo.docx', Buffer.from('fictitious docx')), actor),
    ])
    check(r1.paperId === r2.paperId && Boolean(r1.alreadyFiled) !== Boolean(r2.alreadyFiled), 'Concurrent identical uploads create one audited binding')
    const cross = await uploadMinuteBookFromForm(b.ledger.id, form(M, 'append'), actor)
    check(cross.error, 'Another company cannot attach to this record')
    const crossCreate = await uploadMinuteBookFromForm(b.ledger.id, form(M), actor)
    check(crossCreate.error, 'A crafted creation id cannot take another company record')
    check(await minuteBookPaperFile(b.ledger.id, first.paperId!) === null, 'Another company cannot retrieve the file')
    const forged = form(randomUUID()); forged.set('ledgerId', b.ledger.id); forged.set('entityId', b.company.id)
    const ours = await uploadMinuteBookFromForm(L, forged, actor)
    check(ours.ok, 'Form company fields cannot override the URL company')
    const [{ owner }] = await db.execute<{ owner: string }>(query`SELECT entity_id::text AS owner FROM minute_book_entry WHERE id = ${ours.minuteId}::uuid`)
    check(owner === a.company.id, 'Crafted ownership fields still save in the authorized company')
    const atomic = randomUUID()
    await assert.rejects(fileMinuteBookDocument({ ledgerId: L, minuteId: atomic, filename: 'Atomic.pdf', bytes, mime: 'application/pdf', actor,
      create: { recordKind: 'invalid', onDate: '2026-01-05', title: 'Must roll back', keptAt: 'FigTree', note: '' } }))
    const [{ count: rolledBack }] = await db.execute<{ count: number }>(query`SELECT count(*)::int AS count FROM minute_book_entry WHERE id = ${atomic}::uuid`)
    check(rolledBack === 0, 'Failed first-document transaction leaves no empty record')
    const papers = await minuteBookPaperOf(a.company.id)
    check(papers.filter(p => p.minute_book_entry_id === M).length === 3, 'Three files listed once each')
    const snapshot = await exportCompany(a.company.id, { withFiles: true })
    check(snapshot.rows.minute_book_entry.some(r => r.id === M) && snapshot.rows.minute_book_attachment.length === 4, 'Company backup includes records and bindings')
    check(snapshot.files.some(f => f.sha256 === createHash('sha256').update(bytes).digest('hex') && Buffer.from(f.bytes, 'base64').equals(bytes)), 'Company backup includes unchanged original bytes')
    const dav = await webdavFilesOf(a.company.id, { journal: false, records: true })
    check(dav.length === 4 && dav.every(f => f.segments[0] === 'Minute book' && f.segments[1] === '2026'), 'Existing company/year WebDAV directory includes new documents')
    const edit = new FormData()
    for (const [k, v] of [[F.ledgerId, L], [F.table, 'minute_book'], [F.recordId, M]]) edit.set(k, v)
    for (const [k, v] of Object.entries({ recordKind: 'memo', onDate: '2025-12-31', title: 'Renamed package', keptAt: 'FigTree', note: 'Corrected' })) edit.set(rowField(0, k), v)
    check((await correctRowFromForm(edit, actor)).ok, 'Existing edit path supports new kinds and renamed record')
    const dirs = await readdir(path.join(scratch, 'Minute Book Test A', 'Minute book', '2025'))
    check(dirs.length === 3 && dirs.every(n => n.includes('Renamed package')), 'Editing moves all derived file links together')
    const removeFile = new FormData(); removeFile.set(F.ledgerId, L); removeFile.set(F.paperId, second.paperId!); removeFile.set(F.reason, 'Wrong version')
    check((await detachMinuteBookFromForm(removeFile, actor)).ok, 'One attachment can be removed with an audit reason')
    check((await minuteBookPaperOf(a.company.id)).filter(p => p.minute_book_entry_id === M).length === 2, 'Removing one file leaves the others')
    check((await removeRowFromForm(edit, actor)).ok, 'Record can be deleted through existing audited path')
    check((await minuteBookPaperOf(a.company.id)).every(p => p.minute_book_entry_id !== M), 'Deleting a record removes only its bindings')
    check((await minuteBookPaperFile(L, ours.paperId!))?.bytes.equals(bytes), 'Deleting a record preserves shared document bytes on another record')
    const [{ duplicateAudits }] = await db.execute<{ duplicateAudits: number }>(query`
      SELECT count(*)::int AS "duplicateAudits" FROM audit_log WHERE action = 'attach' AND record_id = ${first.paperId}`)
    check(duplicateAudits === 1, 'Retry produces no duplicate attachment audit event')
    const legacyBytes = Buffer.from('%PDF extensionless legacy scan')
    const legacy = await attachToMinuteBook({ ledgerId: L, minuteId: ours.minuteId!, filename: 'legacy scan', bytes: legacyBytes, mime: 'application/pdf', actor })
    check((await minuteBookPaperFile(L, legacy.id))?.bytes.equals(legacyBytes), 'Existing extensionless PDF filing remains compatible')
    console.log(JSON.stringify({ checks, failures: 0, isolatedDatabase: true, productionDatabaseTouched: false }))
  } finally { await rm(scratch, { recursive: true, force: true }) }
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => sql.end())

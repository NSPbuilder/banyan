import 'server-only'
import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { ledgerHead } from './ledger-head'
import { attachmentsDir } from './backup-paths'
import { actingAs, lockBankAccount, type Runner } from './acting'
import { auditRow } from './audit-row'
import { ATTACHMENT_MAX_BYTES } from './forms'
import { modulePapers } from './module-extensions'

/**
 * Receipts and vouchers, filed the way this repository files everything:
 * the truth once, the views derived.
 *
 *   TRUTH   a content-addressed blob (sha256) in the company's store, plus an
 *           `attachment` row binding it to a journal ENTRY. The entry knows
 *           every account it touched, so the expense account and the bank
 *           account share one receipt through one row — no duplication.
 *
 *   VIEW    the per-account / per-month Finder tree the owner asked for
 *           (2026-09-02), built from HARDLINKS to the blobs. It is a cache
 *           with the period_balance treatment: maintained on upload, provable
 *           by `checkAttachmentIntegrity`, reproducible by
 *           `rebuildAttachmentTree`. Nothing in it is a second copy.
 *
 * No gate anywhere: receipts arrive late, so posting never demands one. The
 * standing reminder is `missingReceipts` — posted entries that touched an
 * expense account and carry nothing.
 *
 * Attaching to a CLOSED month is allowed on purpose: an attachment is
 * metadata about paper, not a change to any figure, and the paper often
 * arrives after the month is shut. Every attach and detach lands in the
 * audit log.
 */

export class AttachmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

/** Read the root PER CALL: the suites point this at a scratch directory. */
function root(): string {
  return attachmentsDir()
}

/** One folder name from a company (or account) name — Finder-safe, readable. */
export function folderName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim()
  return cleaned || 'unnamed'
}

/**
 * The company whose folder of papers a name would land in — another company,
 * not `except` — or null. Folders compare the way Finder compares them, without
 * case. Two companies in one folder share blobs, trees and a Minute book
 * folder, and a rename or a rebuild of one then moves or wipes the other's
 * (independent critic, 2026-09-16); so creating, restoring and renaming a
 * company all ask this first.
 */
export async function folderTakenBy(name: string, except: string | null = null): Promise<string | null> {
  const want = folderName(name).toLowerCase()
  const companies = await db.execute<{ id: string; name: string }>(sql`SELECT id::text, name FROM entity`)
  return companies.find((c) => c.id !== except && folderName(c.name).toLowerCase() === want)?.name ?? null
}

const blobDir = (company: string) => path.join(root(), folderName(company), 'blobs')
// The blob's name is its hash and NOTHING else. An extension came from the
// FILENAME, and the same bytes filed as scan.jpg and scan.jpeg then stored
// twice — block 257's crime shipping in miniature (critic, 2026-09-02). The
// extension lives where a human reads it: on the tree links and in the
// attachment row's filename.
const blobPath = (company: string, sha: string) => path.join(blobDir(company), sha)

/** Read-side fallback for stores written before the extension was dropped:
 *  a legacy `sha.ext` file is renamed to its bare hash on first sight. */
async function findBlob(company: string, sha: string, filename: string): Promise<string> {
  const bare = blobPath(company, sha)
  try { await fs.access(bare); return bare } catch { /* try legacy */ }
  const legacy = bare + path.extname(filename).toLowerCase().slice(0, 10)
  try {
    await fs.access(legacy)
    await fs.rename(legacy, bare)
    return bare
  } catch { return bare }
}

/**
 * The bytes behind one hash, and the way to put them back — for the backup
 * file, which carries a company's receipts as well as its books (2026-09-07).
 *
 * The store is per company (`<root>/<company>/blobs/<sha>`), so both take the
 * company's name: a restored company's paper belongs under the restored
 * company's folder, not under the one it was copied from.
 */
export async function readBlobBytes(company: string, sha: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(await findBlob(company, sha, ''))
  } catch {
    return null
  }
}

export async function writeBlobBytes(company: string, sha: string, bytes: Buffer): Promise<void> {
  const file = blobPath(company, sha)
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.access(file)
  } catch {
    // tmp + rename, the same as filing one: a crash must never leave a
    // half-written file under a name a hash claims to vouch for.
    const tmp = file + '.tmp-' + randomUUID()
    try {
      await fs.writeFile(tmp, bytes)
      await fs.rename(tmp, file)
    } finally {
      await fs.rm(tmp, { force: true })
    }
  }
}

type EntryHead = {
  id: string; entry_no: string | null; entry_date: string; status: string
  entity_id: string; entity: string; period_status: string | null
  /** What the entry is worth, in cents — the amount a filed receipt is named for. */
  total_debit: bigint
}

async function entryHead(ledgerId: string, entryId: string, on:Runner=db): Promise<EntryHead | null> {
  const [row] = await on.execute<EntryHead>(sql`
    SELECT je.id::text, je.entry_no, je.entry_date::text, je.status, je.total_debit,
           e.id::text AS entity_id, e.name AS entity, fp.status AS period_status
      FROM journal_entry je
      JOIN ledger l ON l.id = je.ledger_id
      JOIN entity e ON e.id = l.entity_id
      LEFT JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.id = ${entryId}::uuid AND je.ledger_id = ${ledgerId}::uuid`)
  return row ?? null
}

/**
 * WHAT A FILED RECEIPT IS CALLED: the entry's date, what the entry was worth,
 * and the extension it arrived with. `IMG_4471.HEIC` and `scan0003.pdf` say
 * nothing to a person in three years; `2026-02-10 1498.00.pdf` is the one
 * thing they will be looking for (owner, 2026-09-07).
 *
 * DERIVED, never stored. Both halves of the name belong to the entry, and an
 * entry is editable in place — its date and its amount both move
 * (`OPEN_EDIT_SOURCES`). A name written down at file time would be quietly
 * wrong from the first edit, and the integrity sweep would read it back out
 * of the row and agree with it (critic, 2026-09-07). The row keeps the name
 * the person uploaded, which never changes; everything a person sees is
 * worked out from the entry as it stands.
 *
 * The counter is the receipt's POSITION among that entry's attachments,
 * ordered as they were filed. Nothing has to be reserved, so two uploads at
 * once cannot collide over it.
 */
export function filedAs(
  entry: { entry_date: string; total_debit: bigint | string }, uploaded: string, position: number,
): string {
  const ext = path.extname(uploaded).toLowerCase().slice(0, 10)
  const amount = (Number(entry.total_debit) / 100).toFixed(2)
  const base = `${entry.entry_date} ${amount}`
  return position <= 1 ? `${base}${ext}` : `${base} (${position})${ext}`
}

/** The accounts an entry touched — each one gets the receipt in its folder. */
async function entryAccounts(entryId: string,on:Runner=db) {
  return on.execute<{ code: string; name: string }>(sql`
    SELECT DISTINCT a.code, a.name
      FROM journal_line jl JOIN account a ON a.id = jl.account_id
     WHERE jl.entry_id = ${entryId}::uuid
     ORDER BY a.code`)
}

/** Where one attachment appears in the tree: one link per touched account. */
function treePaths(entry: EntryHead, accounts: Array<{ code: string; name: string }>,
                   sha: string, filename: string): string[] {
  const month = entry.entry_date.slice(0, 7)
  const label = entry.entry_no ?? `draft-${entry.id.slice(0, 8)}`
  // The hash prefix keeps two same-named files on one entry apart in Finder
  // without inventing a counter that a rebuild would have to reproduce.
  const linkName = folderName(`${entry.entry_date} ${label} ${sha.slice(0, 8)} ${filename}`)
  return accounts.map((a) =>
    path.join(root(), folderName(entry.entity), folderName(`${a.code} ${a.name}`), month, linkName))
}

async function linkInto(dest: string, source: string) {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  try {
    await fs.link(source, dest)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return
    // A filesystem without hardlinks still gets the tree — as copies.
    if (code === 'EXDEV' || code === 'EPERM') { await fs.copyFile(source, dest); return }
    throw e
  }
}

export type AttachmentRecord = {
  id: string; sha256: string
  /** What it is FILED as: derived from the entry, every time (`filedAs`). */
  filename: string
  /** What the person uploaded. The row's own text, which never changes. */
  uploaded: string
  note: string | null
  byte_size: string; mime: string; created_at: string
}

export async function attachmentsOf(entryId: string): Promise<AttachmentRecord[]> {
  const rows = await db.execute<Omit<AttachmentRecord, 'filename'> & {
    entry_date: string; total_debit: bigint
  }>(sql`
    SELECT a.id::text, a.sha256, a.filename AS uploaded, a.note,
           b.byte_size::text, b.mime, a.created_at::text,
           je.entry_date::text, je.total_debit
      FROM attachment a
      JOIN attachment_blob b ON b.sha256 = a.sha256
      JOIN journal_entry je ON je.id = a.entry_id
     WHERE a.entry_id = ${entryId}::uuid
     ORDER BY a.created_at, a.id`)
  return rows.map((r, i) => ({ ...r, filename: filedAs(r, r.uploaded, i + 1) }))
}

const MAX_BYTES = ATTACHMENT_MAX_BYTES
const MIME_OK = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif|gif|tiff))$/
const EXT_OK = /\.(pdf|png|jpe?g|webp|heic|heif|gif|tiff?)$/i

/**
 * What the store keeps: a PDF or an image, not empty, not over 25 MB. One
 * rule for a receipt and for a minute-book record's paper (0081), so the two
 * doors cannot come to disagree about what a supporting document is.
 */
function assertDocument(input: { filename: string; bytes: Buffer; mime: string }) {
  if (input.bytes.length === 0) {
    throw new AttachmentError('EMPTY_FILE', 'The file is empty — nothing arrived to keep.')
  }
  if (input.bytes.length > MAX_BYTES) {
    throw new AttachmentError('TOO_BIG',
      `The file is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB. `
      + 'Scan supporting documents at a lower resolution rather than raising it.')
  }
  if (!MIME_OK.test(input.mime) && !EXT_OK.test(input.filename)) {
    throw new AttachmentError('NOT_A_DOCUMENT',
      'Supporting documents are PDFs or images. Anything else does not read at a desk in seven years.')
  }
}

/**
 * File one receipt against one entry. Idempotent on content: the same bytes
 * again land on the same blob; the same bytes on the SAME entry are refused
 * by the unique constraint, in a sentence.
 */
export async function saveAttachment(input: {
  ledgerId: string
  entryId: string
  filename: string
  bytes: Buffer
  mime: string
  note?: string
  actor?: string
},on:Runner=db) {
  const actor = input.actor ?? 'system'
  assertDocument(input)

  const entry = await entryHead(input.ledgerId, input.entryId,on)
  if (!entry) throw new AttachmentError('NO_SUCH_ENTRY', 'There is no such entry in these books.')

  // What a filed receipt is CALLED is derived, not stored: see `filedAs`.
  // The row keeps the name the person uploaded, which is the one fact about
  // it that never changes.

  const sha = createHash('sha256').update(input.bytes).digest('hex')
  const file = await findBlob(entry.entity, sha, input.filename)

  // Write the blob if the store lacks it — tmp + rename, so a crash never
  // leaves a half-written file under a name a hash claims to vouch for.
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.access(file)
  } catch {
    const tmp = file + '.tmp-' + process.pid
    await fs.writeFile(tmp, input.bytes)
    await fs.rename(tmp, file)
  }

  let record: { id: string }
  try {
    record = await actingAs(actor, async (tx) => {
      await tx.execute(sql`
        INSERT INTO attachment_blob (sha256, byte_size, mime, created_by)
        VALUES (${sha}, ${input.bytes.length}, ${input.mime || 'application/octet-stream'}, ${actor})
        ON CONFLICT (sha256) DO NOTHING`)
      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO attachment (entry_id, sha256, filename, note, created_by)
        VALUES (${input.entryId}::uuid, ${sha}, ${input.filename}, ${input.note ?? null}, ${actor})
        RETURNING id::text`)
      await auditRow(tx, {
        actor, action: 'attach', table: 'attachment', recordId: row.id,
        entityId: entry.entity_id, ledgerId: input.ledgerId, scope: 'company',
        targetLabel: input.filename,
        after: { sha256: sha, filename: input.filename, bytes: input.bytes.length },
        context: { entryId: input.entryId, entryNo: entry.entry_no, periodStatus: entry.period_status },
      })
      return row
    },on)
  } catch (e) {
    // The driver wraps the constraint violation; the name rides in the cause.
    const text = `${String(e)} ${String((e as { cause?: unknown }).cause ?? '')}`
    if (text.includes('attachment_once_per_entry')) {
      throw new AttachmentError('ALREADY_ATTACHED',
        'This exact file is already on this entry — same bytes, same document.')
    }
    throw e
  }

  const accounts = await entryAccounts(input.entryId,on)
  // The link's name comes from the same derivation the screen uses, WITHOUT
  // the counter: the sha is already in the link name, so two files on one
  // entry are separate without it — and a counter would shift under every
  // delete, stranding the links of everything filed after it (critic).
  for (const dest of treePaths(entry, accounts, sha, filedAs(entry, input.filename, 1))) {
    await linkInto(dest, file)
  }

  return { id: record.id, sha256: sha }
}

/** Unfile a receipt: the binding and its tree links go; the blob stays. */
export async function deleteAttachment(
  ledgerId: string, attachmentId: string, actor: string, reason: string, on: Runner = db,
) {
  const why = reason.trim()
  if (!why) throw new AttachmentError('NO_REASON', 'Say why this document is being unfiled.')
  const row = await actingAs(actor, async (tx) => {
    const [held] = await tx.execute<{
      id: string; entry_id: string; sha256: string; filename: string; entity_id: string
      entry_no: string | null
    }>(sql`
      SELECT a.id::text, a.entry_id::text, a.sha256, a.filename,
             l.entity_id::text, je.entry_no
        FROM attachment a JOIN journal_entry je ON je.id = a.entry_id
        JOIN ledger l ON l.id = je.ledger_id
       WHERE a.id = ${attachmentId}::uuid AND je.ledger_id = ${ledgerId}::uuid
       FOR UPDATE OF a`)
    if (!held) throw new AttachmentError('NO_SUCH_ATTACHMENT', 'There is no such attachment.')
    await tx.execute(sql`DELETE FROM attachment WHERE id = ${attachmentId}::uuid`)
    await auditRow(tx, {
      actor, action: 'detach', table: 'attachment', recordId: attachmentId,
      entityId: held.entity_id, ledgerId, scope: 'company', targetLabel: held.filename,
      before: { sha256: held.sha256, filename: held.filename },
      context: { entryId: held.entry_id, entryNo: held.entry_no,
        reason: why, note: 'blob kept; paper survives a correction' }, reason: why,
    })
    return held
  },on)
  const entry = (await entryHead(ledgerId, row.entry_id,on))!
  const accounts = await entryAccounts(row.entry_id,on)
  // Named the way it was linked: derived, no counter.
  for (const dest of treePaths(entry, accounts, row.sha256, filedAs(entry, row.filename, 1))) {
    await fs.rm(dest, { force: true })
  }
}

/** The bytes back, for the serving route — from the store, verified nowhere:
 *  serving must be fast; `checkAttachmentIntegrity` is the honesty sweep. */
export async function attachmentFile(ledgerId: string, attachmentId: string) {
  const [row] = await db.execute<{
    sha256: string; uploaded: string; mime: string; entity: string
    entry_date: string; total_debit: bigint; n: string
  }>(sql`
    SELECT a.sha256, a.filename AS uploaded, b.mime, e.name AS entity,
           je.entry_date::text, je.total_debit,
           (SELECT count(*) FROM attachment c
             WHERE c.entry_id = a.entry_id
               AND (c.created_at, c.id) <= (a.created_at, a.id))::text AS n
      FROM attachment a
      JOIN attachment_blob b ON b.sha256 = a.sha256
      JOIN journal_entry je ON je.id = a.entry_id
      JOIN ledger l ON l.id = je.ledger_id
      JOIN entity e ON e.id = l.entity_id
     WHERE a.id = ${attachmentId}::uuid AND je.ledger_id = ${ledgerId}::uuid`)
  if (!row) return null
  // Served under the name it is filed as, not the one the phone gave it.
  const bytes = await fs.readFile(await findBlob(row.entity, row.sha256, row.uploaded))
  return { bytes, filename: filedAs(row, row.uploaded, Number(row.n)), mime: row.mime }
}

/** Every attachment of a ledger with what its tree needs — the one list the
 *  rebuild, the integrity sweep and the exports all walk. */
/**
 * Everything the rebuild and the integrity sweep need about a ledger's
 * attachments, in one read: the row, the entry head the tree paths are named
 * from, and the entry's accounts. Two queries per attachment before
 * (whole-project audit, 2026-09-13). The byte read and the rehash stay per
 * file — proving the bytes are the bytes is the sweep's whole point.
 */
async function ledgerAttachmentsWithContext(ledgerId: string) {
  const rows = await db.execute<{
    id: string; entry_id: string; sha256: string; uploaded: string; byte_size: string
    mime: string; created_at: string
    entry_date: string; total_debit: bigint; n: string
    entry_no: string | null; status: string; entity_id: string; entity: string
    period_status: string | null
    accounts: Array<{ code: string; name: string }> | null
  }>(sql`
    SELECT a.id::text, a.entry_id::text, a.sha256, a.filename AS uploaded,
           b.byte_size::text, b.mime, a.created_at::text,
           je.entry_date::text, je.total_debit, je.entry_no, je.status,
           e.id::text AS entity_id, e.name AS entity, fp.status AS period_status,
           (SELECT count(*) FROM attachment c
             WHERE c.entry_id = a.entry_id
               AND (c.created_at, c.id) <= (a.created_at, a.id))::text AS n,
           (SELECT json_agg(json_build_object('code', x.code, 'name', x.name) ORDER BY x.code)
              FROM (SELECT DISTINCT a3.code, a3.name
                      FROM journal_line jl3 JOIN account a3 ON a3.id = jl3.account_id
                     WHERE jl3.entry_id = a.entry_id) x) AS accounts
      FROM attachment a
      JOIN attachment_blob b ON b.sha256 = a.sha256
      JOIN journal_entry je ON je.id = a.entry_id
      JOIN ledger l ON l.id = je.ledger_id
      JOIN entity e ON e.id = l.entity_id
      LEFT JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.ledger_id = ${ledgerId}::uuid
     ORDER BY je.entry_date, a.created_at, a.id`)
  return rows.map((r) => ({
    ...r,
    filename: filedAs(r, r.uploaded, Number(r.n)),
    entry: {
      id: r.entry_id, entry_no: r.entry_no, entry_date: r.entry_date, status: r.status,
      total_debit: r.total_debit, entity_id: r.entity_id, entity: r.entity,
      period_status: r.period_status,
    } as EntryHead,
    accounts: (r.accounts ?? []) as Array<{ code: string; name: string }>,
  }))
}

/**
 * Rebuild the account/month tree from the truth: delete every tree directory
 * under the company folder (NEVER `blobs`), then relink everything. The
 * remedy for a renamed account, a moved entry date, or a hand-rearranged
 * folder — like rebuilding balances, it cannot lose anything.
 */
export async function rebuildAttachmentTree(ledgerId: string, actor = 'system') {
  const company = await ledgerHead(ledgerId)
  if (!company) throw new AttachmentError('NO_SUCH_LEDGER', 'There is no such ledger.')

  const companyDir = path.join(root(), folderName(company.entity))
  const entries = await fs.readdir(companyDir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'blobs') {
      await fs.rm(path.join(companyDir, e.name), { recursive: true, force: true })
    }
  }

  // The tree dirs are ENTITY-wide (accounts are entity-scoped), and the wipe
  // above took the whole company's tree — so the relink must cover every
  // ledger of the entity, not just the one that was clicked.
  const ledgers = await db.execute<{ id: string }>(sql`
    SELECT l2.id::text FROM ledger l JOIN ledger l2 ON l2.entity_id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  let links = 0
  for (const led of ledgers) for (const a of await ledgerAttachmentsWithContext(led.id)) {
    const entry = a.entry
    const accounts = a.accounts
    const source = await findBlob(entry.entity, a.sha256, a.uploaded)
    for (const dest of treePaths(entry, accounts, a.sha256, filedAs(entry, a.uploaded, 1))) {
      await linkInto(dest, source)
      links++
    }
  }
  // And the minute book's paper (0081), whose folder the wipe above took too.
  for (const paper of await modulePapers(company.entity_id)) {
    await linkInto(paper.destination, await findBlob(paper.entity, paper.sha256, paper.uploaded))
    links++
  }
  for (const paper of await statementPaperWithContext(company.entity_id)) {
    await linkInto(statementPaperPath(paper), await findBlob(paper.entity, paper.sha256, paper.uploaded))
    links++
  }

  await db.execute(sql`
    INSERT INTO audit_log (actor, action, table_name, record_id, after, context)
    VALUES (${actor}, 'rebuild_attachment_tree', 'attachment', ${ledgerId},
            ${JSON.stringify({ links })}::jsonb, ${JSON.stringify({ ledgerId })}::jsonb)`)
  return { links }
}

/**
 * Does the store still hold what the books think it holds? Three questions
 * per attachment: the blob file exists, its bytes still hash to their name,
 * and every account/month link is in place. Findings are sentences.
 */
export async function checkAttachmentIntegrity(ledgerId: string) {
  const problems: Array<{ what: string; detail: string }> = []
  for (const a of await ledgerAttachmentsWithContext(ledgerId)) {
    const entry = a.entry
    const source = await findBlob(entry.entity, a.sha256, a.uploaded)
    let bytes: Buffer | null = null
    try {
      bytes = await fs.readFile(source)
    } catch {
      problems.push({
        what: `${a.filename} is missing from the store`,
        detail: `Expected at ${source}. If the company was renamed, rename its attachments folder to match and rebuild.`,
      })
      continue
    }
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== a.sha256) {
      problems.push({
        what: `${a.filename} is not the file that was attached`,
        detail: `Its bytes hash to ${sha.slice(0, 12)}…, the books recorded ${a.sha256.slice(0, 12)}…. The file was altered or corrupted on disk.`,
      })
      continue
    }
    for (const dest of treePaths(entry, a.accounts, a.sha256, filedAs(entry, a.uploaded, 1))) {
      try {
        await fs.access(dest)
      } catch {
        problems.push({
          what: `${a.filename} is missing from a folder`,
          detail: `${dest} — rebuild the folders to restore it.`,
        })
      }
    }
  }
  // The same three questions of every minute-book record's paper (0081).
  const [ledger] = await db.execute<{ entity_id: string }>(sql`
    SELECT entity_id::text FROM ledger WHERE id = ${ledgerId}::uuid`)
  for (const paper of ledger ? await modulePapers(ledger.entity_id) : []) {
    const named = paper.filename
    const stored = await findBlob(paper.entity, paper.sha256, paper.uploaded)
    const held = await fs.readFile(stored).catch(() => null)
    if (held === null) {
      problems.push({ what: `${named} is missing from the store`, detail: `Expected at ${stored}.` })
      continue
    }
    const hashed = createHash('sha256').update(held).digest('hex')
    if (hashed !== paper.sha256) {
      problems.push({
        what: `${named} is not the file that was attached`,
        detail: `Its bytes hash to ${hashed.slice(0, 12)}…, the books recorded ${paper.sha256.slice(0, 12)}….`,
      })
      continue
    }
    const link = paper.destination
    if (!(await fs.access(link).then(() => true).catch(() => false))) {
      problems.push({ what: `${named} is missing from the ${paper.folderLabel} folder`, detail: `${link} — rebuild the folders to restore it.` })
    }
  }
  for (const paper of ledger ? await statementPaperWithContext(ledger.entity_id) : []) {
    const stored = await findBlob(paper.entity, paper.sha256, paper.uploaded)
    const held = await fs.readFile(stored).catch(() => null)
    if (!held) {
      problems.push({ what: `${paper.uploaded} is missing from the store`, detail: `Expected at ${stored}.` })
    } else if (createHash('sha256').update(held).digest('hex') !== paper.sha256) {
      problems.push({ what: `${paper.uploaded} is not the file that was attached`, detail: `The statement original at ${stored} was altered.` })
    } else if (!(await fs.access(statementPaperPath(paper)).then(() => true).catch(() => false))) {
      problems.push({ what: `${paper.uploaded} is missing from the Bank statements folder`, detail: 'Rebuild the folders to restore it.' })
    }
  }
  return problems
}

/** A virtual read-only file for WebDAV. Paths are derived from the same rules
 * as the Finder tree, but no client ever sees or opens the underlying blobs/. */
export type WebDavFile = {
  segments: string[]
  company: string
  sha256: string
  mime: string
  byteSize: number
  modifiedAt: string
}

export async function webdavFilesOf(
  entityId: string, rights: { journal: boolean; records: boolean },
): Promise<WebDavFile[]> {
  const [company] = await db.execute<{ name: string }>(sql`
    SELECT name FROM entity WHERE id = ${entityId}::uuid`)
  if (!company) return []
  const companyDir = path.join(root(), folderName(company.name))
  const files: WebDavFile[] = []
  const used = new Set<string>()
  const add = (id: string, destination: string, source: {
    sha256: string; mime: string; byte_size: string; created_at: string
  }) => {
    const segments = path.relative(companyDir, destination).split(path.sep)
    let key = segments.join('\0')
    if (used.has(key)) {
      const last = path.parse(segments.at(-1)!)
      segments[segments.length - 1] = `${last.name} (${id})${last.ext}`
      key = segments.join('\0')
    }
    used.add(key)
    files.push({
      segments, company: company.name, sha256: source.sha256,
      mime: source.mime, byteSize: Number(source.byte_size),
      modifiedAt: source.created_at,
    })
  }

  if (rights.journal) {
    const ledgers = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM ledger WHERE entity_id = ${entityId}::uuid ORDER BY id`)
    for (const ledger of ledgers) for (const a of await ledgerAttachmentsWithContext(ledger.id)) {
      const destinations = treePaths(a.entry, a.accounts, a.sha256,
        filedAs(a.entry, a.uploaded, 1))
      // A malformed or legacy entry without account lines still has a filed
      // attachment. Keep it visible instead of silently omitting it.
      if (!destinations.length) {
        destinations.push(path.join(companyDir, 'Unfiled', a.entry.entry_date.slice(0, 7),
          folderName(`${a.entry.entry_date} ${a.entry.entry_no ?? a.entry_id} ${a.sha256.slice(0, 8)} ${a.filename}`)))
      }
      for (const destination of destinations) add(a.id, destination, a)
    }
    for (const paper of await statementPaperWithContext(entityId)) {
      add(paper.id, statementPaperPath(paper), paper)
    }
  }
  for (const paper of await modulePapers(entityId, rights.records ? ['/records'] : [])) {
    add(paper.id, paper.destination, paper)
  }
  return files
}

/**
 * The standing reminder (the owner chose a reminder over a gate,
 * 2026-09-02): posted entries that touched an EXPENSE account and carry no
 * attachment. Opening balances and year-end closes are positions, not
 * purchases, and are left out.
 */
export async function missingReceipts(ledgerId: string) {
  return db.execute<{
    id: string; entry_no: string; entry_date: string; description: string; source_type: string
  }>(sql`
    SELECT je.id::text, je.entry_no, je.entry_date::text, je.description, je.source_type
      FROM journal_entry je
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status = 'posted'
       AND je.source_type NOT IN ('opening_balance', 'period_close')
       AND EXISTS (SELECT 1 FROM journal_line jl JOIN account a ON a.id = jl.account_id
                    WHERE jl.entry_id = je.id AND a.account_type = 'expense')
       AND NOT EXISTS (SELECT 1 FROM attachment at WHERE at.entry_id = je.id)
       -- The owner's recorded judgment that no paper exists (0047): salaries,
       -- bank fees, depreciation. Waived entries leave the chase for good —
       -- or until the waiver is lifted, which is one click and one audit row.
       AND NOT EXISTS (SELECT 1 FROM receipt_waiver rw WHERE rw.entry_id = je.id)
     ORDER BY je.entry_date, je.entry_no`)
}

/** Is this entry waived, and by whom? Null when it is not. */
export async function receiptWaiver(entryId: string) {
  const [row] = await db.execute<{ created_by: string; created_at: string }>(sql`
    SELECT created_by, created_at::text FROM receipt_waiver
     WHERE entry_id = ${entryId}::uuid`)
  return row ?? null
}

/**
 * Record that this entry needs no receipt. Reversible, audited, idempotent —
 * waiving twice is one waiver, not an error.
 */
export async function waiveReceipt(ledgerId: string, entryId: string, actor = 'system') {
  const entry = await entryHead(ledgerId, entryId)
  if (!entry) throw new AttachmentError('NO_SUCH_ENTRY', 'There is no such entry in these books.')
  await actingAs(actor, async (tx) => {
    const inserted = await tx.execute<{ entry_id: string }>(sql`
      INSERT INTO receipt_waiver (entry_id, created_by)
      VALUES (${entryId}::uuid, ${actor})
      ON CONFLICT (entry_id) DO NOTHING RETURNING entry_id::text`)
    if (inserted.length > 0) await auditRow(tx, {
      actor, action: 'waive_receipt', table: 'receipt_waiver', recordId: entryId,
      entityId: entry.entity_id, ledgerId, scope: 'company', targetLabel: entry.entry_no,
      context: { entryNo: entry.entry_no },
    })
  })
}

/** Lift the waiver: the entry rejoins the chase until paper arrives. */
export async function unwaiveReceipt(ledgerId: string, entryId: string, actor = 'system') {
  const entry = await entryHead(ledgerId, entryId)
  if (!entry) throw new AttachmentError('NO_SUCH_ENTRY', 'There is no such entry in these books.')
  await actingAs(actor, async (tx) => {
    const removed = await tx.execute<{ entry_id: string }>(sql`
      DELETE FROM receipt_waiver WHERE entry_id = ${entryId}::uuid RETURNING entry_id::text`)
    if (removed.length > 0) await auditRow(tx, {
      actor, action: 'unwaive_receipt', table: 'receipt_waiver', recordId: entryId,
      entityId: entry.entity_id, ledgerId, scope: 'company', targetLabel: entry.entry_no,
      context: { entryNo: entry.entry_no },
    })
  })
}

// ---------------------------------------------------------- bank statement originals --

/** Use the bytes, never the browser's MIME claim, when admitting or serving paper. */
export function statementDocumentMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))) return 'image/tiff'
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('ascii')
    if (/^(heic|heix|hevc|hevx)$/.test(brand)) return 'image/heic'
    if (/^(mif1|msf1)$/.test(brand)) return 'image/heif'
  }
  return null
}

export function validateStatementDocument(bytes: Buffer): string {
  if (!bytes.length) throw new AttachmentError('EMPTY_FILE', 'The file is empty.')
  if (bytes.length > MAX_BYTES) throw new AttachmentError('TOO_BIG', 'Statement files must be 25 MB or smaller.')
  const mime = statementDocumentMime(bytes)
  if (!mime) throw new AttachmentError('NOT_A_DOCUMENT', 'Choose a PDF or an image of the statement.')
  return mime
}

type StatementHead = {
  statement_id: string; statement_date: string; account_id: string; code: string; name: string
  entity_id: string; entity: string; frozen: string | null
}

const statementHeadQuery = (ledgerId: string, accountId: string, statementId: string) => sql`
  SELECT s.id::text AS statement_id, s.statement_date::text, a.id::text AS account_id,
         a.code, a.name, e.id::text AS entity_id, e.name AS entity,
         bank_frozen_through(a.id)::text AS frozen
    FROM bank_statement s JOIN account a ON a.id = s.account_id
    JOIN entity e ON e.id = a.entity_id JOIN ledger l ON l.entity_id = e.id
   WHERE l.id = ${ledgerId}::uuid AND a.id = ${accountId}::uuid AND s.id = ${statementId}::uuid`

type StatementPaper = StatementHead & {
  id: string; sha256: string; uploaded: string; mime: string; byte_size: string; created_at: string
}

function statementPaperPath(paper: StatementPaper): string {
  const extensions: Record<string, string> = {
    'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/tiff': '.tiff', 'image/heic': '.heic', 'image/heif': '.heif',
  }
  const ext = EXT_OK.test(paper.uploaded) ? path.extname(paper.uploaded).toLowerCase() : extensions[paper.mime] ?? '.bin'
  // UUIDs separate accounts even after duplicate labels or a sanitized-name collision.
  // The label is a readable cache; canonical bytes and bindings do not depend on it.
  const label = Buffer.from(folderName(`${paper.code} ${paper.name}`)).subarray(0, 160).toString('utf8').replace(/\uFFFD$/, '')
  const account = `${label} (${paper.account_id})`
  return path.join(root(), folderName(paper.entity), 'Bank statements', account,
    paper.statement_date.slice(0, 7), `${paper.statement_date} Statement ${paper.id}${ext}`)
}

async function statementPaperWithContext(entityId: string): Promise<StatementPaper[]> {
  return db.execute<StatementPaper>(sql`
    SELECT p.id::text, p.sha256, p.filename AS uploaded, b.mime, b.byte_size::text, p.created_at::text,
           s.id::text AS statement_id, s.statement_date::text, a.id::text AS account_id,
           a.code, a.name, e.id::text AS entity_id, e.name AS entity, bank_frozen_through(a.id)::text AS frozen
      FROM bank_statement_attachment p JOIN attachment_blob b ON b.sha256 = p.sha256
      JOIN bank_statement s ON s.id = p.statement_id JOIN account a ON a.id = s.account_id
      JOIN entity e ON e.id = a.entity_id WHERE e.id = ${entityId}::uuid
     ORDER BY s.statement_date, p.created_at, p.id`)
}

export type StatementFileRecord = {
  id: string; filename: string; byte_size: string; created_at: string
}

export async function statementFilesOf(ledgerId: string, accountId: string, statementId: string): Promise<StatementFileRecord[]> {
  return db.execute<StatementFileRecord>(sql`
    SELECT p.id::text, p.filename, b.byte_size::text, p.created_at::text
      FROM bank_statement_attachment p JOIN attachment_blob b ON b.sha256 = p.sha256
      JOIN bank_statement s ON s.id = p.statement_id JOIN account a ON a.id = s.account_id
      JOIN ledger l ON l.entity_id = a.entity_id
     WHERE l.id = ${ledgerId}::uuid AND a.id = ${accountId}::uuid AND s.id = ${statementId}::uuid
     ORDER BY p.created_at, p.id`)
}

export async function attachStatementFile(input: {
  ledgerId: string; accountId: string; statementId: string; filename: string; bytes: Buffer; actor: string
}): Promise<{ id: string; sha256: string; warning?: string }> {
  const mime = validateStatementDocument(input.bytes)
  const filename = input.filename.replace(/[\\/]/g, '-').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 255) || 'statement.pdf'
  const sha = createHash('sha256').update(input.bytes).digest('hex')
  let saved: StatementHead & { id: string }
  try {
    saved = await actingAs(input.actor, async (tx) => {
      await lockBankAccount(tx, input.accountId)
      const [head] = await tx.execute<StatementHead>(statementHeadQuery(input.ledgerId, input.accountId, input.statementId))
      if (!head) throw new AttachmentError('NO_SUCH_STATEMENT', 'That statement is not in this bank account.')
      await writeBlobBytes(head.entity, sha, input.bytes)
      await tx.execute(sql`
        INSERT INTO attachment_blob (sha256, byte_size, mime, created_by)
        VALUES (${sha}, ${input.bytes.length}, ${mime}, ${input.actor}) ON CONFLICT (sha256) DO NOTHING`)
      const [made] = await tx.execute<{ id: string }>(sql`
        INSERT INTO bank_statement_attachment (statement_id, sha256, filename, created_by)
        VALUES (${input.statementId}::uuid, ${sha}, ${filename}, ${input.actor}) RETURNING id::text`)
      await auditRow(tx, {
        actor: input.actor, action: 'attach', table: 'bank_statement_attachment', recordId: made.id,
        entityId: head.entity_id, ledgerId: input.ledgerId, scope: 'company', targetLabel: filename,
        after: { sha256: sha, filename, bytes: input.bytes.length },
        context: { accountId: head.account_id, statementId: head.statement_id, statementDate: head.statement_date },
      })
      return { ...head, id: made.id }
    })
  } catch (e) {
    if (`${String(e)} ${String((e as { cause?: unknown }).cause ?? '')}`.includes('bank_statement_attachment_once')) {
      throw new AttachmentError('ALREADY_ATTACHED', 'This file is already attached to the statement.')
    }
    throw e
  }
  try {
    await linkInto(statementPaperPath({ ...saved, uploaded: filename, sha256: sha, mime,
      byte_size: String(input.bytes.length), created_at: '' }), blobPath(saved.entity, sha))
    return { id: saved.id, sha256: sha }
  } catch {
    // The canonical file and audited binding are committed. Do not invite a retry.
    return { id: saved.id, sha256: sha, warning: 'File saved. Rebuild attachment folders to restore its folder link.' }
  }
}

export async function detachStatementFile(input: {
  ledgerId: string; accountId: string; statementId: string; attachmentId: string; actor: string; reason: string
}): Promise<{ warning?: string }> {
  const reason = input.reason.trim()
  if (!reason) throw new AttachmentError('NO_REASON', 'Enter a reason for removing the file.')
  const paper = await actingAs(input.actor, async (tx) => {
    await lockBankAccount(tx, input.accountId)
    const [head] = await tx.execute<StatementHead>(statementHeadQuery(input.ledgerId, input.accountId, input.statementId))
    if (!head) throw new AttachmentError('NO_SUCH_STATEMENT', 'That statement is not in this bank account.')
    if (head.frozen && head.statement_date <= head.frozen) {
      throw new AttachmentError('RECONCILED', `Undo the reconciliation of ${head.frozen} before removing its statement file.`)
    }
    const [held] = await tx.execute<{ id: string; sha256: string; uploaded: string }>(sql`
      SELECT id::text, sha256, filename AS uploaded FROM bank_statement_attachment
       WHERE id = ${input.attachmentId}::uuid AND statement_id = ${input.statementId}::uuid FOR UPDATE`)
    if (!held) throw new AttachmentError('NO_SUCH_ATTACHMENT', 'There is no such statement file.')
    await tx.execute(sql`DELETE FROM bank_statement_attachment WHERE id = ${held.id}::uuid`)
    await auditRow(tx, {
      actor: input.actor, action: 'detach', table: 'bank_statement_attachment', recordId: held.id,
      entityId: head.entity_id, ledgerId: input.ledgerId, scope: 'company', targetLabel: held.uploaded,
      before: { sha256: held.sha256, filename: held.uploaded }, reason,
      context: { accountId: head.account_id, statementId: head.statement_id, statementDate: head.statement_date, note: 'blob kept' },
    })
    return { ...head, ...held, mime: '', byte_size: '', created_at: '' }
  })
  try {
    await fs.rm(statementPaperPath(paper), { force: true })
    return {}
  } catch {
    return { warning: 'File removed. Rebuild attachment folders to clear its old folder link.' }
  }
}

export async function statementFile(ledgerId: string, accountId: string, attachmentId: string) {
  const [paper] = await db.execute<{ sha256: string; filename: string; entity: string }>(sql`
    SELECT p.sha256, p.filename, e.name AS entity FROM bank_statement_attachment p
      JOIN bank_statement s ON s.id = p.statement_id JOIN account a ON a.id = s.account_id
      JOIN entity e ON e.id = a.entity_id JOIN ledger l ON l.entity_id = e.id
     WHERE l.id = ${ledgerId}::uuid AND a.id = ${accountId}::uuid AND p.id = ${attachmentId}::uuid`)
  if (!paper) return null
  const bytes = await readBlobBytes(paper.entity, paper.sha256)
  if (!bytes) return null
  return { bytes, filename: paper.filename, mime: statementDocumentMime(bytes) ?? 'application/octet-stream' }
}

/** Shared original-file primitives. Modules own their bindings and derived paths. */
export const attachmentStorage = { root, blobPath, findBlob, linkInto, assertDocument, folderName, mimeAllowed: (mime: string) => MIME_OK.test(mime) }

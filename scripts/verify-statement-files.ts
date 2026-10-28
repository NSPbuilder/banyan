/** Run against an isolated migrated database, with NODE_OPTIONS=--conditions=react-server. */
import './env'
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { saveStatement, deleteStatement, finishReconciliation, undoReconciliation } from '../src/lib/bank'
import {
  attachStatementFile, detachStatementFile, statementFilesOf, statementFile, validateStatementDocument,
  checkAttachmentIntegrity, rebuildAttachmentTree, folderName, webdavFilesOf, readBlobBytes,
} from '../src/lib/attachments'
import { saveStatementFromForm } from '../src/lib/match-forms'
import { uploadStatementFileFromForm, removeStatementFileFromForm } from '../src/lib/bank-statement-forms'
import { MATCH_FIELDS as F, STATEMENT_FILE_FIELDS as S } from '../src/lib/forms'
import { exportCompany, packFigtree, readFigtree, restoreCompany, restorePaper } from '../src/lib/backup'
import { reporter, tinyPdf, errorText } from './suite'

const store = mkdtempSync(path.join(os.tmpdir(), 'figtree-statement-files-'))
process.env.ATTACHMENTS_DIR = store
const r = reporter(64)
const actor = 'statement-check@example.test'
const paper = tinyPdf('September statement original')

async function refused(label: string, fn: () => unknown | Promise<unknown>, message: string) {
  try { await fn(); r.fail(label, 'unexpectedly accepted') } catch (e) {
    r.check(errorText(e).includes(message), label, errorText(e).slice(0, 100))
  }
}

async function main() {
  const co = await createCompanyWithYear({ code: 'STF', name: 'Statement Files Ltd.' }, actor)
  const other = await createCompanyWithYear({ code: 'STX', name: 'Other Statements Ltd.' }, actor)
  const L = co.ledger.id
  const accounts = await importAccounts(co.company.id, parseAccountsCsv(
    '1000,Bank / Operating,asset,,cash_and_cash_equivalents\n1010,Bank / Reserve,asset,,cash_and_cash_equivalents',
  ).map(a => ({ ...a, entityId: co.company.id })), actor)
  const A = accounts[0].id, B = accounts[1].id
  const yr = co.year.endDate.slice(0, 4)
  const date = `${yr}-09-30`
  const st = await saveStatement({ accountId: A, statementDate: date, endingBalance: 0n, actor })
  const scope = { ledgerId: L, accountId: A, statementId: st.id, actor }
  const uploaded = await attachStatementFile({ ...scope, filename: '月结单.pdf', bytes: paper })
  const files = await statementFilesOf(L, A, st.id)
  r.check(files.length === 1 && files[0].filename === '月结单.pdf', 'SF1 original filename and statement association are retained')
  r.check((await statementFile(L, A, uploaded.id))?.bytes.equals(paper) === true, 'SF2 original bytes can be read through the scoped door')
  const companyDir = path.join(store, folderName(co.company.name))
  const tree = await fs.readdir(path.join(companyDir, 'Bank statements'))
  const link = path.join(companyDir, 'Bank statements', tree[0], `${yr}-09`, `${date} Statement ${uploaded.id}.pdf`)
  r.check(tree[0].includes(A) && (await fs.readFile(link)).equals(paper), 'SF3 readable account UUID / statement month directory')
  r.check((await fs.stat(link)).ino === (await fs.stat(path.join(companyDir, 'blobs', uploaded.sha256))).ino,
    'SF4 monthly file is a hardlink to canonical bytes')
  await refused('SF5 duplicate bytes on same statement refused', () => attachStatementFile({ ...scope, filename: 'copy.pdf', bytes: paper }), 'already attached')
  r.check(await statementFile(other.ledger.id, A, uploaded.id) === null, 'SF6 another company cannot read the original')
  r.check(await statementFile(L, B, uploaded.id) === null, 'SF7 another bank account cannot read the original')
  await refused('SF8 another company cannot attach', () => attachStatementFile({ ...scope, ledgerId: other.ledger.id, filename: 'bad.pdf', bytes: paper }), 'not in this bank account')
  await refused('SF9 another account cannot attach', () => attachStatementFile({ ...scope, accountId: B, filename: 'bad.pdf', bytes: paper }), 'not in this bank account')
  await refused('SF10 HTML renamed to PDF refused', () => validateStatementDocument(Buffer.from('<html>statement</html>')), 'PDF or an image')
  await refused('SF11 empty file refused', () => validateStatementDocument(Buffer.alloc(0)), 'empty')
  await refused('SF12 oversized file refused', () => validateStatementDocument(Buffer.alloc(25 * 1024 * 1024 + 1)), '25 MB')
  const png = Buffer.from([137,80,78,71,13,10,26,10,0])
  r.check(validateStatementDocument(png) === 'image/png', 'SF13 image bytes recognized independently of browser MIME')
  await refused('SF14 statement with paper cannot be deleted', () => deleteStatement(st.id, actor), 'Remove the statement files')
  await refused('SF15 SQL cannot cascade away statement originals', () => db.execute(sql`DELETE FROM bank_statement WHERE id = ${st.id}::uuid`), 'foreign key')
  await refused('SF16 removing paper requires a reason', () => detachStatementFile({ ...scope, attachmentId: uploaded.id, reason: '' }), 'reason')
  await refused('SF17 bindings cannot be moved by SQL', () => db.execute(sql`UPDATE bank_statement_attachment SET filename = 'replacement.pdf' WHERE id = ${uploaded.id}::uuid`), 'STATEMENT_FILE_IMMUTABLE')
  await finishReconciliation(st.id, actor)
  await refused('SF18 finished originals cannot be removed', () => detachStatementFile({ ...scope, attachmentId: uploaded.id, reason: 'replace' }), 'Undo the reconciliation')
  await refused('SF19 SQL also protects finished originals', () => db.execute(sql`DELETE FROM bank_statement_attachment WHERE id = ${uploaded.id}::uuid`), 'RECONCILED')
  const late = await attachStatementFile({ ...scope, filename: 'late scan.pdf', bytes: tinyPdf('late second page') })
  r.check(Boolean(late.id) && (await statementFilesOf(L, A, st.id)).length === 2, 'SF20 late paper can be uploaded after Finish')
  const visible = await webdavFilesOf(co.company.id, { journal: true, records: false })
  r.check(visible.length === 2 && visible.every(f => f.segments[0] === 'Bank statements'), 'SF21 accounting WebDAV includes statement originals')
  r.check((await webdavFilesOf(co.company.id, { journal: false, records: true })).length === 0, 'SF22 statement paper respects accounting WebDAV rights')
  await fs.rm(link)
  r.check((await checkAttachmentIntegrity(L)).some(p => p.what.includes('Bank statements')), 'SF23 missing folder link detected')
  await db.execute(sql`UPDATE account SET name = 'Renamed bank' WHERE id = ${A}::uuid`)
  await rebuildAttachmentTree(L, actor)
  const renamed = await fs.readdir(path.join(companyDir, 'Bank statements'))
  r.check(renamed.length === 1 && renamed[0].includes('Renamed bank') && (await checkAttachmentIntegrity(L)).length === 0,
    'SF24 rebuild preserves paper and refreshes renamed account labels')
  const backup = readFigtree(await packFigtree(await exportCompany(co.company.id, { withFiles: true })))
  r.check(backup.rows.bank_statement_attachment.length === 2 && backup.files.length === 2, 'SF25 company backup includes original bindings and bytes')
  const restored = await restoreCompany(backup, actor, { code: 'STR', name: 'Restored Statements Ltd.' })
  await restorePaper(backup, restored.name, restored.ledgerId)
  const [restoredPaper] = await db.execute<{ id: string; account_id: string; statement_id: string }>(sql`
    SELECT p.id::text, s.account_id::text, s.id::text AS statement_id FROM bank_statement_attachment p
    JOIN bank_statement s ON s.id = p.statement_id JOIN account a ON a.id = s.account_id
    WHERE a.entity_id = ${restored.entityId}::uuid AND p.sha256 = ${uploaded.sha256}`)
  r.check(restoredPaper.id !== uploaded.id && restoredPaper.account_id !== A && restoredPaper.statement_id !== st.id,
    'SF26 restore remaps account, statement and attachment UUIDs')
  r.check((await statementFile(restored.ledgerId!, restoredPaper.account_id, restoredPaper.id))?.bytes.equals(paper) === true
    && (await checkAttachmentIntegrity(restored.ledgerId!)).length === 0, 'SF27 restored paper is readable with a rebuilt monthly directory')
  await undoReconciliation(st.id, actor, 'correct scan')
  await detachStatementFile({ ...scope, attachmentId: uploaded.id, reason: 'Duplicate scan, keep the second page' })
  r.check((await statementFilesOf(L, A, st.id)).length === 1 && (await readBlobBytes(co.company.name, uploaded.sha256))?.equals(paper) === true,
    'SF28 detach removes binding but retains canonical original')
  const [audit] = await db.execute<{ reason: string }>(sql`SELECT reason FROM audit_log WHERE record_id = ${uploaded.id} AND action = 'detach'`)
  r.check(audit.reason.includes('Duplicate scan'), 'SF29 removal reason is in company audit history')
  const form = new FormData()
  form.set(F.ledgerId, L); form.set(F.accountId, B); form.set(F.statementDate, `${yr}-10-31`); form.set(F.endingBalance, '0')
  form.set(S.file, new File([tinyPdf('October statement')], 'October.pdf', { type: 'text/html' }))
  const result = await saveStatementFromForm(form, actor)
  const [oct] = await db.execute<{ id: string }>(sql`SELECT id::text FROM bank_statement WHERE account_id = ${B}::uuid AND statement_date = ${`${yr}-10-31`}::date`)
  r.check(Boolean(result.ok) && (await statementFilesOf(L, B, oct.id)).length === 1, 'SF30 record form saves statement and optional original')
  form.set(F.statementDate, `${yr}-11-30`); form.set(S.file, new File(['<html>bad</html>'], 'fake.pdf', { type: 'application/pdf' }))
  const invalid = await saveStatementFromForm(form, actor)
  const absent = await db.execute(sql`SELECT id FROM bank_statement WHERE account_id = ${B}::uuid AND statement_date = ${`${yr}-11-30`}::date`)
  r.check(Boolean(invalid.error) && !absent.length, 'SF31 invalid original prevents creating an assertion')
  form.set(F.statementId, oct.id); form.set(S.file, new File([tinyPdf('another page')], 'page.pdf'))
  r.check(Boolean((await uploadStatementFileFromForm(form, actor)).ok), 'SF32 existing statement upload form uses the same store')
  form.set(S.attachmentId, late.id); form.set('reason', 'wrong association')
  r.check(Boolean((await removeStatementFileFromForm(form, actor)).error), 'SF33 remove form refuses a file from another statement')
  // Force a derived-link failure after the canonical save. Success must remain
  // explicit so a caller does not repeat a committed upload.
  await fs.rm(path.join(companyDir, 'Bank statements'), { recursive: true })
  await fs.writeFile(path.join(companyDir, 'Bank statements'), 'blocked folder')
  const warning = await attachStatementFile({ ...scope, filename: 'final.pdf', bytes: tinyPdf('directory fault') })
  r.check(Boolean(warning.warning) && Boolean(await statementFile(L, A, warning.id)), 'SF34 folder failure preserves downloadable original and reports saved')
  await fs.rm(path.join(companyDir, 'Bank statements'))
  await rebuildAttachmentTree(L, actor)
  r.check((await checkAttachmentIntegrity(L)).length === 0, 'SF35 folder rebuild recovers the derived-link failure')
  const concurrentBytes = tinyPdf('same original uploaded concurrently to two accounts')
  const concurrent = await Promise.all([
    attachStatementFile({ ...scope, filename: 'concurrent.pdf', bytes: concurrentBytes }),
    attachStatementFile({ ledgerId: L, accountId: B, statementId: oct.id, actor, filename: 'concurrent.pdf', bytes: concurrentBytes }),
  ])
  r.check(concurrent[0].sha256 === concurrent[1].sha256 && !concurrent.some(f => f.warning)
    && (await readBlobBytes(co.company.name, concurrent[0].sha256))?.equals(concurrentBytes) === true,
    'SF36 concurrent uploads across bank accounts share complete bytes')
  await db.execute(sql`UPDATE account SET name = ${'长'.repeat(140)} WHERE id = ${B}::uuid`)
  await rebuildAttachmentTree(L, actor)
  const longFolders = await fs.readdir(path.join(companyDir, 'Bank statements'))
  r.check(longFolders.every(f => Buffer.byteLength(f) <= 255) && longFolders.some(f => f.includes(B))
    && (await checkAttachmentIntegrity(L)).length === 0, 'SF37 long Unicode account names stay within filesystem limits')
}

main().catch(e => { r.fail('SF fatal', errorText(e)); process.exitCode = 1 }).finally(async () => {
  console.log(r.summary()); if (r.failures) process.exitCode = 1
  await conn.end(); await fs.rm(store, { recursive: true, force: true })
})

/**
 * Receipts: stored once, filed everywhere, provable.
 *   npm run db:verify-attachments   (resets the TEST database first)
 *
 * The store for this run is a scratch directory — set BEFORE the lib is ever
 * called, because `attachments.ts` reads ATTACHMENTS_DIR per call and the dev
 * store must never be touched by a suite.
 */
import './env'
import { trailNamesPeople } from './actor-trail'
import { reporter, tinyPdf as pdf } from './suite'
import { mkdtempSync } from 'fs'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'

process.env.ATTACHMENTS_DIR = mkdtempSync(path.join(os.tmpdir(), 'erp-attach-'))

import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { editEntry, postEntry } from '../src/lib/posting'
import { closePeriod } from '../src/lib/periods'
import {
  AttachmentError, attachmentFile, attachmentsOf, checkAttachmentIntegrity,
  deleteAttachment, folderName, missingReceipts, rebuildAttachmentTree, receiptWaiver,
  saveAttachment, unwaiveReceipt, waiveReceipt,
} from '../src/lib/attachments'
import { uploadAttachmentFromForm } from '../src/lib/attach-forms'
import { renameCompanyFromForm } from '../src/lib/company-forms'
import { COMPANY_FIELDS } from '../src/lib/forms'
import { parseMoney } from '../src/lib/money'
import { fileResponse } from '../src/lib/pdf-reports'
import { attachToMinuteBook, detachFromMinuteBook, minuteBookPaperFile, minuteBookPaperOf } from '../src/modules/records/attachments'
import { addMinuteBookEntry } from '../src/lib/records'
import {
  RECORD_FIELDS, attachMinuteBookFromForm, correctRowFromForm, detachMinuteBookFromForm, enterRowsFromForm,
  removeRowFromForm,
} from '../src/lib/record-forms'
import { rowField } from '../src/lib/forms'
import { readBill } from '../src/lib/bill-reading'
import { serviceFrom, type Send } from '../src/lib/assistant'

const r = reporter(56)
const { pass, fail, check } = r

const CHART = `1000,Cash — Operating,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
3000,Share Capital,equity,,share_capital
4000,Revenue,revenue,,revenue_from_contracts
5000,Professional Fees,expense,,professional_fees fn_administrative_expenses
5100,Supplies,expense,,`

/** A believable little PDF: the store takes bytes, not promises. */

async function main() {
  const ROOT = process.env.ATTACHMENTS_DIR!
  const co = await createCompanyWithYear({ code: 'ATT', name: 'Paper Trail Ltd.' }, 'alicio@example.test')
  const L = co.ledger.id
  const accts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  const yr = Number(co.year.endDate.slice(0, 4))

  const expense = await postEntry({
    ledgerId: L, entryDate: `${yr}-02-10`, description: 'Stationery run', actor: 'alicio@example.test',
    lines: [
      { accountId: id['5000'], amount: parseMoney('80.00') },
      { accountId: id['1000'], amount: -parseMoney('80.00') },
    ],
  })
  const income = await postEntry({
    ledgerId: L, entryDate: `${yr}-02-15`, description: 'Fee received', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1000'], amount: parseMoney('200.00') },
      { accountId: id['4000'], amount: -parseMoney('200.00') },
    ],
  })

  const companyDir = path.join(ROOT, folderName('Paper Trail Ltd.'))
  const receipt = pdf('staples receipt')
  const sha = createHash('sha256').update(receipt).digest('hex')

  // AT1 — one upload: the blob lands once, and the receipt appears in the
  //       folder of EVERY account the entry touched, under its month.
  const saved = await saveAttachment({
    ledgerId: L, entryId: expense.entry.id, filename: 'staples receipt.pdf',
    bytes: receipt, mime: 'application/pdf', actor: 'alicio@example.test',
  })
  const blobFile = path.join(companyDir, 'blobs', sha)
  // The name a filed receipt is KEPT under, not the one the phone gave it:
  // the entry's date and what it was worth (owner, 2026-09-07). The tree
  // link carries that, so this is what to look for on disk.
  const storedAs = `${yr}-02-10 80.00.pdf`
  const linkIn = (acct: string) => path.join(companyDir, folderName(acct), `${yr}-02`,
    folderName(`${yr}-02-10 ${expense.entry.entryNo} ${sha.slice(0, 8)} ${storedAs}`))
  const at1 = await Promise.all([
    fs.access(blobFile).then(() => true, () => false),
    fs.access(linkIn('5000 Professional Fees')).then(() => true, () => false),
    fs.access(linkIn('1000 Cash — Operating')).then(() => true, () => false),
  ])
  check(saved.sha256 === sha && at1.every(Boolean),
    'AT1 one file, filed under every touched account by month',
    `blob + ${['5000', '1000'].join(' and ')} links, month ${yr}-02`)

  // AT2 — the same bytes on a SECOND entry reuse the blob: still one physical
  //       file; the same bytes on the SAME entry are refused in a sentence.
  // A DIFFERENT filename on purpose: the blob's identity must be the bytes
  // alone, and 'scan.jpg' vs 'scan.jpeg' once stored the same receipt twice
  // (critic, 2026-09-02).
  await saveAttachment({
    ledgerId: L, entryId: income.entry.id, filename: 'same bytes, other name.pdf',
    bytes: receipt, mime: 'application/pdf', actor: 'alicio@example.test',
  })
  const blobCount = (await fs.readdir(path.join(companyDir, 'blobs')))
    .filter((f) => !f.includes('.tmp')).length
  let dupError = ''
  try {
    await saveAttachment({
      ledgerId: L, entryId: expense.entry.id, filename: 'renamed copy.pdf',
      bytes: receipt, mime: 'application/pdf', actor: 'alicio@example.test',
    })
  } catch (e) { dupError = e instanceof AttachmentError ? e.message : String(e) }
  check(blobCount === 1 && dupError.includes('already on this entry'),
    'AT2 same bytes: one blob for two entries, a refusal for one',
    `${blobCount} blob file; "${dupError.slice(0, 50)}…"`)

  // AT3 — a tampered file is named by the sweep: its bytes no longer hash to
  //       the name the books recorded.
  await fs.writeFile(blobFile, pdf('a different receipt entirely'))
  const tampered = await checkAttachmentIntegrity(L)
  await fs.writeFile(blobFile, receipt)
  const clean = await checkAttachmentIntegrity(L)
  check(tampered.some((p) => p.what.includes('not the file that was attached')) && clean.length === 0,
    'AT3 an altered file is caught by its own hash',
    tampered[0]?.what ?? 'nothing reported')

  // AT4 — the standing reminder: the unreceipted expense is chased, the
  //       income entry is not, and filing the paper clears it.
  const naked = await postEntry({
    ledgerId: L, entryDate: `${yr}-03-05`, description: 'Courier, receipt to come', actor: 'alicio@example.test',
    lines: [
      { accountId: id['5100'], amount: parseMoney('25.00') },
      { accountId: id['1000'], amount: -parseMoney('25.00') },
    ],
  })
  const before = await missingReceipts(L)
  await saveAttachment({
    ledgerId: L, entryId: naked.entry.id, filename: 'courier.pdf',
    bytes: pdf('courier'), mime: 'application/pdf', actor: 'alicio@example.test',
  })
  const after = await missingReceipts(L)
  check(before.some((m) => m.id === naked.entry.id)
        && !before.some((m) => m.id === income.entry.id)
        && !after.some((m) => m.id === naked.entry.id),
    'AT4 the reminder chases expenses only, until the paper arrives',
    `${before.length} chased before, ${after.length} after`)

  // AT5 — a CLOSED month still accepts paper: receipts are late by nature and
  //       change no figure. The audit log records the filing.
  const [feb] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM fiscal_period WHERE ledger_id = ${L} AND period_no = 2`)
  await closePeriod(L, feb.id, { actor: 'alicio@example.test' })
  // A refusal here must go RED, not kill the run — a gate is exactly the
  // mutation this check exists to catch (the verify-quick tryPost lesson).
  try {
    const late = await saveAttachment({
      ledgerId: L, entryId: expense.entry.id, filename: 'late statement.pdf',
      bytes: pdf('arrived after closing'), mime: 'application/pdf', actor: 'alicio@example.test',
    })
    const [audit] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM audit_log
       WHERE action = 'attach' AND record_id = ${late.id}
         AND context->>'periodStatus' = 'closed'`)
    check(audit.n === '1',
      'AT5 a closed month accepts paper, and the filing is audited',
      'attach recorded with periodStatus closed')
  } catch (e) {
    fail('AT5 a closed month accepts paper, and the filing is audited',
         `refused: ${e instanceof Error ? e.message.slice(0, 70) : String(e)}`)
  }

  // AT6 — unfiling removes the binding and the folder links; the OTHER
  //       entry's links and the blob itself survive.
  const mine = await attachmentsOf(expense.entry.id)
  // Found by the name it is FILED under. A mutant that stops renaming makes
  // this miss, and a miss must redden AT6 rather than throw and take the
  // whole suite down with it (block 478).
  const original = mine.find((a) => a.uploaded === 'staples receipt.pdf') ?? mine[0]
  if (original) await deleteAttachment(L, original.id, 'alicio@example.test', 'verification')
  const at6 = await Promise.all([
    fs.access(linkIn('5000 Professional Fees')).then(() => false, () => true),
    fs.access(blobFile).then(() => true, () => false),
  ])
  const otherStill = await attachmentsOf(income.entry.id)
  check(mine.some((a) => a.filename === storedAs) && original?.uploaded === 'staples receipt.pdf'
        && at6.every(Boolean) && otherStill.length === 1
        && (await checkAttachmentIntegrity(L)).length === 0,
    'AT6 unfiling one entry leaves the other entry and the blob alone',
    `filed as ${mine.map((a) => a.filename).join(',')}; original ${original?.uploaded}; `
    + `link gone ${at6[0]}, blob ${at6[1]}, other ${otherStill.length}, sweep ${(await checkAttachmentIntegrity(L)).length}`)

  // AT7 — the tree is a cache: wreck it, rebuild it, and the sweep finds a
  //       perfect tree again.
  await fs.rm(path.join(companyDir, folderName('1000 Cash — Operating')), { recursive: true, force: true })
  const wrecked = await checkAttachmentIntegrity(L)
  // A rebuild that cannot find a blob must go RED here, not kill the run —
  // that is precisely what a store broken by a mutation looks like.
  try {
    const { links } = await rebuildAttachmentTree(L, 'alicio@example.test')
    const rebuilt = await checkAttachmentIntegrity(L)
    check(wrecked.length > 0 && rebuilt.length === 0 && links > 0,
      'AT7 a wrecked tree rebuilds from the truth',
      `${wrecked.length} missing before, ${links} links after, sweep clean`)
  } catch (e) {
    fail('AT7 a wrecked tree rebuilds from the truth',
         `rebuild threw: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`)
  }

  // AT8 — the serving path returns the exact bytes that were filed. A THROW
  //       is a red, not a crash: a store that lost the file must not take the
  //       rest of the suite down with it.
  try {
    const served = await attachmentFile(L, otherStill[0].id)
    check(!!served && served.bytes.equals(receipt) && served.filename === `${yr}-02-15 200.00.pdf`,
      'AT8 the served file is byte-identical to what was filed',
      `${served?.bytes.length} bytes`)
  } catch (e) {
    fail('AT8 the served file is byte-identical to what was filed',
         `the store could not produce it: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`)
  }

  // AT9 — refusals, each in a sentence: empty, oversized, not a document,
  //       no such entry.
  const refusals: string[] = []
  const expect = async (want: string, run: () => Promise<unknown>) => {
    try { await run(); refusals.push(`${want}: was ACCEPTED`) } catch (e) {
      const msg = e instanceof AttachmentError ? `${e.code}` : String(e)
      if (!msg.includes(want)) refusals.push(`${want}: got ${msg}`)
    }
  }
  await expect('EMPTY_FILE', () => saveAttachment({
    ledgerId: L, entryId: income.entry.id, filename: 'x.pdf', bytes: Buffer.alloc(0), mime: 'application/pdf' }))
  await expect('TOO_BIG', () => saveAttachment({
    ledgerId: L, entryId: income.entry.id, filename: 'x.pdf', bytes: Buffer.alloc(26 * 1024 * 1024, 1), mime: 'application/pdf' }))
  await expect('NOT_A_DOCUMENT', () => saveAttachment({
    ledgerId: L, entryId: income.entry.id, filename: 'virus.exe', bytes: pdf('x'), mime: 'application/x-msdownload' }))
  await expect('NO_SUCH_ENTRY', () => saveAttachment({
    ledgerId: L, entryId: '00000000-0000-0000-0000-000000000000', filename: 'x.pdf', bytes: pdf('x'), mime: 'application/pdf' }))
  check(refusals.length === 0, 'AT9 every wrong upload is refused by name',
    refusals.join('; ') || 'empty, oversized, wrong type, missing entry')

  // AT10 — the form reader: a real File posts through the same door.
  const f = new FormData()
  f.set('ledgerId', L)
  f.set('entryId', naked.entry.id)
  f.set('file', new File([pdf('form upload')], 'from the form.pdf', { type: 'application/pdf' }))
  const viaForm = await uploadAttachmentFromForm(f, 'alicio@example.test')
  const nowOn = await attachmentsOf(naked.entry.id)
  check(viaForm.ok !== undefined && nowOn.some((a) => a.filename === `${yr}-03-05 25.00.pdf`),
    'AT10 the form path files like the library path', viaForm.ok ?? viaForm.error ?? '')

  // AT11 — the waiver (0047): salaries and bank fees have no paper, and the
  //        owner's recorded judgment removes them from the chase — reversibly,
  //        with an audit row for each real change. Repeating the same waiver
  //        is a no-op and must not manufacture a second success event.
  const salary = await postEntry({
    ledgerId: L, entryDate: `${yr}-03-15`, description: 'March salary run', actor: 'alicio@example.test',
    lines: [
      { accountId: id['5000'], amount: parseMoney('5000.00') },
      { accountId: id['1000'], amount: -parseMoney('5000.00') },
    ],
  })
  const chasedBefore = (await missingReceipts(L)).some((m) => m.id === salary.entry.id)
  await waiveReceipt(L, salary.entry.id, 'alicio@example.test')
  await waiveReceipt(L, salary.entry.id, 'alicio@example.test') // idempotent, not an error
  const chasedWaived = (await missingReceipts(L)).some((m) => m.id === salary.entry.id)
  const marker2 = await receiptWaiver(salary.entry.id)
  await unwaiveReceipt(L, salary.entry.id, 'alicio@example.test')
  const chasedAgain = (await missingReceipts(L)).some((m) => m.id === salary.entry.id)
  const [auditRows] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM audit_log
     WHERE record_id = ${salary.entry.id} AND action IN ('waive_receipt', 'unwaive_receipt')`)
  chasedBefore && !chasedWaived && marker2?.created_by === 'alicio@example.test'
    && chasedAgain && Number(auditRows.n) === 2
    ? pass('AT11 a waiver ends the chase, reversibly and audited',
           `chased -> waived (${marker2?.created_at.slice(0, 10)}) -> chased again; ${auditRows.n} audit rows`)
    : fail('AT11 a waiver ends the chase, reversibly and audited',
           JSON.stringify({ chasedBefore, chasedWaived, chasedAgain, marker: marker2, audit: auditRows.n }))

  await fs.rm(ROOT, { recursive: true, force: true })
  // AT12 — the rename: date and amount, the extension kept, the name the
  //        person uploaded kept in the note, and a second file on the same
  //        entry counted rather than named the same thing twice.
  // Guarded: these file paper onto an entry in a month `AT5` closed on
  // purpose, so a mutation that puts a period gate back into `saveAttachment`
  // makes them THROW. A mutant must redden a line, never take the suite down
  // with a stack trace where its red line belongs (mutations.sh, block 254).
  try {
    const one = await saveAttachment({
      ledgerId: L, entryId: income.entry.id, filename: 'IMG_4471.HEIC',
      bytes: pdf('a photo of a till receipt'), mime: 'image/heic', actor: 'alicio@example.test',
    })
    const two = await saveAttachment({
      ledgerId: L, entryId: income.entry.id, filename: 'scan0003.pdf',
      bytes: pdf('and the invoice behind it'), mime: 'application/pdf', actor: 'alicio@example.test',
    })
    const on = await attachmentsOf(income.entry.id)
    const first = on.find((a) => a.id === one.id)!
    const second = on.find((a) => a.id === two.id)!
    // A THIRD with the same extension as the first, to make the counter work.
    const three = await saveAttachment({
      ledgerId: L, entryId: income.entry.id, filename: 'another scan.pdf',
      bytes: pdf('a third piece of paper'), mime: 'application/pdf', actor: 'alicio@example.test',
    })
    const third = (await attachmentsOf(income.entry.id)).find((a) => a.id === three.id)!
    // The income entry already carries the `.pdf` of that name from AT2, so
    // the counter starts at (2) for the second and (3) for the third — which
    // is the counter doing its job rather than a name colliding twice.
    // The counter is the receipt's POSITION on the entry, so the .pdf AT2
    // filed there is (1) and these are (2), (3) and (4). Position rather than
    // a stored counter: nothing is reserved, so two uploads at once cannot
    // collide over it, and an edited entry renames its paper with it.
    check(first.filename === `${yr}-02-15 200.00 (2).heic` && first.uploaded === 'IMG_4471.HEIC'
      && second.filename === `${yr}-02-15 200.00 (3).pdf` && second.uploaded === 'scan0003.pdf'
      && third.filename === `${yr}-02-15 200.00 (4).pdf` && third.uploaded === 'another scan.pdf',
      'AT12 a filed receipt is renamed for the entry\'s date and amount, keeps its extension, and counts',
      `${first.filename} / ${second.filename} / ${third.filename}; uploaded as ${first.uploaded}`)
  } catch (e) {
    fail('AT12 a filed receipt is renamed for the entry\'s date and amount, keeps its extension, and counts',
      `nothing could be filed: ${(e as Error).message}`)
  }

  // AT13 — the name is DERIVED, so editing the entry renames its paper.
  //        Written down at file time it would have been wrong from the first
  //        edit, and the sweep would have read it back out of the row and
  //        agreed with it (critic, 2026-09-07).
  try {
    const edited = await postEntry({
      ledgerId: L, entryDate: `${yr}-05-01`, description: 'Will be edited', actor: 'alicio@example.test',
      lines: [
        { accountId: id['5100'], amount: parseMoney('12.00') },
        { accountId: id['1000'], amount: -parseMoney('12.00') },
      ],
    })
    await saveAttachment({
      ledgerId: L, entryId: edited.entry.id, filename: 'before.pdf',
      bytes: pdf('paper for an entry about to change'), mime: 'application/pdf', actor: 'alicio@example.test',
    })
    const was = (await attachmentsOf(edited.entry.id))[0]
    await editEntry(edited.entry.id, {
      entryDate: `${yr}-05-09`, description: 'Edited',
      lines: [
        { accountId: id['5100'], amount: parseMoney('99.00') },
        { accountId: id['1000'], amount: -parseMoney('99.00') },
      ],
    }, 'alicio@example.test')
    const now = (await attachmentsOf(edited.entry.id))[0]
    const served = await attachmentFile(L, now.id)
    check(was.filename === `${yr}-05-01 12.00.pdf` && now.filename === `${yr}-05-09 99.00.pdf`
      && now.uploaded === 'before.pdf' && served?.filename === `${yr}-05-09 99.00.pdf`,
      'AT13 the filed name is derived, so an edited entry renames its paper with it',
      `${was.filename} → ${now.filename}; served as ${served?.filename}; uploaded ${now.uploaded}`)
  } catch (e) {
    fail('AT13 the filed name is derived, so an edited entry renames its paper with it',
      `nothing could be filed: ${(e as Error).message}`)
  }

  // AT14 — A STORED FILE IS SHOWN AS A DOCUMENT OR A PICTURE, NEVER RUN. The
  //        door admits a file on its extension OR its type, and stored the
  //        type the uploader's browser sent; the replay echoed it. So
  //        `receipt.pdf` sent as text/html came back as HTML on this origin,
  //        as the signed-in person (audit, 2026-09-13). Off the list it goes
  //        out as bytes, and `nosniff` stops the browser guessing.
  {
    const html = fileResponse({ bytes: Buffer.from('<script>1</script>'), mime: 'text/html', filename: 'receipt.pdf' })
    const real = fileResponse({ bytes: pdf('real'), mime: 'application/pdf', filename: 'receipt.pdf' })
    const h = (r: Response, k: string) => r.headers.get(k) ?? ''
    check(h(html, 'content-type') === 'application/octet-stream' && h(html, 'x-content-type-options') === 'nosniff'
          && h(real, 'content-type') === 'application/pdf' && h(real, 'x-content-type-options') === 'nosniff'
          && h(real, 'content-disposition').startsWith('inline;'),
      'AT14 a file stored as HTML is shown as bytes with nosniff, a PDF as a PDF',
      `text/html -> ${h(html, 'content-type')} (${h(html, 'x-content-type-options') || 'no nosniff'}); `
        + `application/pdf -> ${h(real, 'content-type')} (${h(real, 'x-content-type-options') || 'no nosniff'}), ${h(real, 'content-disposition').split(';')[0]}`)
  }

  // ------------------------------------------------ the minute book's paper --
  //
  // 0081. A minute-book record keeps its documents on the same blobs as the
  // receipts, in a folder of its own, provable and rebuildable the same way.
  const actor = 'alicio@example.test'
  const said = (e: unknown) => (e instanceof AttachmentError ? e.code : (e as Error).message.slice(0, 60))
  // A company of its own: the checks above wiped the store on purpose (before
  // AT12), and a rebuild of THEIR company would meet receipts whose blobs are
  // gone. These start from a store that holds what their books say.
  const mb = await createCompanyWithYear({ code: 'MINUTES', name: 'Minute Paper Ltd.' }, actor)
  const ML = mb.ledger.id
  const mbDir = path.join(ROOT, folderName('Minute Paper Ltd.'))
  const resolution = pdf('signed resolution')
  const resSha = createHash('sha256').update(resolution).digest('hex')

  // AT15 — ONE FILE, TWO RECORDS, ONE BLOB. A signed resolution filed against
  //        two records is one blob; each gets a link under `Minute book/<year>/`
  //        named for the record, and is served under that name; the same bytes
  //        on the same record again are refused; the sweep notices a missing
  //        link and the rebuild puts it back; unfiling takes the link and
  //        leaves the blob.
  {
    const minute = await addMinuteBookEntry({
      entityId: mb.company.id, recordKind: 'directors_resolution', onDate: `${yr}-03-01`,
      title: 'Approve the stationery budget', keptAt: 'Minute book vol. 1', actor,
    })
    const other = await addMinuteBookEntry({
      entityId: mb.company.id, recordKind: 'shareholders_resolution', onDate: `${yr}-03-02`,
      title: 'Ratify the budget', keptAt: 'Minute book vol. 1', actor,
    })
    let filed: { id: string; sha256: string } | null = null
    let firstSaid = ''
    try {
      filed = await attachToMinuteBook({ ledgerId: ML, minuteId: minute!, filename: 'scan0003.pdf', bytes: resolution, mime: 'application/pdf', actor })
      await attachToMinuteBook({ ledgerId: ML, minuteId: other!, filename: 'scan0003.pdf', bytes: resolution, mime: 'application/pdf', actor })
    } catch (e) { firstSaid = said(e) }
    const blobFiles = (await fs.readdir(path.join(mbDir, 'blobs')).catch(() => [] as string[])).length
    const link = path.join(mbDir, 'Minute book', String(yr),
      folderName(`${yr}-03-01 directors resolution Approve the stationery budget ${resSha.slice(0, 8)}.pdf`))
    const linked = await fs.access(link).then(() => true, () => false)
    const served = filed ? await minuteBookPaperFile(ML, filed.id) : null
    let twice = ''
    try { await attachToMinuteBook({ ledgerId: ML, minuteId: minute!, filename: 'again.pdf', bytes: resolution, mime: 'application/pdf', actor }); twice = 'WENT THROUGH' } catch (e) { twice = said(e) }
    const listed = await minuteBookPaperOf(mb.company.id)
    const cleanBefore = (await checkAttachmentIntegrity(ML)).length
    await fs.rm(link, { force: true })
    const flagged = (await checkAttachmentIntegrity(ML)).some((p) => p.what.includes('missing from the Minute book folder'))
    let rebuilt = ''
    try { await rebuildAttachmentTree(ML, actor) } catch (e) { rebuilt = said(e) }
    const restored = await fs.access(link).then(() => true, () => false)
    let unfiled = ''
    try { if (filed) await detachFromMinuteBook(ML, filed.id, actor, 'verification') } catch (e) { unfiled = said(e) }
    const linkGone = !(await fs.access(link).then(() => true, () => false))
    const blobKept = await fs.access(path.join(mbDir, 'blobs', resSha)).then(() => true, () => false)
    check(firstSaid === '' && filed?.sha256 === resSha && blobFiles === 1 && linked && rebuilt === ''
          && served?.filename === `${yr}-03-01 directors resolution Approve the stationery budget.pdf`
          && twice === 'ALREADY_ATTACHED' && listed.length === 2 && cleanBefore === 0 && flagged && restored
          && unfiled === '' && linkGone && blobKept,
      "AT15 a minute-book record's document is one blob, linked in its own folder, provable, and unfiled cleanly",
      `${firstSaid || 'filed on two records'}; ${blobFiles} blob file(s); link ${linked ? 'in Minute book/' + yr : 'MISSING'}; `
        + `served as ${served?.filename ?? 'nothing'}; twice ${twice}; listed ${listed.length}; sweep before ${cleanBefore} problem(s), `
        + `after removing the link ${flagged ? 'names it' : 'says NOTHING'}; rebuild ${rebuilt || (restored ? 'put it back' : 'did NOT')}; `
        + `unfiled ${unfiled || 'ok'}, link ${linkGone ? 'gone' : 'STILL THERE'}, blob ${blobKept ? 'kept' : 'GONE'}`)
  }

  // AT16 — ANOTHER COMPANY'S RECORD IS NOT OURS. The form doors are asked with
  //        this ledger and the other company's ids: nothing is filed there and
  //        nothing of theirs is unfiled.
  {
    const theirs = await createCompanyWithYear({ code: 'ELSE', name: 'Somebody Else Ltd.' }, actor)
    const theirMinute = await addMinuteBookEntry({
      entityId: theirs.company.id, recordKind: 'shareholders_minutes', onDate: `${yr}-04-01`,
      title: 'Their meeting', keptAt: 'their book', actor,
    })
    const theirPaper = await attachToMinuteBook({ ledgerId: theirs.ledger.id, minuteId: theirMinute!, filename: 'theirs.pdf', bytes: pdf('theirs'), mime: 'application/pdf', actor })
    const attachForm = new FormData()
    attachForm.set(RECORD_FIELDS.ledgerId, ML)
    attachForm.set(RECORD_FIELDS.minuteId, theirMinute!)
    attachForm.set(RECORD_FIELDS.file, new File([pdf('crafted')], 'crafted.pdf', { type: 'application/pdf' }))
    const attached = await attachMinuteBookFromForm(attachForm, actor)
    const detachForm = new FormData()
    detachForm.set(RECORD_FIELDS.ledgerId, ML)
    detachForm.set(RECORD_FIELDS.paperId, theirPaper.id)
    detachForm.set(RECORD_FIELDS.reason, 'verification')
    const detached = await detachMinuteBookFromForm(detachForm, actor)
    const theirsNow = await minuteBookPaperOf(theirs.company.id)
    check(attached.error?.includes("not in this company's books") === true
          && detached.error?.includes("not in this company's books") === true && theirsNow.length === 1,
      "AT16 the minute book's paper doors refuse another company's record and document",
      `attach: ${attached.error ?? attached.ok}; unfile: ${detached.error ?? detached.ok}; their documents ${theirsNow.length}`)
  }

  // AT17 — THE DOCUMENT A MINUTE BOOK WAS READ FROM IS FILED AGAINST WHAT IT
  //        MADE. A stand-in model reads a PDF into two minute-book rows; the
  //        add form enters them, and the PDF lands against both — one blob,
  //        two bindings — and the sentence says so. A reading from a sentence
  //        alone has no paper, and the sentence says nothing about any.
  {
    const answer = JSON.stringify({
      suggests: 'minute_book', kind: 'minute book', belongs: 'minutes', facts: {},
      rows: { minute_book: [
        { recordKind: 'directors_resolution', onDate: `${yr}-05-01`, title: 'Open a bank account', keptAt: 'vol. 1' },
        { recordKind: 'shareholders_minutes', onDate: `${yr}-05-02`, title: 'Annual meeting', keptAt: 'vol. 1' },
      ] },
      party: '', documentRef: '', issuedOn: null, dueOn: null, currency: 'CAD', lines: [],
      subtotal: null, gst: null, pst: null, total: null, notes: '',
    })
    const send: Send = async () => ({ model: 'stand-in', stopReason: 'end_turn', explanation: null, text: answer,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })
    const service = serviceFrom({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'stand-in', model: 'stand-in' })!
    const book = pdf('minute book pages 1-3')
    const bookSha = createHash('sha256').update(book).digest('hex')
    const enter = async (readingId: string) => {
      const fd = new FormData()
      fd.set(RECORD_FIELDS.ledgerId, ML)
      fd.set(RECORD_FIELDS.table, 'minute_book')
      fd.set(RECORD_FIELDS.readingId, readingId)
      ;[[`${yr}-05-01`, 'Open a bank account', 'directors_resolution'], [`${yr}-05-02`, 'Annual meeting', 'shareholders_minutes']]
        .forEach(([onDate, title, kind], i) => {
          fd.set(rowField(i, 'recordKind'), kind); fd.set(rowField(i, 'onDate'), onDate)
          fd.set(rowField(i, 'title'), title); fd.set(rowField(i, 'keptAt'), 'vol. 1')
        })
      try { return await enterRowsFromForm(fd, actor) } catch (e) { return { error: `THREW ${(e as Error).message.slice(0, 60)}` } }
    }
    let withFile: { ok?: string; error?: string } = {}
    let withSentence: { ok?: string; error?: string } = {}
    try {
      const reading = await readBill({ ledgerId: ML, filename: 'minute-book.pdf', mime: 'application/pdf', bytes: book, actor, service, prices: null }, send)
      withFile = await enter(reading.id)
      const spoken = await readBill({ ledgerId: ML, sentence: 'Two resolutions from May', actor, service, prices: null }, send)
      withSentence = await enter(spoken.id)
    } catch (e) { withFile = { error: `THREW ${(e as Error).message.slice(0, 60)}` } }
    const bound = (await minuteBookPaperOf(mb.company.id)).filter((p) => p.sha256 === bookSha)
    const onDifferentRecords = new Set(bound.map((p) => p.minute_book_entry_id)).size
    const blobFiles = (await fs.readdir(path.join(mbDir, 'blobs'))).filter((f) => f === bookSha).length
    check(withFile.ok?.includes('minute-book.pdf is filed against each of the 2.') === true
          && bound.length === 2 && onDifferentRecords === 2 && blobFiles === 1
          && withSentence.ok !== undefined && !withSentence.ok.includes('filed against'),
      'AT17 a minute book read from a PDF files that PDF against every record it made',
      `from the PDF: ${withFile.ok ?? withFile.error}; ${bound.length} binding(s) on ${onDifferentRecords} record(s), `
        + `${blobFiles} blob file; from a sentence: ${(withSentence.ok ?? withSentence.error ?? '').slice(0, 80)}`)
  }

  // AT18 — A RECORD PUT RIGHT TAKES ITS PAPER WITH IT (0083). The link's name
  //        is the record's date, kind and title, so correcting the title from
  //        the row's Edit moves the link to the new name — the old one gone, the
  //        new one the same bytes — and deleting the record takes its link and
  //        its bindings while the blob stays in the store, as unfiling does.
  {
    const fixBytes = pdf('a resolution whose title was typed wrong')
    const fixSha = createHash('sha256').update(fixBytes).digest('hex')
    const wrong = await addMinuteBookEntry({
      entityId: mb.company.id, recordKind: 'directors_resolution', onDate: `${yr}-04-01`,
      title: 'Aprove the lease', keptAt: 'Minute book vol. 1', actor,
    })
    await attachToMinuteBook({ ledgerId: ML, minuteId: wrong!, filename: 'lease.pdf', bytes: fixBytes, mime: 'application/pdf', actor })
    const linkFor = (title: string, date = `${yr}-04-01`, kind = 'directors resolution') =>
      path.join(mbDir, 'Minute book', date.slice(0, 4), folderName(`${date} ${kind} ${title} ${fixSha.slice(0, 8)}.pdf`))
    const there = (p: string) => fs.access(p).then(() => true, () => false)
    const form = (values: Record<string, string>) => {
      const fd = new FormData()
      fd.set(RECORD_FIELDS.ledgerId, ML); fd.set(RECORD_FIELDS.table, 'minute_book'); fd.set(RECORD_FIELDS.recordId, wrong!)
      for (const [k, v] of Object.entries(values)) fd.set(rowField(0, k), v)
      return fd
    }
    const oldLinked = await there(linkFor('Aprove the lease'))
    const saved = await correctRowFromForm(form({
      recordKind: 'shareholders_resolution', onDate: `${yr}-04-02`, title: 'Approve the lease', keptAt: 'Minute book vol. 1', note: '',
    }), actor)
    const moved = linkFor('Approve the lease', `${yr}-04-02`, 'shareholders resolution')
    const oldGone = !(await there(linkFor('Aprove the lease')))
    const newLinked = await there(moved)
    const sameBytes = newLinked && createHash('sha256').update(await fs.readFile(moved)).digest('hex') === fixSha
    const clean = (await checkAttachmentIntegrity(ML)).length
    const removed = await removeRowFromForm(form({}), actor)
    const [bindings] = await db.execute<{ n: number }>(raw`
      SELECT count(*)::int AS n FROM minute_book_attachment WHERE minute_book_entry_id = ${wrong!}::uuid`)
    const linkGone = !(await there(moved))
    const blobKept = await there(path.join(mbDir, 'blobs', fixSha))
    check(oldLinked && saved.ok !== undefined && oldGone && newLinked && sameBytes && clean === 0
          && removed.ok?.includes('document was unfiled') === true && bindings.n === 0 && linkGone && blobKept,
      'AT18 a minute-book record corrected moves its documents to the new name, and one deleted takes them out',
      `before: link ${oldLinked ? 'under the typo' : 'MISSING'}; saved: ${saved.ok ?? saved.error}; `
        + `old link ${oldGone ? 'gone' : 'STILL THERE'}, new ${newLinked ? (sameBytes ? 'there, same bytes' : 'there, OTHER bytes') : 'MISSING'}; `
        + `sweep ${clean} problem(s); deleted: ${removed.ok ?? removed.error}; ${bindings.n} binding(s) left, `
        + `link ${linkGone ? 'gone' : 'STILL THERE'}, blob ${blobKept ? 'kept' : 'GONE'}`)
  }

  // AT19 — A COMPANY RENAMED TAKES ITS PAPERS WITH IT (0084). The store keeps
  //        each company's blobs and tree under a folder named for it, and finds
  //        a document's bytes by that name. Minute Paper Ltd. renamed: its
  //        folder moves, its minute-book documents still open, the sweep finds
  //        nothing wrong, the trail keeps both names. A name another company
  //        already has is refused, and nothing moves.
  {
    const renameForm = (name: string, province = 'BC') => {
      const fd = new FormData()
      fd.set(COMPANY_FIELDS.entityId, mb.company.id); fd.set(COMPANY_FIELDS.name, name); fd.set(COMPANY_FIELDS.province, province)
      return fd
    }
    const papers = await minuteBookPaperOf(mb.company.id)
    const opensBefore = papers[0] ? (await minuteBookPaperFile(ML, papers[0].id))?.bytes.length ?? 0 : 0
    const sweepBefore = (await checkAttachmentIntegrity(ML)).length
    const newDir = path.join(ROOT, folderName('Minute Paper Holdings Ltd.'))
    const renamed = await renameCompanyFromForm(renameForm('Minute Paper Holdings Ltd.'), actor)
    const oldGone = !(await fs.access(mbDir).then(() => true, () => false))
    const newThere = await fs.access(path.join(newDir, 'blobs')).then(() => true, () => false)
    let opens = 0
    try { opens = papers[0] ? (await minuteBookPaperFile(ML, papers[0].id))?.bytes.length ?? 0 : 0 } catch { opens = -1 }
    const sweep = await checkAttachmentIntegrity(ML)
    // A company with NO folder on disk: only the database-name check stands in
    // the way, so it is that check this line proves (critic round 2 — Paper
    // Trail's folder existed and the disk check refused in its place).
    await createCompanyWithYear({ code: 'NOFOLDER', name: 'Folderless Ltd.' }, actor)
    const clash = await renameCompanyFromForm(renameForm('Folderless Ltd.'), actor)
    const stillThere = await fs.access(newDir).then(() => true, () => false)
    // And a folder two companies ALREADY share — a restored copy that kept its
    // original's name, before creating and restoring refused that. Renaming
    // either would move both companies' papers, so it is refused and nothing
    // moves (independent critic, 2026-09-16).
    await db.execute(raw`UPDATE entity SET name = 'minute paper holdings ltd.' WHERE id = ${co.company.id}::uuid`)
    const shared = await renameCompanyFromForm(renameForm('Minute Paper Split Ltd.'), actor)
    const sharedUnmoved = await fs.access(newDir).then(() => true, () => false)
    const [sharedName] = await db.execute<{ name: string }>(raw`SELECT name FROM entity WHERE id = ${mb.company.id}::uuid`)
    await db.execute(raw`UPDATE entity SET name = 'Paper Trail Ltd.' WHERE id = ${co.company.id}::uuid`)
    const [trail] = await db.execute<{ before: { name?: string }; after: { name?: string; province?: string } }>(raw`
      SELECT before, after FROM audit_log WHERE action = 'rename_company' AND record_id = ${mb.company.id} ORDER BY id LIMIT 1`)
    check(papers.length > 0 && opensBefore > 0 && sweepBefore === 0
          && renamed.ok?.includes('folder of papers was renamed') === true && oldGone && newThere && opens === opensBefore
          && sweep.length === 0 && clash.error?.includes('Another company is called Folderless Ltd.') === true && stillThere
          && shared.error?.includes('keep their papers in one folder') === true && sharedUnmoved
          && sharedName?.name === 'Minute Paper Holdings Ltd.'
          && trail?.before?.name === 'Minute Paper Ltd.' && trail.after?.name === 'Minute Paper Holdings Ltd.' && trail.after.province === 'BC',
      "AT19 a company renamed moves its folder of papers, every document still opens; another company's name, or a folder already shared, is refused",
      `before: ${papers.length} document(s), the first ${opensBefore} bytes, sweep ${sweepBefore}; renamed: ${renamed.ok ?? renamed.error}; `
        + `old folder ${oldGone ? 'gone' : 'STILL THERE'}, new ${newThere ? 'there' : 'MISSING'}; the document opens: ${opens} bytes; `
        + `sweep ${sweep.length} problem(s)${sweep[0] ? ` (${sweep[0].what})` : ''}; another company's name: ${clash.error ?? 'SAVED'}; `
        + `a folder already shared: ${(shared.error ?? 'SAVED').slice(0, 60)} (${sharedUnmoved && sharedName?.name === 'Minute Paper Holdings Ltd.' ? 'nothing moved' : 'MOVED'}); `
        + `trail ${trail ? `${trail.before?.name} → ${trail.after?.name}` : 'nothing'}`)
  }

  await trailNamesPeople(check, 'AT20 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

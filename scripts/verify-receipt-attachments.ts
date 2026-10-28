/** Run after verify-receipts in the same freshly isolated TEST database. */
import './env'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync,writeFileSync,mkdirSync,readdirSync,statSync,renameSync } from 'node:fs'
import { join,basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import sharp from 'sharp'
import { sql as q } from 'drizzle-orm'
import { db, sql } from '../src/db/client'
import { attachmentsOf, saveAttachment, deleteAttachment } from '../src/lib/attachments'
import { attachProjectFile, detachProjectPaymentFile, projectAttachments, projectPaymentAttachmentTarget, projectPaymentAttachments, readProjectPaymentAttachment, readProjectBlob, writeProjectBlob, projectReceiptAttachments, projectStorageRoot } from '../src/lib/project-attachments'
import { projectCompany, projectHead, updateProject, ProjectError } from '../src/lib/project'
import { entryReceiptAttachments } from '../src/lib/receipt-attachments'
import { appendReceiptSupporting } from '../src/lib/receipt-supporting-pdf'
import { renderProjectPaymentReceipt, renderPaymentReceipt } from '../src/lib/receipts'
import { invoicePaperPdf } from '../src/lib/pdf-reports'
import { receiptResponse } from '../src/lib/receipt-http'
import { DocumentError } from '../src/lib/customer-docs'

let checks=0
const check=(value:unknown,label:string)=>{assert(value,label);console.log(`PASS RA${++checks} ${label}`)}
async function main() {
  const proof=JSON.parse(readFileSync(process.env.FIGTREE_TEST_ISOLATION_PROOF!,'utf8'))
  const [identity]=await db.execute<{name:string}>(q`SELECT current_database() AS name`)
  assert(proof.createdNew&&!proof.productionTouched&&identity.name===proof.testDatabase&&process.env.TEST_DATABASE_CONFIRMATION===identity.name)
  const fixture=JSON.parse(readFileSync(proof.fixturePath,'utf8')),company=await projectCompany(fixture.ledgerId)
  const target=await projectPaymentAttachmentTarget(company.id,fixture.financeProjectId,fixture.financePaymentId)
  assert(target.entry_id&&target.ledger_id===fixture.ledgerId)
  const actor='receipt@example.test',financialBefore=await db.execute(q`SELECT id,status,total_debit,total_credit FROM journal_entry ORDER BY id`)
  const evidence=process.env.RECEIPT_ATTACHMENT_EVIDENCE||'docs/evidence/receipt-attachments';mkdirSync(evidence,{recursive:true});mkdirSync('output/pdf',{recursive:true})
  const source=await PDFDocument.create(),font=await source.embedFont(StandardFonts.Helvetica)
  source.addPage([640,300]).drawText('SUPPORTING PAGE ONE',{x:30,y:240,font,size:18})
  const rotated=source.addPage([300,640]);rotated.setRotation(degrees(90));rotated.drawText('SUPPORTING PAGE TWO',{x:30,y:550,font,size:18})
  const pdf=Buffer.from(await source.save())
  const png=await sharp({create:{width:1600,height:600,channels:3,background:'#dce9dc'}}).png().toBuffer()
  const sharedId=await attachProjectFile({entityId:company.id,projectId:fixture.financeProjectId,paymentId:fixture.financePaymentId,filename:'transfer-confirmation.pdf',mime:'application/pdf',bytes:pdf,actor})
  check((await attachmentsOf(target.entry_id)).some(a=>a.id===sharedId),'Project upload is the same attachment ID in Income supporting')
  check(!(await projectAttachments(company.id,fixture.financeProjectId)).some(a=>a.id===sharedId),'linked upload creates no duplicate Project attachment row')
  const image=await saveAttachment({ledgerId:fixture.ledgerId,entryId:target.entry_id,filename:'cheque.png',mime:'image/png',bytes:png,actor})
  check((await projectPaymentAttachments(company.id,fixture.financeProjectId,fixture.financePaymentId)).some(a=>a.id===image.id&&a.source==='accounting'),'Income upload appears on the linked Project payment')
  check((await readProjectPaymentAttachment(company.id,fixture.financeProjectId,fixture.financePaymentId,sharedId))?.bytes.equals(pdf),'Project download reads exact shared PDF bytes')
  check(await readProjectPaymentAttachment(company.id,fixture.projectId,fixture.projectPaymentId,sharedId)===null,'unrelated payment cannot read a shared attachment ID')
  const foreign=await projectCompany(fixture.foreignLedgerId)
  await assert.rejects(()=>projectPaymentAttachments(foreign.id,fixture.financeProjectId,fixture.financePaymentId),ProjectError);check(true,'foreign company cannot list payment supporting')
  await assert.rejects(()=>projectPaymentAttachments(company.id,fixture.projectId,fixture.financePaymentId),ProjectError);check(true,'wrong project cannot list payment supporting')
  await assert.rejects(()=>projectPaymentAttachments(company.id,fixture.financeProjectId,'bad-id'),ProjectError);check(true,'malformed payment ID is refused')
  const nativeProject=await projectHead(company.id,fixture.projectId)
  if(nativeProject.status==='archived') {
    await assert.rejects(()=>attachProjectFile({entityId:company.id,projectId:fixture.projectId,paymentId:fixture.projectPaymentId,filename:'blocked.png',mime:'image/png',bytes:png,actor}),ProjectError);check(true,'archived Project refuses proof uploads')
    await updateProject({entityId:company.id,projectId:fixture.projectId,version:nativeProject.version,name:nativeProject.name,status:'active',actor})
  }
  const nativeId=await attachProjectFile({entityId:company.id.toUpperCase(),projectId:fixture.projectId.toUpperCase(),paymentId:fixture.projectPaymentId.toUpperCase(),filename:'operational-cheque.png',mime:'image/png',bytes:png,actor})
  const nativeRoot=await projectStorageRoot()
  check(readdirSync(nativeRoot).includes(company.id)&&readdirSync(join(nativeRoot,company.id)).includes(fixture.projectId),'valid uppercase upload IDs use canonical lowercase storage folders')
  check((await projectPaymentAttachments(company.id,fixture.projectId,fixture.projectPaymentId)).some(a=>a.id===nativeId&&a.source==='project'),'independent Project payment retains native supporting without posting')
  check((await readProjectPaymentAttachment(company.id.toUpperCase(),fixture.projectId.toUpperCase(),fixture.projectPaymentId.toUpperCase(),nativeId.toUpperCase()))?.bytes.equals(png),'valid uppercase Project/payment/file IDs read the same native proof')
  check((await projectReceiptAttachments(fixture.ledgerId,fixture.projectId,fixture.projectPaymentId)).length===1,'operational Receipt loads only its own payment proof')
  // Model a file uploaded before the shared-supporting feature. Keep its bytes
  // and payment-specific association; do not migrate or refile historical rows.
  const sha=createHash('sha256').update(pdf).digest('hex')
  await writeProjectBlob(company.id,fixture.financeProjectId,sha,pdf)
  await db.execute(q`INSERT INTO project_attachment_blob(entity_id,project_id,sha256,byte_size,mime)
    VALUES(${company.id}::uuid,${fixture.financeProjectId}::uuid,${sha},${pdf.length},'application/pdf') ON CONFLICT DO NOTHING`)
  await db.execute(q`INSERT INTO project_attachment(entity_id,project_id,payment_id,sha256,uploaded_filename,created_by)
    VALUES(${company.id}::uuid,${fixture.financeProjectId}::uuid,${fixture.financePaymentId}::uuid,${sha},'legacy-transfer.pdf',${actor})`)
  const files=await projectReceiptAttachments(fixture.ledgerId,fixture.financeProjectId,fixture.financePaymentId)
  check(files.length===3&&files.some(f=>f.filename==='legacy-transfer.pdf'),'existing Project payment proof is retained alongside shared proof')
  check((await projectReceiptAttachments(fixture.ledgerId,fixture.financeProjectId.toUpperCase(),fixture.financePaymentId.toUpperCase())).length===3,'uppercase payment identity does not omit native or shared Receipt supporting')
  const body=await invoicePaperPdf(await renderProjectPaymentReceipt(fixture.ledgerId,fixture.financeProjectId,fixture.financePaymentId))
  const withProof=await appendReceiptSupporting(body.buffer,files),loaded=await PDFDocument.load(withProof)
  const bodyPages=(await PDFDocument.load(body.buffer)).getPageCount()
  check(loaded.getPageCount()===bodyPages+3,'two PDF pages plus one image follow body; identical legacy bytes are included once')
  const pages=loaded.getPages();check(pages[bodyPages].getWidth()===640&&pages[bodyPages+1].getRotation().angle===90,'copied PDF pages preserve geometry and rotation')
  const sample='output/pdf/receipt-with-supporting.pdf';writeFileSync(sample,withProof)
  const text=execFileSync('pdftotext',['-layout',sample,'-'],{encoding:'utf8'})
  check(text.indexOf('Receipt')<text.indexOf('SUPPORTING PAGE ONE')&&text.indexOf('SUPPORTING PAGE ONE')<text.indexOf('SUPPORTING PAGE TWO')&&text.indexOf('SUPPORTING PAGE TWO')<text.indexOf('Payment proof'),'body, PDF pages and image follow stable file/page order')
  const incomeFiles=await entryReceiptAttachments(fixture.ledgerId,target.entry_id)
  check(incomeFiles.length===2&&!incomeFiles.some(f=>f.filename==='legacy-transfer.pdf'),'entry Receipt uses shared proof without unrelated native Project files')
  const walk=(dir:string):string[]=>readdirSync(dir).flatMap(name=>{const path=join(dir,name);return statSync(path).isDirectory()?walk(path):[path]})
  const blob=walk(process.env.ATTACHMENTS_DIR!).find(path=>basename(path)===sha)
  assert(blob,'Fresh canonical blob must exist')
  renameSync(blob,blob+'.temporarily-missing')
  try {
    await assert.rejects(()=>projectReceiptAttachments(fixture.ledgerId,fixture.financeProjectId,fixture.financePaymentId),e=>e instanceof DocumentError&&e.message.includes('transfer-confirmation.pdf'))
    await assert.rejects(()=>entryReceiptAttachments(fixture.ledgerId,target.entry_id!),DocumentError)
    check(true,'missing canonical bytes give a file-specific Receipt error in both modules')
  } finally {renameSync(blob+'.temporarily-missing',blob)}
  const incomeResponse=await receiptResponse(new Request('http://local/receipt'),()=>renderPaymentReceipt(fixture.ledgerId,target.entry_id!),()=>entryReceiptAttachments(fixture.ledgerId,target.entry_id!))
  check(incomeResponse.status===200&&(await PDFDocument.load(await incomeResponse.arrayBuffer())).getPageCount()===4,'Income Receipt response automatically appends current supporting')
  const projectResponse=await receiptResponse(new Request('http://local/receipt?download=1'),()=>renderProjectPaymentReceipt(fixture.ledgerId,fixture.financeProjectId,fixture.financePaymentId),()=>projectReceiptAttachments(fixture.ledgerId,fixture.financeProjectId,fixture.financePaymentId))
  check(projectResponse.status===200&&projectResponse.headers.get('Content-Disposition')?.startsWith('attachment;'),'Project Receipt response appends supporting and keeps download headers')
  const long=await PDFDocument.create();long.addPage();long.addPage();const longBody=Buffer.from(await long.save())
  check((await PDFDocument.load(await appendReceiptSupporting(longBody,[{filename:'proof.pdf',mime:'application/pdf',bytes:pdf}]))).getPageCount()===4,'multi-page Receipt body keeps all pages before supporting')
  for(const format of ['jpeg','webp','tiff','gif'] as const) {
    const bytes=await sharp(png).toFormat(format).toBuffer()
    check((await PDFDocument.load(await appendReceiptSupporting(body.buffer,[{filename:'image.'+format,mime:'image/'+format,bytes}]))).getPageCount()===bodyPages+1,format+' image fits on a new page')
  }
  const oriented=await sharp(png).jpeg().withMetadata({orientation:6}).toBuffer()
  writeFileSync('output/pdf/receipt-oriented-image.pdf',await appendReceiptSupporting(body.buffer,[{filename:'phone.jpg',mime:'image/jpeg',bytes:oriented}]))
  check(true,'phone orientation is normalized for the rendered sample')
  for(const [filename,bytes] of [['broken.pdf',Buffer.from('%PDF-broken')],['bad.png',Buffer.from('not a picture')]] as const) {
    await assert.rejects(()=>appendReceiptSupporting(body.buffer,[{filename,mime:'application/octet-stream',bytes}]),e=>e instanceof DocumentError&&e.message.includes(filename));check(true,filename+' reports a file-specific error without omitting proof')
  }
  const encrypted=await PDFDocument.create();encrypted.addPage();encrypted.context.trailerInfo.Encrypt=encrypted.context.register(encrypted.context.obj({Filter:'Standard'}))
  const encryptedBytes=Buffer.from(await encrypted.save())
  await assert.rejects(()=>appendReceiptSupporting(body.buffer,[{filename:'locked.pdf',mime:'application/pdf',bytes:encryptedBytes}]),DocumentError);check(true,'encryption-flagged PDF is refused clearly')
  const tooMany=await PDFDocument.create();for(let i=0;i<201;i++)tooMany.addPage()
  const tooManyBytes=Buffer.from(await tooMany.save())
  await assert.rejects(()=>appendReceiptSupporting(body.buffer,[{filename:'too-long.pdf',mime:'application/pdf',bytes:tooManyBytes}]),DocumentError);check(true,'combined annex page limit is enforced')
  let reachedSupporting=false
  const denied=await receiptResponse(new Request('http://local/receipt'),async()=>{throw new DocumentError('NO_RECEIPT','Unavailable')},async()=>{reachedSupporting=true;return files})
  check(denied.status===404&&!reachedSupporting,'invalid Receipt is rejected before opening supporting bytes')
  for(const [projectId,paymentId] of [[fixture.financeProjectId,fixture.financePaymentId],[fixture.projectId,fixture.projectPaymentId]]) {
    const count=(await projectPaymentAttachments(company.id,projectId,paymentId)).length
    await assert.rejects(()=>attachProjectFile({entityId:company.id,projectId,paymentId,filename:'bad-proof.pdf',mime:'application/pdf',bytes:Buffer.from('%PDF-broken'),actor}),ProjectError)
    check((await projectPaymentAttachments(company.id,projectId,paymentId)).length===count,'invalid payment proof is refused before a shared/native attachment is saved')
  }
  const concurrent=await Promise.all(Array.from({length:12},(_,i)=>sharp({create:{width:20,height:20,channels:3,background:{r:30+i,g:111,b:200}}}).png().toBuffer()))
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    await Promise.race([Promise.all(concurrent.map((bytes,i)=>attachProjectFile({entityId:company.id,projectId:fixture.financeProjectId,paymentId:fixture.financePaymentId,filename:`concurrent-${i}.png`,mime:'image/png',bytes,actor}))),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Concurrent upload pool stalled')),10_000)})])
    check(true,'twelve linked uploads complete with the ten-connection pool by reusing their transactions')
  } finally {clearTimeout(timer)}
  for(const [entity,project,payment,id] of [
    [foreign.id,fixture.financeProjectId,fixture.financePaymentId,sharedId],
    [company.id,fixture.projectId,fixture.financePaymentId,sharedId],
    [company.id,fixture.projectId,fixture.projectPaymentId,sharedId],
    [company.id,fixture.projectId,fixture.invalidProjectPaymentId,nativeId],
    [company.id,fixture.projectId,'bad-id',nativeId],
  ]) {
    await assert.rejects(()=>detachProjectPaymentFile(entity,project,payment,id,actor),ProjectError)
    check(true,'foreign, unrelated, inactive or malformed payment cannot remove proof')
  }
  const other=await saveAttachment({ledgerId:fixture.ledgerId,entryId:fixture.advanceEntryId,filename:'other-payment.pdf',mime:'application/pdf',bytes:pdf,actor})
  await assert.rejects(()=>detachProjectPaymentFile(company.id,fixture.financeProjectId,fixture.financePaymentId,other.id,actor),ProjectError)
  check((await attachmentsOf(fixture.advanceEntryId)).some(a=>a.id===other.id),'same-book proof on another entry cannot be deleted through this payment')
  await deleteAttachment(fixture.ledgerId,other.id,actor,'Verification cleanup')
  const currentNative=await projectHead(company.id,fixture.projectId)
  await updateProject({entityId:company.id,projectId:fixture.projectId,version:currentNative.version,name:currentNative.name,status:'archived',actor})
  await assert.rejects(()=>detachProjectPaymentFile(company.id,fixture.projectId,fixture.projectPaymentId,nativeId,actor),ProjectError)
  check((await projectPaymentAttachments(company.id,fixture.projectId,fixture.projectPaymentId)).some(a=>a.id===nativeId),'archived Project refuses deletion and retains the binding')
  const archived=await projectHead(company.id,fixture.projectId)
  await updateProject({entityId:company.id,projectId:fixture.projectId,version:archived.version,name:archived.name,status:'active',actor})
  await detachProjectPaymentFile(company.id.toUpperCase(),fixture.projectId.toUpperCase(),fixture.projectPaymentId.toUpperCase(),nativeId.toUpperCase(),actor)
  check(!(await projectPaymentAttachments(company.id,fixture.projectId,fixture.projectPaymentId)).some(a=>a.id===nativeId),'native proof deletion accepts canonical uppercase identity and removes only its binding')
  const nativeSha=createHash('sha256').update(png).digest('hex')
  check((await readProjectBlob(company.id,fixture.projectId,nativeSha))?.equals(png),'native immutable blob survives attachment deletion')
  const legacy=(await projectPaymentAttachments(company.id,fixture.financeProjectId,fixture.financePaymentId)).find(a=>a.source==='project'&&a.filename==='legacy-transfer.pdf')!
  await detachProjectPaymentFile(company.id,fixture.financeProjectId,fixture.financePaymentId,legacy.id,actor)
  check((await attachmentsOf(target.entry_id)).some(a=>a.id===sharedId),'deleting a legacy native binding preserves shared Income proof with identical bytes')
  renameSync(blob,blob+'.temporarily-missing')
  try{await detachProjectPaymentFile(company.id,fixture.financeProjectId,fixture.financePaymentId,sharedId,actor)}
  finally{renameSync(blob+'.temporarily-missing',blob)}
  check(!(await attachmentsOf(target.entry_id)).some(a=>a.id===sharedId)&&await readProjectPaymentAttachment(company.id,fixture.financeProjectId,fixture.financePaymentId,sharedId)===null,'shared deletion works without reading missing proof and updates Income and Project together')
  check(readFileSync(blob).equals(pdf),'shared immutable original remains retained after deletion')
  const [detachAudit]=await db.execute<{actor:string;reason:string}>(q`SELECT actor,reason FROM audit_log WHERE table_name='attachment' AND record_id=${sharedId} AND action='detach' ORDER BY id DESC LIMIT 1`)
  check(detachAudit.actor===actor&&detachAudit.reason==='Removed from Project payment attachments.','shared deletion uses canonical actor and factual removal audit reason')
  const concurrentFiles=(await projectPaymentAttachments(company.id,fixture.financeProjectId,fixture.financePaymentId)).filter(a=>a.filename.startsWith('concurrent-'))
  try {
    await Promise.race([Promise.all(concurrentFiles.map(file=>detachProjectPaymentFile(company.id,fixture.financeProjectId,fixture.financePaymentId,file.id,actor))),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Concurrent deletion pool stalled')),10_000)})])
    check(concurrentFiles.length===12,'twelve linked deletions complete with ten connections by retaining their transaction Runner')
  } finally{clearTimeout(timer)}
  const remaining=await projectReceiptAttachments(fixture.ledgerId,fixture.financeProjectId,fixture.financePaymentId)
  check(remaining.length===1&&remaining[0].filename==='cheque.png'&&(await PDFDocument.load(await appendReceiptSupporting(body.buffer,remaining))).getPageCount()===bodyPages+1,'next Receipt contains only remaining proof and no deleted PDF or images')
  const replacement=await attachProjectFile({entityId:company.id,projectId:fixture.financeProjectId,paymentId:fixture.financePaymentId,filename:'replacement-transfer.pdf',mime:'application/pdf',bytes:pdf,actor})
  check(replacement!==sharedId&&(await entryReceiptAttachments(fixture.ledgerId,target.entry_id)).length===2,'deleted proof can be reattached as a replacement using the retained canonical bytes')
  assert.deepEqual(await db.execute(q`SELECT id,status,total_debit,total_credit FROM journal_entry ORDER BY id`),financialBefore);check(true,'attachment and Receipt operations change no journal values or rows')
  writeFileSync(evidence+'/result.json',JSON.stringify({passed:true,checks,bodyPages,appendedPages:3,database:identity.name,sharedAttachmentId:sharedId,imageId:image.id},null,2)+'\n')
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>sql.end({timeout:0}))

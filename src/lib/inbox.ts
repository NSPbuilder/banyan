import 'server-only'
import type {Tx} from './acting'
import type {AutomationScope} from './automation-access'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { AutomationError,automationScope,automationAudit,type AutomationActor } from './automation-access'
import { validateInboxFile } from './inbox-file'
import { writeBlobBytes,readBlobBytes } from './attachments'
import { serviceState } from './ai-service'
import { readBill } from './bill-reading'
import { enqueueJob,lockClaim,completeJob,jobActor,type Job } from './jobs'
import { withDocumentWrite } from './edit-leases'
import type { EditContext } from './edit-proof'
import { createSnapshotDraft,reviewedSnapshot } from './automation-drafts'

export type InboxItem={id:string;entity_id:string;ledger_id:string;filename:string;mime:string;sha256:string;status:string;reading_id:string|null;
  version:string;corrections:Record<string,unknown>|null;duplicate_reason:string|null;duplicate_override:string|null;
  target_invoice_id:string|null;target_entry_id:string|null;last_error:string|null}
export const inboxColumns=sql.raw('id::text,entity_id::text,ledger_id::text,filename,mime,sha256,status,reading_id::text,version::text,corrections,duplicate_reason,duplicate_override,target_invoice_id::text,target_entry_id::text,last_error')
export async function uploadInbox(ledgerId:string,actor:AutomationActor,file:{name:string;type:string;bytes:Buffer},extract:boolean) {
  const verified=await validateInboxFile(file.name,file.type,file.bytes)
  const sha=createHash('sha256').update(file.bytes).digest('hex')
  // Authorize before filesystem I/O; recheck before persisting the receipt.
  const initial=await db.transaction(tx=>automationScope(tx,ledgerId,actor))
  await writeBlobBytes(initial.name,sha,file.bytes)
  return db.transaction(async tx=>{
    const s=await automationScope(tx,ledgerId,actor)
    if(s.name!==initial.name)throw new AutomationError('COMPANY_CHANGED','The company was renamed during upload. Choose the file again.')
    return persistInboxReceipt(tx,s,{name:file.name,mime:verified.mime,sha256:sha,byteSize:file.bytes.length,pages:verified.pages},extract)
  })
}

/** Shared receipt and duplicate rules for authenticated upload and authenticated inbound channels. */
export async function persistInboxReceipt(tx:Tx,s:AutomationScope,file:{name:string;mime:string;sha256:string;byteSize:number;pages:number},extract:boolean){
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${s.ledgerId+':'+file.sha256},0))`)
    const same=await tx.execute(sql`SELECT id FROM inbox_item WHERE ledger_id=${s.ledgerId}::uuid AND sha256=${file.sha256}
      UNION ALL SELECT a.id FROM attachment a JOIN journal_entry e ON e.id=a.entry_id WHERE e.ledger_id=${s.ledgerId}::uuid AND a.sha256=${file.sha256} LIMIT 1`)
    const profile=extract?await serviceState(s.userId):null
    const ready=extract&&profile?.kind==='ready'
    await tx.execute(sql`INSERT INTO attachment_blob(sha256,byte_size,mime,created_by) VALUES (${file.sha256},${file.byteSize},${file.mime},${s.email}) ON CONFLICT(sha256) DO NOTHING`)
    const [item]=await tx.execute<{id:string}>(sql`INSERT INTO inbox_item(entity_id,ledger_id,actor_user_id,sha256,filename,mime,status,corrections,duplicate_reason,last_error)
      VALUES (${s.entity_id}::uuid,${s.ledgerId}::uuid,${s.userId}::uuid,${file.sha256},${file.name},${file.mime},${ready?'received':'needs_review'},
        ${JSON.stringify({pages:file.pages})}::jsonb,${same.length?'An identical file is already in this ledger. Review or link the existing accounting.':null},
        ${extract&&!ready?'AI service is unavailable. Review and enter this document manually.':null}) RETURNING id::text`)
    if(ready)await enqueueJob(tx,s,{type:'inbox_extract',key:item.id,inboxId:item.id})
    await automationAudit(tx,s,'inbox_uploaded','inbox_item',item.id,{sha256:file.sha256,pages:file.pages,extractionQueued:ready})
    return item
}

export async function inboxFile(ledgerId:string,id:string,actor:AutomationActor) {
  const row=await db.transaction(async tx=>{
    const s=await automationScope(tx,ledgerId,actor)
    const [item]=await tx.execute<InboxItem>(sql`SELECT ${inboxColumns} FROM inbox_item WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid`)
    if(!item)throw new AutomationError('NO_FILE','This source document is unavailable in this ledger.')
    return {item,company:s.name}
  })
  const bytes=await readBlobBytes(row.company,row.item.sha256)
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==row.item.sha256)throw new AutomationError('MISSING_FILE','The original file is missing or damaged. Restore its attachment backup before continuing.')
  return {bytes,mime:row.item.mime,name:row.item.filename}
}
export async function runInbox(j:Job) {
  const prepared=await db.transaction(async tx=>{
    await lockClaim(tx,j)
    const s=await automationScope(tx,j.ledger_id,jobActor(j),{enabled:true})
    const [item]=await tx.execute<InboxItem>(sql`SELECT ${inboxColumns} FROM inbox_item WHERE id=${j.inbox_item_id}::uuid FOR UPDATE`)
    if(!item||['converted','ignored'].includes(item.status)){await completeJob(tx,j,{reason:'Source already reviewed.'},'skipped');return null}
    const profile=await serviceState(s.userId)
    if(profile.kind!=='ready') {
      await tx.execute(sql`UPDATE inbox_item SET status='needs_review',last_error='AI service is unavailable. Enter the document manually.' WHERE id=${item.id}::uuid`)
      await completeJob(tx,j,{manualReview:true});return null
    }
    await tx.execute(sql`UPDATE inbox_item SET status='processing',last_error=NULL WHERE id=${item.id}::uuid`)
    return {s,item,profile}
  })
  if(!prepared)return
  const bytes=await readBlobBytes(prepared.s.name,prepared.item.sha256)
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==prepared.item.sha256)throw new AutomationError('MISSING_FILE','The original file is missing or damaged; restore its backup.')
  // The existing reader calls the actual saved provider, outside a claim transaction.
  const reading=await readBill({ledgerId:j.ledger_id,filename:prepared.item.filename,mime:prepared.item.mime,bytes,
    actor:prepared.s.email,service:prepared.profile.saved.service,prices:prepared.profile.saved.prices})
  await db.transaction(async tx=>{
    await lockClaim(tx,j)
    const s=await automationScope(tx,j.ledger_id,jobActor(j),{enabled:true})
    const [item]=await tx.execute<InboxItem>(sql`SELECT ${inboxColumns} FROM inbox_item WHERE id=${j.inbox_item_id}::uuid FOR UPDATE`)
    if(!item||['converted','ignored'].includes(item.status)){await completeJob(tx,j,{readingId:reading.id,reason:'Review already finished.'},'skipped');return}
    const [r]=await tx.execute<{used_entry_id:string|null;used_invoice_id:string|null}>(sql`SELECT used_entry_id::text,used_invoice_id::text FROM ai_bill_reading WHERE id=${reading.id}::uuid FOR UPDATE`)
    const used=!!(r.used_entry_id||r.used_invoice_id)
    await tx.execute(sql`UPDATE inbox_item SET reading_id=${reading.id}::uuid,status='needs_review',last_error=${used?'This extraction was already used. Link its existing accounting.':reading.error} WHERE id=${item.id}::uuid`)
    await automationAudit(tx,s,'inbox_extracted','inbox_item',item.id,{readingId:reading.id,proposalAvailable:!!reading.proposal})
    await completeJob(tx,j,{readingId:reading.id,needsReview:true})
  })
}
export async function reviewInbox(ledgerId:string,id:string,actor:AutomationActor,edit:EditContext,form:FormData) {
  return withDocumentWrite({ledgerId,type:'inbox',id},edit,async tx=>{
    const mode=String(form.get('operation')??'create'),targetType=mode==='link'?(String(form.get('linkType')??'invoice')==='entry'?'entry':'purchase'):String(form.get('targetType')??'purchase')
    const s=await automationScope(tx,ledgerId,actor,{seat:targetType==='entry'||targetType==='expense'?'/entries':'/invoices'})
    const [item]=await tx.execute<InboxItem>(sql`SELECT ${inboxColumns} FROM inbox_item WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid FOR UPDATE`)
    if(!item||['converted','ignored'].includes(item.status))throw new AutomationError('ALREADY_REVIEWED','This receipt has already been converted or ignored. Open its recorded target.')
    if(mode==='ignore') {
      const reason=String(form.get('reason')??'').trim();if(!reason)throw new AutomationError('REASON','Explain why this document is being ignored.')
      await tx.execute(sql`UPDATE inbox_item SET status='ignored',last_error=${reason} WHERE id=${id}::uuid`)
      await automationAudit(tx,s,'inbox_ignored','inbox_item',id,undefined,reason);return {id,entryId:null,invoiceId:null}
    }
    if(!['create','link'].includes(mode)||!['sales','purchase','expense','entry'].includes(targetType))throw new AutomationError('TARGET','Choose a reviewed draft or an existing accounting record.')
    if(item.status==='processing')throw new AutomationError('PROCESSING','Wait for extraction to finish, or pause its job before manual review.')
    let reading:{used_entry_id:string|null;used_invoice_id:string|null}|undefined
    if(item.reading_id)[reading]=await tx.execute<{used_entry_id:string|null;used_invoice_id:string|null}>(sql`SELECT used_entry_id::text,used_invoice_id::text FROM ai_bill_reading WHERE id=${item.reading_id}::uuid FOR UPDATE`)
    const previouslyUsed=!!(reading?.used_entry_id||reading?.used_invoice_id)
    let target:{entryId:string|null;invoiceId:string|null},corrections:unknown=null,duplicate=item.duplicate_reason
    const override=String(form.get('duplicateOverride')??'').trim()
    if(mode==='link') {
      const targetId=String(form.get('targetId')??'')
      const entry=targetType==='entry'||targetType==='expense'
      const [found]=await tx.execute(sql`SELECT id FROM ${sql.raw(entry?'journal_entry':'invoice')} WHERE id=${targetId}::uuid AND ledger_id=${ledgerId}::uuid`)
      if(!found)throw new AutomationError('TARGET','Select an existing record in this ledger.')
      if(previouslyUsed && targetId!==reading?.used_entry_id && targetId!==reading?.used_invoice_id)throw new AutomationError('READING_USED','Link the accounting record already created from this extraction.')
      target={entryId:entry?targetId:null,invoiceId:entry?null:targetId}
    } else {
      if(previouslyUsed)throw new AutomationError('READING_USED','This extraction already has accounting. Link that record instead of creating another draft.')
      if(targetType==='entry')throw new AutomationError('TARGET','Use a reviewed expense draft, invoice or bill; manual journal linking is available.')
      const reviewed=await reviewedSnapshot(tx,s,form)
      if(reviewed.reference&&reviewed.snapshot.type!=='entry') {
        const candidates=await tx.execute(sql`SELECT i.id FROM invoice i WHERE i.ledger_id=${ledgerId}::uuid AND i.party_id=${reviewed.snapshot.partyId}::uuid
          AND i.their_ref=${reviewed.reference} AND i.status<>'void' AND i.direction=${reviewed.snapshot.type}
          AND abs((SELECT coalesce(sum(amount),0) FROM invoice_line WHERE invoice_id=i.id))=${reviewed.total}::bigint LIMIT 1`)
        if(candidates.length)duplicate='A document with this party, reference, currency and total exists in this ledger. Review the existing accounting.'
      }
      const originals=await tx.execute(sql`SELECT n.id FROM inbox_item n WHERE n.ledger_id=${ledgerId}::uuid AND n.sha256=${item.sha256} AND n.id<>${item.id}::uuid
        UNION ALL SELECT a.id FROM attachment a JOIN journal_entry e ON e.id=a.entry_id WHERE e.ledger_id=${ledgerId}::uuid AND a.sha256=${item.sha256}
        UNION ALL SELECT r.id FROM ai_bill_reading r WHERE r.ledger_id=${ledgerId}::uuid AND r.sha256=${item.sha256} AND (r.used_entry_id IS NOT NULL OR r.used_invoice_id IS NOT NULL) LIMIT 1`)
      if(originals.length)duplicate=duplicate??'An identical original is already received or attached to accounting in this ledger. Review the existing record.'
      if(duplicate&&!override)throw new AutomationError('DUPLICATE','A possible duplicate exists. Link its accounting or explain why this is a separate transaction.')
      target=await createSnapshotDraft(tx,s,reviewed.snapshot,reviewed.date,reviewed.dueDays)
      if(target.invoiceId&&reviewed.reference)await tx.execute(sql`UPDATE invoice SET their_ref=${reviewed.reference} WHERE id=${target.invoiceId}::uuid`)
      corrections=reviewed
    }
    if(item.reading_id&&!previouslyUsed) {
      await tx.execute(sql`SELECT set_config('p2.inbox_claim',${id},true)`)
      if(target.entryId)await tx.execute(sql`UPDATE ai_bill_reading SET used_entry_id=${target.entryId}::uuid,used_at=clock_timestamp() WHERE id=${item.reading_id}::uuid`)
      else await tx.execute(sql`UPDATE ai_bill_reading SET used_invoice_id=${target.invoiceId}::uuid WHERE id=${item.reading_id}::uuid`)
    }
    await tx.execute(sql`UPDATE inbox_item SET status='converted',corrections=${JSON.stringify(corrections)}::jsonb,duplicate_reason=${duplicate},duplicate_override=${override||null},
      target_invoice_id=${target.invoiceId}::uuid,target_entry_id=${target.entryId}::uuid,converted_at=clock_timestamp(),converted_by=${s.email},last_error=NULL WHERE id=${id}::uuid`)
    await automationAudit(tx,s,mode==='link'?'inbox_linked':'inbox_draft_created','inbox_item',id,{...target,corrections},override||undefined)
    return {id,...target}
  })
}

/** Financial-document routes authorize through the existing front-door gate. */
export async function targetInboxFile(ledgerId:string,type:'invoice'|'entry',targetId:string,itemId:string) {
  const [row]=await db.execute<{filename:string;mime:string;sha256:string;company:string}>(sql`SELECT n.filename,n.mime,n.sha256,e.name AS company
    FROM inbox_item n JOIN ledger l ON l.id=n.ledger_id JOIN entity e ON e.id=l.entity_id
    WHERE n.id=${itemId}::uuid AND n.ledger_id=${ledgerId}::uuid AND
      ${type==='invoice'?sql`n.target_invoice_id=${targetId}::uuid`:sql`n.target_entry_id=${targetId}::uuid`}`)
  if(!row)return null
  const bytes=await readBlobBytes(row.company,row.sha256)
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==row.sha256)return null
  return {bytes,mime:row.mime,name:row.filename}
}

import 'server-only'
import {companySmtpTransportConfig,validateReminderSchedule} from './company-services'
import { createHash,randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Tx } from './acting'
import { AutomationError,automationScope,automationAudit,companyClock,validId,type AutomationActor,type AutomationScope } from './automation-access'
import { invoicePdf,customerStatementPdf } from './pdf-reports'
import { customerActivityPdf } from './customer-activity'
import { renderCustomerStatement } from './customer-docs'
import { balanceOf } from './payments'
import { validBusinessDate } from './automation-drafts'
import { readBlobBytes,writeBlobBytes } from './attachments'
import { enqueueJob,lockClaim,completeJob,failJob,jobActor,type Job } from './jobs'
import { withDocumentWrite } from './edit-leases'
import type { EditContext } from './edit-proof'

const digest=(v:unknown)=>createHash('sha256').update(Buffer.isBuffer(v)?v:typeof v==='string'?v:JSON.stringify(v)).digest('hex')
const emailPattern=/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/
export function emailAddresses(raw:string|string[],required=true) {
  const values=(Array.isArray(raw)?raw:raw.split(/[;,]/)).map(v=>v.trim()).filter(Boolean)
  if(values.length>10||required&&!values.length||values.some(v=>v.length>254||!emailPattern.test(v)))
    throw new AutomationError('EMAIL','Enter up to 10 plain email addresses, separated by commas.')
  return [...new Set(values)]
}
export type MailMessage={id:string;entity_id:string;ledger_id:string;actor_user_id:string|null;party_id:string;invoice_id:string|null;
  reminder_rule_id:string|null;parent_message_id:string|null;kind:'invoice'|'open_statement'|'activity_statement'|'reminder';request_key:string;request_hash:string;
  recipients:string[];cc:string[];contact_fingerprint:string;subject:string;body:string;attachment_sha256:string;attachment_name:string;
  snapshot:{from:string;asOf:string;periodFrom?:string;revision:string;generatedAt:string;resendReason?:string};invoice_version:string|null;planned_date:string|null;status:string;last_error:string|null;message_id:string|null}
export const mailColumns=sql.raw('id::text,entity_id::text,ledger_id::text,actor_user_id::text,party_id::text,invoice_id::text,reminder_rule_id::text,parent_message_id::text,kind,request_key::text,request_hash,recipients,cc,contact_fingerprint,subject,body,attachment_sha256,attachment_name,snapshot,invoice_version::text,planned_date::text,status,last_error,message_id')
export type ReminderRule={id:string;entity_id:string;ledger_id:string;party_id:string;actor_user_id:string|null;enabled:boolean;paused:boolean;pause_reason:string|null;defer_until:string|null;days:number[];start_hour:number;end_hour:number;version:string;uses_company_defaults:boolean}
export const reminderColumns=sql.raw('id::text,entity_id::text,ledger_id::text,party_id::text,actor_user_id::text,enabled,paused,pause_reason,defer_until::text,days,start_hour,end_hour,version::text,uses_company_defaults')
export async function effectiveReminder(tx:Tx,r:ReminderRule){
  if(!r.uses_company_defaults)return r
  const [s]=await tx.execute<{reminder_days:number[];reminder_start_hour:number;reminder_end_hour:number}>(sql`SELECT reminder_days,reminder_start_hour,reminder_end_hour FROM automation_setting WHERE entity_id=${r.entity_id}::uuid FOR SHARE`)
  return {...r,days:s?.reminder_days??[3,7,14],start_hour:s?.reminder_start_hour??9,end_hour:s?.reminder_end_hour??17}
}
async function customer(tx:Tx,s:AutomationScope,partyId:string) {
  const [p]=await tx.execute<{name:string}>(sql`SELECT p.name FROM party p WHERE p.id=${partyId}::uuid AND p.is_active
    AND EXISTS(SELECT 1 FROM party_role WHERE party_id=p.id AND entity_id=${s.entity_id}::uuid AND role='customer') FOR SHARE`)
  if(!p)throw new AutomationError('CUSTOMER','Choose an active customer in this company.')
  return p
}
export async function customerContact(tx:Tx,partyId:string) {
  const rows=await tx.execute<{id:string;name:string;email:string|null;phone:string|null;is_primary:boolean}>(sql`SELECT id::text,name,email,phone,is_primary FROM party_contact WHERE party_id=${partyId}::uuid ORDER BY is_primary DESC,id`)
  return {fingerprint:digest(rows),email:rows.find(r=>r.is_primary)?.email??null}
}
async function arRevision(tx:Tx,ledgerId:string,partyId:string) {
  const heads=await tx.execute(sql`SELECT je.id::text,je.version::text FROM journal_entry je WHERE je.ledger_id=${ledgerId}::uuid
    AND EXISTS(SELECT 1 FROM journal_line WHERE entry_id=je.id AND party_id=${partyId}::uuid) ORDER BY je.id`)
  const invoices=await tx.execute(sql`SELECT id::text,version::text FROM invoice WHERE ledger_id=${ledgerId}::uuid AND party_id=${partyId}::uuid ORDER BY id`)
  return digest({heads,invoices})
}
async function formalInvoice(tx:Tx,ledgerId:string,id:string,partyId:string,reminder=false) {
  const [i]=await tx.execute<{version:string;number:string|null;due_on:string}>(sql`SELECT version::text,number,due_on::text FROM invoice
    WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid AND party_id=${partyId}::uuid AND direction='sales'
      AND status='posted' AND document_kind IN ('invoice','credit_note') AND (${!reminder} OR document_kind='invoice') FOR SHARE`)
  if(!i)throw new AutomationError('FORMAL_INVOICE','Only a posted sales invoice or credit note can be sent.')
  return i
}
export type MailPreviewInput={kind:MailMessage['kind'];partyId:string;invoiceId?:string;ruleId?:string;plannedDate?:string;asOf:string;periodFrom?:string;
  to:string|string[];cc:string|string[];subject:string;body:string;requestKey:string;parentId?:string;resendReason?:string}
export async function createMailPreview(ledgerId:string,actor:AutomationActor,input:MailPreviewInput) {
  input={...input,invoiceId:['invoice','reminder'].includes(input.kind)?input.invoiceId:undefined,ruleId:input.kind==='reminder'?input.ruleId:undefined,plannedDate:input.kind==='reminder'?input.plannedDate:undefined}
  if(!validId(input.requestKey)||!['invoice','open_statement','activity_statement','reminder'].includes(input.kind))throw new AutomationError('REQUEST','A valid message authorization is required.')
  validBusinessDate(input.asOf)
  if(input.kind==='activity_statement')validBusinessDate(input.periodFrom??'')
  if(!input.subject.trim()||input.subject.length>200||/[\r\n]/.test(input.subject)||!input.body.trim()||input.body.length>10000)
    throw new AutomationError('MESSAGE','Enter a single-line subject and a message up to 10,000 characters.')
  const to=emailAddresses(input.to),cc=emailAddresses(input.cc,false)
  const requestHash=digest({...input,to,cc})
  const initial=await db.transaction(async tx=>{
    const s=await automationScope(tx,ledgerId,actor,{seat:'/invoices'})
    await customer(tx,s,input.partyId)
    if(input.kind==='invoice'){
      const primary=(await customerContact(tx,input.partyId)).email
      if(!primary?.trim())throw new AutomationError('EMAIL','Add a primary customer email in Parties before previewing or sending this invoice.')
      if(to.length!==1||to[0]!==primary.trim())throw new AutomationError('EMAIL','Use the customer’s current primary email. Update it in Parties before sending.')
    }
    const [prior]=await tx.execute<MailMessage>(sql`SELECT ${mailColumns} FROM email_message WHERE ledger_id=${ledgerId}::uuid AND actor_user_id=${s.userId}::uuid AND request_key=${input.requestKey}::uuid`)
    if(prior){if(prior.request_hash!==requestHash)throw new AutomationError('IDEMPOTENCY_CONFLICT','This message authorization was used for different content. Start a new preview.');return {s,prior}}
    if(!s.setting?.sender_email)throw new AutomationError('SENDER','Configure this company’s sender before preparing mail.')
    emailAddresses(s.setting.sender_email)
    let invoice:Awaited<ReturnType<typeof formalInvoice>>|undefined
    if(['invoice','reminder'].includes(input.kind))invoice=await formalInvoice(tx,ledgerId,input.invoiceId??'',input.partyId,input.kind==='reminder')
    if(input.parentId) {
      if(!input.resendReason?.trim())throw new AutomationError('RESEND_REASON','Explain the provider check and why another send is authorized.')
      const previous=await tx.execute(sql`SELECT id FROM email_message WHERE id=${input.parentId}::uuid AND ledger_id=${ledgerId}::uuid AND party_id=${input.partyId}::uuid AND status IN ('accepted','delivery_unknown','bounced','failed','skipped','paused')`)
      if(!previous.length)throw new AutomationError('RESEND','This message is unavailable for a new send authorization.')
    }
    return {s,invoice,contact:await customerContact(tx,input.partyId),revision:await arRevision(tx,ledgerId,input.partyId)}
  })
  if(initial.prior)return {id:initial.prior.id,replayed:true}
  const paper=input.kind==='invoice'?await invoicePdf(input.invoiceId!):input.kind==='activity_statement'
    ?await customerActivityPdf(ledgerId,input.partyId,input.periodFrom!,input.asOf):await customerStatementPdf(ledgerId,input.partyId,input.asOf)
  const sha=digest(paper.buffer),snapshot={from:initial.s.setting!.sender_email!,asOf:input.asOf,periodFrom:input.periodFrom,revision:initial.revision!,generatedAt:new Date().toISOString(),resendReason:input.resendReason}
  await writeBlobBytes(initial.s.name,sha,paper.buffer)
  return db.transaction(async tx=>{
    const s=await automationScope(tx,ledgerId,actor,{seat:'/invoices'})
    await customer(tx,s,input.partyId)
    if(s.name!==initial.s.name||s.setting?.sender_email!==snapshot.from||(await customerContact(tx,input.partyId)).fingerprint!==initial.contact!.fingerprint
      ||await arRevision(tx,ledgerId,input.partyId)!==initial.revision)throw new AutomationError('SNAPSHOT_CHANGED','The company, customer or AR changed during preview. Regenerate and confirm its content.')
    if(initial.invoice&&(await formalInvoice(tx,ledgerId,input.invoiceId!,input.partyId)).version!==initial.invoice.version)throw new AutomationError('SNAPSHOT_CHANGED','The invoice changed during preview.')
    await tx.execute(sql`INSERT INTO attachment_blob(sha256,byte_size,mime,created_by) VALUES (${sha},${paper.buffer.length},'application/pdf',${s.email}) ON CONFLICT(sha256) DO NOTHING`)
    const [row]=await tx.execute<{id:string}>(sql`INSERT INTO email_message(entity_id,ledger_id,actor_user_id,party_id,invoice_id,reminder_rule_id,parent_message_id,kind,request_key,request_hash,
      recipients,cc,contact_fingerprint,subject,body,attachment_sha256,attachment_name,snapshot,invoice_version,planned_date)
      VALUES (${s.entity_id}::uuid,${ledgerId}::uuid,${s.userId}::uuid,${input.partyId}::uuid,${input.invoiceId??null}::uuid,${input.ruleId??null}::uuid,${input.parentId??null}::uuid,
        ${input.kind},${input.requestKey}::uuid,${requestHash},${sql.param(to)},${sql.param(cc)},${initial.contact!.fingerprint},${input.subject.trim()},${input.body},${sha},${paper.filename},${JSON.stringify(snapshot)}::jsonb,
        ${initial.invoice?.version??null}::bigint,${input.plannedDate??null}::date)
      ON CONFLICT(entity_id,ledger_id,actor_user_id,request_key) DO NOTHING RETURNING id::text`)
    if(!row){const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM email_message WHERE ledger_id=${ledgerId}::uuid AND actor_user_id=${s.userId}::uuid AND request_key=${input.requestKey}::uuid`);if(prior.request_hash!==requestHash)throw new AutomationError('IDEMPOTENCY_CONFLICT','This authorization conflicts with another preview.');return {id:prior.id,replayed:true}}
    await automationAudit(tx,s,'mail_preview_created','email_message',row.id,{kind:input.kind,attachmentSha:sha,parentId:input.parentId},input.resendReason)
    return {id:row.id,replayed:false}
  })
}
async function eligible(tx:Tx,s:AutomationScope,m:MailMessage,at=new Date()) {
  await customer(tx,s,m.party_id)
  if(s.setting?.sender_email!==m.snapshot.from||(await customerContact(tx,m.party_id)).fingerprint!==m.contact_fingerprint)
    throw new AutomationError('SNAPSHOT_CHANGED','Sender or customer contact changed. Prepare and approve a new preview.')
  if(m.invoice_id&&(await formalInvoice(tx,s.ledgerId,m.invoice_id,m.party_id,m.kind==='reminder')).version!==m.invoice_version)
    throw new AutomationError('SNAPSHOT_CHANGED','Invoice changed after approval. Prepare and approve a new preview.')
  if(m.kind!=='invoice'&&await arRevision(tx,s.ledgerId,m.party_id)!==m.snapshot.revision)
    throw new AutomationError('SNAPSHOT_CHANGED','AR changed after approval. Prepare a fresh statement.')
  if(m.kind==='reminder') {
    const [saved]=await tx.execute<ReminderRule>(sql`SELECT ${reminderColumns} FROM reminder_rule WHERE id=${m.reminder_rule_id}::uuid AND ledger_id=${s.ledgerId}::uuid FOR SHARE`)
    const rule=saved?await effectiveReminder(tx,saved):undefined
    const clock=companyClock(s.setting!.timezone,at)
    if(rule?.party_id!==m.party_id||!rule?.enabled||rule.paused||rule.defer_until&&rule.defer_until>=clock.date||clock.hour<rule.start_hour||clock.hour>=rule.end_hour||m.planned_date!==clock.date)
      throw new AutomationError('REMINDER_PAUSED','Reminder is paused, deferred, outside its time window or no longer scheduled for today.')
    const item=await balanceOf(m.invoice_id!),st=await renderCustomerStatement(s.ledgerId,m.party_id,clock.date)
    const age=Math.round((new Date(clock.date+'T12:00:00Z').getTime()-new Date(item.due_on+'T12:00:00Z').getTime())/86400000)
    if(!rule.days.includes(age))throw new AutomationError('REMINDER_PAUSED','The edited rule no longer schedules this overdue day.')
    if(item.due_on>=clock.date||item.balance<=0n||st.totalOwed<=0n)throw new AutomationError('NO_DEBT','The invoice is paid, not overdue or covered by customer credits. Reminder skipped.')
    if((await customerContact(tx,m.party_id)).email!==m.recipients[0])throw new AutomationError('SNAPSHOT_CHANGED','The primary customer email changed. Review before sending.')
  }
}
export async function queueMail(ledgerId:string,id:string,actor:AutomationActor) {
  return db.transaction(async tx=>{
    const s=await automationScope(tx,ledgerId,actor,{enabled:true,mail:true,seat:'/invoices'})
    const [m]=await tx.execute<MailMessage>(sql`SELECT ${mailColumns} FROM email_message WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid FOR UPDATE`)
    if(!m||m.actor_user_id!==s.userId)throw new AutomationError('AUTHORIZATION','Approve a preview prepared under your own current authorization.')
    if(m.status==='queued'){return {id,jobId:await enqueueJob(tx,s,{type:'email_send',key:id,emailId:id})}}
    if(m.status!=='preview')throw new AutomationError('STATE','This send authorization has already been used. A resend requires a new approved preview.')
    await eligible(tx,s,m)
    await tx.execute(sql`UPDATE email_message SET status='queued' WHERE id=${id}::uuid`)
    const jobId=await enqueueJob(tx,s,{type:'email_send',key:id,emailId:id})
    await automationAudit(tx,s,'mail_authorized','email_message',id,{jobId,to:m.recipients,cc:m.cc,attachmentSha:m.attachment_sha256})
    return {id,jobId}
  })
}
export function smtpTransport(config?:{host:string;port:number;secure:boolean;user?:string;password?:string}|null) {
  const host=config?.host??process.env.SMTP_HOST,port=config?.port??Number(process.env.SMTP_PORT??587),secure=config?.secure??process.env.SMTP_SECURE==='true'
  const local=process.env.SMTP_LOCAL_CAPTURE==='true'&&['127.0.0.1','::1','localhost'].includes(host??'')
  if(!host||!Number.isInteger(port)||port<1||port>65535||process.env.SMTP_LOCAL_CAPTURE==='true'&&!local)
    throw new AutomationError('SMTP_CONFIG','Configure an SMTP host and port. Insecure capture is restricted to loopback.')
  const timeout=Number(process.env.SMTP_TIMEOUT_MS??15000)
  if(!Number.isInteger(timeout)||timeout<1000||timeout>20000)throw new AutomationError('SMTP_CONFIG','SMTP timeout must be 1–20 seconds, within the worker lease.')
  return nodemailer.createTransport({host,port,secure,requireTLS:!local&&!secure,ignoreTLS:local,
    auth:config?(config.user?{user:config.user,pass:config.password}:undefined):process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}:undefined,
    connectionTimeout:timeout,greetingTimeout:timeout,socketTimeout:timeout,dnsTimeout:timeout,
    disableFileAccess:true,disableUrlAccess:true,logger:false,debug:false,tls:{rejectUnauthorized:true}})
}
export function smtpFailure(error:unknown):'retry'|'bounced'|'failed'|'delivery_unknown' {
  const e=error as {responseCode?:number;command?:string;code?:string;syscall?:string;errno?:number}
  if(e.code==='ETIMEDOUT')return 'delivery_unknown'
  if(e.responseCode && e.responseCode>=400&&e.responseCode<500)return 'retry'
  if(e.responseCode && e.responseCode>=500)return e.command?.startsWith('RCPT')?'bounced':'failed'
  if(e.code==='EDNS'||e.syscall==='connect'&&e.code==='ESOCKET')return 'retry'
  if(['EHLO','HELO','AUTH','MAIL FROM','RCPT TO','STARTTLS'].some(c=>e.command?.startsWith(c)))return e.code==='EAUTH'?'failed':'retry'
  return 'delivery_unknown'
}
async function skipChangedMail(j:Job,error:unknown) {
  if(!(error instanceof AutomationError)||!['SNAPSHOT_CHANGED','NO_DEBT','REMINDER_PAUSED','FORMAL_INVOICE','CUSTOMER'].includes(error.code))return false
  await db.transaction(async tx=>{await lockClaim(tx,j);await tx.execute(sql`UPDATE email_message SET status='skipped',last_error=${error.message} WHERE id=${j.email_message_id}::uuid`);await completeJob(tx,j,{reason:error.message},'skipped')})
  return true
}
export async function runMail(j:Job) {
  let prepared:{s:AutomationScope;m:MailMessage}|null=null
  try {
    prepared=await db.transaction(async tx=>{
      await lockClaim(tx,j)
      const s=await automationScope(tx,j.ledger_id,jobActor(j),{enabled:true,mail:true,seat:'/invoices'})
      const [m]=await tx.execute<MailMessage>(sql`SELECT ${mailColumns} FROM email_message WHERE id=${j.email_message_id}::uuid AND ledger_id=${j.ledger_id}::uuid FOR UPDATE`)
      if(!m||!['queued','sending'].includes(m.status))throw new AutomationError('STATE','This authorization is not queued for sending.')
      await eligible(tx,s,m)
      await tx.execute(sql`UPDATE email_message SET status='sending' WHERE id=${m.id}::uuid`)
      await automationAudit(tx,s,'mail_sending','email_message',m.id,{jobId:j.id,generation:j.generation})
      return {s,m}
    })
  } catch(error) {
    if(await skipChangedMail(j,error))return
    throw error
  }
  const {s,m}=prepared
  const bytes=await readBlobBytes(s.name,m.attachment_sha256)
  if(!bytes||digest(bytes)!==m.attachment_sha256)throw new AutomationError('MISSING_FILE','The approved attachment is missing or damaged. Restore files before sending.')
  const transport=smtpTransport(await companySmtpTransportConfig(s.entity_id))
  try {
    // Blob IO can take time. Recheck the fenced claim and current authorization
    // immediately before handing the approved bytes to the network.
    await db.transaction(async tx=>{
      await lockClaim(tx,j)
      const fresh=await automationScope(tx,j.ledger_id,jobActor(j),{enabled:true,mail:true,seat:'/invoices'})
      await eligible(tx,fresh,m)
    })
    const info=await transport.sendMail({from:m.snapshot.from,to:m.recipients,cc:m.cc,subject:m.subject,text:m.body,
      messageId:`<figtree-${m.id}@${m.snapshot.from.split('@')[1]}>`,attachments:[{filename:m.attachment_name,content:bytes,contentType:'application/pdf'}],disableFileAccess:true,disableUrlAccess:true})
    if(!info.accepted.length)throw new AutomationError('SMTP_EMPTY','SMTP did not confirm an accepted recipient.')
    await db.transaction(async tx=>{
      await lockClaim(tx,j)
      const rejected=info.rejected.map(String)
      await tx.execute(sql`UPDATE email_message SET status='accepted',message_id=${info.messageId},accepted_at=clock_timestamp(),last_error=${rejected.length?'SMTP accepted only part of the envelope; rejected recipients: '+rejected.join(', '):null} WHERE id=${m.id}::uuid`)
      if(rejected.length&&m.reminder_rule_id)await tx.execute(sql`UPDATE reminder_rule SET paused=true,pause_reason='SMTP rejected recipients. Correct the address before resuming.' WHERE id=${m.reminder_rule_id}::uuid`)
      await automationAudit(tx,s,'mail_smtp_accepted','email_message',m.id,{messageId:info.messageId,accepted:info.accepted.map(String),rejected})
      await completeJob(tx,j,{messageId:info.messageId,accepted:info.accepted.map(String),rejected})
    })
  } catch(error) {
    if(error instanceof AutomationError&&error.code==='STALE_WORKER')return
    if(await skipChangedMail(j,error))return
    if(error instanceof AutomationError&&error.code!=='SMTP_EMPTY')throw error
    const state=smtpFailure(error)
    await failJob(j,new AutomationError('SMTP_RESULT',state==='delivery_unknown'?'SMTP result is unknown. Check the provider before creating any new send authorization.':state==='bounced'?'SMTP rejected this customer address. Automatic reminders are paused.':'SMTP refused or could not accept this attempt. Review SMTP configuration and job status.'),state==='bounced'?'failed':state)
    if(state==='bounced')await db.transaction(async tx=>{
      const [current]=await tx.execute<{status:string}>(sql`SELECT status FROM background_job WHERE id=${j.id}::uuid AND generation=${j.generation}::bigint FOR UPDATE`)
      if(current?.status!=='failed')return
      await tx.execute(sql`UPDATE email_message SET status='bounced' WHERE id=${m.id}::uuid`)
      if(m.reminder_rule_id)await tx.execute(sql`UPDATE reminder_rule SET paused=true,pause_reason='Address bounced. Correct it before resuming.' WHERE id=${m.reminder_rule_id}::uuid`)
      await automationAudit(tx,s,'mail_bounced','email_message',m.id)
    })
  } finally {transport.close()}
}

export async function saveReminder(ledgerId:string,actor:AutomationActor,input:{id?:string;partyId:string;enabled:boolean;paused:boolean;reason:string;deferUntil?:string;days:number[];startHour:number;endHour:number;usesCompanyDefaults?:boolean},edit?:EditContext) {
  validateReminderSchedule(input.days,input.startHour,input.endHour)
  if(input.deferUntil)validBusinessDate(input.deferUntil)
  if((input.paused||input.deferUntil)&&!input.reason.trim())throw new AutomationError('REASON','Explain the pause, dispute or promised payment.')
  const command=async(tx:Tx)=>{
    const s=await automationScope(tx,ledgerId,actor,{seat:'/invoices'});await customer(tx,s,input.partyId)
    if(input.enabled){const email=(await customerContact(tx,input.partyId)).email;if(!email?.trim())throw new AutomationError('EMAIL','Add a primary customer email in Parties before enabling reminders.');emailAddresses(email)}
    let id=input.id
    if(id) {
      const match=await tx.execute(sql`SELECT id FROM reminder_rule WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid AND party_id=${input.partyId}::uuid`)
      if(!match.length)throw new AutomationError('REMINDER_RULE','The rule is unavailable in this company.')
      await tx.execute(sql`UPDATE reminder_rule SET actor_user_id=${s.userId}::uuid,enabled=${input.enabled},paused=${input.paused},pause_reason=${input.reason||null},defer_until=${input.deferUntil??null}::date,
        days=${sql.param(input.days)},start_hour=${input.startHour},end_hour=${input.endHour},uses_company_defaults=${input.usesCompanyDefaults??false} WHERE id=${id}::uuid`)
    } else {
      const [row]=await tx.execute<{id:string}>(sql`INSERT INTO reminder_rule(entity_id,ledger_id,party_id,actor_user_id,enabled,paused,pause_reason,defer_until,days,start_hour,end_hour,uses_company_defaults)
        VALUES (${s.entity_id}::uuid,${ledgerId}::uuid,${input.partyId}::uuid,${s.userId}::uuid,${input.enabled},${input.paused},${input.reason||null},${input.deferUntil??null}::date,${sql.param(input.days)},${input.startHour},${input.endHour},${input.usesCompanyDefaults??false}) RETURNING id::text`);id=row.id
    }
    await automationAudit(tx,s,'reminder_configured','reminder_rule',id,{...input,days:input.days},input.reason||undefined);return {id}
  }
  if(input.id){if(!edit)throw new AutomationError('EDIT_PROOF','A saved reminder needs its version and live edit lease.');return withDocumentWrite({ledgerId,type:'reminder',id:input.id},edit,command)}
  return db.transaction(command)
}
export async function togglePartyReminder(ledgerId:string,partyId:string,actor:AutomationActor,enabled:boolean,edit?:EditContext){
  const current=await db.transaction(async tx=>{await automationScope(tx,ledgerId,actor,{seat:'/invoices'});const [row]=await tx.execute<ReminderRule>(sql`SELECT ${reminderColumns} FROM reminder_rule WHERE ledger_id=${ledgerId}::uuid AND party_id=${partyId}::uuid`);return row})
  // Existing pauses and promises survive an availability switch.
  return saveReminder(ledgerId,actor,{id:current?.id,partyId,enabled,paused:current?.paused??false,reason:current?.pause_reason??'',deferUntil:current?.defer_until??undefined,days:current?.days??[3,7,14],startHour:current?.start_hour??9,endHour:current?.end_hour??17,usesCompanyDefaults:current?.uses_company_defaults??true},edit)
}
export async function queueReminders(at=new Date(),limit=12,workerId=randomUUID()) {
  if(process.env.AUTOMATION_ENABLED!=='true')return 0
  const rules=await db.execute<ReminderRule>(sql`SELECT ${reminderColumns} FROM reminder_rule WHERE enabled AND NOT paused ORDER BY id LIMIT 2000`)
  let n=0
  for(const saved of rules) {
    const r=await db.transaction(tx=>effectiveReminder(tx,saved))
    if(n>=limit)break
    const [setting]=await db.execute<{timezone:string}>(sql`SELECT timezone FROM automation_setting WHERE entity_id=${r.entity_id}::uuid AND enabled AND mail_enabled`)
    if(!setting)continue
    const clock=companyClock(setting.timezone,at)
    if(clock.hour<r.start_hour||clock.hour>=r.end_hour||r.defer_until&&r.defer_until>=clock.date)continue
    const candidates=await db.execute<{id:string;number:string;days:number}>(sql`SELECT id::text,number,(${clock.date}::date-due_on) AS days FROM invoice WHERE ledger_id=${r.ledger_id}::uuid AND party_id=${r.party_id}::uuid
      AND direction='sales' AND status='posted' AND document_kind='invoice' AND (${clock.date}::date-due_on)=ANY(${sql.param(r.days)}::int[]) ORDER BY due_on,id LIMIT 12`)
    for(const i of candidates) {
      if(n>=limit)break
      const key=`reminder:${r.id}:${i.id}:${clock.date}`
      const old=await db.execute(sql`SELECT 1 FROM background_job WHERE entity_id=${r.entity_id}::uuid AND ledger_id=${r.ledger_id}::uuid AND job_type='email_send' AND dedupe_key=${key}`)
      if(old.length)continue
      const actor:AutomationActor={source:'job',userId:r.actor_user_id,requestId:randomUUID(),workerId}
      try {
        const email=await db.transaction(async tx=>{const s=await automationScope(tx,r.ledger_id,actor,{enabled:true,mail:true,seat:'/invoices'});await customer(tx,s,r.party_id);return (await customerContact(tx,r.party_id)).email})
        if(!email)throw new AutomationError('EMAIL','Primary customer email is missing. Correct it before enabling reminders.')
        const item=await balanceOf(i.id),st=await renderCustomerStatement(r.ledger_id,r.party_id,clock.date)
        if(item.balance<=0n||st.totalOwed<=0n)continue
        // UUID derived from the business key, independent of rule version.
        const h=digest(key),requestKey=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
        const preview=await createMailPreview(r.ledger_id,actor,{kind:'reminder',partyId:r.party_id,invoiceId:i.id,ruleId:r.id,plannedDate:clock.date,asOf:clock.date,to:email,cc:[],
          subject:`Payment reminder — ${i.number}`,body:`Please review the attached statement of account, including receipts and credits. Invoice ${i.number} is overdue. Contact us if payment is in progress or the balance is disputed.`,requestKey})
        await db.transaction(async tx=>{
          const s=await automationScope(tx,r.ledger_id,actor,{enabled:true,mail:true,seat:'/invoices'})
          const [m]=await tx.execute<MailMessage>(sql`SELECT ${mailColumns} FROM email_message WHERE id=${preview.id}::uuid FOR UPDATE`)
          await eligible(tx,s,m,at)
          if(m.status!=='preview'&&m.status!=='queued')return
          await tx.execute(sql`UPDATE email_message SET status='queued' WHERE id=${m.id}::uuid`)
          await enqueueJob(tx,s,{type:'email_send',key,emailId:m.id})
          await automationAudit(tx,s,'reminder_authorized','email_message',m.id,{ruleId:r.id,plannedDate:clock.date})
        });n++
      } catch(error) {
        if(!(error instanceof AutomationError))throw error
        if(['NO_DEBT','SNAPSHOT_CHANGED','REMINDER_PAUSED'].includes(error.code))continue
        await db.transaction(async tx=>{
          await tx.execute(sql`UPDATE reminder_rule SET paused=true,pause_reason=${error.message} WHERE id=${r.id}::uuid`)
          const {auditRow}=await import('./audit-row');await auditRow(tx,{actor:'automation scheduler',action:'reminder_paused',table:'reminder_rule',recordId:r.id,entityId:r.entity_id,ledgerId:r.ledger_id,scope:'company',reason:error.message,context:{source:'job',actorType:'worker',actorId:workerId,authorizedBy:r.actor_user_id}})
        })
      }
    }
  }
  return n
}

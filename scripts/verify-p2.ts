import './env'
import { randomUUID } from 'node:crypto'
import { mkdtempSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SMTPServer } from 'smtp-server'
import { PDFDocument,PDFName,PDFString } from 'pdf-lib'
import { sql } from 'drizzle-orm'
import { db,sql as connection } from '../src/db/client'
import { reporter,errorText,expectSaying } from './suite'
import { createFirstOwner,createUser,signIn } from '../src/lib/users'
import { setGrants } from '../src/lib/access'
import { createCompany,createFiscalYear } from '../src/lib/setup'
import { importAccounts,parseAccountsCsv } from '../src/lib/accounts'
import { createParty,setPrimaryContactEmail } from '../src/lib/parties'
import { createInvoice,postInvoice,invoiceDetail } from '../src/lib/invoices'
import { saveDraft } from '../src/lib/posting'
import { recordPayment } from '../src/lib/payments'
import { requestActor,configureAutomation,companyClock } from '../src/lib/automation-access'
import { saveRecurring,generateOccurrence,nextOccurrence,futureOccurrences,queueRecurring } from '../src/lib/recurring'
import { editLease } from '../src/lib/edit-leases'
import type { EditResource,EditContext } from '../src/lib/edit-proof'
import { uploadInbox,inboxFile,reviewInbox } from '../src/lib/inbox'
import { validateInboxFile } from '../src/lib/inbox-file'
import { createMailPreview,queueMail,runMail,saveReminder,queueReminders } from '../src/lib/mail'
import { workerHeartbeat,claimJob,failJob,controlJob } from '../src/lib/jobs'
import { runRecurring } from '../src/lib/recurring'
import { automationBatch,pauseFailedRecurring } from '../src/lib/automation-worker'
import { customerActivity } from '../src/lib/customer-activity'
import { pauseRestoredAutomation } from '../src/lib/automation-restore'
import { exportCompany,restoreCompany,restorePaper } from '../src/lib/backup'
import { deleteCompany } from '../src/lib/companies'
import { closePeriod } from '../src/lib/periods'
import { addDays } from '../src/lib/recurrence-calendar'

const r=reporter(78),refused=expectSaying(r,errorText,120),PW='P2 isolated fixture password sentence'
process.env.ATTACHMENTS_DIR=mkdtempSync(join(tmpdir(),'figtree-p2-verify-paper-'))
const proof=async(resource:EditResource,token:string):Promise<EditContext>=>{
  const tables={account:'account',party:'party',payment:'payment_connection',inbound:'inbound_connection',inbox:'inbox_item',recurring:'recurring_template',reminder:'reminder_rule',invoice:'invoice',entry:'journal_entry',budget:'budget',migration:'migration_run'}
  const [head]=await db.execute<{version:string}>(sql`SELECT version::text FROM ${sql.raw(tables[resource.type])} WHERE id=${resource.id}::uuid`)
  const tabId=randomUUID(),lease=await editLease(resource,token,'takeover',{version:head.version,tabId})
  return {sessionToken:token,proof:{version:head.version,tabId,...lease},leaseRequired:true}
}
let smtp:SMTPServer|undefined
async function main() {
  const owner=await createFirstOwner({email:'p2-owner@example.test',password:PW,firstName:'P2 owner'})
  const user=await createUser({email:'p2-limited@example.test',password:PW,firstName:'P2 limited',actor:owner.email})
  const session=await signIn({email:owner.email,password:PW,clientIp:'192.0.2.50'}),actor=requestActor(session.token)
  const limited=await signIn({email:user.email,password:PW,clientIp:'192.0.2.51'})
  const co=await createCompany({code:'P2',name:'P2 isolated company'},owner.email),other=await createCompany({code:'P2OTHER',name:'P2 other isolated company'},owner.email)
  const ledger=co.ledger.id,entity=co.company.id
  await setGrants({userId:user.id,entityIds:[entity],modules:['/automation'],actor:owner.email})
  await createFiscalYear(ledger,'2026-12-31',owner.email)
  const accounts=await importAccounts(entity,parseAccountsCsv('1000,Cash,asset,,cash_and_cash_equivalents\n1200,Receivables,asset,,trade_receivables\n1300,GST recoverable,asset,,gst_hst_recoverable\n2000,Payables,liability,,trade_payables\n2100,GST payable,liability,,gst_hst_payable\n2200,PST payable,liability,,qst_pst_payable\n4000,Revenue,revenue,,revenue_from_contracts\n5000,Expenses,expense,,other_operating_expenses').map(a=>({...a,entityId:entity})),owner.email)
  const at=(code:string)=>accounts.find(a=>a.code===code)!.id
  const customer=await createParty({kind:'organisation',name:'P2 customer',roles:[{entityId:entity,role:'customer',heldFrom:'2026-01-01'}],actor:owner.email})
  const supplier=await createParty({kind:'organisation',name:'P2 supplier',roles:[{entityId:entity,role:'supplier',heldFrom:'2026-01-01'}],actor:owner.email})
  await db.execute(sql`INSERT INTO party_contact(party_id,email,is_primary) VALUES (${customer.id}::uuid,'customer@example.test',true)`)
  const sales=await createInvoice({ledgerId:ledger,direction:'sales',partyId:customer.id,controlAccountId:at('1200'),issuedOn:'2026-09-01',dueOn:'2026-09-30',lines:[{accountId:at('4000'),amount:-10000n}],actor:owner.email})
  const bill=await createInvoice({ledgerId:ledger,direction:'purchase',partyId:supplier.id,controlAccountId:at('2000'),issuedOn:'2026-09-01',dueOn:'2026-09-30',lines:[{accountId:at('5000'),amount:10000n}],actor:owner.email})
  const journal=await saveDraft({ledgerId:ledger,entryDate:'2026-09-01',description:'Manual source',actor:owner.email,lines:[{accountId:at('5000'),amount:100n},{accountId:at('1000'),amount:-100n}]})
  const rule={frequency:'monthly' as const,dayMode:'fixed' as const,anchorDate:'2026-01-31',dayOfMonth:31}
  r.check(nextOccurrence(rule,'2026-01-31')==='2026-02-28','P2R01 fixed day clamps short months')
  r.check(nextOccurrence({...rule,anchorDate:'2024-01-31'},'2024-01-31')==='2024-02-29','P2R02 leap year keeps February 29')
  r.check(nextOccurrence({...rule,dayMode:'last_weekday'},'2026-09-30')==='2026-10-30','P2R03 last Monday–Friday excludes weekends')
  r.check(futureOccurrences({...rule,frequency:'quarterly'},'2026-01-31',3).join(',')==='2026-01-31,2026-04-30,2026-07-31','P2R04 quarterly preview does not drift after clamping')
  r.check(companyClock('America/Vancouver',new Date('2026-03-08T09:59:00Z')).date==='2026-03-08'&&companyClock('America/Vancouver',new Date('2026-03-08T10:01:00Z')).hour===3,'P2R05 Vancouver DST uses scheduled local business dates')
  r.check(nextOccurrence({...rule,anchorDate:'0001-01-31'},'0001-01-31')==='0001-02-28','P2R16 early years do not inherit JavaScript 1900 offset')
  await refused('P2R17 overflowing business date is refused','supported business dates',async()=>nextOccurrence({...rule,anchorDate:'9999-12-31'},'9999-12-31'))
  r.check(companyClock('America/Vancouver',new Date('2026-10-09T02:00:00Z')).date==='2026-10-08','P2R18 reminder scheduling follows local day across UTC midnight')
  await configureAutomation(ledger,actor,{version:'0',enabled:true,mailEnabled:true,timezone:'America/Vancouver',senderEmail:'accounts@example.test'})
  process.env.AUTOMATION_ENABLED='true'
  const generated:Array<{template:{id:string};result:Awaited<ReturnType<typeof generateOccurrence>>}>=[]
  for(const [type,sourceId] of [['sales',sales.id],['purchase',bill.id],['entry',journal.id]] as const) {
    const template=await saveRecurring(ledger,actor,{sourceId,documentType:type,title:type+' recurring',rule,dueDays:15,active:true,maxOccurrences:2})
    const resource:EditResource={ledgerId:ledger,type:'recurring',id:template.id},edit=await proof(resource,session.token)
    const result=await generateOccurrence(ledger,template.id,'2026-01-31',actor,edit);generated.push({template,result})
    const occurrence=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM recurring_occurrence WHERE template_id=${template.id}::uuid`)
    r.check(occurrence[0].n===1,`P2R0${6+generated.length} ${type} occurrence creates one draft`)
    if(result.invoiceId){const d=await invoiceDetail(result.invoiceId);r.check(d?.invoice.status==='draft'&&!d.invoice.entry_id&&!d.invoice.number,`P2R1${generated.length} ${type} copies no formal number or GL`)}
    else {const [d]=await db.execute<{status:string;entry_date:string}>(sql`SELECT status,entry_date::text FROM journal_entry WHERE id=${result.entryId}::uuid`);r.check(d.status==='draft'&&d.entry_date==='2026-01-31','P2R13 manual recurrence retains business date')}
    await refused(`P2R2${generated.length} stale template version refuses duplicate manual generation`,'changed',()=>generateOccurrence(ledger,template.id,'2026-01-31',actor,edit))
  }
  await refused('P2R15 database occurrence business key excludes template version','duplicate key',()=>db.execute(sql`INSERT INTO recurring_occurrence(id,entity_id,ledger_id,template_id,scheduled_for,template_version,target_invoice_id,target_entry_id,template_snapshot,timezone) SELECT gen_random_uuid(),entity_id,ledger_id,template_id,scheduled_for,template_version+1,target_invoice_id,target_entry_id,template_snapshot,timezone FROM recurring_occurrence LIMIT 1`))
  const [gl]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM journal_entry WHERE ledger_id=${ledger}::uuid AND status IN ('posted','reversed')`)
  r.check(gl.n===0,'P2R14 all recurrence generation leaves GL unchanged')
  const workerA=randomUUID(),workerB=randomUUID();await workerHeartbeat(workerA);await workerHeartbeat(workerB)
  await queueRecurring(new Date('2026-03-01T20:00:00Z'))
  const claims=await Promise.all([claimJob(workerA),claimJob(workerB)])
  // SKIP LOCKED may make one simultaneous company claim yield no job.
  // A next short claim must obtain a distinct spare slot, never the same job.
  if(!claims[0])claims[0]=await claimJob(workerA)
  if(!claims[1])claims[1]=await claimJob(workerB)
  r.check(claims.every(Boolean)&&claims[0]!.id!==claims[1]!.id,'P2J01 two actual workers claim distinct persistent jobs')
  r.check(await claimJob(workerA)===null,'P2J02 company concurrency cannot exceed configured two slots')
  const old=claims[0]!
  await db.execute(sql`UPDATE background_job SET locked_until=clock_timestamp()-interval '1 second' WHERE id=${old.id}::uuid`)
  const replacement=await claimJob(workerB)
  r.check(replacement?.id===old.id&&BigInt(replacement.generation)>BigInt(old.generation),'P2J03 expired pure DB work has a newer generation')
  await refused('P2J04 late worker cannot commit an occurrence','no longer owns',()=>runRecurring(old))
  await runRecurring(replacement!);await runRecurring(claims[1]!)
  const pausedBefore=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM recurring_occurrence`)
  process.env.AUTOMATION_ENABLED='false';await queueRecurring(new Date('2027-01-01T20:00:00Z'));await automationBatch()
  const pausedAfter=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM recurring_occurrence`)
  r.check(pausedBefore[0].n===pausedAfter[0].n,'P2J05 installation disabled performs no work or template mutation')
  process.env.AUTOMATION_ENABLED='true'
  const [january]=await db.execute<{id:string}>(sql`SELECT id::text FROM fiscal_period WHERE ledger_id=${ledger}::uuid AND '2026-01-31' BETWEEN start_date AND end_date`)
  await closePeriod(ledger,january.id,{lock:true,actor:owner.email,overrideReason:'Isolated P2 locked-period discrimination'})
  await refused('P2R19 recurring invoice retains locked date and cannot post','locked',()=>postInvoice(generated[0].result.invoiceId!,owner.email))
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=Buffer.from(await pdf.save())
  await refused('P2I01 file type cannot be forged','must agree',()=>validateInboxFile('receipt.jpg','image/jpeg',bytes))
  await refused('P2I02 filename traversal is refused','without directories',()=>validateInboxFile('../receipt.pdf','application/pdf',bytes))
  const many=await PDFDocument.create();for(let i=0;i<31;i++)many.addPage()
  await refused('P2I03 actual parsed PDF page limit','1–30',async()=>validateInboxFile('many.pdf','application/pdf',Buffer.from(await many.save())))
  const active=await PDFDocument.create();active.addPage();active.catalog.set(PDFName.of('OpenAction'),PDFString.of('unsafe'))
  await refused('P2I04 active PDF is refused before storage','active actions',async()=>validateInboxFile('active.pdf','application/pdf',Buffer.from(await active.save())))
  const embedded=await PDFDocument.create();embedded.addPage();embedded.context.register(embedded.context.stream(Buffer.from('embedded'),{Type:PDFName.of('EmbeddedFile')}))
  await refused('P2I23 embedded-file stream dictionary is rejected','embedded content',async()=>validateInboxFile('embedded.pdf','application/pdf',Buffer.from(await embedded.save())))
  const hugePng=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(hugePng);hugePng.writeUInt32BE(13,8);hugePng.write('IHDR',12);hugePng.writeUInt32BE(100000,16);hugePng.writeUInt32BE(100000,20)
  await refused('P2I18 oversized PNG refused before pixel decode','40 megapixels',()=>validateInboxFile('huge.png','image/png',hugePng))
  const item=await uploadInbox(ledger,actor,{name:'receipt.pdf',type:'application/pdf',bytes},true)
  await refused('P2I17 database inbox ledger must belong to its company','P2_LEDGER_ENTITY',()=>db.execute(sql`INSERT INTO inbox_item(entity_id,ledger_id,sha256,filename,mime) SELECT ${entity}::uuid,${other.ledger.id}::uuid,sha256,'foreign.pdf',mime FROM inbox_item WHERE id=${item.id}::uuid`))
  const [manual]=await db.execute<{status:string}>(sql`SELECT status FROM inbox_item WHERE id=${item.id}::uuid`)
  r.check(manual.status==='needs_review','P2I05 absent real AI credentials leaves usable manual review')
  r.check((await inboxFile(ledger,item.id,actor)).bytes.equals(bytes),'P2I06 original private bytes survive upload exactly')
  await refused('P2I07 cross-company source guessing is refused','unavailable',()=>inboxFile(other.ledger.id,item.id,actor))
  const form=()=>{const f=new FormData();for(const [k,v] of Object.entries({operation:'create',targetType:'purchase',issuedOn:'2026-10-08',dueOn:'2026-11-08',partyId:supplier.id,controlAccountId:at('2000'),currency:'CAD',total:'100.00',amounts:'exclusive','line.0.account':at('5000'),'line.0.amount':'100.00','line.0.description':'Reviewed expense','line.0.taxCode':'OUT_OF_SCOPE',theirRef:'R-001',paid:'no'}))f.set(k,v);return f}
  const edit=await proof({ledgerId:ledger,type:'inbox',id:item.id},session.token)
  const bad=form();bad.set('total','99.99');await refused('P2I08 mismatched source total is refused','do not equal',()=>reviewInbox(ledger,item.id,actor,edit,bad))
  const foreign=form();foreign.set('currency','USD');await refused('P2I09 unsupported foreign currency is refused','ledger currency',()=>reviewInbox(ledger,item.id,actor,edit,foreign))
  const converted=await Promise.allSettled([reviewInbox(ledger,item.id,actor,edit,form()),reviewInbox(ledger,item.id,actor,edit,form())])
  r.check(converted.filter(x=>x.status==='fulfilled').length===1,'P2I10 concurrent double conversion creates one draft')
  const duplicate=await uploadInbox(ledger,actor,{name:'second.pdf',type:'application/pdf',bytes},false),dupProof=await proof({ledgerId:ledger,type:'inbox',id:duplicate.id},session.token)
  await refused('P2I11 exact hash and business reference require review reason','possible duplicate',()=>reviewInbox(ledger,duplicate.id,actor,dupProof,form()))
  const override=form();override.set('duplicateOverride','Separate receipt intentionally sharing sample bytes');await reviewInbox(ledger,duplicate.id,actor,dupProof,override)
  r.pass('P2I12 explicit duplicate override preserves source and reason')
  const [linked]=await db.execute<{target_invoice_id:string;duplicate_override:string}>(sql`SELECT target_invoice_id::text,duplicate_override FROM inbox_item WHERE id=${duplicate.id}::uuid`)
  r.check(!!linked.target_invoice_id&&!!linked.duplicate_override,'P2I13 converted source has explicit target FK and override evidence')
  await refused('P2I14 database cannot reopen a converted source','P2_INBOX_ALREADY_CONVERTED',()=>db.execute(sql`UPDATE inbox_item SET status='needs_review' WHERE id=${item.id}::uuid`))
  await refused('P2I19 original source identity cannot be rewritten','P2_INBOX_SOURCE_IMMUTABLE',()=>db.execute(sql`UPDATE inbox_item SET filename='replacement.pdf' WHERE id=${item.id}::uuid`))
  await refused('P2I20 reviewed corrections are retained after conversion','P2_INBOX_REVIEW_IMMUTABLE',()=>db.execute(sql`UPDATE inbox_item SET corrections='{}'::jsonb WHERE id=${item.id}::uuid`))
  const expense=await uploadInbox(ledger,actor,{name:'paid.pdf',type:'application/pdf',bytes},false),expenseProof=await proof({ledgerId:ledger,type:'inbox',id:expense.id},session.token)
  const paid=form();paid.set('targetType','expense');paid.set('paid','yes');paid.set('duplicateOverride','Independent sample receipt')
  await refused('P2I15 paid expense has no automatic payment account','actual payment account',()=>reviewInbox(ledger,expense.id,actor,expenseProof,paid))
  paid.set('paymentAccountId',at('1000'));const expenseTarget=await reviewInbox(ledger,expense.id,actor,expenseProof,paid)
  const [expenseState]=await db.execute<{status:string;sum:string}>(sql`SELECT status,(SELECT sum(amount)::text FROM journal_line WHERE entry_id=e.id) AS sum FROM journal_entry e WHERE id=${expenseTarget.entryId}::uuid`)
  r.check(expenseState.status==='draft'&&expenseState.sum==='0','P2I16 paid receipt creates balanced manual draft without GL')
  const linkedPaper=await uploadInbox(ledger,actor,{name:'existing-bank.pdf',type:'application/pdf',bytes},false),linkProof=await proof({ledgerId:ledger,type:'inbox',id:linkedPaper.id},session.token)
  const linking=new FormData();linking.set('operation','link');linking.set('linkType','entry');linking.set('targetId',journal.id);linking.set('duplicateOverride','Attach to the existing bank journal, do not duplicate expense')
  const [beforeLink]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM journal_entry`)
  const sourceLink=await reviewInbox(ledger,linkedPaper.id,actor,linkProof,linking)
  const [afterLink]=await db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM journal_entry`)
  r.check(sourceLink.entryId===journal.id&&beforeLink.n===afterLink.n,'P2I21 original links to existing manual record without new accounting')
  const taxPaper=await uploadInbox(ledger,actor,{name:'two-tax.pdf',type:'application/pdf',bytes},false),taxProof=await proof({ledgerId:ledger,type:'inbox',id:taxPaper.id},session.token)
  const tax=form();tax.set('duplicateOverride','Separate two-tax sample');tax.set('line.0.taxCode','GST_PST');tax.set('total','112.00');tax.set('theirRef','TAX-002')
  const twoTax=await reviewInbox(ledger,taxPaper.id,actor,taxProof,tax),taxDetail=await invoiceDetail(twoTax.invoiceId!)
  r.check(taxDetail?.total===11200n&&taxDetail.lines.some(l=>l.generated_for==='GST'),'P2I22 reviewed purchase reuses integer GST/PST calculation')
  await refused('P2A01 automation-only user cannot create accounting','permission',()=>saveRecurring(ledger,requestActor(limited.token),{sourceId:sales.id,documentType:'sales',title:'Denied',rule,dueDays:30,active:true}))
  await postInvoice(sales.id,owner.email)
  const input={kind:'invoice' as const,partyId:customer.id,invoiceId:sales.id,asOf:'2026-10-08',to:'customer@example.test',cc:[],subject:'P2 invoice',body:'Please review the attached formal invoice.',requestKey:randomUUID()}
  const mail=await createMailPreview(ledger,actor,input),again=await createMailPreview(ledger,actor,input)
  r.check(mail.id===again.id&&again.replayed,'P2M01 repeated preview authorization resolves to one immutable message')
  await refused('P2M02 changed payload cannot reuse authorization','different content',()=>createMailPreview(ledger,actor,{...input,subject:'Changed'}))
  await refused('P2M03 database protects approved email content','P2_MAIL_SNAPSHOT_IMMUTABLE',()=>db.execute(sql`UPDATE email_message SET subject='Unapproved change' WHERE id=${mail.id}::uuid`))
  await refused('P2M04 draft invoice is never sent as formal','posted sales invoice',()=>createMailPreview(ledger,actor,{...input,invoiceId:generated[0].result.invoiceId!,requestKey:randomUUID()}))
  const queued=await queueMail(ledger,mail.id,actor),requeue=await queueMail(ledger,mail.id,actor)
  r.check(queued.jobId===requeue.jobId,'P2M05 double send approval enqueues one job')
  const captures:Buffer[]=[];let disposition:'accept'|'reject'|'unknown'|'temporary'|'pause'='accept'
  const pauseControl={jobId:undefined as string|undefined,error:undefined as unknown}
  smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],logger:false,onRcptTo(_address,_session,done){if(disposition==='reject'||disposition==='temporary'){const e=Object.assign(new Error('Fixture address rejected'),{responseCode:disposition==='temporary'?451:550});done(e)}else done()},onData(stream,_session,done){const chunks:Buffer[]=[];stream.on('data',b=>chunks.push(Buffer.from(b)));stream.on('end',()=>{captures.push(Buffer.concat(chunks));if(disposition==='unknown')return;if(disposition==='pause'){void controlJob(ledger,pauseControl.jobId!,actor,'pause').then(()=>done(),error=>{pauseControl.error=error;done(new Error('Fixture pause failed'))});return}done()})}})
  await new Promise<void>((resolve,reject)=>{smtp!.once('error',reject);smtp!.listen(0,'127.0.0.1',resolve)})
  // smtp-server exposes its actual TCP server, not an injected send function.
  const port=(smtp as unknown as {server:{address:()=>{port:number}}}).server.address().port
  process.env.SMTP_HOST='127.0.0.1';process.env.SMTP_PORT=String(port);process.env.SMTP_LOCAL_CAPTURE='true';process.env.SMTP_TIMEOUT_MS='1000'
  const j=await claimJob(workerA);r.check(j?.id===queued.jobId,'P2M06 email is prioritized ahead of remaining recurring work');await runMail(j!)
  const [accepted]=await db.execute<{status:string}>(sql`SELECT status FROM email_message WHERE id=${mail.id}::uuid`)
  r.check(accepted.status==='accepted'&&captures.length===1&&captures[0].includes(Buffer.from('application/pdf')),'P2M07 actual local TCP SMTP captures attached PDF and records accepted')
  await refused('P2M08 accepted send is not retried','cannot be retried',()=>controlJob(ledger,j!.id,actor,'retry'))
  const changed=await createMailPreview(ledger,actor,{...input,requestKey:randomUUID()});await queueMail(ledger,changed.id,actor)
  await db.execute(sql`UPDATE party_contact SET email='changed@example.test' WHERE party_id=${customer.id}::uuid`)
  const stale=await claimJob(workerA);await runMail(stale!)
  const [skip]=await db.execute<{status:string}>(sql`SELECT status FROM email_message WHERE id=${changed.id}::uuid`)
  r.check(skip.status==='skipped'&&captures.length===1,'P2M09 email change after approval suppresses actual network delivery')
  await db.execute(sql`UPDATE party_contact SET email='customer@example.test' WHERE party_id=${customer.id}::uuid`)
  disposition='unknown';const unknown=await createMailPreview(ledger,actor,{...input,requestKey:randomUUID()});await queueMail(ledger,unknown.id,actor);const unknownJob=await claimJob(workerA);await runMail(unknownJob!)
  const [u]=await db.execute<{status:string}>(sql`SELECT status FROM email_message WHERE id=${unknown.id}::uuid`)
  r.check(u.status==='delivery_unknown'&&captures.length===2,'P2M10 DATA received without SMTP response remains unknown and is not auto resent')
  await refused('P2M11 unknown provider result cannot retry old job','cannot be retried',()=>controlJob(ledger,unknownJob!.id,actor,'retry'))
  disposition='accept'
  const today=companyClock('America/Vancouver').date,overdue=Math.round((new Date(today+'T12:00:00Z').getTime()-new Date('2026-09-30T12:00:00Z').getTime())/86400000)
  const reminder=await saveReminder(ledger,actor,{partyId:customer.id,enabled:false,paused:false,reason:'',days:[overdue],startHour:0,endHour:24})
  r.check(await queueReminders()===0,'P2M12 new customer reminder stays off by default')
  const reminderProof=await proof({ledgerId:ledger,type:'reminder',id:reminder.id},session.token)
  await saveReminder(ledger,actor,{id:reminder.id,partyId:customer.id,enabled:true,paused:false,reason:'',days:[overdue],startHour:0,endHour:24},reminderProof)
  r.check(await queueReminders()===1&&await queueReminders()===0,'P2M13 reminder current-day business key suppresses repeated scheduling')
  await recordPayment({invoiceId:sales.id,bankAccountId:at('1000'),amount:10000n,paidOn:today,actor:owner.email})
  const paidJob=await claimJob(workerA);await runMail(paidJob!)
  const [paidState]=await db.execute<{status:string}>(sql`SELECT status FROM background_job WHERE id=${paidJob!.id}::uuid`)
  r.check(paidState.status==='skipped'&&captures.length===2,'P2M14 payment between queue and send stops actual reminder')
  const activity=await customerActivity(ledger,customer.id,'2026-09-01',today)
  r.check(activity.opening===0n&&activity.closing===0n&&activity.rows.length===2,'P2M15 period activity contains invoice and receipt and ties to AR')
  const makeCustomer=async(name:string,email?:string)=>{const p=await createParty({kind:'organisation',name,roles:[{entityId:entity,role:'customer',heldFrom:'2026-01-01'}],actor:owner.email});if(email)await db.execute(sql`INSERT INTO party_contact(party_id,email,is_primary) VALUES (${p.id}::uuid,${email},true)`);return p}
  const makeSales=async(partyId:string,kind:'invoice'|'credit_note'='invoice',amount=10000n)=>{const i=await createInvoice({ledgerId:ledger,direction:'sales',kind,partyId,controlAccountId:at('1200'),issuedOn:'2026-09-01',dueOn:'2026-09-30',lines:[{accountId:at('4000'),amount:kind==='invoice'?-amount:amount}],actor:owner.email});await postInvoice(i.id,owner.email);return i}
  const partialCustomer=await makeCustomer('Partial customer','partial@example.test'),partialInvoice=await makeSales(partialCustomer.id)
  await recordPayment({invoiceId:partialInvoice.id,bankAccountId:at('1000'),amount:2500n,paidOn:today,actor:owner.email})
  const partialStatement=await customerActivity(ledger,partialCustomer.id,'2026-09-01',today)
  r.check(partialStatement.closing===7500n,'P2M16 partial payment is reflected in statement balance')
  const partialRule=await saveReminder(ledger,actor,{partyId:partialCustomer.id,enabled:true,paused:false,reason:'',days:[overdue],startHour:0,endHour:24})
  r.check(await queueReminders()===1,'P2M17 partially paid invoice can schedule a current remaining-balance reminder')
  const changedRuleProof=await proof({ledgerId:ledger,type:'reminder',id:partialRule.id},session.token)
  await saveReminder(ledger,actor,{id:partialRule.id,partyId:partialCustomer.id,enabled:true,paused:false,reason:'',days:[overdue+1],startHour:0,endHour:24},changedRuleProof)
  const noLongerDue=await claimJob(workerA);await runMail(noLongerDue!)
  const [editedSkip]=await db.execute<{status:string}>(sql`SELECT status FROM email_message WHERE id=${noLongerDue!.email_message_id}::uuid`)
  r.check(editedSkip.status==='skipped'&&captures.length===2,'P2M18 editing overdue days suppresses already queued reminder')
  const creditCustomer=await makeCustomer('Credited customer','credit@example.test');await makeSales(creditCustomer.id);await makeSales(creditCustomer.id,'credit_note')
  await refused('P2M22 database refuses mail/invoice customer mismatch','P2_MAIL_CUSTOMER_IDENTITY',()=>db.execute(sql`INSERT INTO email_message SELECT (jsonb_populate_record(NULL::email_message,to_jsonb(m)||jsonb_build_object('id',gen_random_uuid(),'request_key',gen_random_uuid(),'party_id',${creditCustomer.id}::uuid))).* FROM email_message m WHERE id=${mail.id}::uuid`))
  await saveReminder(ledger,actor,{partyId:creditCustomer.id,enabled:true,paused:false,reason:'',days:[overdue],startHour:0,endHour:24})
  r.check(await queueReminders()===0,'P2M19 customer credits covering debt suppress reminder without reallocating GL')
  const noEmail=await makeCustomer('No email customer','removed@example.test');await makeSales(noEmail.id);const noEmailRule=await saveReminder(ledger,actor,{partyId:noEmail.id,enabled:true,paused:false,reason:'',days:[overdue],startHour:0,endHour:24})
  await setPrimaryContactEmail(noEmail.id,'',owner.email)
  await refused('P2M20a missing email cannot enable a new reminder','Add a primary customer email',()=>saveReminder(ledger,actor,{partyId:noEmail.id,enabled:true,paused:false,reason:'',days:[overdue],startHour:0,endHour:24}))
  await queueReminders();const [noEmailState]=await db.execute<{paused:boolean}>(sql`SELECT paused FROM reminder_rule WHERE id=${noEmailRule.id}::uuid`)
  r.check(noEmailState.paused,'P2M20 missing customer email pauses rule with no send')
  const bounceCustomer=await makeCustomer('Bounce customer','bounce@example.test');await makeSales(bounceCustomer.id);const bounceRule=await saveReminder(ledger,actor,{partyId:bounceCustomer.id,enabled:true,paused:false,reason:'',days:[overdue],startHour:0,endHour:24})
  await queueReminders();disposition='reject';const bounceJob=await claimJob(workerA);await runMail(bounceJob!)
  const [bounce]=await db.execute<{paused:boolean;status:string}>(sql`SELECT r.paused,m.status FROM reminder_rule r JOIN email_message m ON m.reminder_rule_id=r.id WHERE r.id=${bounceRule.id}::uuid`)
  r.check(bounce.paused&&bounce.status==='bounced'&&captures.length===2,'P2M21 actual SMTP RCPT 550 pauses automatic reminders')
  disposition='temporary';const temporary=await createMailPreview(ledger,actor,{...input,requestKey:randomUUID()});const temporaryQueued=await queueMail(ledger,temporary.id,actor)
  for(let attempt=1;attempt<=3;attempt++) {
    const retryJob=await claimJob(workerA);if(retryJob?.id!==temporaryQueued.jobId)throw Error('SMTP retry fixture claimed unexpected task');await runMail(retryJob)
    const [state]=await db.execute<{status:string;attempt:number;delayed:boolean}>(sql`SELECT status,attempt,run_at>clock_timestamp() AS delayed FROM background_job WHERE id=${retryJob.id}::uuid`)
    r.check(state.attempt===attempt&&state.status===(attempt<3?'queued':'failed')&&state.delayed,`P2M23 actual SMTP 451 attempt ${attempt} observes bounded backoff`)
    if(attempt<3)await db.execute(sql`UPDATE background_job SET run_at=clock_timestamp() WHERE id=${retryJob.id}::uuid`)
  }
  await refused('P2M24 exhausted mail needs fresh approval rather than manual old-job retry','new approved email',()=>controlJob(ledger,temporaryQueued.jobId,actor,'retry'))
  const latePreview=await createMailPreview(ledger,actor,{...input,requestKey:randomUUID()}),lateQueued=await queueMail(ledger,latePreview.id,actor);pauseControl.jobId=lateQueued.jobId;disposition='pause';const lateJob=await claimJob(workerA);await runMail(lateJob!)
  if(pauseControl.error)throw pauseControl.error
  const [late]=await db.execute<{status:string}>(sql`SELECT status FROM email_message WHERE id=${latePreview.id}::uuid`)
  r.check(late.status==='delivery_unknown'&&captures.length===3,'P2M25 late real SMTP acceptance cannot overwrite a paused generation')
  disposition='accept'
  const disablePreview=await createMailPreview(ledger,actor,{...input,requestKey:randomUUID()}),disableQueued=await queueMail(ledger,disablePreview.id,actor)
  const [disableSetting]=await db.execute<{version:string}>(sql`SELECT version::text FROM automation_setting WHERE entity_id=${entity}::uuid`)
  await configureAutomation(ledger,actor,{version:disableSetting.version,enabled:true,mailEnabled:false,timezone:'America/Vancouver',senderEmail:'accounts@example.test'})
  const [disabledMail]=await db.execute<{mail:string;job:string}>(sql`SELECT m.status AS mail,j.status AS job FROM email_message m JOIN background_job j ON j.email_message_id=m.id WHERE j.id=${disableQueued.jobId}::uuid`)
  r.check(disabledMail.mail==='paused'&&disabledMail.job==='paused','P2M26 company mail switch pauses both queued job and message status')
  const [enableSetting]=await db.execute<{version:string}>(sql`SELECT version::text FROM automation_setting WHERE entity_id=${entity}::uuid`)
  await configureAutomation(ledger,actor,{version:enableSetting.version,enabled:true,mailEnabled:true,timezone:'America/Vancouver',senderEmail:'accounts@example.test'})
  const catchup=await saveRecurring(ledger,actor,{sourceId:journal.id,documentType:'entry',title:'Bounded catchup',rule:{...rule,frequency:'weekly',anchorDate:'2026-01-01'},dueDays:0,active:true})
  const batch=await automationBatch(12),[backlog]=await db.execute<{n:number;next_date:string}>(sql`SELECT occurrence_count AS n,next_date::text FROM recurring_template WHERE id=${catchup.id}::uuid`)
  r.check(batch.attempts===12&&backlog.n>0&&backlog.n<=12&&backlog.next_date<today,'P2J06 bounded 12-attempt catchup retains remaining scheduled backlog')
  await db.execute(sql`UPDATE recurring_template SET active=false WHERE id=${catchup.id}::uuid`)
  const editedTemplate=await saveRecurring(ledger,actor,{sourceId:journal.id,documentType:'entry',title:'Future rule edit',rule:{...rule,frequency:'weekly',anchorDate:today},dueDays:0,active:true,maxOccurrences:1})
  await queueRecurring();const earlierClaim=await claimJob(workerA)
  if(earlierClaim?.recurring_template_id!==editedTemplate.id)throw Error('Future edit fixture did not claim its template')
  const futureDate=addDays(today,7),editTemplateProof=await proof({ledgerId:ledger,type:'recurring',id:editedTemplate.id},session.token)
  await saveRecurring(ledger,actor,{id:editedTemplate.id,sourceId:'',documentType:'entry',title:'Reviewed future date',rule:{...rule,frequency:'weekly',anchorDate:futureDate},dueDays:0,active:true,maxOccurrences:1},editTemplateProof)
  await refused('P2R24 template edit fences an already claimed older date','no longer owns',()=>runRecurring(earlierClaim))
  const [futureRule]=await db.execute<{active:boolean;next_date:string;status:string}>(sql`SELECT t.active,t.next_date::text,j.status FROM recurring_template t JOIN background_job j ON j.recurring_template_id=t.id WHERE t.id=${editedTemplate.id}::uuid`)
  r.check(futureRule.active&&futureRule.next_date===futureDate&&futureRule.status==='skipped','P2R25 changed schedule preserves future template and abandons obsolete date')
  await generateOccurrence(ledger,editedTemplate.id,futureDate,actor,await proof({ledgerId:ledger,type:'recurring',id:editedTemplate.id},session.token))
  r.pass('P2R26 reviewed future date generates once with its current lease')
  const staleFailureTemplate=await saveRecurring(ledger,actor,{sourceId:journal.id,documentType:'entry',title:'Old failure authorization',rule:{...rule,frequency:'weekly',anchorDate:today},dueDays:0,active:true,maxOccurrences:1})
  await queueRecurring();const failedClaim=await claimJob(workerA);if(failedClaim?.recurring_template_id!==staleFailureTemplate.id)throw Error('Stale failure fixture not claimed')
  await failJob(failedClaim,new Error('Guard fixture failure'),'paused')
  await saveRecurring(ledger,actor,{id:staleFailureTemplate.id,sourceId:'',documentType:'entry',title:'New reviewed authorization',rule:{...rule,frequency:'weekly',anchorDate:today},dueDays:0,active:true,maxOccurrences:1},await proof({ledgerId:ledger,type:'recurring',id:staleFailureTemplate.id},session.token))
  const oldPaused=await pauseFailedRecurring(failedClaim,workerA,'Older failed attempt')
  const [newApproval]=await db.execute<{active:boolean;title:string}>(sql`SELECT active,title FROM recurring_template WHERE id=${staleFailureTemplate.id}::uuid`)
  r.check(!oldPaused&&newApproval.active&&newApproval.title==='New reviewed authorization','P2R27 old failure cannot pause a newly reviewed template')
  await saveRecurring(ledger,actor,{id:staleFailureTemplate.id,sourceId:'',documentType:'entry',title:newApproval.title,rule:{...rule,frequency:'weekly',anchorDate:today},dueDays:0,active:false,maxOccurrences:1},await proof({ledgerId:ledger,type:'recurring',id:staleFailureTemplate.id},session.token))
  await setGrants({userId:user.id,entityIds:[entity],modules:['/automation','/entries'],actor:owner.email})
  const revokedTemplate=await saveRecurring(ledger,requestActor(limited.token),{sourceId:journal.id,documentType:'entry',title:'Revoked creator',rule:{...rule,frequency:'weekly',anchorDate:today},dueDays:0,active:true})
  await queueRecurring();await setGrants({userId:user.id,entityIds:[entity],modules:['/automation'],actor:owner.email});await automationBatch(1)
  const [revoked]=await db.execute<{active:boolean;status:string}>(sql`SELECT t.active,j.status FROM recurring_template t JOIN background_job j ON j.recurring_template_id=t.id WHERE t.id=${revokedTemplate.id}::uuid`)
  r.check(!revoked.active&&revoked.status==='paused','P2A02 revoked module authorization pauses queued template without fallback actor')
  const inactiveTemplate=await saveRecurring(ledger,actor,{sourceId:journal.id,documentType:'entry',title:'Inactive reference',rule:{...rule,frequency:'weekly',anchorDate:today},dueDays:0,active:true})
  await queueRecurring();await db.execute(sql`UPDATE account SET is_active=false WHERE id=${at('5000')}::uuid`);await automationBatch(1)
  const [inactive]=await db.execute<{active:boolean;status:string}>(sql`SELECT t.active,j.status FROM recurring_template t JOIN background_job j ON j.recurring_template_id=t.id WHERE t.id=${inactiveTemplate.id}::uuid`)
  r.check(!inactive.active&&inactive.status==='paused','P2A03 inactive referenced account pauses template rather than selecting a replacement')
  await db.execute(sql`UPDATE account SET is_active=true WHERE id=${at('5000')}::uuid`)
  await setGrants({userId:user.id,entityIds:[entity],modules:['/automation','/entries'],actor:owner.email})
  const disabledTemplate=await saveRecurring(ledger,requestActor(limited.token),{sourceId:journal.id,documentType:'entry',title:'Disabled authorizer',rule:{...rule,frequency:'weekly',anchorDate:today},dueDays:0,active:true})
  await queueRecurring();await db.execute(sql`UPDATE app_user SET is_active=false WHERE id=${user.id}::uuid`);await automationBatch(1)
  const [disabled]=await db.execute<{active:boolean;status:string}>(sql`SELECT t.active,j.status FROM recurring_template t JOIN background_job j ON j.recurring_template_id=t.id WHERE t.id=${disabledTemplate.id}::uuid`)
  r.check(!disabled.active&&disabled.status==='paused','P2A04 disabled authorizing user pauses queued work instead of running as owner')
  await db.execute(sql`UPDATE app_user SET is_active=true WHERE id=${user.id}::uuid`)
  await setGrants({userId:user.id,entityIds:[entity],modules:['/automation'],actor:owner.email})
  await refused('P2B05 original-source history prevents empty-company deletion','books',()=>deleteCompany(entity,owner.email))
  const exported=await exportCompany(entity,{withFiles:true})
  r.check([item.id,duplicate.id,expense.id].every(id=>(exported.rows.inbox_item??[]).some(row=>row.id===id))&&(exported.rows.email_message??[]).length>=4&&exported.files.length>0,'P2B01 company backup carries automation history and private source/mail blobs')
  const restored=await restoreCompany(exported,owner.email,{code:'P2COPY',name:'P2 restored isolated company'})
  // Paper restoration remains a distinct existing lifecycle boundary.
  await restorePaper(exported,'P2 restored isolated company',restored.ledgerId)
  const [restoredState]=await db.execute<{enabled:boolean;active:number;actors:number}>(sql`SELECT enabled,(SELECT count(*)::int FROM recurring_template WHERE entity_id=${restored.entityId}::uuid AND active) AS active,
    (SELECT count(*)::int FROM background_job WHERE entity_id=${restored.entityId}::uuid AND actor_user_id IS NOT NULL) AS actors FROM automation_setting WHERE entity_id=${restored.entityId}::uuid`)
  r.check(!restoredState.enabled&&restoredState.active===0&&restoredState.actors===0,'P2B02 company restore pauses side effects and drops installation actors')
  const restoredLedger=restored.ledgerId;if(!restoredLedger)throw Error('Restored fixture has no ledger')
  const [restoredSetting]=await db.execute<{version:string}>(sql`SELECT version::text FROM automation_setting WHERE entity_id=${restored.entityId}::uuid`)
  await configureAutomation(restoredLedger,actor,{version:restoredSetting.version,enabled:true,mailEnabled:false,timezone:'America/Vancouver',senderEmail:'accounts@example.test'})
  const [restoredTemplate]=await db.execute<{id:string}>(sql`SELECT id::text FROM recurring_template WHERE ledger_id=${restored.ledgerId}::uuid AND title='Bounded catchup'`)
  await saveRecurring(restoredLedger,actor,{id:restoredTemplate.id,sourceId:'',documentType:'entry',title:'Fresh restored authorization',rule:{...rule,frequency:'weekly',anchorDate:today},dueDays:0,active:true},await proof({ledgerId:restoredLedger,type:'recurring',id:restoredTemplate.id},session.token))
  const companySlots=await saveRecurring(ledger,actor,{sourceId:journal.id,documentType:'entry',title:'Other-company slot discrimination',rule:{...rule,frequency:'weekly',anchorDate:today},dueDays:0,active:true,maxOccurrences:1})
  await db.execute(sql`UPDATE automation_setting SET max_concurrency=1 WHERE entity_id IN (${entity}::uuid,${restored.entityId}::uuid)`)
  await queueRecurring();const companyClaimA=await claimJob(workerA),companyClaimB=await claimJob(workerB)
  r.check(!!companyClaimA&&!!companyClaimB&&companyClaimA.entity_id!==companyClaimB.entity_id,'P2J07 one full company cannot consume another company worker slot')
  if(!companyClaimA||!companyClaimB)throw Error('Two-company fixtures were not claimed')
  await runRecurring(companyClaimA);await runRecurring(companyClaimB)
  const [restoredDraft]=await db.execute<{status:string;foreign_accounts:number}>(sql`SELECT e.status,(SELECT count(*)::int FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.entry_id=e.id AND a.entity_id<>${restored.entityId}::uuid) AS foreign_accounts FROM recurring_occurrence o JOIN journal_entry e ON e.id=o.target_entry_id WHERE o.template_id=${restoredTemplate.id}::uuid AND o.scheduled_for=${today}::date`)
  r.check(restoredDraft.status==='draft'&&restoredDraft.foreign_accounts===0,'P2B06 restored template JSON references remap and require fresh authorization before generating')
  await db.execute(sql`UPDATE recurring_template SET active=false WHERE id IN (${restoredTemplate.id}::uuid,${companySlots.id}::uuid)`)
  await db.transaction(tx=>pauseRestoredAutomation(tx));r.check((await automationBatch()).attempts===0,'P2B03 whole restore leaves no executable side effects')
  await deleteCompany(other.company.id,owner.email)
  r.pass('P2B04 company deletion handles new lifecycle tables without affecting another company')
  // Hand the confirmed TEST fixture to a new browser without our live reminder lease.
  if(process.env.P2_BROWSER_FIXTURE)await editLease({ledgerId:ledger,type:'reminder',id:reminder.id},session.token,'release',reminderProof.proof)
  if(process.env.P2_BROWSER_FIXTURE)writeFileSync(process.env.P2_BROWSER_FIXTURE,JSON.stringify({attachmentsRoot:process.env.ATTACHMENTS_DIR,ledgerId:ledger,entityId:entity,customerId:customer.id,supplierId:supplier.id,invoiceId:sales.id,billId:bill.id,journalId:journal.id,inboxId:item.id,recurringId:generated[0].template.id,reminderId:reminder.id,mailId:mail.id,accounts:Object.fromEntries(accounts.map(a=>[a.code,a.id])),email:owner.email,password:PW}),{mode:0o600})
  if(process.env.P2_CAPTURE_DIR)captures.forEach((bytes,i)=>writeFileSync(join(process.env.P2_CAPTURE_DIR!,`smtp-${i+1}.eml`),bytes))
}
main().catch(e=>r.fail('P2 unexpected fixture/infrastructure failure',errorText(e).slice(0,700))).finally(async()=>{
  if(smtp)await new Promise<void>(resolve=>smtp!.close(()=>resolve()))
  console.log(r.summary());await connection.end();process.exitCode=r.failures?1:0
})

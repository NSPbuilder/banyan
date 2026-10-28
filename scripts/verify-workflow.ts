import './env'
import {randomUUID,randomBytes} from 'node:crypto'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SMTPServer} from 'smtp-server'
import {sql} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {reporter,errorText,expectSaying} from './suite'
import {createFirstOwner,createUser,signIn} from '../src/lib/users'
import {setGrants} from '../src/lib/access'
import {createCompany,createFiscalYear} from '../src/lib/setup'
import {importAccounts,parseAccountsCsv} from '../src/lib/accounts'
import {createParty} from '../src/lib/parties'
import {partyEditFromForm} from '../src/lib/master-forms'
import {createInvoice,postInvoice} from '../src/lib/invoices'
import {requestActor,configureAutomation} from '../src/lib/automation-access'
import {companyServices,saveCompanySmtp,saveCompanyReminderSchedule,companySmtpTransportConfig} from '../src/lib/company-services'
import {createMailPreview,queueMail,runMail,saveReminder,togglePartyReminder,effectiveReminder,reminderColumns,type ReminderRule} from '../src/lib/mail'
import {workerHeartbeat,claimJob} from '../src/lib/jobs'
import {editLease} from '../src/lib/edit-leases'
import type {EditContext,EditResource} from '../src/lib/edit-proof'
import {exportCompany} from '../src/lib/backup'
const r=reporter(75),refused=expectSaying(r,errorText,100),password='Workflow isolated password sentence'
process.env.ATTACHMENTS_DIR=mkdtempSync(join(tmpdir(),'figtree-workflow-paper-'))
process.env.INTEGRATION_KEY_SECRET=randomBytes(32).toString('hex')
const proof=async(resource:EditResource,token:string):Promise<EditContext>=>{const table=resource.type==='party'?'party':'reminder_rule';const [v]=await db.execute<{version:string}>(sql`SELECT version::text FROM ${sql.raw(table)} WHERE id=${resource.id}::uuid`);const tabId=randomUUID(),lease=await editLease(resource,token,'takeover',{version:v.version,tabId});return {sessionToken:token,leaseRequired:true,proof:{version:v.version,tabId,...lease}}}
let smtp:SMTPServer|undefined
async function main(){
  const owner=await createFirstOwner({email:'workflow-owner@example.test',password,firstName:'Workflow owner'}),limited=await createUser({email:'workflow-limited@example.test',password,firstName:'Limited',actor:owner.email})
  const session=await signIn({email:owner.email,password,clientIp:'192.0.2.61'}),limitedSession=await signIn({email:limited.email,password,clientIp:'192.0.2.62'}),actor=requestActor(session.token)
  const co=await createCompany({code:'WORKFLOW',name:'Workflow isolated company'},owner.email),other=await createCompany({code:'WFOTHER',name:'Other isolated company'},owner.email),ledger=co.ledger.id
  await createFiscalYear(ledger,'2026-12-31',owner.email);await setGrants({userId:limited.id,entityIds:[co.company.id],modules:['/automation','/invoices'],actor:owner.email})
  const accounts=await importAccounts(co.company.id,parseAccountsCsv('1200,Receivables,asset,,trade_receivables\n4000,Revenue,revenue,,revenue_from_contracts').map(a=>({...a,entityId:co.company.id})),owner.email)
  const customer=await createParty({kind:'organisation',name:'Workflow customer',roles:[{entityId:co.company.id,role:'customer',heldFrom:'2026-01-01'}],actor:owner.email})
  const invoice=await createInvoice({ledgerId:ledger,direction:'sales',partyId:customer.id,controlAccountId:accounts.find(a=>a.code==='1200')!.id,issuedOn:'2026-09-01',dueOn:'2026-09-30',lines:[{accountId:accounts.find(a=>a.code==='4000')!.id,amount:-12345n}],actor:owner.email});await postInvoice(invoice.id,owner.email)
  await configureAutomation(ledger,actor,{version:'0',enabled:true,mailEnabled:true,timezone:'America/Vancouver',senderEmail:'sender@example.test'});process.env.AUTOMATION_ENABLED='true'
  const input={kind:'invoice' as const,invoiceId:invoice.id,partyId:customer.id,asOf:'2026-10-09',to:'customer@example.test',cc:[],subject:'Workflow invoice',body:'Please review the invoice.',requestKey:randomUUID()}
  await refused('WF01 missing email refuses invoice preview','Add a primary customer email',()=>createMailPreview(ledger,actor,input))
  await refused('WF02 missing email refuses enabled reminder','Add a primary customer email',()=>togglePartyReminder(ledger,customer.id,actor,true))
  const emailForm=new FormData();emailForm.set('ledgerId',ledger);emailForm.set('partyId',customer.id);emailForm.set('email','customer@example.test')
  const partyProof=await proof({ledgerId:ledger,type:'party',id:customer.id},session.token)
  for(const [key,value] of Object.entries({expectedVersion:partyProof.proof.version,editTab:partyProof.proof.tabId,editToken:partyProof.proof.token,editGeneration:partyProof.proof.generation}))emailForm.set(key,value!)
  await partyEditFromForm('contact',emailForm,session.token)
  const [contact]=await db.execute<{email:string}>(sql`SELECT email FROM party_contact WHERE party_id=${customer.id}::uuid AND is_primary`)
  r.check(contact.email==='customer@example.test','WF03 real protected Party form saves existing contact identity')
  await refused('WF04 stale Party contact save refuses','changed',()=>partyEditFromForm('contact',emailForm,session.token))
  const saveContact=async(email:string)=>{
    emailForm.set('email',email)
    const current=await proof({ledgerId:ledger,type:'party',id:customer.id},session.token)
    for(const [key,value] of Object.entries({expectedVersion:current.proof.version,editTab:current.proof.tabId,editToken:current.proof.token,editGeneration:current.proof.generation}))emailForm.set(key,value!)
    await partyEditFromForm('contact',emailForm,session.token)
  }
  await saveContact('')
  const empty=await db.execute(sql`SELECT id FROM party_contact WHERE party_id=${customer.id}::uuid AND is_primary`)
  r.check(empty.length===0,'WF26 clearing an email-only contact removes empty record through protected Party form')
  await db.execute(sql`INSERT INTO party_contact(party_id,name,phone,is_primary) VALUES(${customer.id}::uuid,'Customer contact','555-0101',true)`)
  await saveContact('customer@example.test');await saveContact('')
  const [kept]=await db.execute<{name:string;phone:string;email:string|null}>(sql`SELECT name,phone,email FROM party_contact WHERE party_id=${customer.id}::uuid AND is_primary`)
  r.check(kept.name==='Customer contact'&&kept.phone==='555-0101'&&kept.email===null,'WF27 clearing email preserves existing contact name and phone')
  await saveContact('customer@example.test')
  await refused('WF05 changed recipient cannot override customer email','current primary email',()=>createMailPreview(ledger,actor,{...input,to:'someone-else@example.test',requestKey:randomUUID()}))
  const setting=async()=> (await companyServices(ledger,actor)).setting
  const smtpPassword=randomUUID(),captures:string[]=[]
  smtp=new SMTPServer({allowInsecureAuth:true,disabledCommands:['STARTTLS'],onAuth(auth,_session,cb){cb(auth.username==='workflow'&&auth.password===smtpPassword?null:new Error('Authentication failed'),{user:'workflow'})},onData(stream,_session,cb){let raw='';stream.on('data',chunk=>raw+=chunk);stream.on('end',()=>{captures.push(raw);cb()})}})
  await new Promise<void>(resolve=>smtp!.listen(0,'127.0.0.1',resolve));const port=(smtp as unknown as {server:{address():{port:number}}}).server.address().port
  const smtpInput={version:(await setting()).version,senderEmail:'sender@example.test',host:'127.0.0.1',port,secure:false,username:'workflow',password:smtpPassword,clear:false}
  await saveCompanySmtp(ledger,actor,smtpInput)
  const [cipher]=await db.execute<{cipher:Buffer}>(sql`SELECT smtp_password_ciphertext AS cipher FROM automation_setting WHERE entity_id=${co.company.id}::uuid`)
  r.check(!Buffer.from(cipher.cipher).includes(Buffer.from(smtpPassword)),'WF06 SMTP password is persisted encrypted')
  const view=await companyServices(ledger,actor);r.check(view.setting.has_password&&!JSON.stringify(view).includes(smtpPassword)&&!JSON.stringify(view).includes('ciphertext'),'WF07 UI state exposes presence only, never credential bytes')
  r.check((await companySmtpTransportConfig(co.company.id))?.password===smtpPassword,'WF08 server transport reads saved credential')
  await refused('WF09 stale SMTP setting refuses','changed',()=>saveCompanySmtp(ledger,actor,smtpInput))
  await refused('WF10 restricted user cannot edit SMTP','administrator',async()=>saveCompanySmtp(ledger,requestActor(limitedSession.token),{...smtpInput,version:(await setting()).version}))
  await refused('WF11 invalid SMTP port refuses','port',async()=>saveCompanySmtp(ledger,actor,{...smtpInput,version:(await setting()).version,port:70000}))
  await saveCompanySmtp(ledger,actor,{...smtpInput,version:(await setting()).version,password:''});r.check((await companySmtpTransportConfig(co.company.id))?.password===smtpPassword,'WF12 blank password preserves saved credential')
  await refused('WF13 changed host cannot reuse blank password','password',async()=>saveCompanySmtp(ledger,actor,{...smtpInput,version:(await setting()).version,host:'smtp.example.test',password:''}))
  const otherView=await companyServices(other.ledger.id,actor);r.check(!otherView.setting.smtp_host&&!otherView.setting.has_password,'WF14 settings do not leak across companies')
  process.env.SMTP_LOCAL_CAPTURE='true';delete process.env.SMTP_HOST
  const preview=await createMailPreview(ledger,actor,input),again=await createMailPreview(ledger,actor,input);r.check(preview.id===again.id,'WF15 preview preserves existing request idempotency')
  const worker=randomUUID();await workerHeartbeat(worker);await queueMail(ledger,preview.id,actor);await runMail((await claimJob(worker))!)
  const [sent]=await db.execute<{status:string;recipients:string[]}>(sql`SELECT status,recipients FROM email_message WHERE id=${preview.id}::uuid`)
  r.check(sent.status==='accepted'&&captures.length===1&&captures[0].includes('application/pdf')&&sent.recipients[0]===contact.email,'WF16 actual authenticated local TCP SMTP accepts PDF to customer email')
  const [queued]=await db.execute<{status:string}>(sql`SELECT status FROM background_job WHERE email_message_id=${preview.id}::uuid`);r.check(queued.status==='succeeded','WF17 real Back desk task records successful transport')
  await saveCompanyReminderSchedule(ledger,actor,{version:(await setting()).version,days:[2,8],startHour:10,endHour:16})
  const newRule=await togglePartyReminder(ledger,customer.id,actor,true)
  const [rule]=await db.execute<ReminderRule>(sql`SELECT ${reminderColumns} FROM reminder_rule WHERE id=${newRule.id}::uuid`),effective=await db.transaction(tx=>effectiveReminder(tx,rule))
  r.check(rule.enabled&&rule.uses_company_defaults&&effective.days.join(',')==='2,8'&&effective.start_hour===10,'WF18 Party toggle uses actual company schedule')
  await saveCompanyReminderSchedule(ledger,actor,{version:(await setting()).version,days:[4,9],startHour:8,endHour:18})
  r.check((await db.transaction(tx=>effectiveReminder(tx,rule))).days.join(',')==='4,9','WF19 company defaults apply dynamically without re-enabling customers')
  await refused('WF20 duplicate reminder days refuse','distinct overdue days',async()=>saveCompanyReminderSchedule(ledger,actor,{version:(await setting()).version,days:[4,4],startHour:8,endHour:18}))
  const edit=await proof({ledgerId:ledger,type:'reminder',id:rule.id},session.token)
  await saveReminder(ledger,actor,{id:rule.id,partyId:customer.id,enabled:true,paused:true,reason:'Payment promised',days:[5],startHour:9,endHour:17},edit)
  await togglePartyReminder(ledger,customer.id,actor,false,await proof({ledgerId:ledger,type:'reminder',id:rule.id},session.token))
  const [custom]=await db.execute<ReminderRule>(sql`SELECT ${reminderColumns} FROM reminder_rule WHERE id=${rule.id}::uuid`)
  r.check(!custom.enabled&&custom.paused&&!custom.uses_company_defaults&&custom.days[0]===5&&custom.pause_reason==='Payment promised','WF21 toggling off preserves existing custom schedule and dispute/promise pause')
  await refused('WF22 stale reminder toggle refuses','changed',()=>togglePartyReminder(ledger,customer.id,actor,true,edit))
  const file=await exportCompany(co.company.id,{withFiles:true}),portable=JSON.stringify(file.rows.automation_setting,(_k,v)=>typeof v==='bigint'?String(v):v)
  r.check(!portable.includes(smtpPassword)&&file.rows.automation_setting[0].smtp_password_ciphertext===null&&file.rows.automation_setting[0].smtp_host===null,'WF23 portable backup strips SMTP execution credentials')
  const [audit]=await db.execute<{text:string}>(sql`SELECT coalesce(string_agg(coalesce(before::text,'')||coalesce(after::text,'')||coalesce(context::text,''),' '),'') AS text FROM audit_log`);r.check(audit.text.includes('127.0.0.1')&&!audit.text.includes(smtpPassword),'WF24 existing audit retains changes without SMTP plaintext')
  const [gl]=await db.execute<{n:number;amount:string}>(sql`SELECT count(DISTINCT je.id)::int AS n,sum(jl.amount)::text AS amount FROM journal_entry je JOIN journal_line jl ON jl.entry_id=je.id WHERE je.ledger_id=${ledger}::uuid AND je.status='posted'`)
  r.check(gl.n===1&&gl.amount==='0','WF25 email and reminder configuration adds no accounting entries')
  const version=(await setting()).version
  const concurrent=await Promise.allSettled([saveCompanySmtp(ledger,actor,{...smtpInput,version,password:''}),saveCompanyReminderSchedule(ledger,actor,{version,days:[4,9],startHour:8,endHour:18})])
  r.check(concurrent.filter(v=>v.status==='fulfilled').length===1&&concurrent.some(v=>v.status==='rejected'&&errorText(v.reason).includes('changed')),'WF28 concurrent company settings serialize and reject stale writer')
  await saveCompanySmtp(ledger,actor,{...smtpInput,version:(await setting()).version,password:'',clear:true})
  r.check(await companySmtpTransportConfig(co.company.id)===null&&!(await setting()).has_password,'WF29 explicit clear removes company SMTP credentials and restores installation fallback')
}
main().catch(error=>{r.fail('UNEXPECTED',errorText(error))}).finally(async()=>{if(smtp)await new Promise<void>(resolve=>smtp!.close(resolve));console.log(r.summary());await connection.end();process.exitCode=r.failures?1:0})

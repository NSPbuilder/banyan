/** Focused regression and browser fixture; fresh isolated TEST database only. */
import './env'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { sql as q } from 'drizzle-orm'
import { db, sql } from '../src/db/client'
import { createFirstOwner, createUser, signIn } from '../src/lib/users'
import { createCompanyWithYear } from '../src/lib/setup'
import { createParty } from '../src/lib/parties'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createProject } from '../src/lib/project'
import { setCompanyModules } from '../src/lib/company-modules'
import { MODULE_PATHS } from '../src/lib/nav'
import { setGrants } from '../src/lib/access'
import { saveProjectFinanceRecord, saveProjectFinancePayment, projectFinanceLinks } from '../src/lib/project-finance'
import { actingAs } from '../src/lib/acting'
import { renderInvoiceDocument } from '../src/lib/customer-docs'

let checks=0
const check=(value:unknown,label:string)=>{assert(value,label);console.log(`✅ STAGES ${++checks} ${label}`)}
async function main(){
 const proof=JSON.parse(readFileSync(process.env.FIGTREE_TEST_ISOLATION_PROOF!,'utf8'))
 const [identity]=await db.execute<{name:string}>(q`SELECT current_database() AS name`)
 assert(proof.createdNew&&!proof.productionTouched&&identity.name===proof.testDatabase&&identity.name===process.env.TEST_DATABASE_CONFIRMATION)
 assert(/^figtree_.*_test$/.test(identity.name)&&identity.name!==proof.applicationDatabase)
 assert.equal((await db.execute(q`SELECT id FROM entity`)).length,0)
 const password='Only-Isolated-Stages-123!',me=await createFirstOwner({email:'stages-edit@example.test',firstName:'Stage tester',password})
 const co=await createCompanyWithYear({code:'STEDIT',name:'Stages Edit Sample'},me.email)
 await setCompanyModules(me,{entityId:co.company.id,modules:MODULE_PATHS})
 const chart='1000,Bank,asset,,cash_and_cash_equivalents\n1200,Receivables,asset,,trade_receivables\n2100,Payables,liability,,trade_payables\n2200,GST payable,liability,,gst_hst_payable\n2300,PST payable,liability,,qst_pst_payable\n4000,Revenue,revenue,,revenue_from_contracts\n5100,Materials,expense,,'
 const accounts=await importAccounts(co.company.id,parseAccountsCsv(chart).map(row=>({...row,entityId:co.company.id})),me.email)
 const at=(code:string)=>accounts.find(a=>a.code===code)!.id
 const party=await createParty({kind:'organisation',name:'Stage Customer',actor:me.email,roles:[{entityId:co.company.id,role:'customer'}]})
 const projectId=await createProject({entityId:co.company.id,actor:me.email,code:'STEDIT-P',name:'Stage edit project',customerPartyId:party.id,currency:'CAD',startDate:'2026-01-01'})
 const input={entityId:co.company.id,ledgerId:co.ledger.id,projectId,actor:me.email,kind:'revenue' as const,partyId:party.id,date:'2026-01-02',description:'Existing receipt-backed revenue',controlAccountId:at('1200'),key:randomUUID(),lines:[{kind:'revenue' as const,description:'',base:10000n,gst:0n,pst:0n,gstRecoverable:null,pstRecoverable:null,taxCode:'OUT_OF_SCOPE' as const}]}
 const recordId=await saveProjectFinanceRecord(me,input),link=(await projectFinanceLinks(co.company.id,projectId)).find(l=>l.record_id===recordId)!
 await saveProjectFinancePayment(me,{entityId:co.company.id,ledgerId:co.ledger.id,projectId,actor:me.email,partyId:party.id,direction:'received',date:'2026-01-03',amount:3000n,recordId,bankAccountId:at('1000'),key:randomUUID()})
 const version=async()=>Number((await db.execute<{version:number}>(q`SELECT version FROM project_record WHERE id=${recordId}::uuid`))[0].version)
 const stage=async()=>(await projectFinanceLinks(co.company.id,projectId)).find(l=>l.record_id===recordId)!.payment_stages
 const save=async(text:string|undefined,other:object={})=>saveProjectFinanceRecord(me,{...input,recordId,version:await version(),paymentStages:text,...other})
 const state=async()=>JSON.stringify(await db.execute(q`SELECT jsonb_build_object(
  'invoice',(SELECT to_jsonb(i)-ARRAY['version','print_template_snapshot'] FROM invoice i WHERE i.id=${link.invoice_id}::uuid),
  'template',(SELECT print_template_snapshot-'paymentStages' FROM invoice WHERE id=${link.invoice_id}::uuid),
  'invoiceLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY line_no) FROM invoice_line l WHERE invoice_id=${link.invoice_id}::uuid),
  'entry',(SELECT to_jsonb(j) FROM journal_entry j JOIN invoice i ON i.entry_id=j.id WHERE i.id=${link.invoice_id}::uuid),
  'journalLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY line_no) FROM journal_line l JOIN invoice i ON i.entry_id=l.entry_id WHERE i.id=${link.invoice_id}::uuid),
  'applications',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM invoice_application a WHERE invoice_id=${link.invoice_id}::uuid),
  'source',(SELECT to_jsonb(r)-ARRAY['version','updated_at'] FROM project_record r WHERE id=${recordId}::uuid),
  'sourceLines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY position) FROM project_record_line l WHERE record_id=${recordId}::uuid),
  'allocations',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM project_payment_allocation a WHERE record_id=${recordId}::uuid),
  'link',(SELECT to_jsonb(h) FROM project_accounting_link h WHERE record_id=${recordId}::uuid)) AS state`))
 const before=await state(),initialVersion=await version()
 console.log('🔧 STAGES regression: adding paper prose to an existing invoice with a receipt')
 await save('Deposit: 30%\nFinal: 70%')
 check(await stage()==='Deposit: 30%\nFinal: 70%','add stages after creating revenue without them')
 check(await version()===initialVersion+1&&await state()===before,'paper-only add changes source version but no financial, receipt, line, mapping or template data')
 await save('Revised final: 50%')
 check(await stage()==='Revised final: 50%'&&await state()===before,'modify paper without releasing receipt applications')
 await save(undefined)
 check(await stage()==='Revised final: 50%'&&await state()===before,'omitted legacy field preserves stages and finances')
 const doc=await renderInvoiceDocument(link.invoice_id!)
 check(doc.template?.paymentStages==='Revised final: 50%','customer invoice document reads updated paper text')
 await save('   ')
 check(!await stage()&&await state()===before,'explicit blank clears the paper only')
 check(await saveProjectFinanceRecord(me,input)===recordId,'original no-stage create retry remains idempotent after paper edits')
 await save('Final: 100%')
 const refused=async(work:()=>Promise<unknown>,code:string)=>{await assert.rejects(work,e=>(e as {code?:string}).code===code||String(e).includes(code)||String((e as {cause?:unknown}).cause).includes(code));check(true,'refuses '+code)}
 await refused(()=>save('stale',{version:initialVersion}),'CONFLICT')
 await refused(()=>save('x'.repeat(4001)),'PAYMENT_STAGES')
 await refused(()=>save('cost',{kind:'cost'}),'PAYMENT_STAGES')
 await refused(()=>actingAs(me.email,async tx=>{await tx.execute(q`SELECT set_config('erp.project_write','on',true),set_config('erp.open_edit','on',true)`);await tx.execute(q`UPDATE invoice SET print_template_snapshot=jsonb_set(print_template_snapshot,'{paymentStages}','"raw"'::jsonb) WHERE id=${link.invoice_id}::uuid`)}),'TEMPLATE_SNAPSHOT_FROZEN')
 await refused(()=>actingAs(me.email,async tx=>{await tx.execute(q`SELECT set_config('erp.project_write','on',true),set_config('erp.payment_stages_edit','on',true)`);await tx.execute(q`UPDATE invoice SET print_template_snapshot=jsonb_set(print_template_snapshot,'{name}','"changed template"'::jsonb) WHERE id=${link.invoice_id}::uuid`)}),'TEMPLATE_SNAPSHOT_FROZEN')
 const projectOnly=await createUser({email:'stage-project-only@example.test',firstName:'Project only',password,actor:me.email})
 await setGrants({userId:projectOnly.id,entityIds:[co.company.id],modules:['/projects'],actor:me.email})
 await refused(async()=>saveProjectFinanceRecord(projectOnly,{...input,actor:projectOnly.email,recordId,version:await version(),paymentStages:'unauthorized'}),'NO_ACCESS')
 check(await stage()==='Final: 100%'&&await state()===before,'refused writes leave paper and all financial state unchanged')
 await save('Final: 100%',{description:'Combined financial and paper edit'})
 check(await stage()==='Final: 100%','combined ordinary edit retains explicit stage wording')
 const stagedInput={...input,key:randomUUID(),description:'Created with stages',paymentStages:'Original stages'},stagedId=await saveProjectFinanceRecord(me,stagedInput)
 await saveProjectFinanceRecord(me,{...stagedInput,recordId:stagedId,version:1,paymentStages:'Revised stages'})
 check(await saveProjectFinanceRecord(me,stagedInput)===stagedId,'original staged create retry survives a later paper revision')
 await assert.rejects(()=>saveProjectFinanceRecord(me,{...stagedInput,paymentStages:'Different initial request'}),e=>(e as {code?:string}).code==='REPLAY')
 check(true,'changed create payload still rejects replay')
 const token=(await signIn({email:me.email,password})).token,projectToken=(await signIn({email:projectOnly.email,password})).token
 writeFileSync(proof.fixturePath,JSON.stringify({token,projectToken,ledgerId:co.ledger.id,financeProjectId:projectId,existingRevenueDescription:'Combined financial and paper edit',existingInvoiceId:link.invoice_id},null,2),{mode:0o600})
 console.log(`=== ALL CHECKS PASSED (${checks} focused database cases) ===`)
}
main().then(()=>sql.end()).catch(async error=>{console.error(error);await sql.end();process.exit(1)})

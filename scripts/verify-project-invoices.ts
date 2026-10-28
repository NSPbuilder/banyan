/** Accounting handoff tests; only an explicitly isolated local test database. */
import './env'
import {actingAs} from '../src/lib/acting'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql as q } from 'drizzle-orm'
import { db, sql } from '../src/db/client'
import { createFirstOwner, createUser } from '../src/lib/users'
import { createCompanyWithYear } from '../src/lib/setup'
import { deleteCompany } from '../src/lib/companies'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty, grantRole } from '../src/lib/parties'
import { setGrants } from '../src/lib/access'
import { setCompanyModules } from '../src/lib/company-modules'
import { MODULE_PATHS } from '../src/lib/nav'
import { createProject, saveProjectRecord, createProjectPayment, projectRecords, projectHead, setProjectDeleted, voidProjectItem } from '../src/lib/project'
import { generateProjectInvoice, projectInvoiceReview, projectInvoiceLinks, projectInvoiceOrigin } from '../src/lib/project-invoices'
import { createInvoice, invoiceDetail, postInvoice, deleteInvoice } from '../src/lib/invoices'
import { invoiceEditorState } from '../src/lib/invoice-editor'
import { computeEnteredTax, type TaxCode } from '../src/lib/tax-rates'
import { updateInvoiceFromForm } from '../src/lib/invoice-forms'
import { INVOICE_FIELDS as F, ATTACH_FIELD, lineAccount, lineAmount, lineDescription, lineTaxCode, lineGst, linePst } from '../src/lib/forms'
import { parseMoney } from '../src/lib/money'
import { createInvoiceTemplate, setInvoiceTemplateAssignment } from '../src/lib/invoice-templates'
import { exportCompany, restoreCompany } from '../src/lib/backup'

let checks=0
const check=(value:unknown,label:string)=>{assert(value,label);console.log(`PASS PI${++checks} ${label}`)}
const refusal=async(fn:()=>Promise<unknown>,code:string)=>{try{await fn()}catch(e){check((e as {code?:string}).code===code,`refused ${code}`);return}throw Error('Expected '+code)}
async function counts(){const [r]=await db.execute<{ invoices:number; entries:number; handoffs:number }>(q`
 SELECT (SELECT count(*)::int FROM invoice) AS invoices,(SELECT count(*)::int FROM journal_entry) AS entries,
 (SELECT count(*)::int FROM project_invoice_handoff) AS handoffs`);return r}
async function main(){
 const test=new URL(process.env.TEST_DATABASE_URL!),app=new URL(process.env.APP_DATABASE_URL!)
 assert(test.pathname.endsWith('_test')&&['localhost','127.0.0.1','[::1]'].includes(test.hostname)&&test.href!==app.href)
 const [identity]=await db.execute<{name:string}>(q`SELECT current_database() AS name`);assert.equal(identity.name,test.pathname.slice(1))
 const me=await createFirstOwner({email:'project-invoices@example.test',firstName:'Tester',password:'Only-Local-Test-123!'})
 const A=await createCompanyWithYear({code:'PIA',name:'Project Invoice A Test'},me.email)
 const B=await createCompanyWithYear({code:'PIB',name:'Project Invoice B Test'},me.email)
 const chart='1200,Receivables,asset,,trade_receivables\n2200,GST payable,liability,,gst_hst_payable\n2300,PST payable,liability,,qst_pst_payable\n4000,Contract revenue,revenue,,revenue_from_contracts\n4100,Service revenue,revenue,,revenue_from_contracts'
 const accts=await importAccounts(A.company.id,parseAccountsCsv(chart).map(r=>({...r,entityId:A.company.id})),me.email)
 const foreign=await importAccounts(B.company.id,parseAccountsCsv(chart).map(r=>({...r,entityId:B.company.id})),me.email)
 const acct=(code:string)=>accts.find(a=>a.code===code)!.id
 const customer=await createParty({kind:'organisation',name:'Project Invoice Customer',actor:me.email,roles:[{entityId:A.company.id,role:'customer',heldFrom:'2026-01-01'}]})
 const p=await createProject({entityId:A.company.id,currency:'CAD',code:'PR-26001',name:'Renovation',customerPartyId:customer.id,actor:me.email})
 const source={entityId:A.company.id,currency:'CAD',projectId:p,kind:'revenue' as const,partyId:customer.id,date:'2026-10-06',dueDate:'2026-11-05',description:'Progress billing',reference:'Phase 1',actor:me.email,
   lines:[{kind:'revenue' as const,description:'Materials and labor',base:100001n,gst:4999n,pst:6999n,gstRecoverable:null,pstRecoverable:null},{kind:'revenue' as const,description:'Additional services',base:23455n,gst:1173n,pst:0n,gstRecoverable:null,pstRecoverable:null}]}
 const record=await saveProjectRecord({...source,key:randomUUID()})
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS})
 await setCompanyModules(me,{entityId:B.company.id,modules:MODULE_PATHS})
 const review=await projectInvoiceReview(A.company.id,p,record)
 check(review.number==='PR-26001'&&review.lines.length===2&&review.accounts.revenue.length===1&&review.accounts.revenue[0].label.startsWith('8000'),'review uses project code, source lines and automatic company revenue account')
 const input={ledgerId:A.ledger.id,projectId:p,recordId:record,version:1,issuedOn:'2026-10-06',dueOn:'2026-11-05',controlAccountId:acct('1200'),revenueAccountIds:[acct('4000'),acct('4100')],gstAccountId:acct('2200'),pstAccountId:acct('2300')}
 const onlyProject=await createUser({email:'project-only@example.test',firstName:'Project only',password:'Only-Local-Test-123!',actor:me.email})
 const onlyInvoice=await createUser({email:'invoice-only@example.test',firstName:'Invoice only',password:'Only-Local-Test-123!',actor:me.email})
 await setGrants({userId:onlyProject.id,entityIds:[A.company.id],modules:['/projects'],actor:me.email})
 await setGrants({userId:onlyInvoice.id,entityIds:[A.company.id],modules:['/invoices'],actor:me.email})
 await refusal(()=>generateProjectInvoice(onlyProject,input),'NO_ACCESS')
 await refusal(()=>generateProjectInvoice(onlyInvoice,input),'NO_ACCESS')
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS.filter(m=>m!=='/invoices')})
 await refusal(()=>generateProjectInvoice(me,input),'NO_ACCESS')
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS.filter(m=>m!=='/projects')})
 await refusal(()=>generateProjectInvoice(me,input),'NO_ACCESS')
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS})
 await refusal(()=>generateProjectInvoice(me,{...input,ledgerId:B.ledger.id}),'NO_PROJECT')
 await refusal(()=>generateProjectInvoice(me,{...input,controlAccountId:acct('4000')}),'RECEIVABLE')
 await actingAs(me.email,tx=>tx.execute(q`UPDATE account SET is_active=false WHERE id=${acct('2300')}::uuid`))
 await refusal(()=>generateProjectInvoice(me,{...input,pstAccountId:acct('2200')}),'TAX_ACCOUNT')
 await actingAs(me.email,tx=>tx.execute(q`UPDATE account SET is_active=true WHERE id=${acct('2300')}::uuid`))
 await refusal(()=>generateProjectInvoice(me,{...input,version:2}),'STALE')
 await refusal(()=>generateProjectInvoice(me,{...input,dueOn:'2026-10-01'}),'DUE_DATE')
 check((await counts()).invoices===0&&(await counts()).handoffs===0,'all refused handoffs leave no invoice, link or financial entry')
 await createProjectPayment({...source,partyId:customer.id,direction:'received',date:'2026-10-06',amount:50000n,key:randomUUID(),recordId:record})
 const template=await createInvoiceTemplate(me,{entityId:A.company.id,name:'Project client template',settings:{layout:'compact',paymentInstructions:'Bank transfer',footer:'Project footer'}})
 await setInvoiceTemplateAssignment(me,{ledgerId:A.ledger.id,partyId:customer.id,templateId:template})
 const generated=await generateProjectInvoice(me,{...input,revenueAccountIds:[foreign.find(a=>a.code==='4000')!.id,acct('4100')]})
 const detail=(await invoiceDetail(generated.invoice_id))!
 check(detail.invoice.status==='draft'&&detail.invoice.entry_id===null&&(await counts()).entries===0,'Generate creates only a draft; no journal entry until confirmation')
 check(detail.invoice.number==='PR-26001'&&detail.invoice.party_id===customer.id&&detail.invoice.their_ref==='Phase 1','customer, reference and number transfer exactly')
 check(detail.total===136627n&&detail.lines.length===4,'source net, GST and PST transfer as exact signed cents with per-line accounts')
 check(detail.lines[0].account_id===review.accounts.revenue[0].id&&detail.lines[1].account_id===review.accounts.revenue[0].id,'foreign and custom client accounts cannot override automatic 8000 revenue mapping')
 const edit=invoiceEditorState(detail)
 const taxes=edit.rows.map(l=>computeEnteredTax(parseMoney(l.amount),l.taxCode as TaxCode,false,'2026-10-06',{gst:parseMoney(l.gst || '0'),pst:parseMoney(l.pst || '0')}))
 check(taxes.reduce((n,t)=>n+t.gst+t.pst+t.base,0n)===detail.total,'draft editor preserves explicit source tax amounts without recalculation')
 const editForm=new FormData()
 for(const [key,value] of [[F.ledgerId,A.ledger.id],[F.invoiceId,generated.invoice_id],[F.direction,'sales'],[F.kind,'invoice'],[F.partyId,customer.id],[F.controlAccountId,acct('1200')],[F.issuedOn,input.issuedOn],[F.dueOn,input.dueOn],[F.number,'PR-26001'],[F.amounts,'exclusive']])editForm.set(key,value)
 for(const [i,l] of edit.rows.entries())for(const [key,value] of [[lineAccount(i),l.account],[lineAmount(i),l.amount],[lineDescription(i),l.description],[lineTaxCode(i),l.taxCode],[lineGst(i),l.gst || '0'],[linePst(i),l.pst || '0']])editForm.set(key,value)
 editForm.set(ATTACH_FIELD,new File(['test-only draft attachment'],'draft.pdf',{type:'application/pdf'}))
 const saved=await updateInvoiceFromForm(editForm,id=>id,me.email)
 check(!saved.error&&saved.ok?.startsWith('Draft saved.')&&saved.ok.includes('file was not attached'),'draft save reports a supplied file cannot be attached before posting')
 const savedDraft=(await invoiceDetail(generated.invoice_id))!
 check(savedDraft.invoice.status==='draft'&&savedDraft.total===136627n&&(await counts()).entries===0,'editing draft preserves source tax amounts and does not post')
 check((await projectRecords(A.company.id,{},p))[0].settled==='50000','Project receipts remain intact and independent')
 const retries=await Promise.all([generateProjectInvoice(me,input),generateProjectInvoice(me,input),generateProjectInvoice(me,{...input,revenueAccountIds:[]})])
 check(retries.every(i=>i.invoice_id===generated.invoice_id)&&(await counts()).invoices===1,'simultaneous/repeated requests return the existing invoice without duplicates')
 const posted=await postInvoice(generated.invoice_id,me.email)
 check(posted.total===136627n&&(await counts()).entries===1,'explicit Post confirms one balanced accounting entry')
 const [controlLine]=await db.execute<{amount:string;party_id:string}>(q`SELECT amount::text,party_id::text FROM journal_line WHERE entry_id=${posted.entryId}::uuid AND account_id=${acct('1200')}::uuid`)
 check(controlLine.amount==='136627'&&controlLine.party_id===customer.id,'receivable is fully unpaid in accounting despite independent Project receipts')
 check((await invoiceDetail(generated.invoice_id))!.invoice.print_template_snapshot?.templateId===template,'posting freezes the authorized customer template')
 await saveProjectRecord({...source,recordId:record,version:1,description:'Updated progress billing',key:randomUUID()})
 check((await invoiceDetail(generated.invoice_id))!.total===136627n&&(await projectInvoiceOrigin(A.company.id,generated.invoice_id))!.version===2,'source edits are visible as a change but do not overwrite accounting invoices')
 check((await generateProjectInvoice(me,input)).invoice_id===generated.invoice_id,'stale generation retry still opens the original linked invoice')
 const r2=await saveProjectRecord({...source,description:'Second billing',key:randomUUID()})
 const r3=await saveProjectRecord({...source,description:'Third billing',key:randomUUID()})
 const simultaneous=await Promise.all([r2,r3].map(recordId=>generateProjectInvoice(me,{...input,recordId})))
 check(new Set(simultaneous.map(i=>i.number)).size===2&&simultaneous.some(i=>i.number==='PR-26001-02')&&simultaneous.some(i=>i.number==='PR-26001-03'),'multiple revenue records get distinct project-derived suffixes under concurrency')
 await voidProjectItem({entityId:A.company.id,projectId:p,id:record,kind:'record',version:2,reason:'Duplicate operational record',actor:me.email})
 check((await projectInvoiceOrigin(A.company.id,generated.invoice_id))!.state==='void'&&(await invoiceDetail(generated.invoice_id))!.invoice.status==='posted','cancelling Project revenue retains its accounting invoice and provenance')
 const before=(await counts()).invoices
 await deleteInvoice(simultaneous[0].invoice_id,me.email)
 check((await projectInvoiceLinks(A.company.id,p)).length===2&&(await counts()).invoices===before-1,'deliberate draft deletion removes its link so a replacement can be generated')
 const again=await generateProjectInvoice(me,{...input,recordId:simultaneous[0].record_id})
 check(again.invoice_id!==simultaneous[0].invoice_id,'explicit generation after deletion creates a new draft')
 const collision=await createProject({entityId:A.company.id,currency:'CAD',code:'PR-COLLIDE',name:'Number collision',customerPartyId:customer.id,actor:me.email})
 await createInvoice({ledgerId:A.ledger.id,direction:'sales',number:'PR-COLLIDE',partyId:customer.id,controlAccountId:acct('1200'),issuedOn:'2026-10-06',dueOn:'2026-10-06',lines:[{accountId:acct('4000'),amount:-100n}],actor:me.email})
 const collisionRecord=await saveProjectRecord({...source,projectId:collision,key:randomUUID()})
 check((await generateProjectInvoice(me,{...input,projectId:collision,recordId:collisionRecord})).number==='PR-COLLIDE-02','existing manually numbered invoices are respected')
 const unclassified=await createParty({kind:'organisation',name:'Project supplier only',roles:[{entityId:A.company.id,role:'supplier',heldFrom:'2026-01-01'}],actor:me.email})
 const noRole=await createProject({entityId:A.company.id,currency:'CAD',code:'PR-NOROLE',name:'Unclassified client',customerPartyId:unclassified.id,actor:me.email})
 const noRoleRecord=await saveProjectRecord({...source,projectId:noRole,partyId:unclassified.id,key:randomUUID()})
 await refusal(()=>generateProjectInvoice(me,{...input,projectId:noRole,recordId:noRoleRecord}),'CUSTOMER_ROLE')
 await grantRole({entityId:A.company.id,partyId:unclassified.id,role:'customer',heldFrom:'2026-10-01',actor:me.email})
 check((await generateProjectInvoice(me,{...input,projectId:noRole,recordId:noRoleRecord})).status==='draft','adding an explicit customer role enables the handoff without duplicating Party')
 const taxOnly=await saveProjectRecord({...source,description:'Tax adjustment',lines:[{...source.lines[0],base:0n,gst:25n,pst:0n},{...source.lines[1],base:100n,gst:0n,pst:0n}],key:randomUUID()})
 const taxOnlyInvoice=await generateProjectInvoice(me,{...input,recordId:taxOnly})
 const taxDetail=(await invoiceDetail(taxOnlyInvoice.invoice_id))!
 check(taxDetail.total===125n&&invoiceEditorState(taxDetail).rows.length===2,'tax-only source adjustments retain all values when opened for editing')
 const invalidTemplateSource=await saveProjectRecord({...source,description:'Unauthorized template',key:randomUUID()})
 const beforeInvalid=await counts()
 await refusal(()=>generateProjectInvoice(me,{...input,recordId:invalidTemplateSource,template:randomUUID()}),'NOT_GRANTED')
 check(JSON.stringify(await counts())===JSON.stringify(beforeInvalid),'failed template authorization rolls back draft and linkage together')
 await setGrants({userId:onlyProject.id,entityIds:[A.company.id],modules:['/projects','/invoices'],actor:me.email})
 const userSource=await saveProjectRecord({...source,description:'Authorized regular user',key:randomUUID()})
 check((await generateProjectInvoice(onlyProject,{...input,recordId:userSource})).status==='draft','regular user with both seats can generate a draft')
 const backup=await exportCompany(A.company.id)
 check(backup.rows.project_invoice_handoff.length===7,'portable company backup includes source links')
 const restored=await restoreCompany(backup,me.email,{code:'PIRESTORED',name:'Restored Project Invoice Test'})
 const restoredLinks=await db.execute<{invoice_id:string;project_id:string}>(q`SELECT invoice_id::text,project_id::text FROM project_invoice_handoff WHERE entity_id=${restored.entityId}::uuid`)
 check(restoredLinks.length===7&&restoredLinks.every(l=>l.invoice_id!==generated.invoice_id&&l.project_id!==p),'restoration remaps Project and invoice identities while retaining historical links')
 const trail=await db.execute<{actor:string}>(q`SELECT actor FROM audit_log WHERE table_name='project_invoice_handoff' AND entity_id=${A.company.id}::uuid`)
 check(trail.length>=7&&trail.every(t=>[me.email,onlyProject.email].includes(t.actor)),'handoff audit records name the acting user')
 await db.execute(q`INSERT INTO bank_statement(account_id,statement_date,ending_balance,created_by) VALUES(${foreign[0].id}::uuid,'2026-10-31',0,${me.email})`)
 await refusal(()=>deleteCompany(B.company.id,me.email),'HAS_BOOKS')
 const h=await projectHead(A.company.id,p)
 await setProjectDeleted({entityId:A.company.id,projectId:p,version:h.version,deleted:true,actor:me.email})
 await refusal(()=>generateProjectInvoice(me,input),'NO_PROJECT')
 console.log(`Project invoice checks passed: ${checks}`)
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>sql.end())

/** Verify only in a fresh, explicitly isolated local test database. */
import './env'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {sql as q} from 'drizzle-orm'
import {db,sql} from '../src/db/client'
import {createFirstOwner,createUser} from '../src/lib/users'
import {createCompanyWithYear,createCompany} from '../src/lib/setup'
import {importAccounts,parseAccountsCsv} from '../src/lib/accounts'
import {createParty} from '../src/lib/parties'
import {setGrants} from '../src/lib/access'
import {companyModulePolicies,setCompanyModules} from '../src/lib/company-modules'
import {MODULE_PATHS} from '../src/lib/nav'
import {generateProjectInvoice} from '../src/lib/project-invoices'
import {createProject,projectRecords,projectPayments,projectAllocations,createProjectPayment,saveProjectRecord} from '../src/lib/project'
import {saveProjectFinanceRecord,saveProjectFinancePayment,allocateProjectFinancePayment,cancelProjectFinanceItem,projectFinanceLinks,withProjectPaymentEditing,editProjectFinancePayment} from '../src/lib/project-finance'
import {invoiceDetail,editInvoice,createInvoice,postInvoice} from '../src/lib/invoices'
import {ensureProjectAccounts,projectCategoryAccounts} from '../src/lib/project-accounts'
import {actingAs} from '../src/lib/acting'
import {recordPayment,unapply,deletePayment,balanceOf,applyEntryToInvoice} from '../src/lib/payments'
import {editEntry} from '../src/lib/posting'
import {exportCompany,restoreCompany} from '../src/lib/backup'
import {projectLineRows,projectLines} from '../src/lib/project-forms'
import {lineGst,linePst,lineTaxCode} from '../src/lib/forms'
import {saveAttachment,attachmentFile} from '../src/lib/attachments'

let checks=0
const check=(v:unknown,label:string)=>{assert(v,label);console.log(`PASS PF${++checks} ${label}`)}
const refuse=async(fn:()=>Promise<unknown>,code:string)=>{try{await fn()}catch(e){const chain=(e as Error).message+' '+String((e as {cause?:unknown}).cause);check((e as {code?:string}).code===code||chain.includes(code),'refused '+code);return}throw Error('Expected '+code)}
async function main(){
 const test=new URL(process.env.TEST_DATABASE_URL!),app=new URL(process.env.APP_DATABASE_URL!)
 assert(test.pathname.endsWith('_test')&&['localhost','127.0.0.1','[::1]'].includes(test.hostname)&&test.href!==app.href)
 const [identity]=await db.execute<{name:string}>(q`SELECT current_database() AS name`);assert.equal(identity.name,test.pathname.slice(1))
 const me=await createFirstOwner({email:'finance@example.test',firstName:'Tester',password:'Only-Local-Test-123!'})
 const A=await createCompanyWithYear({code:'PFA',name:'Project Finance A'},me.email),B=await createCompanyWithYear({code:'PFB',name:'Project Finance B'},me.email)
 const chart='1000,Bank,asset,,cash_and_cash_equivalents\n1200,Receivables,asset,,trade_receivables\n1300,GST recoverable,asset,,gst_hst_recoverable\n1400,PST recoverable,asset,,qst_pst_recoverable\n2100,Payables,liability,,trade_payables\n2200,GST payable,liability,,gst_hst_payable\n2300,PST payable,liability,,qst_pst_payable\n4000,Revenue,revenue,,revenue_from_contracts\n5100,Materials,expense,,\n5200,Labor,expense,,'
 const accts=await importAccounts(A.company.id,parseAccountsCsv(chart).map(r=>({...r,entityId:A.company.id})),me.email),foreign=await importAccounts(B.company.id,parseAccountsCsv(chart).map(r=>({...r,entityId:B.company.id})),me.email)
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS})
 const acct=(code:string)=>accts.find(a=>a.code===code)!.id
 const customer=await createParty({kind:'organisation',name:'Finance Customer',actor:me.email,roles:[{entityId:A.company.id,role:'customer',heldFrom:'2026-01-01'}]})
 const supplier=await createParty({kind:'organisation',name:'Finance Supplier',actor:me.email,roles:[{entityId:A.company.id,role:'supplier',heldFrom:'2026-01-01'}]})
 const p=await createProject({entityId:A.company.id,currency:'CAD',code:'PF-001',name:'Automatic workflow',customerPartyId:customer.id,actor:me.email})
 const base={entityId:A.company.id,ledgerId:A.ledger.id,projectId:p,actor:me.email,date:'2026-10-06',description:'Test source'}
 const revenue={...base,kind:'revenue' as const,partyId:customer.id,dueDate:'2026-11-05',accountIds:[acct('4000')],controlAccountId:acct('1200'),gstAccountId:acct('2200'),pstAccountId:acct('2300'),key:randomUUID(),
  lines:[{kind:'revenue' as const,description:'Progress',base:100001n,gst:4999n,pst:7000n,gstRecoverable:null,pstRecoverable:null}]}
 const r=await saveProjectFinanceRecord(me,revenue),link=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===r)!,detail=(await invoiceDetail(link.invoice_id!))!
 check(detail.invoice.status==='posted'&&detail.invoice.number==='PF-001'&&detail.total===112000n,'revenue save immediately posts exactly priced project-numbered invoice')
 check((await db.execute(q`SELECT id FROM journal_entry`)).length===1,'automatic invoice posts exactly one accounting entry')
 check(await saveProjectFinanceRecord(me,revenue)===r,'retry returns the same source without another document')
 check((await generateProjectInvoice(me,{ledgerId:A.ledger.id,projectId:p,recordId:r,version:1,issuedOn:base.date,dueOn:'2026-11-05',controlAccountId:acct('1200'),revenueAccountIds:[acct('4000')]})).invoice_id===link.invoice_id,'old Generate action returns automatic invoice instead of duplicating it')
 check(await saveProjectFinanceRecord(me,{...revenue,accountIds:[acct('5100')]})===r,'client item-account overrides cannot change an automatic mapping or duplicate its invoice')
 const mapped=await db.execute<{code:string;id:string}>(q`SELECT code,id::text FROM account WHERE entity_id=${A.company.id}::uuid`)
 const mappedId=(code:string)=>mapped.find(a=>a.code===code)!.id
 const [r2,r3]=await Promise.all([saveProjectFinanceRecord(me,{...revenue,key:randomUUID()}),saveProjectFinanceRecord(me,{...revenue,key:randomUUID()})])
 check(new Set((await projectFinanceLinks(A.company.id,p)).map(l=>l.number)).size===3,'concurrent revenue saves use distinct project suffixes')
 check(await saveProjectFinanceRecord(me,{...revenue,accountIds:[foreign.find(a=>a.code==='4000')!.id]})===r,'foreign client item-account IDs are ignored in favor of company-owned bindings')
 check((await projectRecords(A.company.id,{},p)).length===3,'ignored mapping overrides create no duplicate Project record')
 const projectOnly=await createUser({email:'finance-project-only@example.test',firstName:'Project',password:'Only-Local-Test-123!',actor:me.email})
 await setGrants({userId:projectOnly.id,entityIds:[A.company.id],modules:['/projects'],actor:me.email})
 await refuse(()=>saveProjectFinanceRecord(projectOnly,{...revenue,key:randomUUID()}),'NO_ACCESS')
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS.filter(m=>m!=='/invoices')})
 await refuse(()=>saveProjectFinanceRecord(me,{...revenue,key:randomUUID()}),'NO_ACCESS')
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS})
 const beforeFailedPayment=(await db.execute(q`SELECT id FROM journal_entry`)).length
 await refuse(()=>saveProjectFinancePayment(me,{...base,partyId:customer.id,direction:'received',date:base.date,amount:200000n,key:randomUUID(),recordId:r,bankAccountId:acct('1000')}),'OVERPAYMENT')
 check((await invoiceDetail(link.invoice_id!))!.invoice.status==='posted'&&(await db.execute(q`SELECT id FROM journal_entry`)).length===beforeFailedPayment,'overpayment preserves posted invoice and rolls back payment and Project mirror together')
 const receipt={...base,partyId:customer.id,direction:'received' as const,date:'2026-10-07',amount:50000n,key:randomUUID(),recordId:r,bankAccountId:acct('1000')}
 const pay=await saveProjectFinancePayment(me,receipt)
 check((await invoiceDetail(link.invoice_id!))!.invoice.status==='posted','Project payment uses the already posted invoice')
 check((await balanceOf(link.invoice_id!)).balance===62000n&&(await projectRecords(A.company.id,{},p)).find(x=>x.id===r)!.outstanding==='62000','Project and invoice balances agree after partial receipt')
 check(await saveProjectFinancePayment(me,receipt)===pay,'payment retry posts once')
 await refuse(()=>saveProjectFinancePayment(me,{...receipt,allocation:10000n}),'REPLAY')
 const accountingPay=await recordPayment({invoiceId:link.invoice_id!,bankAccountId:acct('1000'),amount:12000n,paidOn:'2026-10-08',actor:me.email})
 check((await projectRecords(A.company.id,{},p)).find(x=>x.id===r)!.settled==='62000','payment entered in Invoices appears in Project')
 const [application]=await db.execute<{id:string}>(q`SELECT id::text FROM invoice_application WHERE entry_id=${accountingPay.entryId}::uuid`)
 await unapply(application.id,me.email)
 check((await projectRecords(A.company.id,{},p)).find(x=>x.id===r)!.settled==='50000','unapply in Invoices removes Project allocation')
 await applyEntryToInvoice({invoiceId:link.invoice_id!,entryId:accountingPay.entryId,amount:12000n,actor:me.email})
 check((await projectRecords(A.company.id,{},p)).find(x=>x.id===r)!.settled==='62000','reapplying an existing receipt reactivates its Project mirror')
 await deletePayment(accountingPay.entryId,me.email)
 check((await projectRecords(A.company.id,{},p)).find(x=>x.id===r)!.settled==='50000','deleting accounting payment cancels its Project mirror')
 await refuse(()=>editInvoice(link.invoice_id!,{partyId:customer.id,controlAccountId:acct('1200'),issuedOn:'2026-10-06',dueOn:'2026-11-05',number:'PF-001',lines:[{accountId:acct('4000'),amount:-112000n}],actor:me.email}),'PROJECT_ACCOUNTING_OWNER')
 await saveProjectFinanceRecord(me,{...revenue,recordId:r,version:1,description:'Revised source'})
 check((await projectRecords(A.company.id,{},p)).find(x=>x.id===r)!.settled==='0'&&(await balanceOf(link.invoice_id!)).balance===112000n,'source edit atomically releases applications in both books')
 const [paidMirror]=await db.execute<{entry_id:string}>(q`SELECT entry_id::text FROM project_accounting_payment WHERE payment_id=${pay}::uuid`)
 check(!!paidMirror.entry_id,'released Project receipt remains an accounting advance')
 const alloc={...base,paymentId:pay,recordId:r,amount:50000n,key:randomUUID()}
 await allocateProjectFinancePayment(me,alloc);await allocateProjectFinancePayment(me,alloc)
 check((await balanceOf(link.invoice_id!)).applied===50000n,'reallocate an advance exactly once')
 const cost={...base,kind:'cost' as const,partyId:supplier.id,accountIds:[acct('5100')],controlAccountId:acct('2100'),gstAccountId:acct('1300'),pstAccountId:acct('1400'),bankAccountId:acct('1000'),key:randomUUID(),
  lines:[{kind:'material' as const,description:'Materials',base:10000n,gst:500n,pst:700n,gstRecoverable:300n,pstRecoverable:0n}]}
 const c=await saveProjectFinanceRecord(me,{...cost,paid:{date:base.date}}),cl=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===c)!
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS.filter(m=>m!=='/entries')})
 await refuse(()=>saveProjectFinanceRecord(me,{...cost,key:randomUUID(),paid:{date:base.date}}),'NO_ACCESS')
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS})
 check(!!cl.expense_entry_id&&!cl.invoice_id,'fully paid same-day cost goes directly to Expense')
 const expense=await db.execute<{account_id:string;amount:string}>(q`SELECT account_id::text,amount::text FROM journal_line WHERE entry_id=${cl.expense_entry_id}::uuid`)
 check(expense.find(l=>l.account_id===mappedId('8320'))?.amount==='10900'&&expense.find(l=>l.account_id===acct('1300'))?.amount==='300'&&expense.find(l=>l.account_id===acct('1000'))?.amount==='-11200','automatic material account, partial GST recovery and nonrecoverable PST are exact')
 await refuse(()=>editEntry(cl.expense_entry_id!,{entryDate:base.date,description:'Outside edit',lines:[{accountId:acct('5100'),amount:11200n},{accountId:acct('1000'),amount:-11200n}]},me.email),'PROJECT_ACCOUNTING_OWNER')
 await saveProjectFinanceRecord(me,{...cost,recordId:c,version:1,lines:[{...cost.lines[0],base:20000n}]})
 const edited=(await projectRecords(A.company.id,{},p)).find(x=>x.id===c)!
 check(edited.gross==='21200'&&edited.settled==='21200','paid Expense edit updates its Project payment and amount together')
 await refuse(()=>saveProjectFinanceRecord(me,{...cost,key:randomUUID(),lines:[{...cost.lines[0],gstRecoverable:null}]}),'TAX_REVIEW')
 const unpaid=await saveProjectFinanceRecord(me,{...cost,key:randomUUID()}),ul=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===unpaid)!
 check((await invoiceDetail(ul.invoice_id!))!.invoice.status==='posted','unpaid cost immediately posts purchase bill')
 await saveProjectFinancePayment(me,{...base,partyId:supplier.id,direction:'paid',date:'2026-10-08',amount:11200n,key:randomUUID(),recordId:unpaid,bankAccountId:acct('1000')})
 check((await balanceOf(ul.invoice_id!)).balance===0n&&(await projectRecords(A.company.id,{},p)).find(x=>x.id===unpaid)!.outstanding==='0','later supplier payment confirms bill and settles both balances')
 const partial=await saveProjectFinanceRecord(me,{...cost,key:randomUUID(),paid:{date:base.date,amount:5000n}}),pl=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===partial)!
 check(!!pl.invoice_id&&(await balanceOf(pl.invoice_id!)).balance===6200n,'part-paid cost posts Bill plus Payment, preserving payable')
 const later=await saveProjectFinanceRecord(me,{...cost,key:randomUUID(),paid:{date:'2026-10-09'}}),ll=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===later)!
 check(!!ll.invoice_id&&(await balanceOf(ll.invoice_id!)).balance===0n,'different payment date keeps separate dated Bill and Payment')
 const before=(await projectRecords(A.company.id,{},p)).length
 await refuse(()=>saveProjectFinanceRecord(me,{...cost,key:randomUUID(),paid:{date:base.date},bankAccountId:foreign.find(a=>a.code==='1000')!.id}),'BANK')
 check((await projectRecords(A.company.id,{},p)).length===before,'invalid paid account leaves neither source nor expense')
 const advance=await saveProjectFinancePayment(me,{...base,partyId:customer.id,direction:'received',date:base.date,amount:20000n,key:randomUUID(),bankAccountId:acct('1000'),controlAccountId:acct('1200')})
 await allocateProjectFinancePayment(me,{...base,paymentId:advance,recordId:r2,amount:20000n,key:randomUUID()})
 check((await projectPayments(A.company.id,{},p)).find(x=>x.id===advance)!.unallocated==='0','Project advance posts once and allocates to a later invoice')
 const allocation=(await projectAllocations(A.company.id,p)).find(x=>x.payment_id===advance)!
 await cancelProjectFinanceItem(me,{...base,id:allocation.id,kind:'allocation',version:allocation.version,reason:'Wrong invoice'})
 check((await projectPayments(A.company.id,{},p)).find(x=>x.id===advance)!.unallocated==='20000','Project unallocation releases accounting application and preserves advance')
 await cancelProjectFinanceItem(me,{...base,id:c,kind:'record',version:2,reason:'Duplicate cost'})
 check(!(await projectRecords(A.company.id,{},p)).some(x=>x.id===c)&&!(await db.execute(q`SELECT id FROM journal_entry WHERE id=${cl.expense_entry_id}::uuid`)).length,'cancel paid cost removes expense and cancels Project payment')
 await cancelProjectFinanceItem(me,{...base,id:r3,kind:'record',version:1,reason:'Duplicate revenue'})
 check((await db.execute<{invoice_id:string|null}>(q`SELECT invoice_id::text FROM project_accounting_link WHERE record_id=${r3}::uuid`))[0].invoice_id===null,'cancel revenue removes its linked posted invoice')
 // Correcting settlements must preserve recognition and every valid application.
 const editState=async(id:string,projectId=p)=>{const x=(await withProjectPaymentEditing(A.company.id,projectId,await projectPayments(A.company.id,{},projectId))).find(x=>x.id===id)!;return {...base,projectId,paymentId:id,version:x.version,signature:x.edit!.signature,date:x.payment_date,amount:BigInt(x.edit!.amount),bankAccountId:x.edit!.bankAccountId||undefined,reference:x.reference||undefined,allocations:x.edit!.allocations.map(a=>({target:a.target,amount:BigInt(a.amount)}))}}
 const er=await saveProjectFinanceRecord(me,{...revenue,key:randomUUID()}),el=(await projectFinanceLinks(A.company.id,p)).find(x=>x.record_id===er)!
 const ep=await saveProjectFinancePayment(me,{...receipt,key:randomUUID(),recordId:er}),originalEdit=await editState(ep)
 await refuse(()=>editProjectFinancePayment(projectOnly,originalEdit),'NO_ACCESS')
 await refuse(()=>editProjectFinancePayment(me,{...originalEdit,amount:10000n}),'OVERPAYMENT')
 await editProjectFinancePayment(me,{...originalEdit,date:'2026-10-09',amount:60000n,reference:'Corrected receipt',note:'Receipt correction'})
 check((await projectPayments(A.company.id,{},p)).find(x=>x.id===ep)!.unallocated==='10000'&&(await balanceOf(el.invoice_id!)).applied===50000n,'payment edit keeps applications and exposes additional advance')
 check((await projectAllocations(A.company.id,p)).find(x=>x.payment_id===ep)!.effective_date==='2026-10-09','edited payment date changes effective allocation date')
 await refuse(()=>editProjectFinancePayment(me,originalEdit),'STALE')
 const reduced=await editState(ep)
 await editProjectFinancePayment(me,{...reduced,amount:30000n,allocations:reduced.allocations.map(a=>({...a,amount:30000n}))})
 check((await balanceOf(el.invoice_id!)).applied===30000n&&(await projectPayments(A.company.id,{},p)).find(x=>x.id===ep)!.amount==='30000','payment and allocation reductions update both balances')
 const ep2=await createProject({entityId:A.company.id,currency:'CAD',code:'PF-SHARED',name:'Shared receipt',customerPartyId:customer.id,actor:me.email})
 await saveProjectFinanceRecord(me,{...revenue,projectId:ep2,key:randomUUID()})
 const sharedLink=(await projectFinanceLinks(A.company.id,ep2))[0]
 const shared=await recordPayment({invoiceId:el.invoice_id!,bankAccountId:acct('1000'),amount:25000n,paidOn:'2026-10-08',actor:me.email})
 const [sharedApp]=await db.execute<{id:string}>(q`SELECT id::text FROM invoice_application WHERE entry_id=${shared.entryId}::uuid`)
 await unapply(sharedApp.id,me.email)
 await applyEntryToInvoice({invoiceId:el.invoice_id!,entryId:shared.entryId,amount:20000n,actor:me.email})
 await applyEntryToInvoice({invoiceId:sharedLink.invoice_id!,entryId:shared.entryId,amount:5000n,actor:me.email})
 const sm=(await projectPayments(A.company.id,{},ep2))[0]
 const sharedEdit=await editState(sm.id,ep2)
 check(sharedEdit.amount===25000n&&sharedEdit.allocations.length===2,'shared payment edit shows full cash amount and all invoice applications')
 await editProjectFinancePayment(me,{...sharedEdit,date:'2026-10-10',amount:30000n,reference:'Shared corrected'})
 check((await balanceOf(el.invoice_id!)).applied===50000n&&(await balanceOf(sharedLink.invoice_id!)).applied===5000n,'shared receipt correction preserves other project allocation')
 check((await projectPayments(A.company.id,{},p)).find(x=>x.accounting_entry_id===shared.entryId)!.payment_date==='2026-10-10','shared correction updates every Project mirror date')
 const dc=await saveProjectFinanceRecord(me,{...cost,key:randomUUID(),paid:{date:base.date}}),dl=(await projectFinanceLinks(A.company.id,p)).find(x=>x.record_id===dc)!
 const paper=await saveAttachment({ledgerId:A.ledger.id,entryId:dl.expense_entry_id!,filename:'original-cost.pdf',mime:'application/pdf',bytes:Buffer.from('%PDF-1.4\nOriginal cost supporting paper\n%%EOF'),actor:me.email})
 const dp=(await projectAllocations(A.company.id,p)).find(x=>x.record_id===dc)!.payment_id
 await editProjectFinancePayment(me,{...await editState(dp),reference:'Bank reference only',note:'Corrected reference'})
 check((await projectFinanceLinks(A.company.id,p)).find(x=>x.record_id===dc)!.expense_entry_id===dl.expense_entry_id,'reference-only correction keeps paid cost as Expense')
 const dEdit=await editState(dp)
 await editProjectFinancePayment(me,{...dEdit,date:'2026-10-11',amount:5000n,controlAccountId:acct('2100'),allocations:dEdit.allocations.map(a=>({...a,amount:5000n}))})
 const converted=(await projectFinanceLinks(A.company.id,p)).find(x=>x.record_id===dc)!
 check(!!converted.invoice_id&&!converted.expense_entry_id&&(await balanceOf(converted.invoice_id!)).balance===6200n,'corrected paid cost becomes posted Bill plus partial Payment')
 check((await projectRecords(A.company.id,{},p)).find(x=>x.id===dc)!.gross==='11200'&&(await projectRecords(A.company.id,{},p)).find(x=>x.id===dc)!.record_date===base.date,'payment correction preserves original cost amount and recognition date')
 check(!(await db.execute(q`SELECT id FROM journal_entry WHERE id=${dl.expense_entry_id}::uuid`)).length,'conversion removes old Expense without duplicate expense recognition')
 check(!!await attachmentFile(A.ledger.id,paper.id),'conversion retains the original attachment and download binding')
 const legacyRecord=await saveProjectRecord({...base,kind:'revenue',partyId:customer.id,key:randomUUID(),lines:revenue.lines})
 const legacyPayment=await createProjectPayment({...receipt,recordId:legacyRecord,key:randomUUID()})
 await editProjectFinancePayment(projectOnly,{...await editState(legacyPayment),date:'2026-10-12',amount:55000n})
 check((await projectPayments(A.company.id,{},p)).find(x=>x.id===legacyPayment)!.unallocated==='5000','operational payment edits retain existing allocation without requiring accounting seat')
 const closedPayment=await editState(ep)
 await db.execute(q`UPDATE fiscal_period SET status='closed' WHERE ledger_id=${A.ledger.id}::uuid AND start_date='2026-10-01'`)
 await refuse(()=>saveProjectFinanceRecord(me,{...revenue,recordId:r,version:2,description:'Closed change'}),'PERIOD_CLOSED')
 await refuse(()=>editProjectFinancePayment(me,{...closedPayment,date:'2026-11-02',amount:35000n}),'PERIOD_CLOSED')
 check((await projectPayments(A.company.id,{},p)).find(x=>x.id===ep)!.amount==='30000'&&(await balanceOf(el.invoice_id!)).applied===50000n,'closed-period refusal rolls back payment and applications')
 check((await projectRecords(A.company.id,{},p)).find(x=>x.id===r)!.description==='Revised source','closed-period refusal rolls back source edits and allocation release')
 check((await balanceOf(link.invoice_id!)).applied===50000n&&(await projectRecords(A.company.id,{},p)).find(x=>x.id===r)!.settled==='50000','closed-period refusal preserves both existing payment allocations')
 const closedCount=(await projectRecords(A.company.id,{},p)).length
 await refuse(()=>saveProjectFinanceRecord(me,{...revenue,key:randomUUID()}),'PERIOD_CLOSED')
 check((await projectRecords(A.company.id,{},p)).length===closedCount,'direct posting in closed period leaves no source or draft behind')
 await db.execute(q`UPDATE fiscal_period SET status='open' WHERE ledger_id=${A.ledger.id}::uuid AND start_date='2026-10-01'`)
 const form=(amount:string,code:string,gst='',pst='')=>{const f=new FormData();f.set('date',base.date);f.append('lineKind','material');f.append('base',amount);f.set(lineTaxCode(0),code);f.set(lineGst(0),gst);f.set(linePst(0),pst);return f}
 const automatic=projectLines(form('200.00','GST_PST'),'cost')[0]
 check(automatic.base===20000n&&automatic.gst===1000n&&automatic.pst===1400n&&automatic.gstRecoverable===1000n&&automatic.pstRecoverable===0n,'tax code computes GST/PST and uses Expense recovery rules without user fields')
 const overridden=projectLines(form('200.00','GST_PST','9.99','14.01'),'cost')[0]
 check(overridden.gst===999n&&overridden.pst===1401n,'manual GST/PST overrides remain exact')
 const zero=projectLines(form('200.00','GST','0'),'cost')[0]
 check(zero.gst===0n&&zero.taxCode==='GST','explicit zero override keeps selected tax code')
 await refuse(async()=>projectLines(form('200.00','OUT_OF_SCOPE','5'),'cost'),'TAX')
 await refuse(async()=>projectLines(form('200.00','UNKNOWN'),'cost'),'TAX')
 const mixed=form('0','OUT_OF_SCOPE');mixed.append('lineKind','labor');mixed.append('base','100.00');mixed.set(lineTaxCode(1),'GST');
 check(projectLineRows(mixed,'cost')[0].index===1,'empty-row filtering preserves account mapping indexes')
 const described=form('100.00','OUT_OF_SCOPE');described.set('lineKind','revenue');described.append('lineDescription','  Design services  ')
 described.append('lineKind','revenue');described.append('base','0');described.set(lineTaxCode(1),'OUT_OF_SCOPE');described.append('lineDescription','Not billed')
 described.append('lineKind','revenue');described.append('base','200.00');described.set(lineTaxCode(2),'OUT_OF_SCOPE');described.append('lineDescription','Installation services')
 const describedRows=projectLineRows(described,'revenue')
 check(describedRows[0].line.description==='Design services'&&describedRows[1].line.description==='Installation services','each Revenue amount retains its own trimmed description')
 check(describedRows[0].index===0&&describedRows[1].index===2&&describedRows[0].line.base===10000n&&describedRows[1].line.base===20000n,'zero-row filtering preserves description, amount and source-position alignment')
 const incompleteDescriptions=new FormData();for(const [key,value] of described)if(key!=='lineDescription')incompleteDescriptions.append(key,value);incompleteDescriptions.append('lineDescription','Only one')
 await refuse(async()=>projectLineRows(incompleteDescriptions,'revenue'),'LINES')
 check(projectLines(form('100.00','OUT_OF_SCOPE'),'revenue')[0].description==='','older tax-code Revenue forms may omit the entire description array')
 const costDescription=form('100.00','OUT_OF_SCOPE');costDescription.append('lineDescription','Ignored by the existing Cost form')
 check(projectLines(costDescription,'cost')[0].description==='','Cost tax-code parsing keeps its existing description behavior')
 const legacy=new FormData();for(const [key,value] of Object.entries({date:base.date,lineKind:'revenue',lineDescription:'Legacy service',base:'12.34',gst:'0',pst:'0',gstRecoverable:'',pstRecoverable:''}))legacy.append(key,value)
 check(projectLines(legacy,'revenue')[0].description==='Legacy service','legacy explicit-tax form parsing still preserves its existing line description')
 const supplied=await saveProjectFinanceRecord(me,{...cost,description:'',reference:'VENDOR-001',lines:[automatic],key:randomUUID()}),sl=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===supplied)!
 const sd=(await invoiceDetail(sl.invoice_id!))!
 check(sd.invoice.status==='posted'&&sd.invoice.number==='VENDOR-001'&&sd.invoice.their_ref==='VENDOR-001','supplier invoice number takes precedence and purchase bill posts immediately')
 check((await projectRecords(A.company.id,{},p)).find(x=>x.id===supplied)!.description===''&&sd.invoice.note===null,'header description is optional in source and accounting invoice')
 check((await projectRecords(A.company.id,{},p)).find(x=>x.id===supplied)!.lines[0].taxCode==='GST_PST','tax code persists when reopening the source')
 const countBeforeDuplicate=(await projectRecords(A.company.id,{},p)).length
 await refuse(()=>saveProjectFinanceRecord(me,{...cost,description:'',reference:'VENDOR-001',lines:[automatic],key:randomUUID()}),'DUPLICATE_NUMBER')
 check((await projectRecords(A.company.id,{},p)).length===countBeforeDuplicate,'duplicate supplier invoice refuses and rolls back the source')
 const supplier2=await createParty({kind:'organisation',name:'Other Finance Supplier',actor:me.email,roles:[{entityId:A.company.id,role:'supplier',heldFrom:'2026-01-01'}]})
 const otherVendor=await saveProjectFinanceRecord(me,{...cost,partyId:supplier2.id,reference:'VENDOR-001',lines:[automatic],key:randomUUID()})
 check((await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===otherVendor)!.number==='VENDOR-001','different suppliers can use the same invoice number')
 await saveProjectFinanceRecord(me,{...cost,recordId:supplied,version:1,description:'',reference:'VENDOR-002',lines:[overridden]})
 check((await invoiceDetail(sl.invoice_id!))!.invoice.number==='VENDOR-002'&&(await projectRecords(A.company.id,{},p)).find(x=>x.id===supplied)!.gst==='999','source edit updates supplier number and overridden tax in posted bill')
 await saveProjectFinanceRecord(me,{...cost,recordId:supplied,version:2,description:'',reference:'',lines:[automatic]})
 check((await invoiceDetail(sl.invoice_id!))!.invoice.number!.startsWith('PF-001-B'),'blank supplier number falls back to generated project bill number')
 const blankExpense=await saveProjectFinanceRecord(me,{...cost,description:'',reference:'PAID-001',lines:[automatic],key:randomUUID(),paid:{date:base.date}}),bel=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===blankExpense)!
 check(!!bel.expense_entry_id&&(await db.execute<{description:string}>(q`SELECT description FROM journal_entry WHERE id=${bel.expense_entry_id}::uuid`))[0].description==='Project PF-001 cost','paid cost accepts empty description and posts a readable accounting entry')
 const bytes=await exportCompany(A.company.id),copy=await restoreCompany(bytes,me.email,{code:'PFCOPY',name:'Portable project finance'})
 const [copyProject]=await db.execute<{id:string}>(q`SELECT id::text FROM project WHERE entity_id=${copy.entityId}::uuid AND code='PF-001'`)
 const copiedLinks=await projectFinanceLinks(copy.entityId,copyProject.id)
 check(copiedLinks.length===(await projectFinanceLinks(A.company.id,p)).length&&copiedLinks.every(l=>l.ledger_id!==A.ledger.id),'company backup restores source documents, accounts and payment links into new company')
 check((await db.execute<{bad:number}>(q`SELECT count(*)::int AS bad FROM project_accounting_line m JOIN project_accounting_link h ON h.id=m.link_id JOIN account a ON a.id=m.account_id WHERE h.entity_id=${copy.entityId}::uuid AND a.entity_id<>h.entity_id`))[0].bad===0,'restored line accounts never point back to original company')
 check((await db.execute(q`SELECT id FROM project_accounting_application WHERE entity_id=${copy.entityId}::uuid`)).length>0,'backup includes accounting-to-Project payment applications')
 const deliveryLine={...automatic,kind:'delivery' as const}
 const deliveryBill=await saveProjectFinanceRecord(me,{...cost,description:'Delivery',reference:'DELIVERY-VENDOR-001',lines:[deliveryLine],key:randomUUID()})
 const deliveryLink=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===deliveryBill)!,deliveryDetail=(await invoiceDetail(deliveryLink.invoice_id!))!
 check(deliveryDetail.invoice.status==='posted'&&deliveryDetail.total===22400n&&(await projectRecords(A.company.id,{kind:'delivery'},p)).some(r=>r.id===deliveryBill),'unpaid Delivery saves as a posted supplier bill with unchanged exact taxes')
 const deliveryExpense=await saveProjectFinanceRecord(me,{...cost,description:'Paid delivery',lines:[deliveryLine],key:randomUUID(),paid:{date:base.date}})
 const deliveryExpenseLink=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===deliveryExpense)!
 check(!!deliveryExpenseLink.expense_entry_id&&(await db.execute<{status:string}>(q`SELECT status FROM journal_entry WHERE id=${deliveryExpenseLink.expense_entry_id}::uuid`))[0].status==='posted','paid Delivery posts directly to Expenses with no extra post step')
 const bindings=await projectCategoryAccounts(A.company.id)
 const expected={revenue:'8000',material:'8320',labor:'8340',subcontractor:'8360',janitorial:'8360',delivery:'8457',other:'8450'} as const
 check(Object.entries(expected).every(([k,code])=>bindings[k as keyof typeof expected]?.id===mappedId(code))&&Object.keys(bindings).length===7,'all seven Project categories bind to the six requested GIFI accounts')
 const costHierarchy=await db.execute<{code:string;parent_code:string|null;parent_postable:boolean|null}>(q`SELECT a.code,p.code AS parent_code,p.is_postable AS parent_postable FROM account a LEFT JOIN account p ON p.id=a.parent_id WHERE a.entity_id=${A.company.id}::uuid AND a.code IN ('8000','8320','8340','8360','8457','8450')`)
 check(costHierarchy.filter(a=>a.code!=='8000').every(a=>a.parent_code==='8518'&&a.parent_postable===false)&&costHierarchy.find(a=>a.code==='8000')!.parent_code===null,'all five direct-cost accounts sit under nonpostable Cost of sales 8518; Revenue stays outside the group')
 check(detail.lines[0].account_id===mappedId('8000'),'new revenue posts to 8000 regardless of a supplied 4000 account')
 const idsBefore=JSON.stringify(bindings)
 await Promise.all([ensureProjectAccounts(A.company.id,me.email),ensureProjectAccounts(A.company.id,me.email)])
 await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS})
 check(JSON.stringify(await projectCategoryAccounts(A.company.id))===idsBefore,'concurrent initialization and unchanged module activation reuse the same account IDs')
 await setCompanyModules(me,{entityId:B.company.id,modules:MODULE_PATHS})
 const bindingsB=await projectCategoryAccounts(B.company.id)
 check(Object.keys(bindingsB).length===7&&bindingsB.revenue!.id!==bindings.revenue!.id&&bindingsB.material!.id!==bindings.material!.id,'same GIFI codes in different companies have independent account bindings')
 const reuse=await createCompany({code:'PFREUSE',name:'Reuse a custom Project account'},me.email)
 const [existingMaterial]=await importAccounts(reuse.company.id,[{entityId:reuse.company.id,code:'8320',name:'My materials',accountType:'expense',roles:['raw_materials_and_consumables','fn_cost_of_sales']}],me.email)
 await setCompanyModules(me,{entityId:reuse.company.id,modules:MODULE_PATHS.filter(m=>m!=='/projects')})
 check(Object.keys(await projectCategoryAccounts(reuse.company.id)).length===0,'disabled Project creates no category accounts')
 await setCompanyModules(me,{entityId:reuse.company.id,modules:MODULE_PATHS})
 check((await projectCategoryAccounts(reuse.company.id)).material!.id===existingMaterial.id&&(await db.execute<{name:string}>(q`SELECT name FROM account WHERE id=${existingMaterial.id}::uuid`))[0].name==='My materials','activation reuses an existing compatible GIFI account without renaming it')
 const [customGroup]=await importAccounts(reuse.company.id,[{entityId:reuse.company.id,code:'5999',name:'Existing company cost group',accountType:'expense',isPostable:false}],me.email)
 await actingAs(me.email,tx=>tx.execute(q`UPDATE account SET parent_id=${customGroup.id}::uuid WHERE id=${existingMaterial.id}::uuid`))
 await ensureProjectAccounts(reuse.company.id,me.email)
 check((await db.execute<{parent_id:string}>(q`SELECT parent_id::text FROM account WHERE id=${existingMaterial.id}::uuid`))[0].parent_id===customGroup.id,'initialization preserves an existing custom cost parent instead of regrouping it')
 const parentReuse=await createCompany({code:'PFPARENT',name:'Reuse a cost heading'},me.email)
 const [existingHeading]=await importAccounts(parentReuse.company.id,[{entityId:parentReuse.company.id,code:'8518',name:'My cost of sales',accountType:'expense',isPostable:false}],me.email)
 await setCompanyModules(me,{entityId:parentReuse.company.id,modules:MODULE_PATHS})
 check((await db.execute<{name:string;children:number}>(q`SELECT a.name,(SELECT count(*)::int FROM account WHERE parent_id=a.id) AS children FROM account a WHERE a.id=${existingHeading.id}::uuid`))[0].children===5&&(await db.execute<{name:string}>(q`SELECT name FROM account WHERE id=${existingHeading.id}::uuid`))[0].name==='My cost of sales','a compatible existing 8518 heading is reused with exactly five child accounts and its name preserved')
 const parentConflict=await createCompany({code:'PFPARENTBAD',name:'Conflicting cost heading'},me.email)
 await setCompanyModules(me,{entityId:parentConflict.company.id,modules:MODULE_PATHS.filter(m=>m!=='/projects')})
 await importAccounts(parentConflict.company.id,[{entityId:parentConflict.company.id,code:'8518',name:'Unrelated asset',accountType:'asset'}],me.email)
 const parentConflictBefore=await db.execute(q`SELECT to_jsonb(a)::text AS row FROM account a WHERE entity_id=${parentConflict.company.id}::uuid ORDER BY id`)
 await refuse(()=>setCompanyModules(me,{entityId:parentConflict.company.id,modules:MODULE_PATHS}),'ACCOUNT_SETUP')
 check(JSON.stringify(await db.execute(q`SELECT to_jsonb(a)::text AS row FROM account a WHERE entity_id=${parentConflict.company.id}::uuid ORDER BY id`))===JSON.stringify(parentConflictBefore)&&!(await companyModulePolicies())[parentConflict.company.id].includes('/projects')&&Object.keys(await projectCategoryAccounts(parentConflict.company.id)).length===0,'8518 type conflict rolls back activation, mappings and all newly provisioned child accounts')
 const conflict=await createCompany({code:'PFCONFLICT',name:'Conflicting GIFI chart'},me.email)
 await setCompanyModules(me,{entityId:conflict.company.id,modules:MODULE_PATHS.filter(m=>m!=='/projects')})
 await importAccounts(conflict.company.id,[{entityId:conflict.company.id,code:'8320',name:'A different asset',accountType:'asset'}],me.email)
 const conflictBefore=await db.execute(q`SELECT to_jsonb(a)::text AS row FROM account a WHERE entity_id=${conflict.company.id}::uuid ORDER BY id`)
 await refuse(()=>setCompanyModules(me,{entityId:conflict.company.id,modules:MODULE_PATHS}),'ACCOUNT_SETUP')
 check(!(await companyModulePolicies())[conflict.company.id].includes('/projects')&&JSON.stringify(await db.execute(q`SELECT to_jsonb(a)::text AS row FROM account a WHERE entity_id=${conflict.company.id}::uuid ORDER BY id`))===JSON.stringify(conflictBefore)&&Object.keys(await projectCategoryAccounts(conflict.company.id)).length===0,'incompatible account rolls activation and all newly provisioned accounts back together')
 await refuse(()=>actingAs(me.email,tx=>tx.execute(q`UPDATE project_category_account SET account_id=${bindingsB.material!.id}::uuid WHERE entity_id=${A.company.id}::uuid AND category='material'`)),'PROJECT_ACCOUNT_SCOPE')
 const kinds=['material','labor','subcontractor','janitorial','delivery','other'] as const
 const mixedLines=kinds.map((kind,i)=>({kind,description:'',base:BigInt((i+1)*100),gst:0n,pst:0n,gstRecoverable:0n,pstRecoverable:0n}))
 const mixedBill=await saveProjectFinanceRecord(me,{...cost,accountIds:undefined,lines:mixedLines,key:randomUUID()})
 const mixedLink=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===mixedBill)!
 const mixedDetail=(await invoiceDetail(mixedLink.invoice_id!))!
 check(mixedDetail.lines.length===6&&mixedDetail.lines.every((l,i)=>l.account_id===bindings[kinds[i]]!.id&&l.amount===BigInt((i+1)*100)),'mixed unpaid categories post the exact amount to each automatic account with no account inputs')
 const mixedPaid=await saveProjectFinanceRecord(me,{...cost,accountIds:undefined,lines:mixedLines,key:randomUUID(),paid:{date:base.date}})
 const mixedPaidLink=(await projectFinanceLinks(A.company.id,p)).find(l=>l.record_id===mixedPaid)!
 const journal=await db.execute<{code:string;amount:string}>(q`SELECT a.code,sum(l.amount)::text AS amount FROM journal_line l JOIN account a ON a.id=l.account_id WHERE l.entry_id=${mixedPaidLink.expense_entry_id}::uuid GROUP BY a.code`)
 check(journal.find(l=>l.code==='8340')?.amount==='200'&&journal.find(l=>l.code==='8360')?.amount==='700'&&journal.find(l=>l.code==='8457')?.amount==='500'&&journal.find(l=>l.code==='1000')?.amount==='-2100','paid mixed costs post labour separately and combine subcontractor and Janitorial amounts at 8360')
 await saveProjectFinanceRecord(me,{...cost,recordId:mixedBill,version:1,accountIds:undefined,originalPositions:[1,2,3,4,5,6],lines:[{...mixedLines[0],kind:'delivery'},...mixedLines.slice(1)]})
 check((await invoiceDetail(mixedLink.invoice_id!))!.lines[0].account_id===bindings.delivery!.id,'changing a cost category changes its accounting line to the new category binding')
 // Construct a consistent pre-feature bill using the ordinary accounting
 // doors, then attach its historical mappings exactly as the old workflow did.
 const oldLines=[{...mixedLines[0],base:1000n},{...mixedLines[0],base:2000n}]
 const oldRecord=await saveProjectRecord({...cost,lines:oldLines,key:randomUUID()})
 const oldBill=await createInvoice({ledgerId:A.ledger.id,direction:'purchase',partyId:supplier.id,number:'HISTORICAL-MAPPING',controlAccountId:acct('2100'),issuedOn:base.date,dueOn:base.date,actor:me.email,lines:[{accountId:acct('5100'),amount:1000n},{accountId:acct('5200'),amount:2000n}]})
 await postInvoice(oldBill.id,me.email)
 await actingAs(me.email,async tx=>{
  const [h]=await tx.execute<{id:string}>(q`INSERT INTO project_accounting_link(entity_id,project_id,record_id,ledger_id,invoice_id,control_account_id,mapping_hash,created_by) VALUES(${A.company.id}::uuid,${p}::uuid,${oldRecord}::uuid,${A.ledger.id}::uuid,${oldBill.id}::uuid,${acct('2100')}::uuid,'historical',${me.email}) RETURNING id::text`)
  for(const [i,id] of [acct('5100'),acct('5200')].entries())await tx.execute(q`INSERT INTO project_accounting_line(entity_id,link_id,position,account_id) VALUES(${A.company.id}::uuid,${h.id}::uuid,${i+1},${id}::uuid)`)
 })
 await saveProjectFinanceRecord(me,{...cost,recordId:oldRecord,version:1,accountIds:undefined,originalPositions:[1,2],description:'Description-only correction',lines:oldLines})
 check((await invoiceDetail(oldBill.id))!.lines.every((l,i)=>l.account_id===[acct('5100'),acct('5200')][i]),'ordinary edits preserve the accounts on historical posted lines')
 await saveProjectFinanceRecord(me,{...cost,recordId:oldRecord,version:2,accountIds:undefined,originalPositions:[2],lines:[oldLines[1]]})
 check((await invoiceDetail(oldBill.id))!.lines[0].account_id===acct('5200')&&(await invoiceDetail(oldBill.id))!.total===2000n,'removing the first row preserves the remaining historical row account by source position')
 await refuse(()=>saveProjectFinanceRecord(me,{...cost,recordId:oldRecord,version:3,originalPositions:[1,1],lines:oldLines}),'STALE_LINES')
 check((await invoiceDetail(oldBill.id))!.total===2000n,'invalid duplicate source positions leave the posted bill unchanged')
 const newCopy=await restoreCompany(await exportCompany(A.company.id),me.email,{code:'PFMAPCOPY',name:'Copied category mappings'})
 const copiedBindings=await projectCategoryAccounts(newCopy.entityId)
 check(Object.keys(copiedBindings).length===7&&Object.values(copiedBindings).every(a=>!Object.values(bindings).some(b=>b.id===a.id)),'company export and restore remap every category binding to copied company accounts')
 check((await db.execute<{children:number}>(q`SELECT count(*)::int AS children FROM account a JOIN account p ON p.id=a.parent_id WHERE a.entity_id=${newCopy.entityId}::uuid AND p.entity_id=a.entity_id AND p.code='8518'`))[0].children===5,'portable restore retains all five cost children under the copied company’s 8518 heading')
 // Tax setup is mandatory for a selected code, even with a zero override.
 const nt=await createCompanyWithYear({code:'PFNOTAX',name:'Project without tax accounts'},me.email)
 const ntAccounts=await importAccounts(nt.company.id,parseAccountsCsv('1000,Bank,asset,,cash_and_cash_equivalents\n1200,Receivables,asset,,trade_receivables\n2100,Payables,liability,,trade_payables').map(r=>({...r,entityId:nt.company.id})),me.email)
 await setCompanyModules(me,{entityId:nt.company.id,modules:MODULE_PATHS})
 const ntId=(code:string)=>ntAccounts.find(a=>a.code===code)!.id
 const ntParty=await createParty({kind:'organisation',name:'No-tax counterparty',actor:me.email,roles:[{entityId:nt.company.id,role:'customer',heldFrom:'2026-01-01'},{entityId:nt.company.id,role:'supplier',heldFrom:'2026-01-01'}]})
 const ntProject=await createProject({entityId:nt.company.id,currency:'CAD',code:'PF-NOTAX',name:'Tax validation',customerPartyId:ntParty.id,actor:me.email})
 const ntBase={entityId:nt.company.id,ledgerId:nt.ledger.id,projectId:ntProject,actor:me.email,date:base.date,description:'',partyId:ntParty.id,key:randomUUID()}
 const ntRevenue={...ntBase,kind:'revenue' as const,controlAccountId:ntId('1200'),lines:[{kind:'revenue' as const,description:'',base:10000n,gst:0n,pst:0n,gstRecoverable:null,pstRecoverable:null,taxCode:'OUT_OF_SCOPE' as const}]}
 const ntCost={...ntBase,kind:'cost' as const,controlAccountId:ntId('2100'),lines:[{kind:'material' as const,description:'',base:10000n,gst:0n,pst:0n,gstRecoverable:0n,pstRecoverable:0n,taxCode:'OUT_OF_SCOPE' as const}]}
 await saveProjectFinanceRecord(me,ntRevenue)
 await saveProjectFinanceRecord(me,{...ntCost,key:randomUUID()})
 check((await db.execute(q`SELECT a.id FROM account a JOIN account_role r ON r.account_id=a.id WHERE a.entity_id=${nt.company.id}::uuid AND r.role IN ('gst_hst_payable','gst_hst_recoverable','qst_pst_payable','qst_pst_recoverable')`)).length===0,'Project setup creates no tax accounts; out-of-scope sales and costs post without tax setup')
 const taxRefusal=async(input:Parameters<typeof saveProjectFinanceRecord>[1],message:string)=>{
  try {await saveProjectFinanceRecord(me,{...input,key:randomUUID()})}
  catch(e){check((e as {code?:string}).code==='TAX_ACCOUNT'&&(e as Error).message.includes(message),'tax refusal explains '+message);return}
  throw Error('Expected TAX_ACCOUNT: '+message)
 }
 const financialCounts=()=>db.execute(q`SELECT (SELECT count(*) FROM project_record WHERE entity_id=${nt.company.id}::uuid)::int AS sources,(SELECT count(*) FROM invoice WHERE entity_id=${nt.company.id}::uuid)::int AS invoices,(SELECT count(*) FROM journal_entry WHERE ledger_id=${nt.ledger.id}::uuid)::int AS entries`)
 const beforeTaxFailures=await financialCounts()
 await taxRefusal({...ntRevenue,gstAccountId:acct('2200'),lines:[{...ntRevenue.lines[0],taxCode:'GST'}]},'GST/HST payable')
 await taxRefusal({...ntCost,gstAccountId:acct('1300'),lines:[{...ntCost.lines[0],taxCode:'GST'}]},'GST/HST recoverable')
 await taxRefusal({...ntRevenue,pstAccountId:acct('2300'),lines:[{...ntRevenue.lines[0],taxCode:'PST'}]},'PST/QST payable')
 await taxRefusal({...ntCost,pstAccountId:acct('1400'),lines:[{...ntCost.lines[0],taxCode:'PST'}]},'PST/QST')
 check(JSON.stringify(await financialCounts())===JSON.stringify(beforeTaxFailures),'missing tax accounts and forged foreign overrides leave sources, invoices and journals unchanged')
 const ntTax=await importAccounts(nt.company.id,parseAccountsCsv('2200,GST payable,liability,,gst_hst_payable\n2300,PST payable,liability,,qst_pst_payable').map(r=>({...r,entityId:nt.company.id})),me.email)
 const ntTaxId=(code:string)=>ntTax.find(a=>a.code===code)!.id
 const ntSale=await saveProjectFinanceRecord(me,{...ntRevenue,key:randomUUID(),gstAccountId:acct('2200'),pstAccountId:acct('2300'),lines:[{...ntRevenue.lines[0],taxCode:'GST_PST',gst:500n,pst:700n}]})
 const ntSaleLink=(await projectFinanceLinks(nt.company.id,ntProject)).find(l=>l.record_id===ntSale)!
 const ntSaleDetail=(await invoiceDetail(ntSaleLink.invoice_id!))!
 check(ntSaleDetail.invoice.status==='posted'&&ntSaleDetail.lines.some(l=>l.account_id===ntTaxId('2200')&&l.amount===-500n)&&ntSaleDetail.lines.some(l=>l.account_id===ntTaxId('2300')&&l.amount===-700n),'sales taxes automatically post to this company’s payable accounts and ignore foreign client IDs')
 await taxRefusal({...ntCost,lines:[{...ntCost.lines[0],taxCode:'GST',gst:500n,gstRecoverable:500n}]},'GST/HST recoverable')
 const ntPstCost=await saveProjectFinanceRecord(me,{...ntCost,key:randomUUID(),lines:[{...ntCost.lines[0],taxCode:'PST',pst:700n}]})
 const ntPstLink=(await projectFinanceLinks(nt.company.id,ntProject)).find(l=>l.record_id===ntPstCost)!
 const ntPstDetail=(await invoiceDetail(ntPstLink.invoice_id!))!
 check(ntPstDetail.lines.length===1&&ntPstDetail.lines[0].amount===10700n&&ntPstDetail.total===10700n,'PST setup is required but nonrecoverable cost PST stays in the item cost without a recoverable tax line')
 const [ntGstRecovery]=await importAccounts(nt.company.id,[{entityId:nt.company.id,code:'1300',name:'GST recoverable',accountType:'asset',roles:['gst_hst_recoverable']}],me.email)
 const gstCostLines=[{...ntCost.lines[0],taxCode:'GST' as const,gst:500n,gstRecoverable:500n}]
 const ntGstCost=await saveProjectFinanceRecord(me,{...ntCost,key:randomUUID(),lines:gstCostLines})
 const ntGstLink=(await projectFinanceLinks(nt.company.id,ntProject)).find(l=>l.record_id===ntGstCost)!
 check((await invoiceDetail(ntGstLink.invoice_id!))!.lines.some(l=>l.account_id===ntGstRecovery.id&&l.amount===500n),'cost GST automatically uses the company’s recoverable account')
 await actingAs(me.email,tx=>tx.execute(q`UPDATE account SET is_active=false WHERE id=${ntGstRecovery.id}::uuid`))
 await taxRefusal({...ntCost,lines:[{...ntCost.lines[0],taxCode:'GST'}]},'GST/HST recoverable')
 await actingAs(me.email,tx=>tx.execute(q`UPDATE account SET is_active=true WHERE id=${ntGstRecovery.id}::uuid`))
 await importAccounts(nt.company.id,[{entityId:nt.company.id,code:'1310',name:'Second GST recoverable',accountType:'asset',roles:['gst_hst_recoverable']}],me.email)
 await taxRefusal({...ntCost,lines:gstCostLines},'more than one GST/HST recoverable')
 await saveProjectFinanceRecord(me,{...ntCost,recordId:ntGstCost,version:1,lines:gstCostLines})
 check((await invoiceDetail(ntGstLink.invoice_id!))!.lines.some(l=>l.account_id===ntGstRecovery.id&&l.amount===500n),'a saved eligible tax binding is preserved when later setup has multiple accounts')
 const [canonicalRecovery]=await importAccounts(nt.company.id,[{entityId:nt.company.id,code:'1066',name:'Default GST recoverable',accountType:'asset',roles:['gst_hst_recoverable']}],me.email)
 const canonicalCost=await saveProjectFinanceRecord(me,{...ntCost,key:randomUUID(),lines:gstCostLines})
 const canonicalLink=(await projectFinanceLinks(nt.company.id,ntProject)).find(l=>l.record_id===canonicalCost)!
 check((await invoiceDetail(canonicalLink.invoice_id!))!.lines.some(l=>l.account_id===canonicalRecovery.id&&l.amount===500n),'the established tax default resolves a new record when multiple eligible accounts exist')
 // Stage prose belongs only to the invoice paper snapshot.
 const stages='Deposit: 30% on confirmation\nProgress payment: 40% after stage 1\nFinal payment: 30% on completion'
 const paperInput={...ntRevenue,key:randomUUID(),description:'Paper-only project work',paymentStages:stages}
 const plainRecord=await saveProjectFinanceRecord(me,{...ntRevenue,key:randomUUID(),description:paperInput.description})
 const paperRecord=await saveProjectFinanceRecord(me,paperInput)
 const paperLinks=await projectFinanceLinks(nt.company.id,ntProject)
 const plainInvoice=(await invoiceDetail(paperLinks.find(l=>l.record_id===plainRecord)!.invoice_id!))!
 const paperLink=paperLinks.find(l=>l.record_id===paperRecord)!,paperInvoice=(await invoiceDetail(paperLink.invoice_id!))!
 check(paperInvoice.invoice.print_template_snapshot?.paymentStages===stages&&paperLink.payment_stages===stages,'payment stages are stored and read only from the invoice paper snapshot')
 check(!('paymentStages' in plainInvoice.invoice.print_template_snapshot!)&&JSON.stringify(plainInvoice.invoice.print_template_snapshot!.settings)===JSON.stringify(paperInvoice.invoice.print_template_snapshot!.settings),'old no-stage snapshot shape and shared template settings remain unchanged')
 check(paperInvoice.total===plainInvoice.total&&paperInvoice.invoice.due_on===plainInvoice.invoice.due_on&&paperInvoice.invoice.note===paperInput.description&&paperInvoice.lines.every(l=>!l.description?.includes('Deposit:')),'stage prose does not alter totals, due date, private note or financial line descriptions')
 const paperNumbers=(id:string)=>db.execute(q`SELECT line_no,account_id::text,amount::text,party_id::text FROM journal_line WHERE entry_id=${id}::uuid ORDER BY line_no`)
 check(JSON.stringify(await paperNumbers(plainInvoice.invoice.entry_id!))===JSON.stringify(await paperNumbers(paperInvoice.invoice.entry_id!)),'equivalent inputs with and without paper stages produce identical journal amounts, accounts and parties')
 check((await db.execute<{description:string|null}>(q`SELECT description FROM journal_entry WHERE id=${paperInvoice.invoice.entry_id}::uuid UNION ALL SELECT description FROM journal_line WHERE entry_id=${paperInvoice.invoice.entry_id}::uuid`)).every(l=>!l.description?.includes('Deposit:')),'stage text never enters journal descriptions')
 check(await saveProjectFinanceRecord(me,{...paperInput,paymentStages:'  '+stages+'  '})===paperRecord,'same-key retry with normalized paper prose posts once')
 await refuse(()=>saveProjectFinanceRecord(me,{...paperInput,paymentStages:stages+' changed'}),'REPLAY')
 await refuse(()=>saveProjectFinanceRecord(me,{...paperInput,paymentStages:undefined}),'REPLAY')
 await saveProjectFinanceRecord(me,{...paperInput,recordId:paperRecord,version:1,paymentStages:undefined})
 check(await saveProjectFinanceRecord(me,paperInput)===paperRecord,'ordinary financial edits retain the saved paper text in the create-retry identity')
 await saveProjectFinancePayment(me,{entityId:nt.company.id,ledgerId:nt.ledger.id,projectId:ntProject,actor:me.email,partyId:ntParty.id,direction:'received',date:base.date,amount:3000n,recordId:paperRecord,bankAccountId:ntId('1000'),key:randomUUID()})
 check((await balanceOf(paperInvoice.invoice.id)).balance===7000n,'actual receipt alone reduces the balance; stage percentages have no financial effect')
 const paperState=()=>db.execute<{state:string}>(q`SELECT jsonb_build_object('invoice',to_jsonb(i),'entry',(SELECT to_jsonb(j) FROM journal_entry j WHERE j.id=i.entry_id),'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_no) FROM journal_line l WHERE l.entry_id=i.entry_id),'applications',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM invoice_application a WHERE a.invoice_id=i.id))::text AS state FROM invoice i WHERE i.id=${paperInvoice.invoice.id}::uuid`)
 const paperBefore=JSON.stringify(await paperState()),countsBefore=JSON.stringify(await financialCounts())
 await refuse(()=>saveProjectFinanceRecord(me,{...paperInput,key:randomUUID(),paymentStages:'x'.repeat(4001)}),'PAYMENT_STAGES')
 await refuse(()=>saveProjectFinanceRecord(me,{...ntCost,key:randomUUID(),paymentStages:stages}),'PAYMENT_STAGES')
 check(JSON.stringify(await paperState())===paperBefore&&JSON.stringify(await financialCounts())===countsBefore,'invalid length and cost submissions leave invoices, journals and existing receipt applications byte-equivalent')
 await refuse(()=>actingAs(me.email,async tx=>{await tx.execute(q`SELECT set_config('erp.project_write','on',true),set_config('erp.open_edit','on',true)`);await tx.execute(q`UPDATE invoice SET print_template_snapshot=jsonb_set(print_template_snapshot,'{paymentStages}','"changed"'::jsonb) WHERE id=${paperInvoice.invoice.id}::uuid`)}),'TEMPLATE_SNAPSHOT_FROZEN')
 check(JSON.stringify(await paperState())===paperBefore,'existing posted-paper database guard remains intact')
 const paperCopy=await restoreCompany(await exportCompany(nt.company.id),me.email,{code:'PFPAPERCP',name:'Copied paper-only stages'})
 check((await db.execute<{stages:string}>(q`SELECT print_template_snapshot->>'paymentStages' AS stages FROM invoice WHERE entity_id=${paperCopy.entityId}::uuid AND print_template_snapshot->>'paymentStages' IS NOT NULL`))[0].stages===stages,'company backup and restore retain the optional paper prose without a format migration')
 console.log(`Project finance checks passed: ${checks}`)
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>sql.end())

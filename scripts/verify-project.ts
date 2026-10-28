/** Project integration suite. Never resets or drops a database. Requires an
 * explicitly separate local *_test database, already migrated. */
import './env'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import ExcelJS from 'exceljs'
import { db, sql as connection } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { createFirstOwner, createUser } from '../src/lib/users'
import { createParty } from '../src/lib/parties'
import { setGrantMatrix, refuseForLedger } from '../src/lib/access'
import { archiveCompany, companyById, unarchiveCompany, deleteCompany } from '../src/lib/companies'
import { createProject, updateProject, setProjectDeleted, saveProjectRecord, createProjectPayment, allocateProjectPayment, voidProjectItem, projectSummaries, projectRecords, projectPayments, projectProfit, projectHead, projectParties, projectCostTotals, ProjectError, type ProjectLine } from '../src/lib/project'
import { projectAccountingGroups, projectAccountingTotal, projectSheetSummary, projectProfitBasis, projectAccountingProfit, projectRecordType } from '../src/lib/project-accounting'
import { createProjectPartyFromForm } from '../src/lib/project-party'
import { projectLines } from '../src/lib/project-forms'
import { attachProjectFile, detachProjectFile, projectAttachments, projectStorageRoot, readProjectBlob } from '../src/lib/project-attachments'
import { exportCompany, packFigtree, readFigtree, inspectFigtree, restoreCompany, restorePaper } from '../src/lib/backup'
import { projectExport } from '../src/lib/project-export'

let checks=0
const verify=(ok:unknown,label:string)=>{assert.ok(ok,label);checks++;console.log(`PASS P${checks} ${label}`)}
async function refused(work:()=>Promise<unknown>,code?:string) {try{await work();return false}catch(e){return code?e instanceof ProjectError&&e.code===code:true}}
async function glSnapshot() {
  const results=[]
  for(const t of ['journal_entry','journal_line','invoice','invoice_line','bank_transaction','pay_run','pay_stub','entity_tax_registration']) {
    const [r]=await db.execute<{rows:unknown}>(sql`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${sql.raw(t)} t`);results.push([t,r.rows])
  }
  return JSON.stringify(results)
}
async function main() {
  const test=process.env.TEST_DATABASE_URL,live=process.env.APP_DATABASE_URL
  if(!test||!live)throw Error('Both explicit test and application database identities are required.')
  const t=new URL(test),a=new URL(live)
  if(!t.pathname.endsWith('_test')||!['localhost','127.0.0.1','[::1]'].includes(t.hostname)||(t.host===a.host&&t.pathname===a.pathname))throw Error('Project verification refused: database isolation is not proven.')
  const [identity]=await db.execute<{name:string}>(sql`SELECT current_database() AS name`)
  assert.equal(identity.name,t.pathname.slice(1))
  const root=await projectStorageRoot();await fs.mkdir(root,{recursive:true})
  verify(root!==path.resolve(process.env.ATTACHMENTS_DIR||'attachments'),'separate test database and independent file root verified before writes')
  const actor='project-owner@example.test',suffix=randomUUID().slice(0,8)
  const [existing]=await db.execute<{id:string}>(sql`SELECT id::text FROM app_user WHERE is_owner ORDER BY created_at LIMIT 1`)
  if(!existing)await createFirstOwner({email:actor,firstName:'Project Tester',password:'project test password only'})
  const user=await createUser({email:`project-${suffix}@example.test`,firstName:'Project only',password:'project seat test only',actor})
  const A=await createCompanyWithYear({code:`PRA${suffix}`,name:`Project Alpha Test ${suffix}`},actor)
  const B=await createCompanyWithYear({code:`PRB${suffix}`,name:`Project Beta Test ${suffix}`},actor)
  // These fixtures intentionally exercise Project, which is opt-in per company.
  for(const c of [A,B])await db.execute(sql`INSERT INTO company_module_access(entity_id,module,enabled,updated_by)
    VALUES(${c.company.id}::uuid,'/projects',true,${actor})`)
  const entityId=A.company.id,ledgerId=A.ledger.id
  const customer=await createParty({kind:'organisation',name:`Project customer ${suffix}`,actor,roles:[{entityId,role:'customer',heldFrom:'2026-01-01'},{entityId:B.company.id,role:'customer',heldFrom:'2026-01-01'}]})
  const supplier=await createParty({kind:'organisation',name:`Material supplier ${suffix}`,actor,roles:[{entityId,role:'supplier',heldFrom:'2026-01-01'}]})
  const labor=await createParty({kind:'organisation',name:`Labor provider ${suffix}`,actor,roles:[{entityId,role:'supplier',heldFrom:'2026-01-01'}]})
  const foreign=await createParty({kind:'organisation',name:`Other company vendor ${suffix}`,actor,roles:[{entityId:B.company.id,role:'supplier',heldFrom:'2026-01-01'}]})
  await setGrantMatrix({userId:user.id,actor,grants:[{entityId,module:'/projects'}]})
  verify(await refuseForLedger(user,ledgerId,'/projects')===null&&(await refuseForLedger(user,ledgerId,'/entries'))?.code==='NO_MODULE'&&(await refuseForLedger(user,B.ledger.id,'/projects'))!==null,'Project seat is scoped to one company and grants no GL access')
  const glBefore=await glSnapshot()
  const projectId=await createProject({entityId,currency:'CAD',code:'SITE-01',name:'Workshop renovation',customerPartyId:customer.id,site:'Synthetic test site',startDate:'2026-01-01',actor})
  const other=await createProject({entityId:B.company.id,currency:'CAD',code:'SITE-B',name:'Second company project',customerPartyId:customer.id,actor})
  const base={entityId,projectId,actor}
  const line=(kind:ProjectLine['kind'],amount:bigint,gst=0n,pst=0n,recoverGST:bigint|null=0n,recoverPST:bigint|null=0n)=>({kind,description:kind,base:amount,gst,pst,gstRecoverable:recoverGST,pstRecoverable:recoverPST})
  const revenueInput={...base,partyId:customer.id,kind:'revenue' as const,date:'2026-01-10',description:'Customer contract revenue',lines:[line('revenue',2000000n,100000n)],key:randomUUID()}
  const revenue=await saveProjectRecord(revenueInput)
  const materialInput={...base,partyId:supplier.id,kind:'cost' as const,date:'2026-01-12',description:'Construction material',lines:[line('material',600000n,30000n,42000n,30000n,0n)],key:randomUUID()}
  const material=await saveProjectRecord(materialInput)
  const laborRecord=await saveProjectRecord({...base,partyId:labor.id,kind:'cost',date:'2026-01-15',description:'Installation labor',lines:[line('labor',400000n,20000n,0n,20000n)],key:randomUUID()})
  await createProjectPayment({...base,partyId:customer.id,direction:'received',date:'2026-01-20',amount:1050000n,key:randomUUID(),recordId:revenue})
  await createProjectPayment({...base,partyId:supplier.id,direction:'paid',date:'2026-01-21',amount:336000n,key:randomUUID(),recordId:material})
  await createProjectPayment({...base,partyId:labor.id,direction:'paid',date:'2026-01-22',amount:420000n,key:randomUUID(),recordId:laborRecord})
  const summary=()=>projectSummaries(entityId,{},projectId).then(x=>x[0])
  let p=await summary();const profit=projectProfit(p)
  verify(profit.before===1000000n&&profit.adjusted===958000n&&profit.cash===294000n,'confirmed fixture: pretax 10,000; adjusted 9,580; cash 2,940')
  verify(p.receivable==='1050000'&&p.payable==='336000'&&p.pending_tax==='0','receivable 10,500 and payable 3,360 include GST/PST')
  verify((await projectRecords(entityId,{settlement:'partial'},projectId)).length===2&&(await projectRecords(entityId,{settlement:'paid'},projectId)).length===1,'unpaid / partial / paid status is derived from allocations')
  await saveProjectRecord({...materialInput,recordId:material,version:1,lines:[line('material',600000n,30000n,42000n,null,0n)]})
  p=await summary();verify(p.pending_tax==='30000'&&p.nonrecoverable==='42000'&&projectProfit(p).adjusted===null,'unconfirmed GST leaves adjusted profit pending without hiding pretax or cash')
  verify((await projectRecords(entityId,{tax:'pending'},projectId)).length===1,'pending-tax filter locates the unconfirmed cost record')
  await saveProjectRecord({...materialInput,recordId:material,version:2})
  const advanceInput={...base,partyId:customer.id,direction:'received' as const,date:'2026-02-01',amount:100000n,key:randomUUID()}
  const advance=await createProjectPayment(advanceInput)
  p=await summary();verify(projectProfit(p).cash===394000n&&projectProfit(p).before===1000000n&&p.customer_advance==='100000'&&p.receivable==='1050000','advance changes cash only; revenue and receivable are unchanged')
  verify(await createProjectPayment(advanceInput)===advance,'identical payment retry is idempotent')
  verify(await refused(()=>createProjectPayment({...advanceInput,date:'2026-02-02'}),'REPLAY'),'same key with a different date is refused')
  verify(await saveProjectRecord(revenueInput)===revenue,'identical revenue retry is idempotent')
  verify(await refused(()=>saveProjectRecord({...revenueInput,description:'Changed retry'}),'REPLAY'),'same record key with different content is refused')
  const allocationInput={...base,paymentId:advance,recordId:revenue,amount:50000n,key:randomUUID()}
  const allocation=await allocateProjectPayment(allocationInput)
  verify(await allocateProjectPayment(allocationInput)===allocation,'allocation retry does not settle twice')
  verify(await refused(()=>allocateProjectPayment({...allocationInput,amount:50001n}),'REPLAY'),'allocation key cannot be reused for different money')
  const period=(await projectSummaries(entityId,{from:'2026-02-01',to:'2026-02-28'},projectId))[0]
  verify(period.revenue==='0'&&period.material==='0'&&period.received==='100000'&&period.receivable==='1000000','period cash uses payment date; as-of receivable retains January records')
  const january=(await projectSummaries(entityId,{to:'2026-01-31'},projectId))[0]
  verify(january.receivable==='1050000'&&january.customer_advance==='0'&&projectProfit(january).cash===294000n,'as-of date excludes later payments and allocations')
  verify((await projectSummaries(entityId,{supplier:supplier.id}))[0].labor==='400000'&&(await projectRecords(entityId,{supplier:supplier.id},projectId)).length===1,'supplier filter narrows detail while profit retains all direct costs')
  const filtered=projectCostTotals(await projectRecords(entityId,{supplier:supplier.id},projectId))
  verify(filtered.material===600000n&&filtered.labor===0n&&filtered.nonrecoverPST===42000n,'filtered direct-cost totals do not masquerade as full project profit')
  verify(await refused(()=>saveProjectRecord({...materialInput,recordId:material,version:1}),'CONFLICT'),'stale record edit is refused')
  verify(await refused(()=>saveProjectRecord({...materialInput,recordId:material,version:3,lines:[line('material',1n)]}),'ALLOCATED'),'allocated cost cannot be reduced below settlements')
  verify(await refused(()=>saveProjectRecord({...materialInput,partyId:foreign.id,key:randomUUID()}),'BAD_PARTY'),'foreign-company Party cannot be used')
  const [crmParty]=await db.execute<{id:string}>(sql`INSERT INTO party(kind,name) VALUES('organisation',${`CRM only ${suffix}`}) RETURNING id::text`)
  await db.execute(sql`INSERT INTO crm_account(entity_id,party_id,created_by,updated_by) VALUES(${entityId}::uuid,${crmParty.id}::uuid,${actor},${actor})`)
  verify((await projectParties(entityId)).some(p=>p.id===crmParty.id),'existing CRM Party association is available without creating an accounting role')
  const invalidLines=new FormData()
  for(const [key,value] of Object.entries({lineKind:'material',lineDescription:'Test',base:'1.001',gst:'',pst:'',gstRecoverable:'',pstRecoverable:''})) invalidLines.append(key,value)
  let lineError='';try{projectLines(invalidLines,'cost')}catch(e){lineError=(e as Error).message}
  verify(lineError.includes('Line 1 tax exclusive amount'),'invalid money identifies the exact line and field')
  verify(await refused(()=>projectHead(B.company.id,projectId),'NO_PROJECT'),'forged cross-company Project ID reveals no project')
  verify(await refused(()=>allocateProjectPayment({...base,paymentId:advance,recordId:material,amount:1n}),'ALLOCATION'),'cross-Party / direction allocations are refused')
  verify(await refused(()=>createProjectPayment({...base,partyId:customer.id,direction:'received',date:'2026-02-01',amount:9999999n,key:randomUUID(),recordId:revenue}),'OVERPAYMENT'),'overpayment allocation rolls back the entire payment')
  const race=await Promise.allSettled([allocateProjectPayment({...base,paymentId:advance,recordId:revenue,amount:40000n,key:randomUUID()}),allocateProjectPayment({...base,paymentId:advance,recordId:revenue,amount:40000n,key:randomUUID()})])
  verify(race.filter(x=>x.status==='fulfilled').length===1,'concurrent allocations serialize; only one can spend the remaining advance')
  verify(await refused(()=>db.execute(sql`INSERT INTO project_payment_allocation(entity_id,project_id,party_id,payment_id,record_id,effective_date,amount_cents,created_by) VALUES(${entityId}::uuid,${projectId}::uuid,${customer.id}::uuid,${advance}::uuid,${revenue}::uuid,'2026-02-01',999999,'raw test')`)),'direct SQL cannot over-allocate')
  await voidProjectItem({...base,id:advance,kind:'payment',version:1,reason:'Duplicate input error',actor})
  p=await summary();verify(projectProfit(p).cash===294000n&&p.receivable==='1050000'&&p.customer_advance==='0','voided input removes its allocations and cash; bigint audit succeeds')
  const bytes=Buffer.from('Synthetic Project attachment. No customer information.'),sha=createHash('sha256').update(bytes).digest('hex')
  const attached=await attachProjectFile({...base,recordId:material,filename:'material-proof.txt',mime:'text/plain',bytes})
  await attachProjectFile({...base,filename:'same-bytes.txt',mime:'text/plain',bytes})
  verify((await projectAttachments(entityId,projectId)).length===2&&(await readProjectBlob(entityId,projectId,sha))?.equals(bytes),'independent attachments preserve bytes and share one project blob')
  verify(await refused(()=>attachProjectFile({...base,projectId:other,filename:'wrong.txt',mime:'text/plain',bytes}),'NO_PROJECT'),'attachment target must belong to the authorized company')
  const configured=process.env.PROJECT_ATTACHMENTS_DIR!
  process.env.PROJECT_ATTACHMENTS_DIR=process.env.ATTACHMENTS_DIR
  verify(await refused(()=>projectStorageRoot(),'STORAGE'),'same-root storage is refused')
  process.env.PROJECT_ATTACHMENTS_DIR=path.join(process.env.ATTACHMENTS_DIR!,'nested')
  verify(await refused(()=>projectStorageRoot(),'STORAGE'),'nested storage is refused')
  process.env.PROJECT_ATTACHMENTS_DIR=configured
  await fs.mkdir(process.env.ATTACHMENTS_DIR!,{recursive:true})
  const symlink=path.join(path.dirname(configured),'overlap-link-'+suffix);await fs.symlink(process.env.ATTACHMENTS_DIR!,symlink,'dir')
  process.env.PROJECT_ATTACHMENTS_DIR=symlink
  verify(await refused(()=>projectStorageRoot(),'STORAGE'),'symlink overlap is refused')
  process.env.PROJECT_ATTACHMENTS_DIR=configured;await fs.unlink(symlink)
  await db.execute(sql`UPDATE party SET is_active=false WHERE id=${supplier.id}::uuid`)
  await saveProjectRecord({...materialInput,recordId:material,version:3})
  verify((await projectRecords(entityId,{},projectId)).find(r=>r.id===material)?.version===4,'historical cost tax review preserves an inactive original Party')
  verify(await refused(()=>saveProjectRecord({...materialInput,key:randomUUID()}),'BAD_PARTY'),'inactive Party still cannot be used for a new record')
  await db.execute(sql`UPDATE party SET is_active=true WHERE id=${supplier.id}::uuid`)
  const [history]=await db.execute<{before: {lines:{base_cents:string}[]}}>(sql`SELECT before FROM audit_log WHERE table_name='project_record' AND record_id=${material} ORDER BY id DESC LIMIT 1`)
  verify(history.before.lines[0].base_cents==='600000','record edit audit retains the complete original cost line amounts')
  const blob=path.join(configured,entityId,projectId,'blobs',sha),kept=blob+'.test-original'
  await fs.rename(blob,kept)
  try {
    await fs.symlink(kept,blob)
    verify(await refused(()=>readProjectBlob(entityId,projectId,sha),'STORAGE'),'a final-file symbolic link is refused')
    await fs.unlink(blob);await fs.link(kept,blob)
    verify(await refused(()=>readProjectBlob(entityId,projectId,sha),'STORAGE'),'a final-file hard link is refused')
  } finally {await fs.unlink(blob).catch(()=>{});await fs.rename(kept,blob)}
  const csv=String(await projectExport(entityId,A.company.name,{},projectId,'summary'))
  verify(csv.includes('10000.00')&&csv.includes('9580.00')&&csv.includes('2940.00'),'CSV uses the same exact profit service')
  const allocatedCSV=String(await projectExport(entityId,A.company.name,{},projectId,'allocations')),taxCSV=String(await projectExport(entityId,A.company.name,{},projectId,'taxes'))
  verify(allocatedCSV.includes(revenue)&&allocatedCSV.includes('10500.00')&&taxCSV.includes('420.00')&&csv.includes('Attachment count'),'allocation and tax exports expose exact supporting totals and attachment counts')
  const balances=String(await projectExport(entityId,A.company.name,{from:'2026-02-01',to:'2026-02-28'},projectId,'balances'))
  verify(balances.includes('2026-01-10')&&balances.includes('10500.00'),'balance export includes records before the period')
  const book=await projectExport(entityId,A.company.name,{},projectId,'summary','xlsx')
  verify(Buffer.isBuffer(book)&&book.subarray(0,2).toString()==='PK','workbook contains summary, detail, Party and as-of balances')
  const hugeProject=await createProject({entityId,currency:'CAD',code:'LARGE',name:'Precision test',customerPartyId:customer.id,actor})
  const huge=9007199254740993n
  await saveProjectRecord({...base,projectId:hugeProject,partyId:customer.id,kind:'revenue',date:'2026-01-01',description:'Beyond JS safe integer',lines:[line('revenue',huge)],key:randomUUID()})
  verify((await projectSummaries(entityId,{},hugeProject))[0].revenue===huge.toString()&&String(await projectExport(entityId,A.company.name,{},hugeProject)).includes('90071992547409.93'),'large values stay exact beyond JavaScript safe integer')
  const largeWorkbook=new ExcelJS.Workbook(),largeBytes=await projectExport(entityId,A.company.name,{},hugeProject,'summary','xlsx')
  await largeWorkbook.xlsx.load(largeBytes as unknown as Parameters<typeof largeWorkbook.xlsx.load>[0])
  verify(largeWorkbook.worksheets.length===10&&largeWorkbook.getWorksheet('summary')!.getCell('F2').value==='90071992547409.93','XLSX round-trip preserves large money as exact decimal text across ten sheets')
  const doc=await exportCompany(entityId,{withFiles:true}),read=readFigtree(await packFigtree(doc))
  verify(read.figtree===4&&!!read.auditProof&&read.rows.project.length===2&&read.files.some(f=>f.storageDomain==='project')&&read.parties.party.some(x=>x.id===labor.id),'portable v4 carries Project graph, shared Party, source audit proof and independent files')
  const partial={...read,files:read.files.filter(f=>f.storageDomain!=='project')}
  verify((await inspectFigtree(partial)).missingPaper===1,'portable restore inspection exposes missing Project bytes as incomplete document recovery')
  const restored=await restoreCompany(read,actor,{code:`PRR${suffix}`,name:`Restored Project ${suffix}`})
  await restorePaper(read,restored.name,restored.ledgerId,restored)
  const restoredId=restored.projectMap[projectId],rp=(await projectSummaries(restored.entityId,{},restoredId))[0]
  verify(restoredId!==projectId&&projectProfit(rp).adjusted===958000n&&(await readProjectBlob(restored.entityId,restoredId,sha))?.equals(bytes),'restore remaps company/project IDs and writes files only to the new Project store')
  await detachProjectFile(entityId,projectId,attached,actor)
  verify((await projectAttachments(entityId,projectId)).length===1&&(await readProjectBlob(entityId,projectId,sha))?.equals(bytes),'unlink retains immutable stored bytes')
  await updateProject({...base,version:1,name:'Workshop renovation',status:'archived'})
  verify(await refused(()=>createProjectPayment({...advanceInput,key:randomUUID()}),'ARCHIVED'),'archived project refuses new payments')
  await updateProject({...base,version:2,name:'Workshop renovation',status:'active'})
  await archiveCompany(entityId,'Test archive',actor)
  verify(await refused(()=>saveProjectRecord({...revenueInput,key:randomUUID()}),'ARCHIVED'),'archived company refuses Project writes')
  await unarchiveCompany(entityId,actor)
  verify((await companyById(entityId))?.entries!=='0'&&await refused(()=>deleteCompany(entityId,actor)),'a company containing projects cannot be deleted as empty')

  // Owner's worksheet example: 1,050 gross revenue, 840 gross costs, 504 paid.
  const refinedProjectId=await createProject({entityId,currency:'CAD',code:'5611',name:'Baillie St',customerPartyId:customer.id,actor})
  const refined={...base,projectId:refinedProjectId}
  const demoRevenue=await saveProjectRecord({...refined,kind:'revenue',partyId:customer.id,date:'2026-10-02',description:'Project revenue',lines:[line('revenue',100000n,5000n)],key:randomUUID()})
  await saveProjectRecord({...refined,kind:'cost',partyId:labor.id,date:'2026-10-02',description:'Labour A',lines:[line('labor',10000n,500n,700n,500n,0n)],key:randomUUID()})
  await saveProjectRecord({...refined,kind:'cost',partyId:supplier.id,date:'2026-10-02',description:'Labour B',lines:[line('labor',20000n,1000n,1400n,1000n,0n)],key:randomUUID()})
  const paidInput={...refined,kind:'cost' as const,partyId:supplier.id,date:'2026-10-02',description:'Material A',lines:[line('material',10000n,500n,700n,500n,0n)],key:randomUUID(),paid:{date:'2026-10-05',method:'Transfer'}}
  const paidMaterial=await saveProjectRecord(paidInput)
  await saveProjectRecord({...paidInput,description:'Material B',lines:[line('material',20000n,1000n,1400n,1000n,0n)],key:randomUUID(),paid:{date:'2026-10-06'}})
  await saveProjectRecord({...paidInput,description:'Janitorial',lines:[line('janitorial',10000n,500n,700n,500n,0n)],key:randomUUID(),paid:{date:'2026-10-07'}})
  const paidOther=await saveProjectRecord({...paidInput,description:'Other',partyId:null,lines:[line('other',5000n,250n,350n,250n,0n)],key:randomUUID(),paid:{date:'2026-10-03'}})
  for(const [date,amount] of [['2026-10-02',50000n],['2026-10-07',55000n]] as const)
    await createProjectPayment({...refined,partyId:customer.id,direction:'received',date,amount,key:randomUUID(),recordId:demoRevenue})
  const demoSummary=(await projectSummaries(entityId,{},refinedProjectId))[0],demoRecords=await projectRecords(entityId,{},refinedProjectId)
  const groups=projectAccountingGroups(demoRecords),costs=projectAccountingTotal(groups,'cost'),sheet=projectSheetSummary(demoRecords),demoProfit=projectProfit(demoSummary)
  verify(costs.base===75000n&&costs.gst===3750n&&costs.pst===5250n&&costs.gross===84000n&&costs.settled===50400n&&costs.outstanding===33600n,'worksheet cost totals match net 750, GST 37.50, PST 52.50, gross 840, paid 504')
  verify(sheet.revenue.gross-costs.gross===21000n&&demoProfit.before===25000n&&demoProfit.adjusted===19750n&&demoProfit.cash===54600n,'inclusive difference 210 stays distinct from pretax 250, adjusted 197.50 and net cash 546')
  verify(demoSummary.janitorial==='10000'&&demoSummary.other==='5000'&&sheet.janitorial.gross===11200n&&sheet.other.gross===5600n,'Janitorial and Other flow through exact cost summaries')
  verify(demoRecords.find(r=>r.id===paidMaterial)?.settled==='11200'&&(await projectPayments(entityId,{},refinedProjectId)).some(p=>p.payment_date==='2026-10-05'&&p.amount==='11200'),'Already paid creates a real payment and record allocation')
  verify(demoRecords.find(r=>r.id===paidOther)?.party_id===null&&demoRecords.find(r=>r.id===paidOther)?.settled==='5600'&&groups.some(g=>g.partyId===null&&g.type==='Cost · Other'),'Other can retain no Party, including its exact paid and tax values')
  const paymentCount=(await projectPayments(entityId,{},refinedProjectId)).length
  verify(await saveProjectRecord(paidInput)===paidMaterial&&(await projectPayments(entityId,{},refinedProjectId)).length===paymentCount,'retrying a paid cost creates neither a second cost nor a second payment')
  verify(await refused(()=>saveProjectRecord({...paidInput,paid:{date:'2026-10-06'}}),'REPLAY'),'paid-cost key cannot silently change its payment date')
  verify(await refused(()=>saveProjectRecord({...paidInput,recordId:paidMaterial,version:1}),'PAYMENT'),'editing an existing cost cannot repeat Already paid')
  verify(await refused(()=>saveProjectRecord({...paidInput,partyId:null,key:randomUUID()}),'BAD_PARTY'),'material and labour still require an existing company Party')

  const sandboxId=await createProject({entityId,currency:'CAD',code:'PAYMENT-TEST',name:'Payment edge cases',customerPartyId:customer.id,actor})
  const sandbox={...base,projectId:sandboxId}
  const partialCost=await saveProjectRecord({...paidInput,...sandbox,description:'Partially paid cost',lines:[line('janitorial',10000n)],key:randomUUID(),paid:{date:'2026-10-01',amount:3000n}})
  const partialRow=(await projectRecords(entityId,{},sandboxId))[0],early=(await projectSummaries(entityId,{to:'2026-10-01'},sandboxId))[0]
  verify(partialRow.id===partialCost&&partialRow.settled==='3000'&&partialRow.outstanding==='7000'&&early.paid==='3000'&&early.supplier_advance==='3000'&&early.payable==='0','partial paid cost preserves balance; payment before the cost remains an advance as of that date')
  await saveProjectRecord({...paidInput,...sandbox,description:'Mixed paid cost',lines:[line('material',100n),line('labor',200n)],key:randomUUID(),paid:{date:'2026-10-02',amount:100n}})
  const mixedGroup=projectAccountingGroups(await projectRecords(entityId,{},sandboxId)).find(g=>g.type==='Cost · Labour / Material')
  verify(mixedGroup?.base===300n&&mixedGroup.settled===100n&&mixedGroup.outstanding===200n&&mixedGroup.count===1,'accountant groups keep mixed classifications whole without fabricated per-line payment allocations')
  verify(await refused(()=>saveProjectRecord({...paidInput,...sandbox,key:randomUUID(),paid:{date:'2026-10-05',amount:11201n}}),'OVERPAYMENT'),'Already paid refuses an amount above the cost total')
  const beforeFailed=JSON.stringify(await db.execute(sql`SELECT (SELECT count(*) FROM project_record)::text AS records,(SELECT count(*) FROM project_record_line)::text AS lines,(SELECT count(*) FROM project_payment)::text AS payments,(SELECT count(*) FROM audit_log)::text AS audit`))
  await db.execute(sql`CREATE FUNCTION project_test_payment_failure() RETURNS trigger AS $$ BEGIN IF NEW.reference='reject-after-cost' THEN RAISE EXCEPTION 'TEST_PAYMENT_FAILURE'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`)
  await db.execute(sql`CREATE TRIGGER project_test_payment_failure BEFORE INSERT ON project_payment FOR EACH ROW EXECUTE FUNCTION project_test_payment_failure()`)
  let lateFailure=false
  try {lateFailure=await refused(()=>saveProjectRecord({...paidInput,...sandbox,key:randomUUID(),paid:{date:'2026-10-05',reference:'reject-after-cost'}}))}
  finally {await db.execute(sql`DROP TRIGGER project_test_payment_failure ON project_payment`);await db.execute(sql`DROP FUNCTION project_test_payment_failure()`)}
  const afterFailed=JSON.stringify(await db.execute(sql`SELECT (SELECT count(*) FROM project_record)::text AS records,(SELECT count(*) FROM project_record_line)::text AS lines,(SELECT count(*) FROM project_payment)::text AS payments,(SELECT count(*) FROM audit_log)::text AS audit`))
  verify(lateFailure&&beforeFailed===afterFailed,'a failure at payment insertion rolls back cost, lines, payment and audit together')
  const nullPayment=(await projectPayments(entityId,{},refinedProjectId)).find(p=>p.party_id===null)!
  verify(await refused(()=>db.execute(sql`INSERT INTO project_payment_allocation(entity_id,project_id,party_id,payment_id,record_id,effective_date,amount_cents,created_by) VALUES(${entityId}::uuid,${sandboxId}::uuid,NULL,${nullPayment.id}::uuid,${paidOther}::uuid,'2026-10-03',1,'scope test')`)),'nullable Party allocations still enforce payment and record company/project FKs')
  verify(await refused(()=>db.execute(sql`UPDATE project_record_line SET kind='labor' WHERE record_id=${paidOther}::uuid`)),'direct SQL cannot reclassify a no-Party Other cost as labour')
  verify(await refused(()=>db.execute(sql`INSERT INTO project_payment_allocation(entity_id,project_id,party_id,payment_id,record_id,effective_date,amount_cents,created_by) VALUES(${entityId}::uuid,${refinedProjectId}::uuid,${customer.id}::uuid,${nullPayment.id}::uuid,${paidOther}::uuid,'2026-10-03',1,'party test')`)),'nullable Party allocation cannot claim a different Party')
  const accountingCSV=String(await projectExport(entityId,A.company.name,{},refinedProjectId,'accounting'))
  verify(accountingCSV.includes('Cost · Other')&&accountingCSV.includes('Cost total,,6,750.00,802.50,37.50,52.50,840.00,504.00,336.00'),'accountant export carries exact classification/Party, taxes, payment and balance totals')
  verify(projectProfitBasis(costs,'cost')===80250n&&projectAccountingProfit(groups).beforeGST===19750n,'GST-excluding profit includes confirmed non-recoverable cost PST')
  const taxedRevenue=projectAccountingGroups(demoRecords.map(r=>r.kind==='revenue'?{...r,lines:r.lines.map(l=>({...l,pst:'7000'}))}:r))
  verify(projectAccountingTotal(taxedRevenue,'revenue').pst===7000n&&projectAccountingProfit(taxedRevenue).beforeGST===19750n,'customer-collected PST remains visible tax and never increases profit')
  verify(projectProfitBasis({...costs,nonrecoverPST:3250n,recoverPST:2000n},'cost')===78250n,'partially recoverable PST adds only its non-recoverable part to cost')
  verify(projectProfitBasis({...costs,pendingPST:1n},'cost')===null&&projectAccountingProfit(groups.map(g=>g.kind==='cost'?{...g,pendingPST:1n}:g)).beforeGST===null,'pending cost PST blocks the PST-inclusive basis and profit')
  const gstPending=projectAccountingProfit(groups.map(g=>g.kind==='cost'?{...g,pendingGST:1n}:g))
  verify(gstPending.beforeGST===19750n&&gstPending.adjusted===null,'unknown GST recovery keeps profit before GST but blocks the fully adjusted result')
  const nonrecoverGST=projectAccountingProfit(groups.map((g,i)=>i===1?{...g,nonrecoverGST:500n}:g))
  verify(nonrecoverGST.beforeGST===19750n&&nonrecoverGST.adjusted===19250n,'confirmed non-recoverable GST has its own deduction, never hidden by GST-excluding profit')
  verify(projectProfitBasis({...costs,base:9007199254740993n,nonrecoverPST:1n},'cost')===9007199254740994n,'profit basis preserves cents above JavaScript safe integer precision')
  verify(projectAccountingProfit([]).beforeGST===0n&&projectAccountingProfit(groups.map(g=>g.kind==='revenue'?{...g,base:0n}:g)).beforeGST===-80250n,'zero and negative project profit retain their exact sign')
  const accountingHeader=accountingCSV.split('\n').find(l=>l.startsWith('Project,Currency,Type,Party,'))!
  verify(accountingHeader.includes('Total,Paid / received as of,Outstanding as of')&&!accountingHeader.includes('Recoverable')&&!accountingHeader.includes('Pending GST'),'simplified accounting export keeps Total adjacent to settlement without recovery columns')
  const accountingBook=new ExcelJS.Workbook();await accountingBook.xlsx.load(await projectExport(entityId,A.company.name,{},refinedProjectId,'accounting','xlsx') as never)
  const accountingSheet=accountingBook.getWorksheet('accounting')!
  const marginRow=accountingSheet.getRows(2,accountingSheet.rowCount-1)!.find(r=>r.getCell(3).value==='Profit before GST')!
  verify(accountingSheet.columnCount===13&&marginRow.getCell(7).value==='197.50','workbook unified summary includes exact text profit and simplified columns')
  const newPartyForm=(name:string,role='supplier')=>{const f=new FormData();Object.entries({ledgerId,name,role,heldFrom:'2026-10-02',entityId:B.company.id}).forEach(([k,v])=>f.set(k,v));return f}
  const createdParty=await createProjectPartyFromForm(newPartyForm('Project inline supplier '+suffix),actor)
  verify(!!createdParty.madeId&&createdParty.madeLabel==='Project inline supplier '+suffix&&(await projectParties(entityId)).some(p=>p.id===createdParty.madeId)&&!(await projectParties(B.company.id)).some(p=>p.id===createdParty.madeId),'inline Party creation reuses shared identity and forces the current ledger company despite a forged entity field')
  const duplicateParty=await createProjectPartyFromForm(newPartyForm('Project inline supplier '+suffix),actor)
  verify(!!duplicateParty.error&&!duplicateParty.madeId,'duplicate inline Party returns existing shared refusal wording')
  verify(await refused(()=>createProjectPartyFromForm(newPartyForm('Invalid project Party '+suffix,'employee'),actor),'PARTY'),'Project Party creation refuses unrelated roles')
  await archiveCompany(B.company.id,'Project inline Party check',actor)
  const archivedParty=newPartyForm('Archived Party '+suffix);archivedParty.set('ledgerId',B.ledger.id)
  verify(await refused(()=>createProjectPartyFromForm(archivedParty,actor),'ARCHIVED'),'inline Party creation refuses an archived company')
  await unarchiveCompany(B.company.id,actor)
  const demoBytes=Buffer.from('Synthetic project worksheet document'),demoSha=createHash('sha256').update(demoBytes).digest('hex')
  const refinedAttachmentId=await attachProjectFile({...refined,recordId:paidMaterial,filename:'material-receipt.txt',mime:'text/plain',bytes:demoBytes})
  await setProjectDeleted({...refined,version:1,deleted:true})
  verify(!(await projectSummaries(entityId)).some(p=>p.id===refinedProjectId)&&(await projectSummaries(entityId,{deleted:'yes'})).some(p=>p.id===refinedProjectId)&&await refused(()=>projectHead(entityId,refinedProjectId),'NO_PROJECT'),'delete removes the project from normal lists/deep links and exposes it only in Deleted projects')
  verify(await refused(()=>saveProjectRecord({...paidInput,key:randomUUID()}),'NO_PROJECT')&&await refused(()=>attachProjectFile({...refined,filename:'blocked.txt',mime:'text/plain',bytes:demoBytes}),'NO_PROJECT'),'deleted project refuses records and attachments')
  verify(await refused(()=>db.execute(sql`INSERT INTO project_payment(entity_id,project_id,party_id,direction,payment_date,amount_cents,created_by) VALUES(${entityId}::uuid,${refinedProjectId}::uuid,${customer.id}::uuid,'received','2026-10-02',1,'deleted test')`)),'direct SQL cannot write a deleted project')
  verify(await refused(()=>setProjectDeleted({...base,projectId:other,version:1,deleted:true}),'NO_PROJECT')&&await refused(()=>setProjectDeleted({...refined,version:1,deleted:false}),'CONFLICT'),'deletion/restoration rejects another company and stale versions')
  const deletedDoc=readFigtree(await packFigtree(await exportCompany(entityId,{withFiles:true})))
  const copied=await restoreCompany(deletedDoc,actor,{code:`PRD${suffix}`,name:`Restored deleted Project ${suffix}`})
  await restorePaper(deletedDoc,copied.name,copied.ledgerId,copied)
  const copiedId=copied.projectMap[refinedProjectId],copiedSummary=(await projectSummaries(copied.entityId,{deleted:'yes'},copiedId))[0]
  verify(copiedSummary.deleted_at!==null&&projectProfit(copiedSummary).adjusted===19750n&&(await readProjectBlob(copied.entityId,copiedId,demoSha))?.equals(demoBytes),'backup restore preserves deleted state, new classifications, no-Party paid costs and independent attachment bytes')
  await setProjectDeleted({...refined,version:2,deleted:false})
  verify(projectProfit((await projectSummaries(entityId,{},refinedProjectId))[0]).cash===54600n&&(await projectRecords(entityId,{},refinedProjectId)).length===7&&(await readProjectBlob(entityId,refinedProjectId,demoSha))?.equals(demoBytes),'restoring a deleted project recovers the exact records, payments and attachments')
  const [deleteAudit]=await db.execute<{count:string}>(sql`SELECT count(*)::text AS count FROM audit_log WHERE table_name='project' AND record_id=${refinedProjectId} AND action IN ('delete_project','restore_project')`)
  verify(deleteAudit.count==='2','delete and restore each leave a company audit event')
  await setProjectDeleted({...sandbox,version:1,deleted:true})
  await updateProject({...refined,version:3,name:'Baillie St',status:'archived'})
  await setProjectDeleted({...refined,version:4,deleted:true});await setProjectDeleted({...refined,version:5,deleted:false})
  verify((await projectHead(entityId,refinedProjectId)).status==='archived','archived projects can be deleted and restored without silently becoming active')
  await updateProject({...refined,version:6,name:'Baillie St',status:'active'})
  verify(await glSnapshot()===glBefore,'Project mutations never alter GL, invoices, banking, payroll or tax registrations')
  // Delivery is a persisted cost, included in period/lifetime profit and every export.
  const deliveryProject=await createProject({entityId,currency:'CAD',code:'DELIVERY',name:'Delivery category check',customerPartyId:customer.id,actor})
  const deliveryInput={...base,projectId:deliveryProject,partyId:supplier.id,kind:'cost' as const,date:'2026-10-07',description:'Delivery',lines:[line('delivery',12500n,625n,875n,625n,0n)],key:randomUUID()}
  const deliveryId=await saveProjectRecord(deliveryInput)
  const deliveryRecords=await projectRecords(entityId,{kind:'delivery'},deliveryProject),deliverySummary=(await projectSummaries(entityId,{},deliveryProject))[0]
  verify(deliveryRecords.length===1&&deliveryRecords[0].lines[0].kind==='delivery'&&projectRecordType(deliveryRecords[0])==='Cost · Delivery','Delivery persists and is returned by the category filter with the correct label')
  verify(deliverySummary.delivery==='12500'&&projectProfit(deliverySummary).cost===12500n&&projectProfit(deliverySummary).before===-12500n&&projectProfit(deliverySummary).adjusted===-13375n,'Delivery contributes to cost and exact pre-tax/adjusted profit')
  verify(projectSheetSummary(deliveryRecords).delivery.gross===14000n&&projectCostTotals(deliveryRecords).delivery===12500n&&projectAccountingTotal(projectAccountingGroups(deliveryRecords),'cost').gross===14000n,'Delivery flows through worksheet and Party-grouped cost totals')
  verify((await projectSummaries(entityId,{from:'2026-10-08'},deliveryProject))[0].delivery==='0'&&(await projectSummaries(entityId,{from:'2026-10-07',to:'2026-10-07'},deliveryProject))[0].delivery==='12500','Delivery period totals obey the record date')
  await saveProjectRecord({...deliveryInput,recordId:deliveryId,version:1,lines:[line('delivery',15000n)]})
  verify((await projectSummaries(entityId,{},deliveryProject))[0].delivery==='15000','editing Delivery updates its saved summary')
  const deliveryCsv=String(await projectExport(entityId,A.company.name,{},deliveryProject,'summary')),deliveryTaxCsv=String(await projectExport(entityId,A.company.name,{},deliveryProject,'taxes'))
  verify(deliveryCsv.includes('Delivery')&&deliveryCsv.includes('-150.00')&&deliveryTaxCsv.includes('Filtered delivery')&&deliveryTaxCsv.includes('150.00'),'CSV summary and tax exports include Delivery and its profit impact')
  const deliveryBook=new ExcelJS.Workbook();await deliveryBook.xlsx.load(await projectExport(entityId,A.company.name,{},deliveryProject,'summary','xlsx') as unknown as Parameters<typeof deliveryBook.xlsx.load>[0])
  const deliverySheet=deliveryBook.getWorksheet('summary')!,deliveryColumn=(deliverySheet.getRow(1).values as string[]).indexOf('Delivery')
  verify(deliveryColumn>0&&deliverySheet.getRow(2).getCell(deliveryColumn).value==='150.00','XLSX exports a named Delivery column with exact decimal text')
  verify(await refused(()=>saveProjectRecord({...deliveryInput,partyId:null,key:randomUUID()}),'BAD_PARTY'),'Delivery retains the supplier requirement used by other named cost categories')
  const subcontractorId=await saveProjectRecord({...deliveryInput,description:'Outside labour',lines:[line('subcontractor',25000n,1250n,0n,1250n,0n)],key:randomUUID()})
  const subcontractors=await projectRecords(entityId,{kind:'subcontractor'},deliveryProject),subSummary=(await projectSummaries(entityId,{},deliveryProject))[0]
  verify(subcontractors.length===1&&subcontractors[0].id===subcontractorId&&projectRecordType(subcontractors[0])==='Cost · Labour (subcontractor)','Subcontractor persists, filters and displays separately from Labour and Janitorial')
  verify(subSummary.subcontractor==='25000'&&subSummary.delivery==='15000'&&projectProfit(subSummary).cost===40000n&&projectCostTotals(subcontractors).subcontractor===25000n&&projectSheetSummary(subcontractors).subcontractor.gross===26250n,'Subcontractor contributes exactly once to summaries, profit, tax and worksheet totals')
  const subCsv=String(await projectExport(entityId,A.company.name,{},deliveryProject,'summary')),subTaxCsv=String(await projectExport(entityId,A.company.name,{},deliveryProject,'taxes'))
  verify(subCsv.includes('Subcontractor')&&subCsv.includes('250.00')&&subTaxCsv.includes('Filtered subcontractor'),'CSV summary and tax exports expose the Subcontractor category')
  const subBook=new ExcelJS.Workbook();await subBook.xlsx.load(await projectExport(entityId,A.company.name,{},deliveryProject,'summary','xlsx') as never)
  const subSheet=subBook.getWorksheet('summary')!,subCol=(subSheet.getRow(1).values as string[]).indexOf('Subcontractor')
  verify(subCol>0&&subSheet.getRow(2).getCell(subCol).value==='250.00','XLSX Subcontractor column preserves the exact decimal amount')
  if(process.env.PROJECT_TEST_RECEIPT)await fs.writeFile(process.env.PROJECT_TEST_RECEIPT,JSON.stringify({entityId,ledgerId,projectId,refinedProjectId,refinedAttachmentId,otherLedgerId:B.ledger.id,otherProjectId:other,attachmentId:(await projectAttachments(entityId,projectId))[0].id,ownerEmail:actor,checks},null,2),{mode:0o600})
  console.log(`Project integration: ${checks} checks passed.`)
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

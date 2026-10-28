import './env'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {sql as q} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner,createUser} from '../src/lib/users'
import {createCompanyWithYear} from '../src/lib/setup'
import {importAccounts,parseAccountsCsv} from '../src/lib/accounts'
import {STARTER_CHART} from '../src/lib/starter-chart'
import {initializeOperationsFinance,connectOperationsFinance} from '../src/lib/operations-finance'
import {operationsReconciliation,operationsLatestDate,reconciliationHash} from '../src/lib/operations-reconciliation'
import {saveInventoryItem,inventoryWarehouses,recordStockMovement,saveInventorySettings,saveInventoryWarehouse} from '../src/lib/inventory'
import {saveBom,createProductionOrder,productionOrderDetail,recordProductionEvent,type ProductionAction} from '../src/lib/production'
import {recordProductionTime,cancelProductionTime} from '../src/lib/production-payroll'
import {createLabourPeriod,accrueProductionTime,previewLabourSettlement,settleLabourPeriod,reverseLabourSettlement,reverseLabourAccrual,labourOptions,type PeriodInput,type SettlementInput} from '../src/lib/production-labour-accrual'
import {createParty} from '../src/lib/parties'
import {saveEmployee} from '../src/lib/payroll/employees'
import {runPayroll,payRunDetail} from '../src/lib/payroll/runs'
import {closePeriod,periodOverview} from '../src/lib/periods'
import {reverseEntry} from '../src/lib/posting'
import {exportCompany,restoreCompany} from '../src/lib/backup'
import {setGrants} from '../src/lib/access'
import {productionReport} from '../src/lib/production-report'
import {parseQuantity as Q} from '../src/lib/quantity'
import {labourShare} from '../src/lib/production-labour-math'
import {errorText} from './suite'
const refuse=(code:string,fn:()=>Promise<unknown>)=>assert.rejects(fn,e=>(e as {code:string}).code===code)
async function main(){
 const me=await createFirstOwner({email:'labour@example.test',firstName:'Labour test',password:'A synthetic labour accrual test password'})
 assert.equal(labourShare(10001n,500n,1000n),5001n)
 for(const method of ['fifo','moving_average'] as const){
  const company=await createCompanyWithYear({code:method==='fifo'?'LABFIFO':'LABMA',name:'Synthetic labour '+method},me.email),l=company.ledger.id
  const accounts=await importAccounts(company.company.id,parseAccountsCsv(STARTER_CHART).map(a=>({...a,entityId:company.company.id})),me.email),cash=accounts.find(a=>a.code==='1002')!.id,equity=accounts.find(a=>a.code==='3500')!.id
  await initializeOperationsFinance(me,l,'/inventory');const rows=await operationsReconciliation(l,'/inventory','2026-01-01');await connectOperationsFinance(me,l,'/inventory',{date:'2026-01-01',fundingAccountId:cash,openingAccountId:equity,expectedHash:reconciliationHash(rows,'2026-01-01',await operationsLatestDate(l,'/inventory')),taxRateBp:0,taxRateNote:'',ccaStrategy:'maximum'})
  await saveInventorySettings(me,l,{version:0,warehousesEnabled:true,costMethod:method})
  const warehouse=(await inventoryWarehouses(l))[0].id,second=await saveInventoryWarehouse(me,l,{code:'SECOND',name:'Second warehouse',isActive:true})
  const item=(sku:string,kind:string)=>saveInventoryItem(me,l,{sku,name:sku,kind,unit:'each',reorderLevel:0n,trackBatches:false,trackSerials:false,isActive:true,notes:''})
  const raw=await item('RAW','raw_material'),fg=await item('FG','finished_goods')
  const move=(itemId:string,kind:'receipt'|'issue'|'transfer',date:string,quantity:string,cost=0n,from=warehouse,to=warehouse)=>recordStockMovement(me,l,{itemId,kind,date,quantity:Q(quantity),cost,fromWarehouseId:kind==='receipt'?'':from,toWarehouseId:kind==='issue'?'':to,batch:'',serials:[],reference:'',note:'Synthetic cost flow',key:randomUUID(),finance:kind==='receipt'?{counterpartAccountId:cash}:{}})
  await move(raw,'receipt','2026-01-01','20',20000n)
  const bom=await saveBom(me,l,{code:'BOM',name:'One raw into one finished',outputItemId:fg,outputQuantity:Q('1'),components:[{itemId:raw,quantity:Q('1')}],notes:'',isActive:true}),order=await createProductionOrder(me,l,{bomId:bom,quantity:Q('10'),warehouseId:warehouse,startDate:'2026-01-02',dueDate:'',notes:'',key:randomUUID()})
  const event=(patch:Partial<ProductionAction>)=>productionOrderDetail(l,order).then(d=>recordProductionEvent(me,l,{orderId:order,version:d!.order.version,kind:'material_issue',date:'2026-01-02',itemId:raw,sourceEventId:'',quantity:0n,cost:0n,batch:'',serials:[],note:'Synthetic production',key:randomUUID(),...patch}))
  await event({quantity:Q('10')})
  const party=await createParty({kind:'person',name:'Synthetic '+method+' worker',roles:[{entityId:company.company.id,role:'employee',heldFrom:'2026-01-01'}],actor:me.email}),employee=await saveEmployee({ledgerId:l,partyId:party.id,frequency:'semi_monthly',hiredOn:'2026-01-01',cppExempt:true,eiExempt:true,actor:me.email})
  const estimate:PeriodInput={employeeId:employee.id,start:'2026-01-01',end:'2026-01-15',payDate:'2026-01-15',basis:method==='fifo'?'hourly':'fixed',hourlyRate:1000n,paidHours:1000n,normalHours:1000n,gross:10000n,note:'Normal productive capacity, no bonus or separate paid leave',key:randomUUID()}
  const period=await createLabourPeriod(me,l,estimate);assert.equal(await createLabourPeriod(me,l,estimate),period)
  await refuse('PERIOD',()=>createLabourPeriod(me,l,{...estimate,key:randomUUID()}))
  for(const [date,hours] of [['2026-01-02',400n],['2026-01-03',600n]] as const){
   const time=await recordProductionTime(me,l,{orderId:order,employeeId:employee.id,date,hours,note:'Assembly',key:randomUUID()})
   await refuse('LABOUR_PENDING',()=>event({kind:'completion',date,quantity:Q('1')}))
   const input={timeId:time,periodId:period,key:randomUUID()},accrual=await accrueProductionTime(me,l,input);assert.equal(await accrueProductionTime(me,l,input),accrual)
   await refuse('ALLOCATED',()=>cancelProductionTime(me,l,{id:time,version:1}))
   const recon=await operationsReconciliation(l,'/inventory',date);assert(recon.every(r=>r.difference==='0'));assert(BigInt(recon.find(r=>r.key==='labour_accrual')!.gl_amount)<0n)
  }
  await event({kind:'completion',date:'2026-01-04',quantity:Q('4')});await event({kind:'completion',date:'2026-01-05',quantity:Q('6')})
  if(method==='moving_average')await move(fg,'receipt','2026-01-06','10',30000n)
  await move(fg,'issue','2026-01-07',method==='fifo'?'6':'10')
  const remaining=method==='fifo'?'4':'10';await move(fg,'transfer','2026-01-08',remaining,0n,warehouse,second)
  const pay=await runPayroll({ledgerId:l,payDate:'2026-01-15',periodStart:'2026-01-01',periodEnd:'2026-01-15',bankAccountId:cash,lines:[{employeeId:employee.id,gross:12000n,hours:0n}],actor:me.email}),stub=(await payRunDetail(l,pay.runId))!.stubs[0].id
  const input:SettlementInput={periodId:period,payStubId:stub,date:'2026-01-15',eligibleGross:12000n,normalHours:1000n,note:'Actual wage and normal capacity reviewed',key:randomUUID()},preview=await previewLabourSettlement(me,l,input)
  assert.equal(preview.estimated,10000n);assert.equal(preview.actual,12000n)
  assert.equal(preview.corrections.find(c=>c.target.kind==='expense')!.amount,method==='fifo'?1200n:1000n)
  assert.equal(preview.corrections.filter(c=>c.target.kind==='stock').reduce((n,c)=>n+c.amount,0n),method==='fifo'?800n:1000n)
  await refuse('STALE',()=>settleLabourPeriod(me,l,input));const confirmed={...input,reviewHash:preview.reviewHash},settlement=await settleLabourPeriod(me,l,confirmed);assert.equal(await settleLabourPeriod(me,l,confirmed),settlement)
  await refuse('PAYROLL_ALLOCATED',()=>reverseEntry(pay.entryId,'2026-01-15','Must clear settlement first',me.email))
  const issue=await move(fg,'issue','2026-01-16',method==='fifo'?'2':'5',0n,second)
  const [actualIssue]=await db.execute<{cost:string}>(q`SELECT cost::text FROM inventory_movement WHERE id=${issue}::uuid`);assert.equal(actualIssue.cost,method==='fifo'?'4400':'13000')
  const reverse={settlementId:settlement,date:'2026-01-17',note:'Correct original pay run after further sales',key:randomUUID()},reversal=await reverseLabourSettlement(me,l,reverse);assert.equal(await reverseLabourSettlement(me,l,reverse),reversal)
  for(const day of ['2026-01-02','2026-01-03','2026-01-07','2026-01-15','2026-01-16','2026-01-17'])assert((await operationsReconciliation(l,'/inventory',day)).every(r=>r.difference==='0'))
  const [cost]=await db.execute<{cost:string}>(q`SELECT sum(remaining_cost)::text cost FROM inventory_cost_layer WHERE item_id=${fg}::uuid`);assert.equal(cost.cost,method==='fifo'?'4000':'12500')
  // A lower actual wage is a signed correction, not a new positive conversion cost.
  const input2={...input,eligibleGross:8000n,date:'2026-01-17',key:randomUUID()},p2=await previewLabourSettlement(me,l,input2),s2=await settleLabourPeriod(me,l,{...input2,reviewHash:p2.reviewHash});assert.equal(p2.actual,8000n)
  assert((await operationsReconciliation(l,'/inventory','2026-01-17')).every(r=>r.difference==='0'))
  const file=await exportCompany(company.company.id),copy=await restoreCompany(file,me.email,{code:method==='fifo'?'LABFCOPY':'LABMCOPY',name:'Copied daily labour '+method})
  assert((await operationsReconciliation(copy.ledgerId!,'/inventory','2026-01-17')).every(r=>r.difference==='0'))
  // Restore locators are exercised by reversing through the copied settlement snapshot and cost history.
  const [cs]=await db.execute<{id:string}>(q`SELECT st.id::text FROM production_labour_settlement st WHERE st.ledger_id=${copy.ledgerId}::uuid AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id)`)
  await reverseLabourSettlement(me,copy.ledgerId!,{settlementId:cs.id,date:'2026-01-18',note:'Copied source reversal',key:randomUUID()});assert((await operationsReconciliation(copy.ledgerId!,'/inventory','2026-01-18')).every(r=>r.difference==='0'))
  assert((await productionReport(l,'2026-01-01','2026-01-17')).some(e=>e.kind==='labour_settlement'))
  const viewer=await createUser({email:`inventory-${method}@example.test`,firstName:'Inventory only',password:'Synthetic inventory-only test password',actor:me.email});await setGrants({userId:viewer.id,entityIds:[company.company.id],modules:['/inventory'],actor:me.email})
  await assert.rejects(()=>labourOptions(viewer,l,order));await assert.rejects(()=>createLabourPeriod(viewer,l,{...estimate,start:'2026-02-01',end:'2026-02-15',payDate:'2026-02-15',key:randomUUID()}))
  // Corrupted copies cannot bypass source totals while replay triggers are suppressed.
  const tampered=structuredClone(file);tampered.rows.production_labour_settlement_line[0].gross_cost='999999'
  await assert.rejects(()=>restoreCompany(tampered,me.email,{code:'BAD'+(method==='fifo'?'F':'M'),name:'Reject tampered labour'}),e=>errorText(e).includes('LABOUR_SETTLEMENT_CEILING'))
  const mirrors=structuredClone(file);for(const st of mirrors.rows.production_labour_settlement){(st.snapshot as {estimated:string;actual:string;lines:unknown[]}).estimated='999999';(st.snapshot as {actual:string}).actual='888888';(st.snapshot as {lines:unknown[]}).lines=[]}
  const mc=await restoreCompany(mirrors,me.email,{code:method==='fifo'?'MIRF':'MIRM',name:'Non-authoritative JSON mirrors '+method}),[ms]=await db.execute<{id:string}>(q`SELECT st.id::text FROM production_labour_settlement st WHERE st.ledger_id=${mc.ledgerId}::uuid AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id)`)
  await reverseLabourSettlement(me,mc.ledgerId!,{settlementId:ms.id,date:'2026-01-18',note:'Use authoritative relational costs rather than JSON mirrors',key:randomUUID()});assert((await operationsReconciliation(mc.ledgerId!,'/inventory','2026-01-18')).every(r=>r.difference==='0'))
  const badTransfer=structuredClone(file);badTransfer.rows.inventory_cost_layer.find(x=>x.transfer_source_layer_id!==null)!.transfer_source_layer_id=null
  await assert.rejects(()=>restoreCompany(badTransfer,me.email,{code:'BADDONOR'+(method==='fifo'?'F':'M'),name:'Reject missing transfer donor '+method}),e=>errorText(e).includes('LABOUR_TRANSFER_SOURCE'))
  void s2
  console.log(`PASS LAB-${method}: daily estimate, partial completion before payday, sale, transfer, ${method} variance, post-settlement sale, reversal, negative correction, exact historical GL, backup replay and payroll permissions`)
 }
 await boundaryCases(me)
 // CPP/EI can be estimated before month end; posted annual maxima stop the forecast deductions.
 const [co]=await db.execute<{id:string;ledger:string;cash:string}>(q`SELECT e.id::text,l.id::text ledger,a.id::text cash FROM entity e JOIN ledger l ON l.entity_id=e.id JOIN account a ON a.entity_id=e.id AND a.code='1002' WHERE e.code='LABFIFO'`)
 const person=await createParty({kind:'person',name:'Annual cap employee',roles:[{entityId:co.id,role:'employee',heldFrom:'2026-01-01'}],actor:me.email}),employee=await saveEmployee({ledgerId:co.ledger,partyId:person.id,frequency:'semi_monthly',hiredOn:'2026-01-01',actor:me.email})
 await runPayroll({ledgerId:co.ledger,payDate:'2026-01-31',periodStart:'2026-01-16',periodEnd:'2026-01-31',bankAccountId:co.cash,lines:[{employeeId:employee.id,gross:10000000n}],actor:me.email})
 const cap=await createLabourPeriod(me,co.ledger,{employeeId:employee.id,start:'2026-02-01',end:'2026-02-15',payDate:'2026-02-15',basis:'fixed',hourlyRate:0n,paidHours:8000n,normalHours:7000n,gross:100000n,note:'Paid holiday included; normal capacity separately reviewed',key:randomUUID()})
 const [period]=await db.execute<{employer:string}>(q`SELECT employer_cost::text employer FROM production_labour_period WHERE id=${cap}::uuid`);assert.equal(period.employer,'0');const [count]=await db.execute<{n:string}>(q`SELECT count(*)::text n FROM pay_stub WHERE employee_id=${employee.id}::uuid`);assert.equal(count.n,'1')
 console.log('PASS LAB-CAPS: complete-pay-period engine uses posted CPP, CPP2 and EI YTD annual ceilings, separate normal and paid hours, no actual stub from forecast')
}
main().then(()=>console.log('=== ALL CHECKS PASSED ===')).catch(e=>{console.error(errorText(e));process.exitCode=1}).finally(()=>connection.end())

async function boundaryCases(me:Awaited<ReturnType<typeof createFirstOwner>>){
 const co=await createCompanyWithYear({code:'LABEDGE',name:'Labour boundary cases'},me.email),l=co.ledger.id
 const accounts=await importAccounts(co.company.id,parseAccountsCsv(STARTER_CHART).map(a=>({...a,entityId:co.company.id})),me.email),cash=accounts.find(a=>a.code==='1002')!.id,equity=accounts.find(a=>a.code==='3500')!.id
 await initializeOperationsFinance(me,l,'/inventory');const rows=await operationsReconciliation(l,'/inventory','2026-01-01');await connectOperationsFinance(me,l,'/inventory',{date:'2026-01-01',fundingAccountId:cash,openingAccountId:equity,expectedHash:reconciliationHash(rows,'2026-01-01',await operationsLatestDate(l,'/inventory')),taxRateBp:0,taxRateNote:'',ccaStrategy:'maximum'})
 await saveInventorySettings(me,l,{version:0,warehousesEnabled:false,costMethod:'fifo'})
 const wh=(await inventoryWarehouses(l))[0].id,item=(sku:string,kind:string)=>saveInventoryItem(me,l,{sku,name:sku,kind,unit:'each',reorderLevel:0n,trackBatches:false,trackSerials:false,isActive:true,notes:''})
 const raw=await item('FREE','raw_material'),fg=await item('UPSTREAM','finished_goods'),down=await item('DOWNSTREAM','finished_goods')
 await recordStockMovement(me,l,{itemId:raw,kind:'receipt',date:'2026-03-01',quantity:Q('30'),cost:0n,fromWarehouseId:'',toWarehouseId:wh,batch:'',serials:[],reference:'',note:'Free material for cent tests',key:randomUUID(),finance:{counterpartAccountId:cash}})
 const bom=await saveBom(me,l,{code:'UP',name:'Upstream',outputItemId:fg,outputQuantity:Q('1'),components:[{itemId:raw,quantity:Q('1')}],notes:'',isActive:true}),dbom=await saveBom(me,l,{code:'DOWN',name:'Downstream',outputItemId:down,outputQuantity:Q('1'),components:[{itemId:fg,quantity:Q('1')}],notes:'',isActive:true})
 const create=(bomId:string,date:string)=>createProductionOrder(me,l,{bomId,quantity:Q('3'),warehouseId:wh,startDate:date,dueDate:'',notes:'',key:randomUUID()})
 const event=async(orderId:string,patch:Partial<ProductionAction>)=>recordProductionEvent(me,l,{orderId,version:(await productionOrderDetail(l,orderId))!.order.version,kind:'material_issue',date:'2026-03-02',itemId:raw,sourceEventId:'',quantity:Q('3'),cost:0n,batch:'',serials:[],note:'Boundary cost source',key:randomUUID(),...patch})
 const party=await createParty({kind:'person',name:'Cent boundary worker',roles:[{entityId:co.company.id,role:'employee',heldFrom:'2026-01-01'}],actor:me.email}),employee=await saveEmployee({ledgerId:l,partyId:party.id,frequency:'semi_monthly',hiredOn:'2026-01-01',cppExempt:true,eiExempt:true,actor:me.email})
 const estimate=(start:string,end:string,gross:bigint,hours=100n)=>createLabourPeriod(me,l,{employeeId:employee.id,start,end,payDate:end,basis:'fixed',hourlyRate:0n,paidHours:hours,normalHours:hours,gross,note:'Synthetic normal-capacity review',key:randomUUID()})
 const time=(orderId:string,date:string)=>recordProductionTime(me,l,{orderId,employeeId:employee.id,date,hours:100n,note:'Boundary labour',key:randomUUID()})
 const payroll=async(start:string,end:string,gross:bigint)=>{const pay=await runPayroll({ledgerId:l,payDate:end,periodStart:start,periodEnd:end,bankAccountId:cash,lines:[{employeeId:employee.id,gross,hours:0n}],actor:me.email});return (await payRunDetail(l,pay.runId))!.stubs[0].id}
 const confirm=async(input:SettlementInput)=>{const p=await previewLabourSettlement(me,l,input);return settleLabourPeriod(me,l,{...input,reviewHash:p.reviewHash})}
 const period=await estimate('2026-03-01','2026-03-15',1n),order=await create(bom,'2026-03-02');await event(order,{})
 const t=await time(order,'2026-03-02');await accrueProductionTime(me,l,{timeId:t,periodId:period,key:randomUUID()})
 for(let i=0;i<3;i++)await event(order,{kind:'completion',quantity:Q('1')})
 const second=await create(dbom,'2026-03-03'),issue=await event(second,{date:'2026-03-03',itemId:fg})
 const stub=await payroll('2026-03-01','2026-03-15',2n),input:SettlementInput={periodId:period,payStubId:stub,date:'2026-03-15',eligibleGross:2n,normalHours:100n,note:'Actual eligible pay',key:randomUUID()},st=await confirm(input)
 assert.equal((await productionOrderDetail(l,second))!.order.wip_cost,'2')
 await refuse('RETURN_SETTLEMENT',()=>event(second,{kind:'material_return',date:'2026-03-15',sourceEventId:issue,itemId:fg}))
 await reverseLabourSettlement(me,l,{settlementId:st,date:'2026-03-15',note:'Return material before re-settlement',key:randomUUID()})
 await event(second,{kind:'material_return',date:'2026-03-15',sourceEventId:issue,itemId:fg});assert.equal((await productionOrderDetail(l,second))!.order.wip_cost,'0')
 await confirm({...input,key:randomUUID()});const [value]=await db.execute<{cost:string}>(q`SELECT sum(remaining_cost)::text cost FROM inventory_cost_layer WHERE item_id=${fg}::uuid`);assert.equal(value.cost,'2')
 const third=await create(dbom,'2026-03-16'),src=await event(third,{date:'2026-03-16',itemId:fg});await event(third,{kind:'completion',date:'2026-03-16',quantity:Q('1')})
 // Over-issue another source, then try to return the entire already-consumed original source.
 await recordStockMovement(me,l,{itemId:fg,kind:'receipt',date:'2026-03-16',quantity:Q('3'),cost:3n,fromWarehouseId:'',toWarehouseId:wh,batch:'',serials:[],reference:'',note:'Separate source',key:randomUUID(),finance:{counterpartAccountId:cash}})
 await event(third,{date:'2026-03-16',itemId:fg});await refuse('RETURN_SOURCE',()=>event(third,{kind:'material_return',date:'2026-03-16',sourceEventId:src,itemId:fg}))
 const micro=await estimate('2026-03-16','2026-03-31',1n),tiny=await create(bom,'2026-03-20');await event(tiny,{date:'2026-03-20'})
 const wrong=await time(tiny,'2026-03-20'),ac=await accrueProductionTime(me,l,{timeId:wrong,periodId:micro,key:randomUUID()})
 const rv={accrualId:ac,date:'2026-03-20',note:'Wrong time row',key:randomUUID()},ar=await reverseLabourAccrual(me,l,rv);assert.equal(await reverseLabourAccrual(me,l,rv),ar)
 await cancelProductionTime(me,l,{id:wrong,version:1});const corrected=await time(tiny,'2026-03-20');await accrueProductionTime(me,l,{timeId:corrected,periodId:micro,key:randomUUID()})
 for(let i=0;i<3;i++)await event(tiny,{kind:'completion',date:'2026-03-20',quantity:Q('1')})
 const ms=await payroll('2026-03-16','2026-03-31',1n),mi:SettlementInput={periodId:micro,payStubId:ms,date:'2026-03-31',eligibleGross:0n,normalHours:100n,note:'Actual eligible labour is zero',key:randomUUID()},mp=await previewLabourSettlement(me,l,mi)
 assert.equal(mp.corrections.reduce((n,c)=>n+c.amount,0n),-1n);await settleLabourPeriod(me,l,{...mi,reviewHash:mp.reviewHash})
 const file=await exportCompany(co.company.id),bad=structuredClone(file);const stock=bad.rows.production_labour_cost_adjustment.find(x=>x.target_kind==='stock')!;stock.cost_after=(BigInt(String(stock.cost_after))+1n).toString()
 await assert.rejects(()=>restoreCompany(bad,me.email,{code:'LABBADPRICE',name:'Reject changed pricing basis'}),e=>errorText(e).includes('LABOUR_CORRECTION_SCOPE'))
 const p3=await estimate('2026-05-01','2026-05-15',100n,300n),round=await create(bom,'2026-05-02');await event(round,{date:'2026-05-02'})
 const daily:string[]=[],times:string[]=[]
 for(const date of ['2026-05-02','2026-05-03','2026-05-04']){const tid=await time(round,date);times.push(tid);daily.push(await accrueProductionTime(me,l,{timeId:tid,periodId:p3,key:randomUUID()}))}
 await reverseLabourAccrual(me,l,{accrualId:daily[1],date:'2026-05-04',note:'Correct the middle day without changing adjacent history',key:randomUUID()})
 assert.equal((await productionOrderDetail(l,round))!.order.wip_cost,'66')
 await cancelProductionTime(me,l,{id:times[1],version:1});const replacement=await time(round,'2026-05-03');await accrueProductionTime(me,l,{timeId:replacement,periodId:p3,date:'2026-05-04',key:randomUUID()});assert.equal((await productionOrderDetail(l,round))!.order.wip_cost,'99')
 assert((await operationsReconciliation(l,'/inventory','2026-05-04')).every(r=>r.difference==='0'))
 const pay3=await payroll('2026-05-01','2026-05-15',100n),input3:SettlementInput={periodId:p3,payStubId:pay3,date:'2026-05-15',eligibleGross:100n,normalHours:300n,note:'Close-period atomicity',key:randomUUID()},preview3=await previewLabourSettlement(me,l,input3)
 const glPeriod=(await periodOverview(l)).find(p=>p.start_date<='2026-05-15'&&p.end_date>='2026-05-15')!;await closePeriod(l,glPeriod.id,{actor:me.email})
 const before=(await db.execute<{n:string}>(q`SELECT count(*)::text n FROM production_labour_settlement WHERE ledger_id=${l}::uuid`))[0].n
 await refuse('PERIOD_CLOSED',()=>settleLabourPeriod(me,l,{...input3,reviewHash:preview3.reviewHash}));assert.equal((await db.execute<{n:string}>(q`SELECT count(*)::text n FROM production_labour_settlement WHERE ledger_id=${l}::uuid`))[0].n,before)
 console.log('PASS LAB-EDGES: upstream variance into downstream WIP, recoverable return preflight and re-settlement into returned stock, consumed-issue return refusal, unused daily reversal/time correction, zero-cost output negative-cent rounding, mid-period reversal rounding and corrupt FIFO pricing basis refusal')
}

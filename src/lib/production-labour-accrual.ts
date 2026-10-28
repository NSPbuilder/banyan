import 'server-only'
import {createHash,randomUUID} from 'node:crypto'
import {sql} from 'drizzle-orm'
import type {Tx} from './acting'
import type {UserRecord} from './users'
import {operationWrite,operationScope,operationId,operationDate,operationText,operationAmount,OperationsError} from './operations-scope'
import {previewPayRun} from './payroll/runs'
import {accountId,financialDay,postOperationsEvent} from './operations-finance'
import {labourShare,fraction,roundedShares} from './production-labour-math'
import {traceLabourCost,type FlowSeed,type FlowEvent,type FlowLayer,type FlowAllocation,type CostTarget} from './production-labour-cost-flow'
import {distributeCost} from './inventory-cost'
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)
const hash=(v:unknown)=>createHash('sha256').update(json(v)).digest('hex')
export type LabourPeriod={id:string;employee_id:string;employee_name:string;period_start:string;period_end:string;pay_date:string;wage_basis:string;hourly_rate:string;paid_hours:string;normal_hours:string;gross:string;employer_cost:string;accrued_hours:string;settlement_id:string|null;note:string}
export type LabourAccrual={id:string;time_id:string;period_id:string;event_id:string;gross_cost:string;employer_cost:string;actual_gross:string|null;actual_employer:string|null;settlement_id:string|null}
export type LabourStub={id:string;employee_id:string;employee_name:string;pay_date:string;period_start:string;period_end:string;gross:string;bonus:string;employer:string;entry_id:string}
export type PeriodInput={employeeId:string;start:string;end:string;payDate:string;basis:'hourly'|'fixed';hourlyRate:bigint;paidHours:bigint;normalHours:bigint;gross:bigint;pensionable?:bigint;insurable?:bigint;note:string;key:string}
export type SettlementInput={periodId:string;payStubId:string;date:string;eligibleGross:bigint;normalHours:bigint;note:string;key:string;reviewHash?:string}
const active=`NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id)`
export async function labourOptions(me:UserRecord,ledgerId:string,orderId:string) {
 return operationWrite(me,ledgerId,'/inventory',async tx=>{
  await operationScope(tx,me,ledgerId,'/payroll')
  const [periods,accruals,stubs]=await Promise.all([
   tx.execute<LabourPeriod>(sql`SELECT p.id::text,p.employee_id::text,pt.name employee_name,p.period_start::text,p.period_end::text,p.pay_date::text,p.wage_basis,p.hourly_rate::text,p.paid_hours::text,p.normal_hours::text,p.gross::text,p.employer_cost::text,p.note,
    coalesce((SELECT sum(t.hours) FROM production_labour_accrual a JOIN production_time t ON t.id=a.time_id WHERE a.period_id=p.id AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=a.id)),0)::text accrued_hours,
    (SELECT st.id::text FROM production_labour_settlement st WHERE st.period_id=p.id AND st.reverse_of IS NULL AND ${sql.raw(active)}) settlement_id
    FROM production_labour_period p JOIN payroll_employee pe ON pe.id=p.employee_id JOIN party pt ON pt.id=pe.party_id WHERE p.ledger_id=${ledgerId}::uuid ORDER BY p.period_start DESC,pt.name`),
   tx.execute<LabourAccrual>(sql`SELECT a.id::text,a.time_id::text,a.period_id::text,a.event_id::text,a.gross_cost::text,a.employer_cost::text,sl.gross_cost::text actual_gross,sl.employer_cost::text actual_employer,st.id::text settlement_id
    FROM production_labour_accrual a JOIN production_time t ON t.id=a.time_id
    LEFT JOIN production_labour_settlement_line sl ON sl.accrual_id=a.id AND EXISTS(SELECT 1 FROM production_labour_settlement st WHERE st.id=sl.settlement_id AND st.reverse_of IS NULL AND ${sql.raw(active)})
    LEFT JOIN production_labour_settlement st ON st.id=sl.settlement_id WHERE a.ledger_id=${ledgerId}::uuid AND t.order_id=${operationId(orderId)}::uuid AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=a.id)`),
   availableStubs(tx,ledgerId)
  ])
  return {periods,accruals,stubs}
 })
}
async function availableStubs(tx:Tx,ledgerId:string) {
 return tx.execute<LabourStub>(sql`SELECT s.id::text,s.employee_id::text,pt.name employee_name,r.pay_date::text,r.period_start::text,r.period_end::text,s.gross::text,s.bonus::text,(s.employer_cpp+s.employer_cpp2+s.employer_ei)::text employer,r.entry_id::text
 FROM pay_stub s JOIN pay_run r ON r.id=s.pay_run_id JOIN journal_entry j ON j.id=r.entry_id JOIN payroll_employee pe ON pe.id=s.employee_id JOIN party pt ON pt.id=pe.party_id
 WHERE r.ledger_id=${ledgerId}::uuid AND j.status='posted' AND r.period_start IS NOT NULL AND r.period_end IS NOT NULL ORDER BY r.pay_date DESC,s.id`)
}
export async function createLabourPeriod(me:UserRecord,ledgerId:string,input:PeriodInput) {
 operationId(input.employeeId);operationId(input.key);operationDate(input.start);operationDate(input.end);operationDate(input.payDate)
 for(const amount of [input.hourlyRate,input.paidHours,input.normalHours,input.gross])operationAmount(amount)
 if(input.start>input.end||input.payDate<input.end)throw new OperationsError('PERIOD','The expected payday must follow the work period.')
 if(!['hourly','fixed'].includes(input.basis)||input.normalHours<=0n||input.paidHours<=0n)throw new OperationsError('BASIS','Enter paid and normal available hours above zero.')
 const days=(Date.parse(input.end)-Date.parse(input.start))/86400000+1
 if(days>366||input.paidHours>BigInt(days)*2400n||input.normalHours>BigInt(days)*2400n)throw new OperationsError('HOURS','Review the period length and its available hours.')
 const gross=input.basis==='hourly'?(input.hourlyRate*input.paidHours+50n)/100n:input.gross
 if(gross<=0n)throw new OperationsError('GROSS','Enter a positive expected gross pay.')
 const note=operationText(input.note,'Cost basis review',10000,true),requestHash=hash({...input,note})
 return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
  await operationScope(tx,me,ledgerId,'/payroll')
  if(s.currency!=='CAD')throw new OperationsError('CURRENCY','Canadian payroll estimates require a CAD ledger.')
  const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_labour_period WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
  if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This estimate request has different values.');return prior.id}
  if((await tx.execute(sql`SELECT 1 FROM production_labour_period WHERE ledger_id=${ledgerId}::uuid AND employee_id=${input.employeeId}::uuid AND period_start<=${input.end}::date AND period_end>=${input.start}::date`)).length)throw new OperationsError('PERIOD','This employee already has an estimate for an overlapping work period.')
  // The statutory engine sees one complete expected pay period, with posted YTD and its CRA edition.
  // Nothing here creates a pay stub, deduction, remittance or actual YTD contribution.
  const preview=await previewPayRun({ledgerId,payDate:input.payDate,lines:[{employeeId:input.employeeId,gross,pensionable:input.pensionable,insurable:input.insurable}]})
  const stub=preview.stubs[0],employer=stub.employerCpp+stub.employerCpp2+stub.employerEi
  await tx.execute(sql`SELECT set_config('app.inventory_write','on',true)`)
  const [r]=await tx.execute<{id:string}>(sql`INSERT INTO production_labour_period(ledger_id,employee_id,period_start,period_end,pay_date,wage_basis,hourly_rate,paid_hours,normal_hours,gross,employer_cost,snapshot,note,request_key,request_hash,created_by)
   VALUES(${ledgerId}::uuid,${input.employeeId}::uuid,${input.start}::date,${input.end}::date,${input.payDate}::date,${input.basis},${input.hourlyRate},${input.paidHours},${input.normalHours},${gross},${employer},${json({engine:stub,input,calculatedAt:new Date().toISOString()})}::jsonb,${note},${input.key}::uuid,${requestHash},${s.email}) RETURNING id::text`)
  return r.id
 })
}
export async function accrueProductionTime(me:UserRecord,ledgerId:string,input:{timeId:string;periodId:string;key:string;date?:string}) {
 operationId(input.timeId);operationId(input.periodId);operationId(input.key);const requestHash=hash(input)
 return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
  await operationScope(tx,me,ledgerId,'/payroll')
  const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_labour_accrual WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
  if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This accrual request has different values.');return prior.id}
  const [t]=await tx.execute<{order_id:string;employee_id:string;work_date:string;hours:string;cancelled:boolean}>(sql`SELECT order_id::text,employee_id::text,work_date::text,hours::text,cancelled FROM production_time WHERE ledger_id=${ledgerId}::uuid AND id=${input.timeId}::uuid FOR UPDATE`)
  const [p]=await tx.execute<LabourPeriod>(sql`SELECT *,period_start::text,period_end::text,pay_date::text FROM production_labour_period WHERE ledger_id=${ledgerId}::uuid AND id=${input.periodId}::uuid FOR UPDATE`)
  if(!t||!p||t.cancelled||p.employee_id!==t.employee_id||t.work_date<p.period_start||t.work_date>p.period_end)throw new OperationsError('TIME','Choose active work within this employee’s estimated pay period.')
  if((await tx.execute(sql`SELECT 1 FROM production_labour_accrual WHERE time_id=${input.timeId}::uuid UNION ALL SELECT 1 FROM production_payroll_allocation a WHERE time_id=${input.timeId}::uuid AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id)`)).length)throw new OperationsError('ALLOCATED','This time already has labour cost.')
  if((await tx.execute(sql`SELECT 1 FROM production_labour_settlement st WHERE period_id=${p.id}::uuid AND st.reverse_of IS NULL AND ${sql.raw(active)}`)).length)throw new OperationsError('SETTLED','Reverse the settlement before adding more accrued time to this period.')
  const [o]=await tx.execute<{status:string;latest:string}>(sql`SELECT status,coalesce((SELECT max(event_date) FROM production_event WHERE order_id=o.id),start_date)::text latest FROM production_order o WHERE id=${t.order_id}::uuid FOR UPDATE`)
  const eventDate=operationDate(input.date??t.work_date)
  if(eventDate<t.work_date)throw new OperationsError('DATE','An accrual cannot precede the actual work date.')
  if(o.status!=='in_progress'||eventDate<o.latest)throw new OperationsError('DATE',`Accrue time on an open order, dated ${o.latest} or later, before output is completed.`)
  if(!await financialDay(tx,ledgerId,'/inventory',eventDate))throw new OperationsError('FINANCE_SETUP','Connect Inventory to Finance first.')
  const [used]=await tx.execute<{hours:string;gross:string;employer:string}>(sql`SELECT coalesce(sum(t.hours),0)::text hours,coalesce(sum(a.gross_cost),0)::text gross,coalesce(sum(a.employer_cost),0)::text employer FROM production_labour_accrual a JOIN production_time t ON t.id=a.time_id WHERE a.period_id=${p.id}::uuid AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=a.id)`)
  const hours=BigInt(used.hours)+BigInt(t.hours)
  if(hours>BigInt(p.normal_hours))throw new OperationsError('CAPACITY','Accrued productive hours exceed the reviewed normal available hours.')
  const gross=labourShare(BigInt(p.gross),BigInt(t.hours),BigInt(p.normal_hours)),employer=labourShare(BigInt(p.employer_cost),BigInt(t.hours),BigInt(p.normal_hours))
  await tx.execute(sql`SELECT set_config('app.inventory_write','on',true)`)
  const [e]=await tx.execute<{id:string}>(sql`INSERT INTO production_event(ledger_id,order_id,event_date,kind,quantity,cost,note,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${t.order_id}::uuid,${eventDate}::date,'labour_accrual',0,${gross+employer},'Estimated daily production labour',${input.key}::uuid,${requestHash},${s.email}) RETURNING id::text`)
  const [a]=await tx.execute<{id:string}>(sql`INSERT INTO production_labour_accrual(ledger_id,period_id,time_id,event_id,gross_cost,employer_cost,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${p.id}::uuid,${input.timeId}::uuid,${e.id}::uuid,${gross},${employer},${input.key}::uuid,${requestHash},${s.email}) RETURNING id::text`)
  await postOperationsEvent(tx,{ledgerId,seat:'/inventory',kind:'production',sourceId:e.id,date:eventDate,actor:s.email,description:'Daily production labour accrual',lines:[{accountId:await accountId(tx,ledgerId,'/inventory','wip'),amount:gross+employer},{accountId:await accountId(tx,ledgerId,'/inventory','labour_accrual'),amount:-gross-employer}],snapshot:{workDate:t.work_date,postingDate:eventDate,periodId:p.id,timeId:input.timeId,accrualId:a.id,gross,employer,normalHours:p.normal_hours}})
  await tx.execute(sql`UPDATE production_order SET version=version+1 WHERE id=${t.order_id}::uuid`)
  return a.id
 })
}

async function flowData(tx:Tx,ledgerId:string,date:string) {
 const [events,layers,allocations]=await Promise.all([
 tx.execute<FlowEvent>(sql`WITH mapped AS (SELECT m.key,m.account_id FROM operations_account m JOIN ledger l ON l.entity_id=m.entity_id WHERE l.id=${ledgerId}::uuid AND m.seat='/inventory')
 SELECT e.id::text,e.event_date::text date,e.created_at::text stamp,e.kind,e.order_id::text,e.movement_id::text,coalesce(e.source_event_id,(SELECT ac.event_id FROM production_labour_accrual_reversal v JOIN production_labour_accrual ac ON ac.id=v.accrual_id WHERE v.event_id=e.id))::text source_event_id,e.quantity::text,o.planned_quantity::text,e.item_id::text,m.from_warehouse_id::text,m.to_warehouse_id::text,
 coalesce(m.cost_method,j.snapshot->>'costMethod','fifo') cost_method,coalesce(j.snapshot->'input'->>'counterpartAccountId',(SELECT account_id::text FROM mapped WHERE key='adjustment')) expense_account_id
 FROM production_event e JOIN production_order o ON o.id=e.order_id LEFT JOIN inventory_movement m ON m.id=e.movement_id LEFT JOIN operations_journal_event j ON j.source_kind='production' AND j.source_id=e.id AND j.ledger_id=e.ledger_id
 WHERE e.ledger_id=${ledgerId}::uuid AND e.event_date<=${date}::date
 UNION ALL SELECT m.id::text,m.movement_date::text,m.created_at::text,m.kind,NULL::text,m.id::text,NULL::text,m.quantity::text,'0',m.item_id::text,m.from_warehouse_id::text,m.to_warehouse_id::text,m.cost_method,
 coalesce(j.snapshot->'input'->>'counterpartAccountId',(SELECT account_id::text FROM mapped WHERE key=CASE WHEN m.kind='issue' THEN 'cogs' ELSE 'adjustment' END))
 FROM inventory_movement m LEFT JOIN operations_journal_event j ON j.source_kind='inventory' AND j.source_id=m.id AND j.ledger_id=m.ledger_id
 WHERE m.ledger_id=${ledgerId}::uuid AND m.movement_date<=${date}::date AND NOT EXISTS(SELECT 1 FROM production_event e WHERE e.movement_id=m.id)
 ORDER BY date,stamp,id`),
 tx.execute<FlowLayer>(sql`SELECT id::text,movement_id::text,item_id::text,warehouse_id::text,quantity::text,transfer_source_layer_id::text FROM inventory_cost_layer WHERE ledger_id=${ledgerId}::uuid`),
 tx.execute<FlowAllocation>(sql`SELECT movement_id::text,layer_id::text,quantity::text FROM inventory_cost_allocation WHERE ledger_id=${ledgerId}::uuid`)
 ])
 return {events,layers,allocations}
}
type AccrualRow={id:string;event_id:string;order_id:string;hours:string;gross_cost:string;employer_cost:string}
type Correction={target:CostTarget;amount:bigint}
/** Quantity proportions may put a rounding cent on a zero-cost output layer.
 * Keep corrections on traced destinations while respecting their recorded carrying costs.
 */
async function boundedCorrections(tx:Tx,ledgerId:string,rows:Correction[]) {
 const capacities:(bigint|null)[]=[]
 for(const c of rows){
  if(c.target.kind==='expense'){capacities.push(null);continue}
  const [r]=c.target.kind==='stock'?await tx.execute<{cost:string}>(sql`SELECT remaining_cost::text cost FROM inventory_cost_layer WHERE ledger_id=${ledgerId}::uuid AND id=${c.target.id}::uuid`):c.target.kind==='wip'?await tx.execute<{cost:string}>(sql`SELECT coalesce(sum(CASE WHEN kind IN ('material_issue','conversion_cost','labour_accrual','labour_adjustment') THEN cost ELSE -cost END),0)::text cost FROM production_event WHERE ledger_id=${ledgerId}::uuid AND order_id=${c.target.id}::uuid`):[]
  capacities.push(BigInt(r?.cost??0))
 }
 let residual=0n
 const result=rows.map((c,i)=>{const cap=capacities[i],amount=cap!==null&&c.amount< -cap?-cap:c.amount;residual+=c.amount-amount;return {...c,amount}})
 for(const i of result.map((_,i)=>i).sort((a,b)=>Number(capacities[a]===null)-Number(capacities[b]===null))){const c=result[i]
  if(!residual)break
  const room=capacities[i]===null?-residual:capacities[i]!+c.amount,take=room< -residual?room:-residual
  if(take>0n){c.amount-=take;residual+=take}
 }
 if(residual)throw new OperationsError('COST','The negative correction exceeds the recorded costs at its traced destinations. Review the eligible-pay basis.')
 return result.filter(c=>c.amount!==0n)
}
async function prepareSettlement(tx:Tx,ledgerId:string,input:SettlementInput) {
 const [p]=await tx.execute<LabourPeriod>(sql`SELECT *,period_start::text,period_end::text FROM production_labour_period WHERE ledger_id=${ledgerId}::uuid AND id=${input.periodId}::uuid FOR UPDATE`)
 await tx.execute(sql`SELECT id FROM pay_stub WHERE id=${input.payStubId}::uuid FOR UPDATE`)
 const stub=(await availableStubs(tx,ledgerId)).find(s=>s.id===input.payStubId)
 if(!p||!stub||stub.employee_id!==p.employee_id||stub.period_start!==p.period_start||stub.period_end!==p.period_end)throw new OperationsError('PAYROLL_SCOPE','Choose a posted stub with the same employee and complete work period.')
 await tx.execute(sql`SELECT id FROM journal_entry WHERE id=${stub.entry_id}::uuid FOR UPDATE`)
 if(input.date<stub.pay_date)throw new OperationsError('DATE','Settle on the actual payday or later.')
 if((await tx.execute(sql`SELECT 1 FROM production_labour_settlement st WHERE st.reverse_of IS NULL AND ${sql.raw(active)} AND (st.period_id=${p.id}::uuid OR st.pay_stub_id=${stub.id}::uuid)
 UNION ALL SELECT 1 FROM production_payroll_allocation a WHERE a.pay_stub_id=${stub.id}::uuid AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id)`)).length)throw new OperationsError('SETTLED','This period or payroll stub already has active production allocations. Reverse them first.')
 const rows=await tx.execute<AccrualRow>(sql`SELECT a.id::text,a.event_id::text,t.order_id::text,t.hours::text,a.gross_cost::text,a.employer_cost::text FROM production_labour_accrual a JOIN production_time t ON t.id=a.time_id WHERE a.period_id=${p.id}::uuid AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=a.id) ORDER BY t.work_date,a.created_at,a.id`)
 if(!rows.length)throw new OperationsError('ACCRUAL','Accrue productive time before settlement.')
 const hours=rows.reduce((n,a)=>n+BigInt(a.hours),0n)
 if(input.normalHours<hours||input.normalHours<=0n||input.eligibleGross<0n||input.eligibleGross>BigInt(stub.gross)-BigInt(stub.bonus))throw new OperationsError('BASIS','Review normal available hours and eligible regular gross; productive hours and regular pay are the limits.')
 const employer=(BigInt(stub.employer)*input.eligibleGross+BigInt(stub.gross)/2n)/BigInt(stub.gross)
 const wageAccounts=await tx.execute<{id:string}>(sql`SELECT DISTINCT jl.account_id::text id FROM journal_line jl JOIN account_role ar ON ar.account_id=jl.account_id AND ar.role='employee_benefits_expense' WHERE jl.entry_id=${stub.entry_id}::uuid AND jl.amount>0`)
 if(wageAccounts.length!==1)throw new OperationsError('PAYROLL_ACCOUNT','One original payroll wage expense account must be identifiable.')
 const data=await flowData(tx,ledgerId,input.date),corrections=new Map<string,Correction>()
 let usedHours=0n,usedGross=0n,usedEmployer=0n,estimated=0n
 const lines=rows.map(a=>{
  usedHours+=BigInt(a.hours);const gross=labourShare(input.eligibleGross,usedHours,input.normalHours)-usedGross,burden=labourShare(employer,usedHours,input.normalHours)-usedEmployer;usedGross+=gross;usedEmployer+=burden
  const estimate=BigInt(a.gross_cost)+BigInt(a.employer_cost);estimated+=estimate
  const destinations=traceLabourCost(data.events,data.layers,data.allocations,[{eventId:a.event_id,target:{kind:'wip',id:a.order_id},value:fraction(1n)}])
  for(const row of roundedShares(destinations,gross+burden-estimate)){const key=row.target.kind+row.target.id,prior=corrections.get(key);corrections.set(key,{target:row.target,amount:row.amount+(prior?.amount??0n)})}
  return {accrualId:a.id,orderId:a.order_id,hours:a.hours,gross,employer:burden,estimated:estimate}
 })
 const actual=usedGross+usedEmployer
 return {period:p,stub,lines,estimated,actual,expenseAccountId:wageAccounts[0].id,corrections:await boundedCorrections(tx,ledgerId,[...corrections.values()])}
}
async function postingDate(tx:Tx,ledgerId:string,date:string) {
 if(!await financialDay(tx,ledgerId,'/inventory',date))throw new OperationsError('FINANCE_SETUP','Connect Inventory to Finance first.')
 const [latest]=await tx.execute<{date:string|null}>(sql`SELECT max(d)::text date FROM (SELECT movement_date d FROM inventory_movement WHERE ledger_id=${ledgerId}::uuid UNION ALL SELECT event_date FROM production_event WHERE ledger_id=${ledgerId}::uuid) h`)
 if(latest.date&&date<latest.date)throw new OperationsError('DATE',`Cost corrections must be dated ${latest.date} or later; later cost history already exists.`)
}
export async function previewLabourSettlement(me:UserRecord,ledgerId:string,input:SettlementInput) {
 validateSettlement(input)
 return operationWrite(me,ledgerId,'/inventory',async tx=>{await operationScope(tx,me,ledgerId,'/payroll');await postingDate(tx,ledgerId,input.date);const plan=await prepareSettlement(tx,ledgerId,input);return {...plan,reviewHash:hash(plan)}})
}
function validateSettlement(input:SettlementInput) {
 operationId(input.periodId);operationId(input.payStubId);operationId(input.key);operationDate(input.date);operationAmount(input.eligibleGross);operationAmount(input.normalHours);operationText(input.note,'Settlement review',10000,true)
}
async function applyCorrections(tx:Tx,ledgerId:string,settlementId:string,eventId:string,date:string,corrections:Correction[],actor:string,costMethod:string) {
 const result:{accountId:string;amount:bigint}[]=[],stock=new Map<string,bigint>()
 for(const c of corrections){
  if(c.target.kind==='stock'){stock.set(c.target.id,(stock.get(c.target.id)??0n)+c.amount);continue}
  const account=c.target.kind==='wip'?await accountId(tx,ledgerId,'/inventory','wip'):c.target.id
  let child:string|null=null
  if(c.target.kind==='wip'){
   const [w]=await tx.execute<{cost:string}>(sql`SELECT coalesce(sum(CASE WHEN kind IN ('material_issue','conversion_cost','labour_accrual','labour_adjustment') THEN cost ELSE -cost END),0)::text cost FROM production_event WHERE order_id=${c.target.id}::uuid`)
   if(BigInt(w.cost)+c.amount<0n)throw new OperationsError('COST','This correction would make WIP negative. Review the cost basis and cent rounding.')
   const [e]=await tx.execute<{id:string}>(sql`INSERT INTO production_event(ledger_id,order_id,event_date,kind,quantity,cost,note,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${c.target.id}::uuid,${date}::date,'labour_adjustment',0,${c.amount},'Payroll settlement cost correction',${randomUUID()}::uuid,${hash({settlementId,target:c.target,amount:c.amount})},${actor}) RETURNING id::text`)
   child=e.id
   await postOperationsEvent(tx,{ledgerId,seat:'/inventory',kind:'production',sourceId:e.id,date,actor,description:'Labour correction included in payroll settlement',lines:[],snapshot:{settlementId,eventId},zeroReason:'Financial lines are posted once in the linked payroll settlement journal'})
  }
  await tx.execute(sql`INSERT INTO production_labour_cost_adjustment(ledger_id,settlement_id,target_kind,order_id,account_id,amount,event_id) VALUES(${ledgerId}::uuid,${settlementId}::uuid,${c.target.kind},${c.target.kind==='wip'?c.target.id:null}::uuid,${account}::uuid,${c.amount},${child}::uuid)`)
  result.push({accountId:account,amount:c.amount})
 }
 // Re-pool MA after corrections. Dated rows include zero-net layer redistribution and a new FIFO pricing basis.
 if(stock.size){
  const layers=await tx.execute<{id:string;item_id:string;warehouse_id:string;kind:string;quantity:string;cost:string}>(sql`SELECT c.id::text,c.item_id::text,c.warehouse_id::text,i.kind,c.remaining_quantity::text quantity,c.remaining_cost::text cost FROM inventory_cost_layer c JOIN inventory_item i ON i.id=c.item_id WHERE c.ledger_id=${ledgerId}::uuid AND c.remaining_quantity>0 ORDER BY c.acquired_on,c.fifo_order,c.id FOR UPDATE OF c`)
  const groups=new Set(layers.filter(l=>stock.has(l.id)).map(l=>l.item_id+l.warehouse_id))
  for(const group of groups){const ls=layers.filter(l=>l.item_id+l.warehouse_id===group),values=ls.map(l=>BigInt(l.cost)+(stock.get(l.id)??0n)),total=values.reduce((n,v)=>n+v,0n)
   if(total<0n)throw new OperationsError('COST','This correction would make inventory negative. Review the settlement basis.')
   const costs=costMethod==='moving_average'?distributeCost(total,ls.map(l=>BigInt(l.quantity))):values
   for(const [i,l] of ls.entries()){if(costs[i]<0n)throw new OperationsError('COST','This correction would make a FIFO layer negative. Review the settlement basis.');const amount=costs[i]-BigInt(l.cost);if(!amount)continue
    const account=await accountId(tx,ledgerId,'/inventory',l.kind==='work_in_progress'?'wip':l.kind)
    await tx.execute(sql`INSERT INTO production_labour_cost_adjustment(ledger_id,settlement_id,target_kind,layer_id,account_id,amount,basis_quantity,cost_after) VALUES(${ledgerId}::uuid,${settlementId}::uuid,'stock',${l.id}::uuid,${account}::uuid,${amount},${l.quantity}::bigint,${costs[i]})`)
    await tx.execute(sql`UPDATE inventory_cost_layer SET remaining_cost=${costs[i]} WHERE id=${l.id}::uuid`)
    result.push({accountId:account,amount})
   }
  }
 }
 return result
}
export async function settleLabourPeriod(me:UserRecord,ledgerId:string,input:SettlementInput) {
 validateSettlement(input);const requestHash=hash({...input,reviewHash:undefined})
 return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
  await operationScope(tx,me,ledgerId,'/payroll')
  const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_labour_settlement WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
  if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This settlement request has different values.');return prior.id}
  await postingDate(tx,ledgerId,input.date);const plan=await prepareSettlement(tx,ledgerId,input)
  if(!input.reviewHash||hash(plan)!==input.reviewHash)throw new OperationsError('STALE','Preview the latest payroll settlement and confirm its costs before posting.')
  return postSettlement(tx,ledgerId,plan,input,s.email,requestHash,null)
 })
}
type SettlementPlan=Awaited<ReturnType<typeof prepareSettlement>>
async function postSettlement(tx:Tx,ledgerId:string,plan:SettlementPlan,input:SettlementInput,actor:string,requestHash:string,reverseOf:string|null) {
 const [setting]=await tx.execute<{cost_method:string}>(sql`SELECT cost_method FROM inventory_setting WHERE ledger_id=${ledgerId}::uuid`)
 await tx.execute(sql`SELECT set_config('app.inventory_write','on',true)`)
 const [e]=await tx.execute<{id:string}>(sql`INSERT INTO production_event(ledger_id,order_id,event_date,kind,quantity,cost,note,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${plan.lines[0].orderId}::uuid,${input.date}::date,'labour_settlement',0,0,${input.note},${input.key}::uuid,${requestHash},${actor}) RETURNING id::text`)
 const [st]=await tx.execute<{id:string}>(sql`INSERT INTO production_labour_settlement(ledger_id,period_id,pay_stub_id,event_id,reverse_of,eligible_gross,normal_hours,estimated_cost,actual_cost,expense_account_id,snapshot,note,request_key,request_hash,created_by)
 VALUES(${ledgerId}::uuid,${input.periodId}::uuid,${input.payStubId}::uuid,${e.id}::uuid,${reverseOf}::uuid,${input.eligibleGross},${input.normalHours},${plan.estimated},${plan.actual},${plan.expenseAccountId}::uuid,${json(plan)}::jsonb,${input.note},${input.key}::uuid,${requestHash},${actor}) RETURNING id::text`)
 for(const l of plan.lines)await tx.execute(sql`INSERT INTO production_labour_settlement_line(ledger_id,settlement_id,accrual_id,gross_cost,employer_cost) VALUES(${ledgerId}::uuid,${st.id}::uuid,${l.accrualId}::uuid,${l.gross},${l.employer})`)
 const correctionLines=await applyCorrections(tx,ledgerId,st.id,e.id,input.date,plan.corrections,actor,setting?.cost_method??'fifo'),direction=reverseOf?-1n:1n
 await postOperationsEvent(tx,{ledgerId,seat:'/inventory',kind:'production',sourceId:e.id,date:input.date,actor,description:reverseOf?'Reverse production payroll settlement':'Confirm production payroll settlement',lines:[{accountId:await accountId(tx,ledgerId,'/inventory','labour_accrual'),amount:direction*plan.estimated},{accountId:plan.expenseAccountId,amount:-direction*plan.actual},...correctionLines],snapshot:{settlementId:st.id,reverseOf,costMethod:setting?.cost_method??'fifo',plan}})
 return st.id
}
export async function reverseLabourSettlement(me:UserRecord,ledgerId:string,input:{settlementId:string;date:string;note:string;key:string}) {
 operationId(input.settlementId);operationId(input.key);operationDate(input.date);operationText(input.note,'Reversal reason',10000,true);const requestHash=hash(input)
 return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
  await operationScope(tx,me,ledgerId,'/payroll')
  const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_labour_settlement WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
  if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This reversal request has different values.');return prior.id}
  const [st]=await tx.execute<{period_id:string;pay_stub_id:string;event_id:string;eligible_gross:string;normal_hours:string;estimated_cost:string;actual_cost:string;expense_account_id:string}>(sql`SELECT period_id::text,pay_stub_id::text,event_id::text,eligible_gross::text,normal_hours::text,estimated_cost::text,actual_cost::text,expense_account_id::text FROM production_labour_settlement st WHERE ledger_id=${ledgerId}::uuid AND id=${input.settlementId}::uuid AND st.reverse_of IS NULL AND ${sql.raw(active)} FOR UPDATE`)
  if(!st)throw new OperationsError('SETTLEMENT','Choose an active payroll settlement.')
  await postingDate(tx,ledgerId,input.date)
  const adjustments=await tx.execute<{target_kind:CostTarget['kind'];order_id:string|null;layer_id:string|null;account_id:string;amount:string}>(sql`SELECT target_kind,order_id::text,layer_id::text,account_id::text,amount::text FROM production_labour_cost_adjustment WHERE settlement_id=${input.settlementId}::uuid ORDER BY id`)
  const seeds:FlowSeed[]=adjustments.map(a=>({eventId:st.event_id,target:{kind:a.target_kind,id:a.order_id??a.layer_id??a.account_id},value:fraction(BigInt(a.amount))}))
  const data=await flowData(tx,ledgerId,input.date),traced=traceLabourCost(data.events,data.layers,data.allocations,seeds)
  // Historical JSON mirrors are display evidence, never authoritative inputs to a financial correction.
  const [period]=await tx.execute<LabourPeriod>(sql`SELECT *,period_start::text,period_end::text FROM production_labour_period WHERE id=${st.period_id}::uuid AND ledger_id=${ledgerId}::uuid`)
  const stub=(await availableStubs(tx,ledgerId)).find(s=>s.id===st.pay_stub_id)
  if(!stub)throw new OperationsError('PAYROLL_SCOPE','Keep the actual payroll posted until its production settlement is reversed.')
  const sourceLines=await tx.execute<{accrualId:string;orderId:string;hours:string;gross:string;employer:string;estimated:string}>(sql`SELECT sl.accrual_id::text "accrualId",t.order_id::text "orderId",t.hours::text,sl.gross_cost::text gross,sl.employer_cost::text employer,(a.gross_cost+a.employer_cost)::text estimated FROM production_labour_settlement_line sl JOIN production_labour_accrual a ON a.id=sl.accrual_id JOIN production_time t ON t.id=a.time_id WHERE sl.settlement_id=${input.settlementId}::uuid ORDER BY t.work_date,a.created_at,a.id`)
  const plan:SettlementPlan={period,stub,expenseAccountId:st.expense_account_id,estimated:BigInt(st.estimated_cost),actual:BigInt(st.actual_cost),lines:sourceLines.map(l=>({...l,gross:BigInt(l.gross),employer:BigInt(l.employer),estimated:BigInt(l.estimated)})),corrections:await boundedCorrections(tx,ledgerId,roundedShares(traced).map(c=>({...c,amount:-c.amount})))}
  // Trace the correction's current location; sold goods reverse cost of sales, not their former stock layer.
  return postSettlement(tx,ledgerId,plan,{periodId:st.period_id,payStubId:st.pay_stub_id,eligibleGross:BigInt(st.eligible_gross),normalHours:BigInt(st.normal_hours),date:input.date,note:input.note,key:input.key},s.email,requestHash,input.settlementId)
 })
}

/** Correct a time-entry mistake while its estimate is still unused. Cancel that time and enter its replacement. */
export async function reverseLabourAccrual(me:UserRecord,ledgerId:string,input:{accrualId:string;date:string;note:string;key:string}) {
 operationId(input.accrualId);operationId(input.key);operationDate(input.date);operationText(input.note,'Reversal reason',10000,true);const requestHash=hash(input)
 return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
  await operationScope(tx,me,ledgerId,'/payroll')
  const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_labour_accrual_reversal WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
  if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This accrual reversal request has different values.');return prior.id}
  const [a]=await tx.execute<{order_id:string;event_id:string;cost:string;latest:string;status:string}>(sql`SELECT e.order_id::text,e.id::text event_id,e.cost::text,o.status,(SELECT max(event_date)::text FROM production_event WHERE order_id=o.id) latest FROM production_labour_accrual a JOIN production_event e ON e.id=a.event_id JOIN production_order o ON o.id=e.order_id WHERE a.ledger_id=${ledgerId}::uuid AND a.id=${input.accrualId}::uuid FOR UPDATE OF a,o`)
  if(!a)throw new OperationsError('ACCRUAL','Choose a daily estimate in this ledger.')
  if((await tx.execute(sql`SELECT 1 FROM production_labour_accrual_reversal WHERE accrual_id=${input.accrualId}::uuid`)).length)throw new OperationsError('REVERSED','This estimate was already reversed.')
  if(a.status!=='in_progress'||(await tx.execute(sql`SELECT 1 FROM production_event e JOIN production_event src ON src.id=${a.event_id}::uuid WHERE e.order_id=src.order_id AND e.kind IN ('completion','loss') AND (e.event_date,e.created_at,e.id)>(src.event_date,src.created_at,src.id)`)).length)throw new OperationsError('LABOUR_CONSUMED','The daily estimate was consumed by output or loss. Review a later actual-payroll settlement instead.')
  if((await tx.execute(sql`SELECT 1 FROM production_labour_settlement_line sl JOIN production_labour_settlement st ON st.id=sl.settlement_id WHERE sl.accrual_id=${input.accrualId}::uuid AND st.reverse_of IS NULL AND ${sql.raw(active)}`)).length)throw new OperationsError('SETTLED','Reverse the actual-payroll settlement first.')
  if(input.date<a.latest)throw new OperationsError('DATE',`Reverse the estimate on ${a.latest} or later.`)
  await financialDay(tx,ledgerId,'/inventory',input.date);await tx.execute(sql`SELECT set_config('app.inventory_write','on',true)`)
  const [e]=await tx.execute<{id:string}>(sql`INSERT INTO production_event(ledger_id,order_id,event_date,kind,quantity,cost,note,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${a.order_id}::uuid,${input.date}::date,'labour_accrual_return',0,${a.cost}::bigint,${input.note},${input.key}::uuid,${requestHash},${s.email}) RETURNING id::text`)
  const [v]=await tx.execute<{id:string}>(sql`INSERT INTO production_labour_accrual_reversal(ledger_id,accrual_id,event_id,note,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${input.accrualId}::uuid,${e.id}::uuid,${input.note},${input.key}::uuid,${requestHash},${s.email}) RETURNING id::text`)
  await postOperationsEvent(tx,{ledgerId,seat:'/inventory',kind:'production',sourceId:e.id,date:input.date,actor:s.email,description:'Reverse unused daily labour estimate',lines:[{accountId:await accountId(tx,ledgerId,'/inventory','wip'),amount:-BigInt(a.cost)},{accountId:await accountId(tx,ledgerId,'/inventory','labour_accrual'),amount:BigInt(a.cost)}],snapshot:{accrualId:input.accrualId,reversalId:v.id}})
  await tx.execute(sql`UPDATE production_order SET version=version+1 WHERE id=${a.order_id}::uuid`)
  return v.id
 })
}

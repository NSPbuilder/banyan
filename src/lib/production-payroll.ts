import 'server-only'
import {createHash} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import type {UserRecord} from './users'
import {operationScope,operationWrite,operationId,operationDate,operationText,operationAmount,OperationsError} from './operations-scope'
import {allocationCeiling,type AllocationStub} from './production-payroll-math'
export {allocationCeiling,type AllocationStub} from './production-payroll-math'
import {financialDay,postProductionEvent} from './operations-finance'
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)
const fingerprint=(v:unknown)=>createHash('sha256').update(json(v)).digest('hex')
export type ProductionTimeRow={id:string;employee_id:string;employee_name:string;work_date:string;hours:string;note:string;cancelled:boolean;version:number;allocation_id:string|null;accrual_id?:string|null;pay_stub_id:string|null;pay_date:string|null;gross_cost:string|null;employer_cost:string|null}
export function productionEmployees(ledgerId:string) {
 return db.execute<{id:string;name:string}>(sql`SELECT e.id::text,p.name FROM payroll_employee e JOIN party p ON p.id=e.party_id JOIN ledger l ON l.entity_id=e.entity_id WHERE l.id=${operationId(ledgerId)}::uuid ORDER BY lower(p.name)`)
}
/** Operational hours are visible without exposing payroll amounts. */
export async function productionTime(ledgerId:string,orderId:string) {
 return db.execute<ProductionTimeRow>(sql`SELECT t.id::text,t.employee_id::text,p.name employee_name,t.work_date::text,t.hours::text,t.note,t.cancelled,t.version,a.id::text allocation_id,(SELECT id::text FROM production_labour_accrual ac WHERE ac.time_id=t.id AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=ac.id)) accrual_id,
  NULL::text pay_stub_id,NULL::text pay_date,NULL::text gross_cost,NULL::text employer_cost
  FROM production_time t JOIN payroll_employee pe ON pe.id=t.employee_id JOIN party p ON p.id=pe.party_id
  LEFT JOIN production_payroll_allocation a ON a.time_id=t.id AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id)
  WHERE t.ledger_id=${operationId(ledgerId)}::uuid AND t.order_id=${operationId(orderId)}::uuid ORDER BY t.work_date,t.created_at`)
}
export async function recordProductionTime(me:UserRecord,ledgerId:string,input:{orderId:string;employeeId:string;date:string;hours:bigint;note:string;key:string}) {
 operationId(input.orderId);operationId(input.employeeId);operationId(input.key);operationDate(input.date);operationAmount(input.hours)
 if(input.hours<=0n||input.hours>2400n)throw new OperationsError('HOURS','Enter work hours above zero up to 24 for this day.')
 const note=operationText(input.note,'Work description',10000,true),hash=fingerprint({...input,note})
 return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
  const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_time WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
  if(prior){if(prior.request_hash!==hash)throw new OperationsError('REPLAY','This time request was used with different values.');return prior.id}
  const [order]=await tx.execute<{status:string;start_date:string}>(sql`SELECT status,start_date::text FROM production_order WHERE ledger_id=${ledgerId}::uuid AND id=${input.orderId}::uuid FOR UPDATE`)
  if(!order||order.status!=='in_progress')throw new OperationsError('ORDER','Record time on an open production order.')
  if(input.date<order.start_date)throw new OperationsError('DATE','Work cannot precede the order start date.')
  if((await tx.execute(sql`SELECT 1 FROM production_event WHERE order_id=${input.orderId}::uuid AND kind='completion' AND event_date>=${input.date}::date`)).length)throw new OperationsError('TIME_HISTORY','This work date was already included in completed output. Record a reviewed later cost correction instead.')
  if(!(await tx.execute(sql`SELECT 1 FROM payroll_employee WHERE id=${input.employeeId}::uuid AND entity_id=${s.entity_id}::uuid FOR SHARE`)).length)throw new OperationsError('EMPLOYEE','Choose a payroll employee of this company.')
  const [hours]=await tx.execute<{n:string}>(sql`SELECT coalesce(sum(hours),0)::text n FROM production_time WHERE ledger_id=${ledgerId}::uuid AND employee_id=${input.employeeId}::uuid AND work_date=${input.date}::date AND NOT cancelled`)
  if(BigInt(hours.n)+input.hours>2400n)throw new OperationsError('HOURS','The employee’s production time exceeds 24 hours for this day.')
  const [r]=await tx.execute<{id:string}>(sql`INSERT INTO production_time(ledger_id,order_id,employee_id,work_date,hours,note,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${input.orderId}::uuid,${input.employeeId}::uuid,${input.date}::date,${input.hours},${note},${input.key}::uuid,${hash},${s.email}) RETURNING id::text`)
  return r.id
 })
}
export function cancelProductionTime(me:UserRecord,ledgerId:string,input:{id:string;version:number}) {
 operationId(input.id)
 return operationWrite(me,ledgerId,'/inventory',async tx=>{
  const [r]=await tx.execute<{version:number;cancelled:boolean}>(sql`SELECT version,cancelled FROM production_time WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid FOR UPDATE`)
  if(!r||r.cancelled)throw new OperationsError('TIME','Choose active time.')
  if(r.version!==input.version)throw new OperationsError('STALE','Time changed. Reload before cancelling.')
  if((await tx.execute(sql`SELECT 1 FROM production_labour_accrual ac WHERE time_id=${input.id}::uuid AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=ac.id) UNION ALL SELECT 1 FROM production_payroll_allocation a WHERE a.time_id=${input.id}::uuid AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id)`)).length)throw new OperationsError('ALLOCATED','Reverse the labour allocation before cancelling its time.')
  await tx.execute(sql`UPDATE production_time SET cancelled=true,version=version+1 WHERE id=${input.id}::uuid`)
 })
}
async function stubs(tx:Tx,ledgerId:string) {
 return tx.execute<AllocationStub>(sql`SELECT s.id::text,s.employee_id::text,r.pay_date::text,r.period_start::text,r.period_end::text,s.hours::text,s.gross::text,s.bonus::text,(s.employer_cpp+s.employer_cpp2+s.employer_ei)::text employer,r.entry_id::text,
  coalesce(u.hours,0)::text used_hours,coalesce(u.gross,0)::text used_gross,coalesce(u.employer,0)::text used_employer
  FROM pay_stub s JOIN pay_run r ON r.id=s.pay_run_id JOIN journal_entry j ON j.id=r.entry_id
  LEFT JOIN LATERAL(SELECT sum(a.hours) hours,sum(a.gross_cost) gross,sum(a.employer_cost) employer FROM production_payroll_allocation a WHERE a.pay_stub_id=s.id AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal v WHERE v.allocation_id=a.id)) u ON true
  WHERE r.ledger_id=${ledgerId}::uuid AND j.status='posted' AND s.hours>0 AND r.period_start IS NOT NULL AND r.period_end IS NOT NULL ORDER BY r.pay_date DESC,s.id`)
}
export async function productionPayrollOptions(me:UserRecord,ledgerId:string,orderId:string) {
 operationId(orderId)
 return operationWrite(me,ledgerId,'/inventory',async tx=>{
  await operationScope(tx,me,ledgerId,'/payroll')
  const [time,options]=await Promise.all([
   tx.execute<ProductionTimeRow>(sql`SELECT t.id::text,t.employee_id::text,p.name employee_name,t.work_date::text,t.hours::text,t.note,t.cancelled,t.version,a.id::text allocation_id,(SELECT id::text FROM production_labour_accrual ac WHERE ac.time_id=t.id AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=ac.id)) accrual_id,a.pay_stub_id::text,r.pay_date::text,a.gross_cost::text,a.employer_cost::text
    FROM production_time t JOIN payroll_employee pe ON pe.id=t.employee_id JOIN party p ON p.id=pe.party_id
    LEFT JOIN production_payroll_allocation a ON a.time_id=t.id AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal v WHERE v.allocation_id=a.id)
    LEFT JOIN pay_stub s ON s.id=a.pay_stub_id LEFT JOIN pay_run r ON r.id=s.pay_run_id
    WHERE t.ledger_id=${ledgerId}::uuid AND t.order_id=${orderId}::uuid ORDER BY t.work_date,t.created_at`),stubs(tx,ledgerId)])
  return {time,stubs:options}
 })
}
export async function allocateProductionPayroll(me:UserRecord,ledgerId:string,input:{timeId:string;payStubId:string;date:string;grossCost?:bigint;employerCost?:bigint;key:string}) {
 operationId(input.timeId);operationId(input.payStubId);operationId(input.key);operationDate(input.date)
 const hash=fingerprint(input)
 return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
  await operationScope(tx,me,ledgerId,'/payroll')
  const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_payroll_allocation WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
  if(prior){if(prior.request_hash!==hash)throw new OperationsError('REPLAY','This allocation request was used with different values.');return prior.id}
  const [t]=await tx.execute<{order_id:string;employee_id:string;work_date:string;hours:string;cancelled:boolean}>(sql`SELECT order_id::text,employee_id::text,work_date::text,hours::text,cancelled FROM production_time WHERE ledger_id=${ledgerId}::uuid AND id=${input.timeId}::uuid FOR UPDATE`)
  if((await tx.execute(sql`SELECT 1 FROM production_labour_accrual ac WHERE time_id=${input.timeId}::uuid AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=ac.id)`)).length)throw new OperationsError('ACCRUED','Settle this daily accrual against the complete pay period instead.');
  if(!t||t.cancelled)throw new OperationsError('TIME','Choose active production time.')
  const [o]=await tx.execute<{version:number;status:string;latest:string}>(sql`SELECT version,status,coalesce((SELECT max(event_date) FROM production_event WHERE order_id=o.id),start_date)::text latest FROM production_order o WHERE ledger_id=${ledgerId}::uuid AND id=${t.order_id}::uuid FOR UPDATE`)
  if(o.status!=='in_progress')throw new OperationsError('ORDER','Allocate labour before the production order is closed.')
  if((await tx.execute(sql`SELECT 1 FROM production_payroll_allocation a WHERE time_id=${input.timeId}::uuid AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id)`)).length)throw new OperationsError('ALLOCATED','This time is already allocated.')
  await tx.execute(sql`SELECT id FROM pay_stub WHERE id=${input.payStubId}::uuid FOR UPDATE`)
  const stub=(await stubs(tx,ledgerId)).find(x=>x.id===input.payStubId)
  if((await tx.execute(sql`SELECT 1 FROM production_labour_settlement st WHERE st.pay_stub_id=${input.payStubId}::uuid AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id)`)).length)throw new OperationsError('SETTLED','This stub is already used by an active daily-labour settlement.');
  if(!stub||stub.employee_id!==t.employee_id||t.work_date<stub.period_start||t.work_date>stub.period_end)throw new OperationsError('PAYROLL_SCOPE','Choose this employee’s posted pay stub with a pay period covering the work date.')
  const [original]=await tx.execute<{status:string}>(sql`SELECT status FROM journal_entry WHERE id=${stub.entry_id}::uuid FOR UPDATE`)
  if(original?.status!=='posted')throw new OperationsError('PAYROLL_SCOPE','This pay run was reversed. Choose a currently posted pay stub.')
  if(input.date<stub.pay_date||input.date<o.latest||input.date<t.work_date)throw new OperationsError('DATE',`Allocate on or after pay date ${stub.pay_date}, work date ${t.work_date} and latest order cost ${o.latest}.`)
  if(!await financialDay(tx,ledgerId,'/inventory',input.date))throw new OperationsError('FINANCE_SETUP','Connect Inventory Finance before allocating payroll cost.')
  if(BigInt(stub.used_hours)+BigInt(t.hours)>BigInt(stub.hours))throw new OperationsError('PAYROLL_HOURS','Production hours exceed the unallocated paid hours on this stub.')
  const ceilings=allocationCeiling(stub,BigInt(t.hours)),gross=operationAmount(input.grossCost??ceilings.gross),employer=operationAmount(input.employerCost??ceilings.employer)
  if(gross>ceilings.gross||employer>ceilings.employer)throw new OperationsError('PAYROLL_COST','Eligible costs cannot exceed the proportional regular-pay and employer-cost ceilings.')
  const accounts=await tx.execute<{id:string}>(sql`SELECT DISTINCT jl.account_id::text id FROM journal_line jl JOIN account_role ar ON ar.account_id=jl.account_id AND ar.role='employee_benefits_expense' WHERE jl.entry_id=${stub.entry_id}::uuid AND jl.amount>0`)
  if(accounts.length!==1)throw new OperationsError('PAYROLL_ACCOUNT','Review the original payroll journal: one actual wage expense account must be identifiable.')
  const snapshot={timeId:input.timeId,payStubId:stub.id,orderId:t.order_id,employeeId:t.employee_id,workDate:t.work_date,payDate:stub.pay_date,originalEntryId:stub.entry_id,expenseAccountId:accounts[0].id,paidHours:stub.hours,allocatedHours:t.hours,ceilings,gross,employer}
  await tx.execute(sql`SELECT set_config('app.inventory_write','on',true)`)
  const [e]=await tx.execute<{id:string}>(sql`INSERT INTO production_event(ledger_id,order_id,event_date,kind,quantity,cost,note,request_key,request_hash,created_by)
   VALUES(${ledgerId}::uuid,${t.order_id}::uuid,${input.date}::date,'conversion_cost',0,${gross+employer},'Confirmed payroll labour allocation',${input.key}::uuid,${hash},${s.email}) RETURNING id::text`)
  const [a]=await tx.execute<{id:string}>(sql`INSERT INTO production_payroll_allocation(ledger_id,time_id,pay_stub_id,event_id,hours,gross_cost,employer_cost,snapshot,request_key,request_hash,created_by)
   VALUES(${ledgerId}::uuid,${input.timeId}::uuid,${stub.id}::uuid,${e.id}::uuid,${t.hours}::bigint,${gross},${employer},${json(snapshot)}::jsonb,${input.key}::uuid,${hash},${s.email}) RETURNING id::text`)
  await tx.execute(sql`UPDATE production_order SET version=version+1 WHERE id=${t.order_id}::uuid`)
  await postProductionEvent(tx,ledgerId,e.id,{counterpartAccountId:accounts[0].id},s.email)
  return a.id
 })
}
export async function reverseProductionPayroll(me:UserRecord,ledgerId:string,input:{allocationId:string;date:string;reason:string;key:string}) {
 operationId(input.allocationId);operationId(input.key);operationDate(input.date)
 const reason=operationText(input.reason,'Reversal reason',10000,true),hash=fingerprint({...input,reason})
 return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
  await operationScope(tx,me,ledgerId,'/payroll')
  const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_payroll_reversal WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
  if(prior){if(prior.request_hash!==hash)throw new OperationsError('REPLAY','This reversal request was used with different values.');return prior.id}
  const [a]=await tx.execute<{event_id:string;cost:string;order_id:string;snapshot:{expenseAccountId:string}}>(sql`SELECT a.event_id::text,(a.gross_cost+a.employer_cost)::text cost,t.order_id::text,a.snapshot FROM production_payroll_allocation a JOIN production_time t ON t.id=a.time_id WHERE a.ledger_id=${ledgerId}::uuid AND a.id=${input.allocationId}::uuid FOR UPDATE OF a,t`)
  if(!a)throw new OperationsError('ALLOCATION','Choose an allocation in this ledger.')
  if((await tx.execute(sql`SELECT 1 FROM production_payroll_reversal WHERE allocation_id=${input.allocationId}::uuid`)).length)throw new OperationsError('REVERSED','This allocation was already reversed.')
  const [o]=await tx.execute<{status:string;latest:string}>(sql`SELECT status,(SELECT max(event_date)::text FROM production_event WHERE order_id=o.id) latest FROM production_order o WHERE id=${a.order_id}::uuid FOR UPDATE`)
  if(o.status!=='in_progress'||(await tx.execute(sql`SELECT 1 FROM production_event e JOIN production_event src ON src.id=${a.event_id}::uuid WHERE e.order_id=${a.order_id}::uuid AND e.kind IN ('completion','loss') AND (e.event_date,e.created_at,e.id)>(src.event_date,src.created_at,src.id)`)).length)throw new OperationsError('LABOUR_CONSUMED','This labour cost has been consumed by output or loss. A later cost correction needs a separate review.')
  if(input.date<o.latest)throw new OperationsError('DATE',`Use ${o.latest} or later for this reversal.`)
  await financialDay(tx,ledgerId,'/inventory',input.date)
  await tx.execute(sql`SELECT set_config('app.inventory_write','on',true)`)
  const [e]=await tx.execute<{id:string}>(sql`INSERT INTO production_event(ledger_id,order_id,event_date,kind,quantity,cost,note,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${a.order_id}::uuid,${input.date}::date,'labour_return',0,${a.cost}::bigint,${reason},${input.key}::uuid,${hash},${s.email}) RETURNING id::text`)
  const [r]=await tx.execute<{id:string}>(sql`INSERT INTO production_payroll_reversal(ledger_id,allocation_id,event_id,reason,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${input.allocationId}::uuid,${e.id}::uuid,${reason},${input.key}::uuid,${hash},${s.email}) RETURNING id::text`)
  await tx.execute(sql`UPDATE production_order SET version=version+1 WHERE id=${a.order_id}::uuid`)
  await postProductionEvent(tx,ledgerId,e.id,{counterpartAccountId:a.snapshot.expenseAccountId},s.email)
  return r.id
 })
}

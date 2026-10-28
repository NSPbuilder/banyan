'use server'
import { revalidatePath } from 'next/cache'
import type { FormState } from '@/app/actions'
import { requireLedger } from '@/lib/gate'
import { parseMoney } from '@/lib/money'
import { parseQuantity } from '@/lib/quantity'
import { saveInventoryItem,saveInventorySettings,saveInventoryWarehouse,recordStockMovement } from '@/lib/inventory'
import type { MovementKind } from '@/lib/inventory-types'
import {saveBom,createProductionOrder,recordProductionEvent,type ProductionAction} from '@/lib/production'
import { OperationsError } from '@/lib/operations-scope'
import {requireFinanceConnected} from '@/lib/operations-finance'
import {operationsFinanceError} from '@/lib/operations-finance-actions'
import {recordProductionTime,cancelProductionTime,allocateProductionPayroll,reverseProductionPayroll} from '@/lib/production-payroll'
import {createLabourPeriod,accrueProductionTime,previewLabourSettlement,settleLabourPeriod,reverseLabourSettlement,reverseLabourAccrual} from '@/lib/production-labour-accrual'
const g=(f:FormData,k:string)=>String(f.get(k)??'').trim()
const error=(e:unknown):FormState=>({error:e instanceof OperationsError?e.message:e instanceof Error&&!('cause' in e)?e.message.split('\n')[0].slice(0,250):'Unable to save this record. Reload and review the fields before trying again.'})
const refresh=(ledgerId:string)=>revalidatePath(`/ledger/${ledgerId}`,'layout')
export async function saveItemAction(_prev:FormState,f:FormData):Promise<FormState> {
  const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/inventory')
  try {
    await saveInventoryItem(me,ledgerId,{id:g(f,'itemId')||undefined,version:Number(g(f,'version')),sku:g(f,'sku'),name:g(f,'name'),kind:g(f,'kind'),unit:g(f,'unit'),reorderLevel:parseQuantity(g(f,'reorderLevel')||'0'),trackBatches:f.has('trackBatches'),trackSerials:f.has('trackSerials'),isActive:g(f,'isActive')!=='false',notes:g(f,'notes')})
    refresh(ledgerId);return{ok:g(f,'itemId')?'Item updated.':'Item added. Open the item to receive its opening stock.'}
  }catch(e){return error(e)}
}
export async function inventorySettingsAction(_prev:FormState,f:FormData):Promise<FormState> {
  const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/inventory')
  try {await saveInventorySettings(me,ledgerId,{version:Number(g(f,'version')),warehousesEnabled:f.has('warehousesEnabled'),costMethod:g(f,'costMethod') as 'fifo'|'moving_average'});refresh(ledgerId);return{ok:'Inventory settings updated.'}}
  catch(e){return error(e)}
}
export async function warehouseAction(_prev:FormState,f:FormData):Promise<FormState> {
  const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/inventory')
  try {await saveInventoryWarehouse(me,ledgerId,{id:g(f,'warehouseId')||undefined,version:Number(g(f,'version')),code:g(f,'code'),name:g(f,'name'),isActive:g(f,'isActive')!=='false'});refresh(ledgerId);return{ok:g(f,'warehouseId')?'Warehouse updated.':'Warehouse added.'}}
  catch(e){return error(e)}
}
export async function stockMovementAction(_prev:FormState,f:FormData):Promise<FormState> {
  const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/inventory')
  try {
    await requireFinanceConnected(ledgerId,'/inventory')
    if(['receipt','adjust_in'].includes(g(f,'kind'))&&!g(f,'cost'))throw new Error('Enter the total receipt cost, including 0 for a zero-cost receipt.')
    await recordStockMovement(me,ledgerId,{itemId:g(f,'itemId'),kind:g(f,'kind') as MovementKind,date:g(f,'date'),quantity:parseQuantity(g(f,'quantity')),cost:parseMoney(g(f,'cost')),fromWarehouseId:g(f,'fromWarehouseId'),toWarehouseId:g(f,'toWarehouseId'),batch:g(f,'batch'),serials:g(f,'serials').split(/\r?\n/).map(s=>s.trim()).filter(Boolean),reference:g(f,'reference'),note:g(f,'note'),key:g(f,'requestKey'),finance:{counterpartAccountId:g(f,'counterpartAccountId')||undefined,recoverableTax:parseMoney(g(f,'recoverableTax')),taxAccountId:g(f,'taxAccountId')||undefined}})
    refresh(ledgerId);return{ok:'Stock movement recorded.'}
  }catch(e){return operationsFinanceError(e)}
}

export async function bomAction(_prev:FormState,f:FormData):Promise<FormState>{
  const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/inventory')
  try{const ids=f.getAll('componentItemId').map(String),quantities=f.getAll('componentQuantity').map(String)
    await saveBom(me,ledgerId,{id:g(f,'bomId')||undefined,version:Number(g(f,'version')),code:g(f,'code'),name:g(f,'name'),outputItemId:g(f,'outputItemId'),outputQuantity:parseQuantity(g(f,'outputQuantity')),components:ids.map((itemId,i)=>({itemId,quantity:parseQuantity(quantities[i]??'')})),notes:g(f,'notes'),isActive:g(f,'isActive')!=='false'});refresh(ledgerId);return {ok:'BOM saved. Existing production orders retain their recipe snapshot.'}
  }catch(e){return error(e)}
}
export async function productionOrderAction(_prev:FormState,f:FormData):Promise<FormState>{
  const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/inventory')
  try{await createProductionOrder(me,ledgerId,{bomId:g(f,'bomId'),quantity:parseQuantity(g(f,'quantity')),warehouseId:g(f,'warehouseId'),startDate:g(f,'startDate'),dueDate:g(f,'dueDate'),notes:g(f,'notes'),key:g(f,'requestKey')});refresh(ledgerId);return {ok:'Production order created.'}}catch(e){return error(e)}
}
export async function productionEventAction(_prev:FormState,f:FormData):Promise<FormState>{
  const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/inventory')
  try{await requireFinanceConnected(ledgerId,'/inventory');await recordProductionEvent(me,ledgerId,{orderId:g(f,'orderId'),version:Number(g(f,'version')),kind:g(f,'kind') as ProductionAction['kind'],date:g(f,'date'),itemId:g(f,'itemId'),sourceEventId:g(f,'sourceEventId'),quantity:parseQuantity(g(f,'quantity')||'0'),cost:parseMoney(g(f,'cost')),batch:g(f,'batch'),serials:g(f,'serials').split(/\r?\n/).map(s=>s.trim()).filter(Boolean),note:g(f,'note'),key:g(f,'requestKey'),finance:{counterpartAccountId:g(f,'counterpartAccountId')||undefined}});refresh(ledgerId);return {ok:'Production action recorded and its journal posted.'}}catch(e){return operationsFinanceError(e)}
}
export async function productionTimeAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/inventory')
 try{await recordProductionTime(me,ledgerId,{orderId:g(f,'orderId'),employeeId:g(f,'employeeId'),date:g(f,'date'),hours:parseMoney(g(f,'hours')),note:g(f,'note'),key:g(f,'requestKey')});refresh(ledgerId);return {ok:'Production time recorded. Accrue estimated labour or allocate confirmed payroll before completing output.'}}catch(e){return operationsFinanceError(e)}
}
export async function cancelProductionTimeAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/inventory')
 try{await cancelProductionTime(me,ledgerId,{id:g(f,'timeId'),version:Number(g(f,'version'))});refresh(ledgerId);return {ok:'Unallocated time cancelled.'}}catch(e){return operationsFinanceError(e)}
}
export async function productionPayrollAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,['/inventory','/payroll'])
 try{await allocateProductionPayroll(me,ledgerId,{timeId:g(f,'timeId'),payStubId:g(f,'payStubId'),date:g(f,'date'),grossCost:parseMoney(g(f,'grossCost')),employerCost:parseMoney(g(f,'employerCost')),key:g(f,'requestKey')});refresh(ledgerId);return {ok:'Confirmed payroll cost allocated to WIP; source journal posted.'}}catch(e){return operationsFinanceError(e)}
}
export async function reverseProductionPayrollAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,['/inventory','/payroll'])
 try{await reverseProductionPayroll(me,ledgerId,{allocationId:g(f,'allocationId'),date:g(f,'date'),reason:g(f,'reason'),key:g(f,'requestKey')});refresh(ledgerId);return {ok:'Labour allocation reversed through its source and journal.'}}catch(e){return operationsFinanceError(e)}
}

export type LabourSettlementState=FormState & {review?:{hash:string;estimated:string;actual:string;corrections:{label:string;amount:string}[]}}
export async function labourPeriodAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,['/inventory','/payroll'])
 try{await createLabourPeriod(me,ledgerId,{employeeId:g(f,'employeeId'),start:g(f,'start'),end:g(f,'end'),payDate:g(f,'payDate'),basis:g(f,'basis') as 'hourly'|'fixed',hourlyRate:parseMoney(g(f,'hourlyRate')),paidHours:parseMoney(g(f,'paidHours')),normalHours:parseMoney(g(f,'normalHours')),gross:parseMoney(g(f,'gross')),pensionable:g(f,'pensionable')?parseMoney(g(f,'pensionable')):undefined,insurable:g(f,'insurable')?parseMoney(g(f,'insurable')):undefined,note:g(f,'note'),key:g(f,'requestKey')});refresh(ledgerId);return {ok:'Pay-period estimate saved. CPP/CPP2/EI were forecast once for the complete pay period.'}}catch(e){return operationsFinanceError(e)}
}
export async function labourAccrualAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,['/inventory','/payroll'])
 try{await accrueProductionTime(me,ledgerId,{timeId:g(f,'timeId'),periodId:g(f,'periodId'),key:g(f,'requestKey'),date:g(f,'date')||undefined});refresh(ledgerId);return {ok:'Daily labour accrued: Dr WIP, Cr accrued production labour.'}}catch(e){return operationsFinanceError(e)}
}
export async function labourSettlementAction(_prev:LabourSettlementState,f:FormData):Promise<LabourSettlementState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,['/inventory','/payroll'])
 try{const input={periodId:g(f,'periodId'),payStubId:g(f,'payStubId'),date:g(f,'date'),eligibleGross:parseMoney(g(f,'eligibleGross')),normalHours:parseMoney(g(f,'normalHours')),note:g(f,'note'),key:g(f,'requestKey'),reviewHash:g(f,'reviewHash')||undefined}

  if(input.reviewHash){await settleLabourPeriod(me,ledgerId,input);refresh(ledgerId);return {ok:'Payroll settled. Accrual cleared and WIP, inventory or consumed costs adjusted.'}}
  const preview=await previewLabourSettlement(me,ledgerId,input),labels={wip:'Work in progress',stock:'On-hand inventory',expense:'Consumed cost / expense'},amounts=new Map<string,bigint>()
  for(const c of preview.corrections)amounts.set(c.target.kind,(amounts.get(c.target.kind)??0n)+c.amount)
  return {review:{hash:preview.reviewHash,estimated:preview.estimated.toString(),actual:preview.actual.toString(),corrections:[...amounts].map(([kind,amount])=>({label:labels[kind as keyof typeof labels],amount:amount.toString()}))}}
 }catch(e){return operationsFinanceError(e)}
}
export async function reverseLabourSettlementAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,['/inventory','/payroll'])
 try{await reverseLabourSettlement(me,ledgerId,{settlementId:g(f,'settlementId'),date:g(f,'date'),note:g(f,'note'),key:g(f,'requestKey')});refresh(ledgerId);return {ok:'Settlement reversed at the current cost locations. Daily estimates are outstanding again.'}}catch(e){return operationsFinanceError(e)}
}

export async function reverseLabourAccrualAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,['/inventory','/payroll'])
 try{await reverseLabourAccrual(me,ledgerId,{accrualId:g(f,'accrualId'),date:g(f,'date'),note:g(f,'note'),key:g(f,'requestKey')});refresh(ledgerId);return {ok:'Unused estimate reversed. Cancel the original time and record its correction.'}}catch(e){return operationsFinanceError(e)}
}

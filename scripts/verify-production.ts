import './env'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {sql as q} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner} from '../src/lib/users'
import {createCompanyWithYear} from '../src/lib/setup'
import {saveInventoryItem,saveInventorySettings,inventorySettings,inventoryWarehouses,inventoryItemDetail,recordStockMovement,movementDetail} from '../src/lib/inventory'
import {saveBom,createProductionOrder,recordProductionEvent,productionOrderDetail,type ProductionAction} from '../src/lib/production'
import {parseQuantity as Q} from '../src/lib/quantity'
import {averageIssue,distributeCost} from '../src/lib/inventory-cost'
import {errorText} from './suite'
import {exportCompany,restoreCompany} from '../src/lib/backup'
const refuse=async(code:string,fn:()=>Promise<unknown>)=>{await assert.rejects(fn,(e:unknown)=>(e as {code:string}).code===code)}
async function main(){
  const me=await createFirstOwner({email:'production@example.test',firstName:'Production test',password:'Isolated production test phrase'})
  const A=await createCompanyWithYear({code:'PROD',name:'Production test'},me.email),B=await createCompanyWithYear({code:'OTHER',name:'Other register'},me.email),ledger=A.ledger.id
  const item=(sku:string,kind='raw_material')=>saveInventoryItem(me,ledger,{sku,name:sku,kind,unit:'each',reorderLevel:0n,trackBatches:false,trackSerials:false,isActive:true,notes:''})
  await saveInventorySettings(me,ledger,{version:0,warehousesEnabled:false,costMethod:'moving_average'})
  const main=(await inventoryWarehouses(ledger))[0].id,raw=await item('RAW'),fg=await item('FINISHED','finished_goods')
  const stock={itemId:raw,kind:'receipt' as const,date:'2026-01-01',quantity:Q('10'),cost:1000n,fromWarehouseId:'',toWarehouseId:main,batch:'',serials:[],reference:'',note:'',key:randomUUID()}
  await recordStockMovement(me,ledger,stock);await recordStockMovement(me,ledger,{...stock,date:'2026-01-02',cost:2000n,key:randomUUID()})
  const out=await recordStockMovement(me,ledger,{...stock,kind:'issue',date:'2026-01-03',quantity:Q('12'),cost:0n,fromWarehouseId:main,toWarehouseId:'',key:randomUUID()})
  assert.equal((await movementDetail(ledger,out))!.movement.cost,'1800');assert.equal((await inventoryItemDetail(ledger,raw))!.item.fifo_cost,'1200')
  await refuse('COST_METHOD_STOCK',()=>saveInventorySettings(me,ledger,{version:2,warehousesEnabled:false,costMethod:'fifo'}))
  await recordStockMovement(me,ledger,{...stock,kind:'issue',date:'2026-01-03',quantity:Q('8'),cost:0n,fromWarehouseId:main,toWarehouseId:'',key:randomUUID()})
  await saveInventorySettings(me,ledger,{version:(await inventorySettings(ledger)).version,warehousesEnabled:false,costMethod:'fifo'})
  await recordStockMovement(me,ledger,{...stock,date:'2026-01-04',quantity:Q('20'),cost:2000n,key:randomUUID()})
  const bomInput={code:'FRAME',name:'Frame recipe',outputItemId:fg,outputQuantity:Q('1'),components:[{itemId:raw,quantity:Q('2')}],notes:'',isActive:true}
  const bom=await saveBom(me,ledger,bomInput)
  const orderInput={bomId:bom,quantity:Q('5'),warehouseId:main,startDate:'2026-01-04',dueDate:'',notes:'',key:randomUUID()},order=await createProductionOrder(me,ledger,orderInput)
  assert.equal(await createProductionOrder(me,ledger,orderInput),order)
  await refuse('REPLAY',()=>createProductionOrder(me,ledger,{...orderInput,quantity:Q('4')}))
  await saveBom(me,ledger,{...bomInput,id:bom,version:1,components:[{itemId:raw,quantity:Q('3')}]})
  assert.equal((await productionOrderDetail(ledger,order))!.lines[0].quantity,Q('10').toString())
  const event=async(patch:Partial<ProductionAction>)=>recordProductionEvent(me,ledger,{orderId:order,version:(await productionOrderDetail(ledger,order))!.order.version,kind:'material_issue',date:'2026-01-04',itemId:raw,sourceEventId:'',quantity:0n,cost:0n,batch:'',serials:[],note:'',key:randomUUID(),...patch})
  await refuse('MATERIALS',()=>event({kind:'completion',quantity:Q('1')}))
  const issue=await event({quantity:Q('10')})
  await event({kind:'conversion_cost',cost:500n,note:'Assembly labour'})
  await event({kind:'completion',quantity:Q('2')})
  assert.equal((await productionOrderDetail(ledger,order))!.order.wip_cost,'900')
  await event({kind:'material_return',sourceEventId:issue,quantity:Q('2')})
  assert.equal((await productionOrderDetail(ledger,order))!.order.wip_cost,'700')
  await event({kind:'completion',quantity:Q('2')})
  await refuse('MATERIALS',()=>event({kind:'completion',quantity:Q('1')}))
  await event({quantity:Q('2')})
  await event({kind:'completion',quantity:Q('1')})
  const detail=(await productionOrderDetail(ledger,order))!
  assert.equal(detail.order.status,'completed');assert.equal(detail.order.wip_cost,'0');assert.equal((await inventoryItemDetail(ledger,fg))!.item.fifo_cost,'1500')
  assert.equal(detail.events.filter(e=>e.kind==='completion').reduce((n,e)=>n+BigInt(e.cost),0n),1500n)
  await refuse('ORDER_CLOSED',()=>event({quantity:Q('1')}))
  await refuse('ORDER',()=>recordProductionEvent(me,B.ledger.id,{orderId:order,version:1,kind:'loss',date:'2026-01-04',itemId:'',sourceEventId:'',quantity:0n,cost:0n,batch:'',serials:[],note:'Close',key:randomUUID()}))
  const loss=await createProductionOrder(me,ledger,{...orderInput,key:randomUUID()})
  const lossEvent=async(kind:ProductionAction['kind'],quantity=0n)=>recordProductionEvent(me,ledger,{orderId:loss,version:(await productionOrderDetail(ledger,loss))!.order.version,kind,date:'2026-01-05',itemId:raw,sourceEventId:'',quantity,cost:0n,batch:'',serials:[],note:'Rejected batch',key:randomUUID()})
  await lossEvent('material_issue',Q('1'));await refuse('CANCEL',()=>lossEvent('cancel'));await lossEvent('loss')
  assert.equal((await productionOrderDetail(ledger,loss))!.order.status,'closed_loss')
  const serialItem=await saveInventoryItem(me,ledger,{sku:'SERIAL-RAW',name:'Serialized component',kind:'raw_material',unit:'each',reorderLevel:0n,trackBatches:false,trackSerials:true,isActive:true,notes:''})
  await recordStockMovement(me,ledger,{...stock,itemId:serialItem,date:'2026-01-06',quantity:Q('2'),cost:200n,serials:['S1','S2'],key:randomUUID()})
  const serialBom=await saveBom(me,ledger,{...bomInput,code:'SERIAL-RECIPE',components:[{itemId:serialItem,quantity:Q('1')}]})
  const serialOrder=await createProductionOrder(me,ledger,{...orderInput,bomId:serialBom,quantity:Q('2'),startDate:'2026-01-06',key:randomUUID()})
  const serialEvent=async(patch:Partial<ProductionAction>)=>recordProductionEvent(me,ledger,{orderId:serialOrder,version:(await productionOrderDetail(ledger,serialOrder))!.order.version,kind:'material_issue',date:'2026-01-06',itemId:serialItem,sourceEventId:'',quantity:0n,cost:0n,batch:'',serials:[],note:'',key:randomUUID(),...patch})
  const serialIssue=await serialEvent({quantity:Q('2'),serials:['S1','S2']})
  await serialEvent({kind:'material_return',quantity:Q('1'),serials:['S1'],sourceEventId:serialIssue})
  await recordStockMovement(me,ledger,{...stock,itemId:serialItem,kind:'issue',date:'2026-01-06',quantity:Q('1'),cost:0n,fromWarehouseId:main,toWarehouseId:'',serials:['S1'],key:randomUUID()})
  await refuse('RETURN',()=>serialEvent({kind:'material_return',quantity:Q('1'),serials:['S1'],sourceEventId:serialIssue}))
  await serialEvent({kind:'loss',note:'Rejected remaining serialized material'})
  const concurrentOrder=await createProductionOrder(me,ledger,{...orderInput,quantity:Q('1'),startDate:'2026-01-07',key:randomUUID()})
  await recordProductionEvent(me,ledger,{orderId:concurrentOrder,version:1,kind:'material_issue',date:'2026-01-07',itemId:raw,sourceEventId:'',quantity:Q('3'),cost:0n,batch:'',serials:[],note:'',key:randomUUID()})
  const complete={orderId:concurrentOrder,version:2,kind:'completion' as const,date:'2026-01-07',itemId:'',sourceEventId:'',quantity:Q('1'),cost:0n,batch:'',serials:[],note:''}
  const concurrent=await Promise.allSettled([recordProductionEvent(me,ledger,{...complete,key:randomUUID()}),recordProductionEvent(me,ledger,{...complete,key:randomUUID()})]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.equal((await productionOrderDetail(ledger,concurrentOrder))!.events.filter(e=>e.kind==='completion').length,1)
  const zero=await createCompanyWithYear({code:'ZERO',name:'Zero stock production'},me.email),zeroLedger=zero.ledger.id
  const emptyItem=async(sku:string,kind:string)=>saveInventoryItem(me,zeroLedger,{sku,name:sku,kind,unit:'each',reorderLevel:0n,trackBatches:false,trackSerials:false,isActive:true,notes:''})
  const zeroRaw=await emptyItem('RAW','raw_material'),zeroFg=await emptyItem('FG','finished_goods'),zeroBom=await saveBom(me,zeroLedger,{...bomInput,outputItemId:zeroFg,components:[{itemId:zeroRaw,quantity:Q('1')}]})
  await createProductionOrder(me,zeroLedger,{...orderInput,bomId:zeroBom,quantity:Q('1'),warehouseId:'',key:randomUUID()})
  await refuse('COST_METHOD_STOCK',async()=>saveInventorySettings(me,zeroLedger,{version:(await inventorySettings(zeroLedger)).version,warehousesEnabled:false,costMethod:'moving_average'}))
  await db.execute(q`SELECT operations_validate_ledger(${ledger}::uuid)`)
  const backup=await exportCompany(A.company.id),restored=await restoreCompany(backup,me.email,{code:'COPY',name:'Production copy'})
  await db.execute(q`SELECT operations_validate_ledger(${restored.ledgerId}::uuid)`)
  const damaged=structuredClone(backup);damaged.rows.production_event.find(e=>e.kind==='completion')!.quantity='999000000'
  await assert.rejects(()=>restoreCompany(damaged,me.email,{code:'BADPROD',name:'Corrupt production'}),e=>errorText(e).includes('PRODUCTION_'))
  assert.equal((await db.execute<{n:string}>(q`SELECT count(*)::text AS n FROM journal_entry`))[0].n,'0')
  for(let qty=1n;qty<=17n;qty++){
    const result=averageIssue([{id:'a',quantity:7n,cost:11n},{id:'b',quantity:10n,cost:22n}],qty)
    assert.equal(result.layers.reduce((n,l)=>n+l.revaluation,0n),0n)
    assert.equal(result.layers.reduce((n,l)=>n+l.remainingCost,0n)+result.cost,33n)
  }
  assert.deepEqual(distributeCost(1n,[1n,1n,1n]),[0n,1n,0n])
  console.log('PASS  PR01 production and moving-average invariants  cost examples, partial completion, return, loss, serial-return uniqueness, concurrent completion, zero-stock open-order method lock, replay, ledger scope, backup and no-GL checks passed')
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>connection.end())

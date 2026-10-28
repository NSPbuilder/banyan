import {randomUUID} from 'node:crypto'
import type {UserRecord} from '../src/lib/users'
import {saveAsset} from '../src/lib/assets'
import {saveInventoryItem,saveInventorySettings,inventorySettings,inventoryWarehouses,recordStockMovement} from '../src/lib/inventory'
import {saveBom,createProductionOrder,recordProductionEvent,productionOrderDetail,type ProductionAction} from '../src/lib/production'
import {saveDepreciationPolicy,adjustDepreciation,depreciationAssets,depreciationPreview,runDepreciation} from '../src/lib/depreciation'
import {saveCcaPool,saveCcaAssignment,ccaPreview,recordCcaYear,ccaRegister} from '../src/lib/cca'
import {deferredTaxPreview,recordDeferredTaxReview} from '../src/lib/deferred-tax'
import {parseQuantity as Q} from '../src/lib/quantity'
import {fixtureAsset} from './operations-fixture'
/** Call before receiving other fixture stock so a real MA/FIFO switch is safe. */
export async function buildAdvancedOperationsFixture(me:UserRecord,ledgerId:string){
  const setting=await inventorySettings(ledgerId);await saveInventorySettings(me,ledgerId,{version:setting.version,warehousesEnabled:false,costMethod:'moving_average'})
  const main=(await inventoryWarehouses(ledgerId))[0].id
  const item=(sku:string,name:string,kind:string)=>saveInventoryItem(me,ledgerId,{sku,name,kind,unit:'each',reorderLevel:0n,trackBatches:false,trackSerials:false,isActive:true,notes:''})
  const average=await item('MA-001','Cost method opening test','raw_material'),stock={itemId:average,kind:'receipt' as const,date:'2026-01-01',quantity:Q('10'),cost:1000n,fromWarehouseId:'',toWarehouseId:main,batch:'',serials:[],reference:'Opening cost-method fixture',note:'',key:randomUUID()}
  await recordStockMovement(me,ledgerId,stock);await recordStockMovement(me,ledgerId,{...stock,cost:2000n,key:randomUUID()});await recordStockMovement(me,ledgerId,{...stock,kind:'issue',quantity:Q('20'),cost:0n,fromWarehouseId:main,toWarehouseId:'',key:randomUUID()})
  await saveInventorySettings(me,ledgerId,{version:(await inventorySettings(ledgerId)).version,warehousesEnabled:false,costMethod:'fifo'})
  const raw=await item('RM-PROD','Production aluminum sections','raw_material'),wip=await item('WIP-PROD','Assembled subframe','work_in_progress'),fg=await item('FG-PROD','Finished display frame','finished_goods')
  await recordStockMovement(me,ledgerId,{...stock,itemId:raw,quantity:Q('100'),cost:10000n,key:randomUUID()})
  const bom=await saveBom(me,ledgerId,{code:'SUBFRAME',name:'Subframe recipe',outputItemId:wip,outputQuantity:Q('1'),components:[{itemId:raw,quantity:Q('2')}],notes:'Reusable first-stage recipe',isActive:true})
  const order=await createProductionOrder(me,ledgerId,{bomId:bom,quantity:Q('4'),warehouseId:main,startDate:'2026-01-01',dueDate:'2026-12-31',notes:'Subassembly production',key:randomUUID()})
  const event=async(orderId:string,patch:Partial<ProductionAction>)=>recordProductionEvent(me,ledgerId,{orderId,version:(await productionOrderDetail(ledgerId,orderId))!.order.version,kind:'material_issue',date:'2026-01-01',itemId:raw,sourceEventId:'',quantity:0n,cost:0n,batch:'',serials:[],note:'',key:randomUUID(),...patch})
  const issue=await event(order,{quantity:Q('9')});await event(order,{kind:'material_return',sourceEventId:issue,quantity:Q('1')});await event(order,{kind:'conversion_cost',cost:200n,note:'Assembly labour'});await event(order,{kind:'completion',quantity:Q('4')})
  const fgBom=await saveBom(me,ledgerId,{code:'FRAME-FINISH',name:'Frame finishing recipe',outputItemId:fg,outputQuantity:Q('1'),components:[{itemId:wip,quantity:Q('1')}],notes:'Reusable final-stage recipe',isActive:true})
  const partial=await createProductionOrder(me,ledgerId,{bomId:fgBom,quantity:Q('2'),warehouseId:main,startDate:'2026-01-01',dueDate:'2026-12-31',notes:'Partial completion fixture',key:randomUUID()});await event(partial,{itemId:wip,quantity:Q('2')});await event(partial,{kind:'completion',quantity:Q('1')})
  const asset=await saveAsset(me,ledgerId,{...fixtureAsset,code:'FA-ZDEP',name:'Production finishing equipment',acquiredOn:'2026-01-01',inServiceOn:'2026-01-01',acquisitionCost:1200000n})
  await saveDepreciationPolicy(me,ledgerId,{assetId:asset,version:0,method:'straight_line',startDate:'2026-01-01',residualValue:0n,lifeMonths:120,annualRateBp:2000})
  await adjustDepreciation(me,ledgerId,{assetId:asset,date:'2026-01-01',amount:100n,note:'Opening accumulated depreciation',key:randomUUID()})
  const preview=depreciationPreview(await depreciationAssets(ledgerId),'2026-01-31');await runDepreciation(me,ledgerId,{through:'2026-01-31',key:randomUUID(),expectedHash:preview.hash})
  const pool=await saveCcaPool(me,ledgerId,{version:0,name:'Class 8 production equipment',classCode:'8',rateBp:2000,calculation:'standard',openingUcc:0n,startDate:'2026-01-01'})
  await saveCcaAssignment(me,ledgerId,{assetId:asset,poolId:pool,version:0,taxCost:1200000n,availableOn:'2026-01-01',rule:'riip',eligibilityNote:'CAD cost; 100% business use; eligible arm’s-length RII property',disposedOn:'',proceeds:0n})
  const input={poolId:pool,startDate:'2026-01-01',endDate:'2026-12-31',adjustment:0n,poolClosed:false},tax=await ccaPreview(ledgerId,input);await recordCcaYear(me,ledgerId,{...input,claim:300000n,note:'Reviewed tax claim below maximum',key:randomUUID(),expectedHash:tax.hash})
  const bookEnd=depreciationPreview(await depreciationAssets(ledgerId),'2026-12-31');await runDepreciation(me,ledgerId,{through:'2026-12-31',key:randomUUID(),expectedHash:bookEnd.hash})
  const review={ccaYearId:(await ccaRegister(ledgerId)).years.find(y=>y.pool_id===pool)!.id,rateBp:2500,rateNote:'Fixture reversal tax-rate assumption',bookAdjustment:0n,taxAdjustment:0n,recognizedAsset:0n,openingLiability:0n,openingAsset:0n,recognition:'profit_loss' as const,scopeReviewed:true,note:'Complete pool scope; tax base and recognition reviewed'}
  const working=await deferredTaxPreview(ledgerId,review);await recordDeferredTaxReview(me,ledgerId,{...review,key:randomUUID(),expectedHash:working.hash})
  await saveDepreciationPolicy(me,ledgerId,{assetId:asset,version:1,method:'straight_line',startDate:'2027-01-01',residualValue:0n,lifeMonths:108,annualRateBp:2000,revisionReason:'Annual useful-life and residual review'})
  return {raw,wip,fg,bom,order,partial,asset,pool}
}

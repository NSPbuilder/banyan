import {randomUUID} from 'node:crypto'
import type {UserRecord} from '../src/lib/users'
import {saveAsset,addAssetActivity,type AssetInput} from '../src/lib/assets'
import {saveInventoryItem,saveInventorySettings,saveInventoryWarehouse,inventorySettings,inventoryWarehouses,recordStockMovement} from '../src/lib/inventory'
import {parseQuantity} from '../src/lib/quantity'
export const fixtureAsset:AssetInput={code:'FA-001',name:'Workshop cutting machine',category:'Machinery',acquiredOn:'2026-01-10',inServiceOn:'2026-01-12',warrantyUntil:'2027-01-10',acquisitionCost:2450000n,supplier:'Equipment supplier',serialNumber:'CM-01928',location:'Workshop',custodian:'Operations',status:'in_use',disposedOn:'',disposalProceeds:0n,notes:'Operations fixture'}
export async function buildOperationsFixture(me:UserRecord,ledgerId:string) {
  const asset=await saveAsset(me,ledgerId,fixtureAsset)
  await addAssetActivity(me,ledgerId,{assetId:asset,date:'2026-02-01',kind:'maintenance',note:'Routine inspection and blade replacement',cost:8500n,key:randomUUID()})
  const item=await saveInventoryItem(me,ledgerId,{sku:'FG-100',name:'Aluminum frame',kind:'finished_goods',unit:'each',reorderLevel:parseQuantity('2'),trackBatches:true,trackSerials:true,isActive:true,notes:'Serialized finished good'})
  const setting=await inventorySettings(ledgerId);await saveInventorySettings(me,ledgerId,{version:setting.version,warehousesEnabled:true})
  const warehouse=await saveInventoryWarehouse(me,ledgerId,{code:'SECOND',name:'Secondary warehouse',isActive:true}),main=(await inventoryWarehouses(ledgerId)).find(w=>w.is_default)!.id
  const base={itemId:item,date:'2026-03-01',quantity:parseQuantity('3'),cost:30000n,fromWarehouseId:'',toWarehouseId:main,batch:'LOT-A',serials:['FRAME-001','FRAME-002','FRAME-003'],reference:'Fixture delivery',note:'',key:randomUUID()}
  const receipt=await recordStockMovement(me,ledgerId,{...base,kind:'receipt'})
  const transfer=await recordStockMovement(me,ledgerId,{...base,kind:'transfer',date:'2026-03-02',quantity:parseQuantity('1'),cost:0n,fromWarehouseId:main,toWarehouseId:warehouse,serials:['FRAME-003'],key:randomUUID()})
  const issue=await recordStockMovement(me,ledgerId,{...base,kind:'issue',date:'2026-03-03',quantity:parseQuantity('1'),cost:0n,fromWarehouseId:main,toWarehouseId:'',serials:['FRAME-001'],key:randomUUID()})
  return {asset,item,main,warehouse,receipt,transfer,issue}
}

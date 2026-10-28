/** Real transactions in a fresh, explicitly isolated test database. */
import './env'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {sql as q} from 'drizzle-orm'
import {db,sql as connection} from '../src/db/client'
import {createFirstOwner,createUser} from '../src/lib/users'
import {createCompanyWithYear} from '../src/lib/setup'
import {setGrants} from '../src/lib/access'
import {setCompanyModules} from '../src/lib/company-modules'
import {MODULE_PATHS} from '../src/lib/nav'
import {saveAsset,assetRows,assetDetail,addAssetActivity} from '../src/lib/assets'
import {saveInventoryItem,inventoryItems,inventoryItemDetail,inventorySettings,inventoryWarehouses,saveInventorySettings,saveInventoryWarehouse,recordStockMovement,movementDetail,inventoryMovements,type StockMovementInput} from '../src/lib/inventory'
import {parseQuantity,quantityInput} from '../src/lib/quantity'
import {exportCompany,restoreCompany,COMPANY_DATA,NOT_COMPANY_DATA} from '../src/lib/backup'
import {actingAs} from '../src/lib/acting'
import {deleteCompany,archiveCompany} from '../src/lib/companies'
import {fixtureAsset,buildOperationsFixture} from './operations-fixture'
import {reporter,errorText} from './suite'
const r=reporter(78),check=r.check
const refuse=async(label:string,code:string,fn:()=>Promise<unknown>)=>{try{await fn();r.fail(label,'accepted unexpectedly')}catch(e){check(errorText(e).includes(code)||(e as {code?:string}).code===code,label,errorText(e).slice(0,100))}}
async function main() {
  const name=new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1),[identity]=await db.execute<{name:string}>(q`SELECT current_database() AS name`);assert.equal(identity.name,name)
  const me=await createFirstOwner({email:'operations-owner@example.test',firstName:'Operations owner',password:'Isolated operations password sentence'})
  const A=await createCompanyWithYear({code:'OPSA',name:'Operations A'},me.email),B=await createCompanyWithYear({code:'OPSB',name:'Operations B'},me.email),ledger=A.ledger.id
  const [before]=await db.execute<{count:string}>(q`SELECT count(*)::text AS count FROM journal_entry`)
  const fixture=await buildOperationsFixture(me,ledger)
  const asset=(await assetDetail(ledger,fixture.asset))!
  check(asset.asset.acquisition_cost==='2450000'&&asset.activities.length===1,'OP01 asset identity, custody, costs and maintenance persist')
  check(await assetDetail(B.ledger.id,fixture.asset)===null,'OP02 foreign asset detail returns no data')
  await refuse('OP03 foreign asset edit refuses','ASSET',()=>saveAsset(me,B.ledger.id,{...fixtureAsset,id:fixture.asset,version:1}))
  await refuse('OP04 duplicate code is case insensitive','CODE',()=>saveAsset(me,ledger,{...fixtureAsset,code:'fa-001'}))
  await refuse('OP05 invalid calendar day refuses','DATE',()=>saveAsset(me,ledger,{...fixtureAsset,code:'BAD',acquiredOn:'2026-02-30'}))
  await refuse('OP06 disposed asset requires a date','DISPOSAL',()=>saveAsset(me,ledger,{...fixtureAsset,code:'BAD',status:'disposed'}))
  await refuse('OP07 activity dates constrain acquisition corrections','ACTIVITY_DATES',()=>saveAsset(me,ledger,{...fixtureAsset,id:fixture.asset,version:1,acquiredOn:'2026-03-01',inServiceOn:'2026-03-02'}))
  await saveAsset(me,ledger,{...fixtureAsset,id:fixture.asset,version:1,location:'Assembly floor',custodian:'New custodian',status:'under_repair'})
  await refuse('OP08 stale asset edit refuses','STALE',()=>saveAsset(me,ledger,{...fixtureAsset,id:fixture.asset,version:1}))
  const activity={assetId:fixture.asset,date:'2026-03-10',kind:'inspection',note:'Safety inspection',cost:100n,key:randomUUID()}
  const activityId=await addAssetActivity(me,ledger,activity)
  check(await addAssetActivity(me,ledger,activity)===activityId,'OP09 retried activity records once')
  await refuse('OP10 changed replay refuses','REPLAY',()=>addAssetActivity(me,ledger,{...activity,note:'Changed'}))
  await saveAsset(me,ledger,{...fixtureAsset,id:fixture.asset,version:2,status:'disposed',disposedOn:'2026-04-01',disposalProceeds:2000000n})
  await refuse('OP11 activity after disposal refuses','DATE',()=>addAssetActivity(me,ledger,{...activity,date:'2026-04-02',key:randomUUID()}))
  check((await assetDetail(ledger,fixture.asset))!.changes.length===3,'OP12 every register edit retains attributed history')
  const physical=(await inventoryItemDetail(ledger,fixture.item))!
  check(physical.item.on_hand==='2000000'&&physical.item.fifo_cost==='20000'&&physical.stock.length===2,'OP13 serial/batch receipt, transfer and issue balances agree')
  check((await movementDetail(ledger,fixture.transfer))!.stock.length===2&&(await movementDetail(ledger,fixture.transfer))!.allocations[0].cost==='10000','OP14 transfer retains physical changes and FIFO cost provenance')
  check(physical.layers.every(l=>l.acquired_on==='2026-03-01'),'OP15 transfer preserves original receipt age')
  check(await inventoryItemDetail(B.ledger.id,fixture.item)===null&&await movementDetail(B.ledger.id,fixture.receipt)===null,'OP16 foreign item and movement reads return no data')
  const itemInput={sku:'RM-200',name:'Aluminum extrusion',kind:'raw_material',unit:'metre',reorderLevel:parseQuantity('5'),trackBatches:false,trackSerials:false,isActive:true,notes:''}
  const item=await saveInventoryItem(me,ledger,itemInput),foreignItem=await saveInventoryItem(me,B.ledger.id,itemInput)
  const base:StockMovementInput={itemId:item,kind:'receipt',date:'2026-05-01',quantity:parseQuantity('10'),cost:1000n,fromWarehouseId:'',toWarehouseId:fixture.main,batch:'',serials:[],reference:'First receipt',note:'',key:randomUUID()}
  const receipt=await recordStockMovement(me,ledger,base)
  check(await recordStockMovement(me,ledger,base)===receipt,'OP17 receipt retry returns the same movement')
  await refuse('OP18 changed receipt replay refuses','REPLAY',()=>recordStockMovement(me,ledger,{...base,cost:2000n}))
  await recordStockMovement(me,ledger,{...base,date:'2026-05-02',quantity:parseQuantity('10'),cost:2000n,key:randomUUID()})
  const issue=await recordStockMovement(me,ledger,{...base,kind:'issue',date:'2026-05-03',quantity:parseQuantity('12'),cost:0n,fromWarehouseId:fixture.main,toWarehouseId:'',key:randomUUID()})
  const issueDetail=(await movementDetail(ledger,issue))!,remaining=(await inventoryItemDetail(ledger,item))!
  check(issueDetail.movement.cost==='1400'&&issueDetail.allocations.length===2&&remaining.item.on_hand==='8000000'&&remaining.item.fifo_cost==='1600','OP19 issue spans oldest FIFO layers with exact cost')
  await refuse('OP20 negative inventory refuses','INSUFFICIENT_STOCK',()=>recordStockMovement(me,ledger,{...base,kind:'issue',date:'2026-05-04',quantity:parseQuantity('9'),cost:0n,fromWarehouseId:fixture.main,toWarehouseId:'',key:randomUUID()}))
  await refuse('OP21 backdated movement refuses','CHRONOLOGY',()=>recordStockMovement(me,ledger,{...base,key:randomUUID()}))
  await refuse('OP22 outgoing cost cannot override FIFO','COST',()=>recordStockMovement(me,ledger,{...base,kind:'issue',date:'2026-05-04',cost:1n,key:randomUUID()}))
  await refuse('OP23 foreign warehouse refuses','WAREHOUSE',()=>recordStockMovement(me,B.ledger.id,{...base,itemId:foreignItem,date:'2026-05-04',key:randomUUID()}))
  await refuse('OP24 foreign item write refuses','ITEM',()=>recordStockMovement(me,B.ledger.id,{...base,date:'2026-05-04',key:randomUUID()}))
  await refuse('OP25 used item unit and tracking are frozen','TRACKING',()=>saveInventoryItem(me,ledger,{...itemInput,id:item,version:1,unit:'foot'}))
  await refuse('OP26 nonempty item cannot be archived','STOCK',()=>saveInventoryItem(me,ledger,{...itemInput,id:item,version:1,isActive:false}))
  const take={...base,kind:'issue' as const,date:'2026-05-04',quantity:parseQuantity('5'),cost:0n,fromWarehouseId:fixture.main,toWarehouseId:''}
  const concurrent=await Promise.allSettled([recordStockMovement(me,ledger,{...take,key:randomUUID()}),recordStockMovement(me,ledger,{...take,key:randomUUID()})])
  check(concurrent.filter(x=>x.status==='fulfilled').length===1&&(await inventoryItemDetail(ledger,item))!.item.on_hand==='3000000','OP27 concurrent issues serialize and prevent overselling')
  const fractional=await saveInventoryItem(me,ledger,{...itemInput,sku:'FRACTION'}),fraction={...base,itemId:fractional,date:'2026-06-01',quantity:parseQuantity('1'),cost:101n,key:randomUUID()}
  await recordStockMovement(me,ledger,fraction)
  const costs=[]
  for(const amount of ['0.333333','0.333333','0.333334']){const id=await recordStockMovement(me,ledger,{...fraction,kind:'issue',quantity:parseQuantity(amount),cost:0n,fromWarehouseId:fixture.main,toWarehouseId:'',key:randomUUID()});costs.push(BigInt((await movementDetail(ledger,id))!.movement.cost))}
  check(costs.reduce((a,b)=>a+b,0n)===101n&&(await inventoryItemDetail(ledger,fractional))!.item.fifo_cost==='0','OP28 fractional issues conserve every cent through exhaustion')
  check(quantityInput(parseQuantity('12345678901.123456'))==='12345678901.123456','OP29 quantity parsing and formatting remain exact beyond float precision')
  await refuse('OP30 overprecision quantity refuses','6 decimal',async()=>parseQuantity('1.0000001'))
  const serialBase={...base,itemId:fixture.item,date:'2026-07-01',quantity:parseQuantity('1'),cost:10000n,batch:'LOT-A',serials:['FRAME-002'],key:randomUUID()}
  await refuse('OP31 duplicate live serial refuses','SERIAL_USED',()=>recordStockMovement(me,ledger,serialBase))
  await refuse('OP32 serial count must equal whole-unit quantity','SERIAL_QUANTITY',()=>recordStockMovement(me,ledger,{...serialBase,quantity:parseQuantity('0.5'),serials:['NEW'],key:randomUUID()}))
  await refuse('OP33 batch is required when enabled','BATCH',()=>recordStockMovement(me,ledger,{...serialBase,batch:'',serials:['NEW'],key:randomUUID()}))
  const beforeFailed=(await inventoryMovements(ledger,fixture.item)).length
  await refuse('OP34 wrong physical batch refuses atomically','TRACKED_STOCK',()=>recordStockMovement(me,ledger,{...serialBase,kind:'issue',cost:0n,fromWarehouseId:fixture.main,toWarehouseId:'',batch:'WRONG',key:randomUUID()}))
  check((await inventoryMovements(ledger,fixture.item)).length===beforeFailed&&(await inventoryItemDetail(ledger,fixture.item))!.item.fifo_cost==='20000','OP35 physical refusal rolls back movement and cost')
  await recordStockMovement(me,ledger,{...serialBase,kind:'adjust_in',serials:['FRAME-001'],note:'Customer return',key:randomUUID()})
  check((await inventoryItemDetail(ledger,fixture.item))!.stock.some(s=>s.serial==='FRAME-001'),'OP36 explicit adjustment returns a previously issued serial')
  await refuse('OP37 stock adjustment requires a reason','FIELD',()=>recordStockMovement(me,ledger,{...base,kind:'adjust_in',date:'2026-08-01',key:randomUUID()}))
  const settings=await inventorySettings(ledger)
  await refuse('OP38 warehouses cannot turn off with other stock','WAREHOUSE_STOCK',()=>saveInventorySettings(me,ledger,{version:settings.version,warehousesEnabled:false}))
  await refuse('OP39 stocked warehouse cannot be archived','STOCK',()=>saveInventoryWarehouse(me,ledger,{id:fixture.warehouse,version:1,code:'SECOND',name:'Other',isActive:false}))
  await refuse('OP40 stale settings refuse','STALE',()=>saveInventorySettings(me,ledger,{version:0,warehousesEnabled:true}))
  const user=await createUser({email:'operations-user@example.test',firstName:'Limited',password:'Isolated operations user password',actor:me.email})
  await setGrants({userId:user.id,entityIds:[A.company.id],modules:['/assets'],actor:me.email})
  await refuse('OP41 module permission required at core door','NO_ACCESS',()=>saveInventoryItem(user,ledger,{...itemInput,sku:'DENIED'}))
  await refuse('OP42 company permission required at core door','NO_ACCESS',()=>saveAsset(user,B.ledger.id,{...fixtureAsset,code:'DENIED'}))
  await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS.filter(m=>m!=='/inventory')})
  await refuse('OP43 disabled module refuses even owner','NO_ACCESS',()=>saveInventoryItem(me,ledger,{...itemInput,sku:'DENIED'}))
  await setCompanyModules(me,{entityId:A.company.id,modules:MODULE_PATHS})
  await refuse('OP44 movement history cannot be altered','OPERATIONS_HISTORY_IMMUTABLE',()=>db.execute(q`UPDATE inventory_movement SET note='tampered' WHERE id=${receipt}::uuid`))
  await refuse('OP45 balance cannot be overwritten directly','INVENTORY_WRITE_DOOR',()=>db.execute(q`UPDATE inventory_stock SET quantity=0 WHERE item_id=${item}::uuid`))
  await refuse('OP46 incomplete cost/quantity fails at commit','INVENTORY_COST_QUANTITY_MISMATCH',()=>actingAs(me.email,async tx=>{await tx.execute(q`SELECT set_config('app.inventory_write','on',true)`);await tx.execute(q`UPDATE inventory_stock SET quantity=0 WHERE item_id=${item}::uuid`)}))
  await refuse('OP47 direct SQL cannot change used tracking','INVENTORY_TRACKING_IMMUTABLE',()=>db.execute(q`UPDATE inventory_item SET track_batches=true WHERE id=${item}::uuid`))
  const allTables=await db.execute<{name:string}>(q`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`),known=new Set([...COMPANY_DATA.map(t=>t.table),...Object.keys(NOT_COMPANY_DATA)])
  check(allTables.every(t=>known.has(t.name)),'OP48 every operational table is included in company backup')
  const backup=await exportCompany(A.company.id),copy=await restoreCompany(backup,me.email,{code:'OPSACOPY',name:'Operations A copy'})
  const copiedItems=await inventoryItems(copy.ledgerId!),copiedAsset=(await assetRows(copy.ledgerId!))[0]
  check(copiedItems.length===(await inventoryItems(ledger)).length&&copiedItems.every(i=>{const original=(backup.rows.inventory_item??[]).find(x=>x.sku===i.sku);return original&&i.id!==original.id}),'OP49 backup restore remaps inventory identities')
  const originalItem=(await inventoryItems(ledger)).find(i=>i.id===item)!,copiedItem=copiedItems.find(i=>i.sku===originalItem.sku)!
  check(copiedItem.on_hand===originalItem.on_hand&&copiedItem.fifo_cost===originalItem.fifo_cost&&(await assetDetail(copy.ledgerId!,copiedAsset.id))!.activities.length===2,'OP50 restore preserves quantity, FIFO costs and maintenance')
  const copyMain=(await inventoryWarehouses(copy.ledgerId!)).find(w=>w.is_default)!
  await recordStockMovement(me,copy.ledgerId!,{...base,itemId:copiedItem.id,kind:'issue',date:'2026-08-01',quantity:parseQuantity('1'),cost:0n,fromWarehouseId:copyMain.id,toWarehouseId:'',key:randomUUID()})
  check((await inventoryItemDetail(copy.ledgerId!,copiedItem.id))!.item.on_hand==='2000000'&&(await inventoryItemDetail(ledger,item))!.item.on_hand==='3000000','OP51 restored FIFO register remains usable and independent')
  const [audit]=await db.execute<{bad:string}>(q`SELECT count(*)::text AS bad FROM audit_log WHERE table_name IN ('fixed_asset','fixed_asset_activity','inventory_item','inventory_setting','inventory_warehouse','inventory_movement') AND (entity_id IS NULL OR ledger_id IS NULL OR actor NOT LIKE '%@example.test')`)
  check(audit.bad==='0','OP52 audit rows carry company, ledger and signed-in actor')
  const [after]=await db.execute<{count:string}>(q`SELECT count(*)::text AS count FROM journal_entry`)
  check(before.count===after.count,'OP53 operational workflows leave the general ledger unchanged')
  await refuse('OP54 registers prevent deletion of a company without journals','HAS_BOOKS',()=>deleteCompany(A.company.id,me.email))
  const oneLocation=await recordStockMovement(me,B.ledger.id,{...base,itemId:foreignItem,toWarehouseId:'',quantity:parseQuantity('2'),cost:100n,key:randomUUID()})
  check((await movementDetail(B.ledger.id,oneLocation))!.movement.to_name==='Main stock','OP55 warehouses off uses main location without selecting a warehouse')
  await refuse('OP56 warehouses off refuses transfers','TRANSFER',()=>recordStockMovement(me,B.ledger.id,{...base,itemId:foreignItem,kind:'transfer',cost:0n,fromWarehouseId:'',toWarehouseId:'',quantity:parseQuantity('1'),key:randomUUID()}))
  const tracked=await saveInventoryItem(me,ledger,{...itemInput,sku:'FIFO-SERIAL',unit:'each',trackSerials:true,trackBatches:true})
  const trackedReceipt={...base,itemId:tracked,date:'2026-09-01',quantity:parseQuantity('1'),cost:100n,batch:'OLD',serials:['OLD-SERIAL'],key:randomUUID()}
  await recordStockMovement(me,ledger,trackedReceipt)
  await recordStockMovement(me,ledger,{...trackedReceipt,date:'2026-09-02',cost:200n,batch:'NEW',serials:['NEW-SERIAL'],key:randomUUID()})
  const trackedIssue=await recordStockMovement(me,ledger,{...trackedReceipt,kind:'issue',date:'2026-09-03',cost:0n,fromWarehouseId:fixture.main,toWarehouseId:'',batch:'NEW',serials:['NEW-SERIAL'],key:randomUUID()})
  const trackedAfter=(await inventoryItemDetail(ledger,tracked))!
  check((await movementDetail(ledger,trackedIssue))!.movement.cost==='100'&&trackedAfter.stock[0].serial==='OLD-SERIAL'&&trackedAfter.item.fifo_cost==='200','OP57 physical batch/serial selection does not override FIFO cost')
  await refuse('OP58 incomplete movement fails its deferred history check','INVENTORY_MOVEMENT_STOCK_TOTAL',()=>actingAs(me.email,async tx=>{await tx.execute(q`SELECT set_config('app.inventory_write','on',true)`);await tx.execute(q`INSERT INTO inventory_movement(ledger_id,item_id,sequence,movement_date,kind,to_warehouse_id,quantity,cost,request_key,request_hash,created_by) VALUES(${ledger}::uuid,${item}::uuid,99999,'2026-10-01','receipt',${fixture.main}::uuid,1000000,100,${randomUUID()}::uuid,'fake',${me.email})`)}))
  await archiveCompany(B.company.id,'Finished isolated test',me.email)
  await refuse('OP59 archived company refuses operational writes','NO_ACCESS',()=>saveAsset(me,B.ledger.id,{...fixtureAsset,code:'BLOCKED'}))
  const damaged=structuredClone(await exportCompany(A.company.id)),damagedStock=damaged.rows.inventory_stock.find(s=>s.item_id===item)!;damagedStock.quantity=String(BigInt(String(damagedStock.quantity))+1000000n)
  await refuse('OP60 restored stock must reconcile to immutable movement history','INVENTORY_REGISTER_INCONSISTENT',()=>restoreCompany(damaged,me.email,{code:'DAMAGED',name:'Damaged copy'}))
  check(!(await db.execute(q`SELECT id FROM entity WHERE code='DAMAGED'`)).length,'OP61 refused inconsistent restore leaves no company or partial register')
}
main().catch(e=>r.fail('UNEXPECTED',errorText(e))).finally(async()=>{console.log(r.summary());await connection.end();process.exitCode=r.failures?1:0})

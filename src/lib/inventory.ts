import 'server-only'
import {postStockMovement} from './operations-finance'
import type {FinancialInput} from './operations-finance-types'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Tx } from './acting'
import type { UserRecord } from './users'
import { QUANTITY_SCALE } from './quantity'
import { averageIssue,distributeCost } from './inventory-cost'
import { operationWrite, operationId, operationText, operationDate, operationAmount, OperationsError } from './operations-scope'
import type { InventoryItem, Warehouse, InventorySettings, MovementKind, MovementRow, StockRow, CostLayerRow } from './inventory-types'

const quantity=(n:bigint,positive=false)=>{
  if(n<0n || positive&&n===0n || n>9_000_000_000_000_000_000n)throw new OperationsError('QUANTITY',positive?'Enter a positive quantity.':'Enter a non-negative quantity.')
  return n
}
export async function initializeInventory(tx:Tx,ledgerId:string) {
  await tx.execute(sql`INSERT INTO inventory_setting(ledger_id) VALUES(${ledgerId}::uuid) ON CONFLICT DO NOTHING`)
  await tx.execute(sql`INSERT INTO inventory_warehouse(ledger_id,code,name,is_default) VALUES(${ledgerId}::uuid,'MAIN','Main stock',true) ON CONFLICT DO NOTHING`)
}
export async function inventorySettings(ledgerId:string):Promise<InventorySettings> {
  const [setting]=await db.execute<InventorySettings>(sql`SELECT warehouses_enabled,cost_method,version FROM inventory_setting WHERE ledger_id=${operationId(ledgerId)}::uuid`)
  return setting??{warehouses_enabled:false,cost_method:'fifo',version:0}
}
export async function inventoryItems(ledgerId:string) {
  return db.execute<InventoryItem>(sql`SELECT i.id::text,i.sku,i.name,i.kind,i.unit,i.reorder_level::text,i.track_batches,i.track_serials,i.is_active,i.notes,i.version,
    coalesce((SELECT sum(quantity) FROM inventory_stock WHERE ledger_id=i.ledger_id AND item_id=i.id),0)::text AS on_hand,
    coalesce((SELECT sum(remaining_cost) FROM inventory_cost_layer WHERE ledger_id=i.ledger_id AND item_id=i.id),0)::text AS fifo_cost,
    (EXISTS(SELECT 1 FROM inventory_movement WHERE ledger_id=i.ledger_id AND item_id=i.id) OR EXISTS(SELECT 1 FROM production_order o LEFT JOIN production_order_line p ON p.order_id=o.id WHERE o.ledger_id=i.ledger_id AND (o.output_item_id=i.id OR p.item_id=i.id))) AS has_movements
    FROM inventory_item i WHERE i.ledger_id=${operationId(ledgerId)}::uuid ORDER BY lower(i.sku),i.id`)
}
export async function inventoryWarehouses(ledgerId:string) {
  return db.execute<Warehouse>(sql`SELECT w.id::text,w.code,w.name,w.is_default,w.is_active,w.version,
    coalesce((SELECT sum(quantity) FROM inventory_stock WHERE ledger_id=w.ledger_id AND warehouse_id=w.id),0)::text AS on_hand
    FROM inventory_warehouse w WHERE w.ledger_id=${operationId(ledgerId)}::uuid ORDER BY is_default DESC,lower(code),id`)
}
export async function inventoryMovements(ledgerId:string,itemId?:string,limit=250) {
  if(itemId)operationId(itemId)
  return db.execute<MovementRow>(sql`SELECT m.id::text,m.item_id::text,i.sku,i.name AS item_name,i.unit,m.sequence::text,m.movement_date::text,m.kind,
    f.name AS from_name,t.name AS to_name,m.quantity::text,m.cost::text,m.reference,m.note,m.created_by,m.cost_method
    FROM inventory_movement m JOIN inventory_item i ON i.id=m.item_id LEFT JOIN inventory_warehouse f ON f.id=m.from_warehouse_id LEFT JOIN inventory_warehouse t ON t.id=m.to_warehouse_id
    WHERE m.ledger_id=${operationId(ledgerId)}::uuid AND (${itemId??null}::uuid IS NULL OR m.item_id=${itemId??null}::uuid)
    ORDER BY m.sequence DESC LIMIT ${Math.max(1,Math.min(1000,limit))}`)
}
export async function inventoryItemDetail(ledgerId:string,id:string) {
  operationId(id)
  const item=(await inventoryItems(ledgerId)).find(i=>i.id===id)
  if(!item)return null
  const [stock,layers,movements]=await Promise.all([
    db.execute<StockRow>(sql`SELECT s.id::text,s.warehouse_id::text,w.name AS warehouse_name,s.batch,s.serial,s.quantity::text FROM inventory_stock s JOIN inventory_warehouse w ON w.id=s.warehouse_id
      WHERE s.ledger_id=${ledgerId}::uuid AND s.item_id=${id}::uuid AND s.quantity>0 ORDER BY w.code,s.batch,s.serial`),
    db.execute<CostLayerRow>(sql`SELECT l.id::text,w.name AS warehouse_name,l.acquired_on::text,l.fifo_order::text,l.quantity::text,l.cost::text,l.remaining_quantity::text,l.remaining_cost::text
      FROM inventory_cost_layer l JOIN inventory_warehouse w ON w.id=l.warehouse_id WHERE l.ledger_id=${ledgerId}::uuid AND l.item_id=${id}::uuid AND l.remaining_quantity>0 ORDER BY l.acquired_on,l.fifo_order,l.id`),
    inventoryMovements(ledgerId,id),
  ])
  return {item,stock,layers,movements}
}
export async function movementDetail(ledgerId:string,id:string) {
  const [movement]=await db.execute<MovementRow>(sql`SELECT m.id::text,m.item_id::text,i.sku,i.name AS item_name,i.unit,m.sequence::text,m.movement_date::text,m.kind,f.name AS from_name,t.name AS to_name,
    m.quantity::text,m.cost::text,m.reference,m.note,m.created_by,m.cost_method FROM inventory_movement m JOIN inventory_item i ON i.id=m.item_id LEFT JOIN inventory_warehouse f ON f.id=m.from_warehouse_id LEFT JOIN inventory_warehouse t ON t.id=m.to_warehouse_id
    WHERE m.ledger_id=${operationId(ledgerId)}::uuid AND m.id=${operationId(id)}::uuid`)
  if(!movement)return null
  const [stock,allocations]=await Promise.all([
    db.execute<{warehouse_name:string;batch:string;serial:string;quantity:string}>(sql`SELECT w.name AS warehouse_name,s.batch,s.serial,c.quantity::text FROM inventory_stock_change c JOIN inventory_stock s ON s.id=c.stock_id JOIN inventory_warehouse w ON w.id=s.warehouse_id
      WHERE c.ledger_id=${ledgerId}::uuid AND c.movement_id=${id}::uuid ORDER BY c.quantity,w.code,s.batch,s.serial`),
    db.execute<{acquired_on:string;fifo_order:string;quantity:string;cost:string}>(sql`SELECT l.acquired_on::text,l.fifo_order::text,a.quantity::text,a.cost::text FROM inventory_cost_allocation a JOIN inventory_cost_layer l ON l.id=a.layer_id
      WHERE a.ledger_id=${ledgerId}::uuid AND a.movement_id=${id}::uuid ORDER BY l.acquired_on,l.fifo_order,l.id`),
  ])
  return {movement,stock,allocations}
}
export async function saveInventoryItem(me:UserRecord,ledgerId:string,input:{id?:string;version?:number;sku:string;name:string;kind:string;unit:string;reorderLevel:bigint;trackBatches:boolean;trackSerials:boolean;isActive:boolean;notes:string}) {
  const sku=operationText(input.sku,'SKU',60,true),name=operationText(input.name,'Item name',240,true),unit=operationText(input.unit,'Unit',30,true),notes=operationText(input.notes,'Notes',10000)
  quantity(input.reorderLevel)
  if(!['finished_goods','raw_material','work_in_progress'].includes(input.kind))throw new OperationsError('KIND','Choose raw material, work in progress or finished goods.')
  if(input.trackSerials && input.reorderLevel%QUANTITY_SCALE!==0n)throw new OperationsError('SERIAL_QUANTITY','Serialized items use whole units.')
  if(input.id)operationId(input.id)
  return operationWrite(me,ledgerId,'/inventory',async tx=>{
    await initializeInventory(tx,ledgerId)
    const duplicate=await tx.execute(sql`SELECT id FROM inventory_item WHERE ledger_id=${ledgerId}::uuid AND lower(sku)=lower(${sku}) AND (${input.id??null}::uuid IS NULL OR id<>${input.id??null}::uuid)`)
    if(duplicate.length)throw new OperationsError('SKU','That SKU is already in use.')
    if(input.id) {
      const [old]=await tx.execute<{version:number;kind:string;unit:string;track_batches:boolean;track_serials:boolean}>(sql`SELECT version,kind,unit,track_batches,track_serials FROM inventory_item WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid FOR UPDATE`)
      if(!old)throw new OperationsError('ITEM','This item is unavailable in this ledger.')
      if(old.version!==input.version)throw new OperationsError('STALE','This item changed. Reload before saving.')
      const used=await tx.execute(sql`SELECT id FROM inventory_movement WHERE ledger_id=${ledgerId}::uuid AND item_id=${input.id}::uuid UNION ALL SELECT o.id FROM production_order o LEFT JOIN production_order_line p ON p.order_id=o.id WHERE o.ledger_id=${ledgerId}::uuid AND (o.output_item_id=${input.id}::uuid OR p.item_id=${input.id}::uuid) LIMIT 1`)
      if(used.length && (old.kind!==input.kind || old.unit!==unit || old.track_batches!==input.trackBatches || old.track_serials!==input.trackSerials))throw new OperationsError('TRACKING','Type, unit and tracking cannot change after stock or production history exists. Create a new SKU instead.')
      const balances=await tx.execute(sql`SELECT id FROM inventory_stock WHERE ledger_id=${ledgerId}::uuid AND item_id=${input.id}::uuid AND quantity>0 LIMIT 1`)
      const productionUse=await tx.execute(sql`SELECT 1 FROM production_order o LEFT JOIN production_order_line l ON l.order_id=o.id WHERE o.ledger_id=${ledgerId}::uuid AND o.status='in_progress' AND (o.output_item_id=${input.id}::uuid OR l.item_id=${input.id}::uuid) LIMIT 1`)
      if(!input.isActive&&productionUse.length)throw new OperationsError('PRODUCTION','Close the production orders using this item before archiving it.')
      if(!input.isActive && balances.length)throw new OperationsError('STOCK','An item with stock cannot be archived. Issue or adjust the stock first.')
      await tx.execute(sql`UPDATE inventory_item SET sku=${sku},name=${name},kind=${input.kind},unit=${unit},reorder_level=${input.reorderLevel},track_batches=${input.trackBatches},track_serials=${input.trackSerials},is_active=${input.isActive},notes=${notes},version=version+1,updated_at=clock_timestamp()
        WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid`)
      return input.id
    }
    const [row]=await tx.execute<{id:string}>(sql`INSERT INTO inventory_item(ledger_id,sku,name,kind,unit,reorder_level,track_batches,track_serials,is_active,notes)
      VALUES(${ledgerId}::uuid,${sku},${name},${input.kind},${unit},${input.reorderLevel},${input.trackBatches},${input.trackSerials},${input.isActive},${notes}) RETURNING id::text`)
    return row.id
  })
}
export async function saveInventorySettings(me:UserRecord,ledgerId:string,input:{version:number;warehousesEnabled:boolean;costMethod?:'fifo'|'moving_average'}) {
  return operationWrite(me,ledgerId,'/inventory',async tx=>{
    const [old]=await tx.execute<InventorySettings>(sql`SELECT version,warehouses_enabled,cost_method FROM inventory_setting WHERE ledger_id=${ledgerId}::uuid`)
    if((old?.version??0)!==input.version)throw new OperationsError('STALE','Settings changed. Reload before saving.')
    await initializeInventory(tx,ledgerId)
    const method=input.costMethod??old?.cost_method??'fifo'
    if(!['fifo','moving_average'].includes(method))throw new OperationsError('COST_METHOD','Choose FIFO or moving average.')
    if(method!==(old?.cost_method??'fifo')){
      const used=await tx.execute(sql`SELECT 1 FROM inventory_stock WHERE ledger_id=${ledgerId}::uuid AND quantity>0 UNION ALL SELECT 1 FROM production_order WHERE ledger_id=${ledgerId}::uuid AND status='in_progress' LIMIT 1`)
      if(used.length)throw new OperationsError('COST_METHOD_STOCK','Clear all stock and close production orders before changing the cost method.')
    }
    if(!input.warehousesEnabled) {
      const other=await tx.execute(sql`SELECT s.id FROM inventory_stock s JOIN inventory_warehouse w ON w.id=s.warehouse_id WHERE s.ledger_id=${ledgerId}::uuid AND s.quantity>0 AND NOT w.is_default LIMIT 1`)
      const open=await tx.execute(sql`SELECT 1 FROM production_order o JOIN inventory_warehouse w ON w.id=o.warehouse_id WHERE o.ledger_id=${ledgerId}::uuid AND o.status='in_progress' AND NOT w.is_default LIMIT 1`)
      if(other.length||open.length)throw new OperationsError('WAREHOUSE_STOCK','Transfer all stock to the main warehouse before turning warehouses off.')
    }
    await tx.execute(sql`UPDATE inventory_setting SET warehouses_enabled=${input.warehousesEnabled},cost_method=${method},version=version+1 WHERE ledger_id=${ledgerId}::uuid`)
  })
}
export async function saveInventoryWarehouse(me:UserRecord,ledgerId:string,input:{id?:string;version?:number;code:string;name:string;isActive:boolean}) {
  const code=operationText(input.code,'Warehouse code',60,true),name=operationText(input.name,'Warehouse name',240,true)
  if(input.id)operationId(input.id)
  return operationWrite(me,ledgerId,'/inventory',async tx=>{
    await initializeInventory(tx,ledgerId)
    const [setting]=await tx.execute<InventorySettings>(sql`SELECT warehouses_enabled,cost_method,version FROM inventory_setting WHERE ledger_id=${ledgerId}::uuid`)
    if(!setting.warehouses_enabled)throw new OperationsError('WAREHOUSES_DISABLED','Enable warehouses in Inventory settings first.')
    const duplicate=await tx.execute(sql`SELECT id FROM inventory_warehouse WHERE ledger_id=${ledgerId}::uuid AND lower(code)=lower(${code}) AND (${input.id??null}::uuid IS NULL OR id<>${input.id??null}::uuid)`)
    if(duplicate.length)throw new OperationsError('CODE','That warehouse code is already in use.')
    if(input.id) {
      const [old]=await tx.execute<{version:number;is_default:boolean}>(sql`SELECT version,is_default FROM inventory_warehouse WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid FOR UPDATE`)
      if(!old)throw new OperationsError('WAREHOUSE','This warehouse is unavailable in this ledger.')
      if(old.version!==input.version)throw new OperationsError('STALE','This warehouse changed. Reload before saving.')
      const stock=await tx.execute(sql`SELECT id FROM inventory_stock WHERE ledger_id=${ledgerId}::uuid AND warehouse_id=${input.id}::uuid AND quantity>0 LIMIT 1`)
      if(!input.isActive&&(old.is_default||stock.length))throw new OperationsError('STOCK','The main warehouse and warehouses with stock cannot be archived.')
      await tx.execute(sql`UPDATE inventory_warehouse SET code=${code},name=${name},is_active=${input.isActive},version=version+1 WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid`)
      return input.id
    }
    const [row]=await tx.execute<{id:string}>(sql`INSERT INTO inventory_warehouse(ledger_id,code,name,is_active) VALUES(${ledgerId}::uuid,${code},${name},${input.isActive}) RETURNING id::text`)
    return row.id
  })
}

export type StockMovementInput = {itemId:string;kind:MovementKind;date:string;quantity:bigint;cost:bigint;fromWarehouseId:string;toWarehouseId:string;batch:string;serials:string[];reference:string;note:string;key:string;finance?:FinancialInput}
/** Production uses the same locked transaction as the inventory write. */
export async function recordStockMovement(me:UserRecord,ledgerId:string,input:StockMovementInput) {
  return operationWrite(me,ledgerId,'/inventory',(tx,s)=>applyStockMovement(tx,ledgerId,s.email,input))
}
export async function applyStockMovement(tx:Tx,ledgerId:string,actorEmail:string,input:StockMovementInput,deferProductionPosting=false) {
  operationId(input.itemId);operationId(input.key);operationDate(input.date);quantity(input.quantity,true);operationAmount(input.cost)
  if(!['receipt','issue','transfer','adjust_in','adjust_out'].includes(input.kind))throw new OperationsError('KIND','Choose a valid movement type.')
  const incoming=input.kind==='receipt'||input.kind==='adjust_in',outgoing=input.kind==='issue'||input.kind==='adjust_out',transfer=input.kind==='transfer'
  if(!incoming && input.cost!==0n)throw new OperationsError('COST','Outgoing cost is calculated by the inventory cost method. Leave receipt cost empty.')
  const batch=operationText(input.batch,'Batch',120),serials=input.serials.map(s=>operationText(s,'Serial number',120,true))
  if(new Set(serials).size!==serials.length)throw new OperationsError('SERIAL','Enter each serial number only once.')
  if(serials.length>1000)throw new OperationsError('SERIAL','Record at most 1,000 serial numbers per movement.')
  const reference=operationText(input.reference,'Reference',240),note=operationText(input.note,'Notes',10000,input.kind.startsWith('adjust_'))
  const hash=createHash('sha256').update(JSON.stringify([input.itemId,input.kind,input.date,input.quantity.toString(),input.cost.toString(),input.fromWarehouseId,input.toWarehouseId,batch,[...serials].sort(),reference,note,input.finance??null],(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex')
    await initializeInventory(tx,ledgerId)
    const [previous]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM inventory_movement WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
    if(previous){if(previous.request_hash!==hash)throw new OperationsError('REPLAY','This request was already used with different values. Reload before trying again.');return previous.id}
    const [item]=await tx.execute<{track_batches:boolean;track_serials:boolean;is_active:boolean}>(sql`SELECT track_batches,track_serials,is_active FROM inventory_item WHERE ledger_id=${ledgerId}::uuid AND id=${input.itemId}::uuid FOR UPDATE`)
    if(!item||!item.is_active)throw new OperationsError('ITEM','Choose an active item in this ledger.')
    if(item.track_batches!==!!batch)throw new OperationsError('BATCH',item.track_batches?'This item requires a batch.':'This item does not track batches.')
    if(item.track_serials ? input.quantity!==BigInt(serials.length)*QUANTITY_SCALE : serials.length>0)
      throw new OperationsError('SERIAL_QUANTITY',item.track_serials?'Enter one serial number per whole unit.':'This item does not track serial numbers.')
    const [last]=await tx.execute<{date:string}>(sql`SELECT max(movement_date)::text AS date FROM inventory_movement WHERE ledger_id=${ledgerId}::uuid AND item_id=${input.itemId}::uuid`)
    if(last?.date && input.date<last.date)throw new OperationsError('CHRONOLOGY',`This item has movements on ${last.date}. Use that date or later to preserve cost history.`)
    const [settings]=await tx.execute<InventorySettings>(sql`SELECT warehouses_enabled,cost_method,version FROM inventory_setting WHERE ledger_id=${ledgerId}::uuid`)
    const warehouses=await tx.execute<{id:string;is_default:boolean;is_active:boolean}>(sql`SELECT id::text,is_default,is_active FROM inventory_warehouse WHERE ledger_id=${ledgerId}::uuid`)
    const main=warehouses.find(w=>w.is_default)!
    const choose=(id:string)=>{
      const selected=settings.warehouses_enabled?id:main.id
      if(!settings.warehouses_enabled&&id&&id!==main.id)throw new OperationsError('WAREHOUSE','Warehouses are off. Use main stock.')
      const w=warehouses.find(w=>w.id===selected&&w.is_active)
      if(!w)throw new OperationsError('WAREHOUSE','Choose an active warehouse in this ledger.')
      return w.id
    }
    const from=incoming?null:choose(input.fromWarehouseId),to=outgoing?null:choose(input.toWarehouseId)
    if(transfer&&(!settings.warehouses_enabled||from===to))throw new OperationsError('TRANSFER','Choose two different active warehouses for a transfer.')
    if(incoming && serials.length) {
      const used=await tx.execute<{quantity:string}>(sql`SELECT quantity::text FROM inventory_stock WHERE ledger_id=${ledgerId}::uuid AND item_id=${input.itemId}::uuid AND serial IN (${sql.join(serials.map(s=>sql`${s}`),sql`,`)})`)
      if(used.some(r=>BigInt(r.quantity)>0n))throw new OperationsError('SERIAL_USED','A serial number is already on hand for this item.')
      if(used.length&&input.kind==='receipt')throw new OperationsError('SERIAL_USED','A serial number was already registered. Use Adjustment in with a reason to record a return or correction.')
    }
    type Layer={id:string;acquired_on:string;fifo_order:string;quantity:string;cost:string;remaining_quantity:string;remaining_cost:string;basis_quantity:string|null;basis_cost:string|null}
    const consumed:Array<{layer:Layer;quantity:bigint;cost:bigint;remaining:bigint;remainingCost:bigint}>=[]
    let totalCost=input.cost
    const revaluations:Array<{id:string;amount:bigint;balance:bigint}>=[]
    if(!incoming) {
      const layers=await tx.execute<Layer>(sql`SELECT c.id::text,c.acquired_on::text,c.fifo_order::text,c.quantity::text,c.cost::text,c.remaining_quantity::text,c.remaining_cost::text,
        (SELECT x.basis_quantity::text FROM production_labour_cost_adjustment x WHERE x.layer_id=c.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) basis_quantity,
        (SELECT x.cost_after::text FROM production_labour_cost_adjustment x WHERE x.layer_id=c.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) basis_cost FROM inventory_cost_layer c
        WHERE ledger_id=${ledgerId}::uuid AND item_id=${input.itemId}::uuid AND warehouse_id=${from}::uuid AND remaining_quantity>0 ORDER BY acquired_on,fifo_order,id FOR UPDATE`)
      if(settings.cost_method==='moving_average') {
        if(layers.reduce((n,l)=>n+BigInt(l.remaining_quantity),0n)<input.quantity)throw new OperationsError('INSUFFICIENT_STOCK','Not enough stock in the selected warehouse. Negative inventory is not allowed.')
        const plan=averageIssue(layers.map(l=>({id:l.id,quantity:BigInt(l.remaining_quantity),cost:BigInt(l.remaining_cost)})),input.quantity)
        totalCost=plan.cost
        for(const [i,part] of plan.layers.entries()) {
          if(part.revaluation)revaluations.push({id:part.id,amount:part.revaluation,balance:part.cost+part.remainingCost})
          if(part.quantity)consumed.push({layer:layers[i],quantity:part.quantity,cost:part.cost,remaining:part.remaining,remainingCost:part.remainingCost})
        }
      } else {
      let need=input.quantity;totalCost=0n
      for(const layer of layers) {
        if(need===0n)break
        const available=BigInt(layer.remaining_quantity),take=need<available?need:available,remaining=available-take
        // Cumulative proportional rounding keeps repeated fractional issues
        // consistent and leaves exactly zero cents when a layer is exhausted.
        const originalQty=BigInt(layer.basis_quantity??layer.quantity),remainingCost=(BigInt(layer.basis_cost??layer.cost)*remaining+originalQty/2n)/originalQty
        const cost=BigInt(layer.remaining_cost)-remainingCost
        consumed.push({layer,quantity:take,cost,remaining,remainingCost});totalCost+=cost;need-=take
      }
      if(need)throw new OperationsError('INSUFFICIENT_STOCK','Not enough stock in the selected warehouse. Negative inventory is not allowed.')
      }
    }
    const [next]=await tx.execute<{sequence:string}>(sql`SELECT (coalesce(max(sequence),0)+1)::text AS sequence FROM inventory_movement WHERE ledger_id=${ledgerId}::uuid`)
    await tx.execute(sql`SELECT set_config('app.inventory_write','on',true)`)
    const [movement]=await tx.execute<{id:string}>(sql`INSERT INTO inventory_movement(ledger_id,item_id,sequence,movement_date,kind,from_warehouse_id,to_warehouse_id,quantity,cost,reference,note,request_key,request_hash,created_by,cost_method)
      VALUES(${ledgerId}::uuid,${input.itemId}::uuid,${next.sequence}::bigint,${input.date}::date,${input.kind},${from}::uuid,${to}::uuid,${input.quantity},${totalCost},${reference},${note},${input.key}::uuid,${hash},${actorEmail},${settings.cost_method}) RETURNING id::text`)
    for(const r of revaluations){
      await tx.execute(sql`INSERT INTO inventory_cost_revaluation(ledger_id,movement_id,layer_id,amount) VALUES(${ledgerId}::uuid,${movement.id}::uuid,${r.id}::uuid,${r.amount})`)
      await tx.execute(sql`UPDATE inventory_cost_layer SET remaining_cost=${r.balance} WHERE id=${r.id}::uuid`)
    }
    const physical=serials.length?serials.map(serial=>({serial,quantity:QUANTITY_SCALE})):[{serial:'',quantity:input.quantity}]
    for(const part of physical) {
      if(from) {
        const [stock]=await tx.execute<{id:string;quantity:string}>(sql`SELECT id::text,quantity::text FROM inventory_stock WHERE ledger_id=${ledgerId}::uuid AND item_id=${input.itemId}::uuid AND warehouse_id=${from}::uuid AND batch=${batch} AND serial=${part.serial} FOR UPDATE`)
        if(!stock||BigInt(stock.quantity)<part.quantity)throw new OperationsError('TRACKED_STOCK','Not enough stock for this batch or serial number in the selected warehouse.')
        await tx.execute(sql`UPDATE inventory_stock SET quantity=quantity-${part.quantity} WHERE id=${stock.id}::uuid`)
        await tx.execute(sql`INSERT INTO inventory_stock_change(ledger_id,movement_id,stock_id,quantity) VALUES(${ledgerId}::uuid,${movement.id}::uuid,${stock.id}::uuid,${-part.quantity})`)
      }
      if(to) {
        const [stock]=await tx.execute<{id:string}>(sql`INSERT INTO inventory_stock(ledger_id,item_id,warehouse_id,batch,serial,quantity) VALUES(${ledgerId}::uuid,${input.itemId}::uuid,${to}::uuid,${batch},${part.serial},${part.quantity})
          ON CONFLICT(ledger_id,item_id,warehouse_id,batch,serial) DO UPDATE SET quantity=inventory_stock.quantity+EXCLUDED.quantity RETURNING id::text`)
        await tx.execute(sql`INSERT INTO inventory_stock_change(ledger_id,movement_id,stock_id,quantity) VALUES(${ledgerId}::uuid,${movement.id}::uuid,${stock.id}::uuid,${part.quantity})`)
      }
    }
    const addLayer=async(q:bigint,cost:bigint,acquired:string,order:string,sourceLayer:string|null=null)=>tx.execute(sql`INSERT INTO inventory_cost_layer(ledger_id,item_id,warehouse_id,movement_id,acquired_on,fifo_order,quantity,cost,remaining_quantity,remaining_cost,transfer_source_layer_id)
      VALUES(${ledgerId}::uuid,${input.itemId}::uuid,${to}::uuid,${movement.id}::uuid,${acquired}::date,${order}::bigint,${q},${cost},${q},${cost},${sourceLayer}::uuid)`)
    if(incoming)await addLayer(input.quantity,totalCost,input.date,next.sequence)
    for(const part of consumed) {
      await tx.execute(sql`UPDATE inventory_cost_layer SET remaining_quantity=${part.remaining},remaining_cost=${part.remainingCost} WHERE id=${part.layer.id}::uuid`)
      await tx.execute(sql`INSERT INTO inventory_cost_allocation(ledger_id,movement_id,layer_id,quantity,cost) VALUES(${ledgerId}::uuid,${movement.id}::uuid,${part.layer.id}::uuid,${part.quantity},${part.cost})`)
      if(transfer)await addLayer(part.quantity,part.cost,part.layer.acquired_on,part.layer.fifo_order,part.layer.id)
    }
    if(to&&settings.cost_method==='moving_average') {
      const balances=await tx.execute<{id:string;quantity:string;cost:string}>(sql`SELECT id::text,remaining_quantity::text AS quantity,remaining_cost::text AS cost FROM inventory_cost_layer WHERE ledger_id=${ledgerId}::uuid AND item_id=${input.itemId}::uuid AND warehouse_id=${to}::uuid AND remaining_quantity>0 ORDER BY acquired_on,fifo_order,id FOR UPDATE`)
      const costs=distributeCost(balances.reduce((n,l)=>n+BigInt(l.cost),0n),balances.map(l=>BigInt(l.quantity)))
      for(const [i,l] of balances.entries())if(costs[i]!==BigInt(l.cost)){
        await tx.execute(sql`INSERT INTO inventory_cost_revaluation(ledger_id,movement_id,layer_id,amount) VALUES(${ledgerId}::uuid,${movement.id}::uuid,${l.id}::uuid,${costs[i]-BigInt(l.cost)})`)
        await tx.execute(sql`UPDATE inventory_cost_layer SET remaining_cost=${costs[i]} WHERE id=${l.id}::uuid`)
      }
    }
    if(!deferProductionPosting)await postStockMovement(tx,ledgerId,movement.id,input.finance??{},actorEmail)
    return movement.id
}

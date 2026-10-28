import 'server-only'
import {postProductionEvent} from './operations-finance'
import type {FinancialInput} from './operations-finance-types'
import {createHash} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {UserRecord} from './users'
import {operationId,operationText,operationDate,operationAmount,operationWrite,OperationsError} from './operations-scope'
import {initializeInventory,applyStockMovement,type StockMovementInput} from './inventory'
import {roundRatio} from './inventory-cost'
import {QUANTITY_SCALE} from './quantity'
import type {BomRow,BomComponent,ProductionOrderRow,ProductionEventRow,ProductionLine} from './production-types'
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex')
const positive=(n:bigint)=>{if(n<=0n||n>9_000_000_000_000_000_000n)throw new OperationsError('QUANTITY','Enter a positive quantity.');return n}
const ceiling=(a:bigint,b:bigint,d:bigint)=>(a*b+d-1n)/d
export async function productionBoms(ledgerId:string):Promise<BomRow[]> {
  const rows=await db.execute<Omit<BomRow,'components'>>(sql`SELECT b.id::text,b.code,b.name,b.output_item_id::text,i.sku AS output_sku,i.name AS output_name,i.unit AS output_unit,b.output_quantity::text,b.is_active,b.version,b.notes FROM production_bom b JOIN inventory_item i ON i.id=b.output_item_id WHERE b.ledger_id=${operationId(ledgerId)}::uuid ORDER BY lower(b.code)`)
  const lines=await db.execute<BomComponent & {bom_id:string}>(sql`SELECT l.bom_id::text,l.item_id::text,i.sku,i.name,i.unit,l.quantity::text FROM production_bom_line l JOIN inventory_item i ON i.id=l.item_id WHERE l.ledger_id=${ledgerId}::uuid ORDER BY lower(i.sku)`)
  return rows.map(b=>({...b,components:lines.filter(l=>l.bom_id===b.id)}))
}
export async function productionOrders(ledgerId:string) {
  return db.execute<ProductionOrderRow>(sql`SELECT o.id::text,o.sequence::text,o.bom_id::text,b.code AS bom_code,b.name AS bom_name,o.bom_version,o.output_item_id::text,i.sku AS output_sku,i.name AS output_name,i.unit AS output_unit,o.warehouse_id::text,w.name AS warehouse_name,o.planned_quantity::text,o.start_date::text,o.due_date::text,o.status,o.version,o.notes,
    coalesce((SELECT sum(quantity) FROM production_event WHERE order_id=o.id AND kind='completion'),0)::text AS completed_quantity,
    coalesce((SELECT sum(CASE WHEN kind IN ('material_issue','conversion_cost','labour_accrual','labour_adjustment') THEN cost ELSE -cost END) FROM production_event WHERE order_id=o.id),0)::text AS wip_cost
    FROM production_order o JOIN production_bom b ON b.id=o.bom_id JOIN inventory_item i ON i.id=o.output_item_id JOIN inventory_warehouse w ON w.id=o.warehouse_id WHERE o.ledger_id=${operationId(ledgerId)}::uuid ORDER BY o.sequence DESC`)
}
export async function productionOrderDetail(ledgerId:string,id:string) {
  operationId(id)
  const order=(await productionOrders(ledgerId)).find(o=>o.id===id);if(!order)return null
  const [lines,events]=await Promise.all([
    db.execute<ProductionLine>(sql`SELECT l.item_id::text,i.sku,i.name,i.unit,l.quantity::text,coalesce((SELECT sum(CASE WHEN kind='material_issue' THEN quantity ELSE -quantity END) FROM production_event WHERE order_id=l.order_id AND item_id=l.item_id AND kind IN ('material_issue','material_return')),0)::text AS issued_quantity FROM production_order_line l JOIN inventory_item i ON i.id=l.item_id WHERE l.ledger_id=${ledgerId}::uuid AND l.order_id=${id}::uuid ORDER BY lower(i.sku)`),
    db.execute<ProductionEventRow>(sql`SELECT e.id::text,e.event_date::text,e.kind,e.item_id::text,i.sku,i.name AS item_name,e.quantity::text,e.cost::text,e.note,e.movement_id::text,e.source_event_id::text,e.created_by FROM production_event e LEFT JOIN inventory_item i ON i.id=e.item_id WHERE e.ledger_id=${ledgerId}::uuid AND e.order_id=${id}::uuid ORDER BY e.event_date,e.created_at,e.id`)
  ])
  return {order,lines,events}
}
export async function saveBom(me:UserRecord,ledgerId:string,input:{id?:string;version?:number;code:string;name:string;outputItemId:string;outputQuantity:bigint;components:{itemId:string;quantity:bigint}[];notes:string;isActive:boolean}) {
  if(input.id)operationId(input.id);operationId(input.outputItemId);positive(input.outputQuantity)
  const code=operationText(input.code,'BOM code',60,true),name=operationText(input.name,'BOM name',240,true),notes=operationText(input.notes,'Notes',10000)
  if(!input.components.length||input.components.length>100)throw new OperationsError('BOM','Add between 1 and 100 components.')
  for(const c of input.components){operationId(c.itemId);positive(c.quantity);if(c.itemId===input.outputItemId)throw new OperationsError('BOM_CYCLE','An output cannot be its own component.')}
  if(new Set(input.components.map(c=>c.itemId)).size!==input.components.length)throw new OperationsError('BOM','Use each component once.')
  return operationWrite(me,ledgerId,'/inventory',async tx=>{
    const ids=[input.outputItemId,...input.components.map(c=>c.itemId)]
    const items=await tx.execute<{id:string;kind:string;track_serials:boolean}>(sql`SELECT id::text,kind,track_serials FROM inventory_item WHERE ledger_id=${ledgerId}::uuid AND is_active AND id IN (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)}) FOR SHARE`)
    if(items.length!==ids.length)throw new OperationsError('ITEM','Choose active items in this ledger.')
    if(items.find(i=>i.id===input.outputItemId)!.kind==='raw_material')throw new OperationsError('BOM','Choose a WIP or finished-goods output.')
    for(const i of items){const q=i.id===input.outputItemId?input.outputQuantity:input.components.find(c=>c.itemId===i.id)!.quantity;if(i.track_serials&&q%QUANTITY_SCALE)throw new OperationsError('SERIAL_QUANTITY','Serialized components and outputs use whole units.')}
    const edges=await tx.execute<{output:string;component:string}>(sql`SELECT b.output_item_id::text AS output,l.item_id::text AS component FROM production_bom b JOIN production_bom_line l ON l.bom_id=b.id WHERE b.ledger_id=${ledgerId}::uuid AND (${input.id??null}::uuid IS NULL OR b.id<>${input.id??null}::uuid)`)
    const reaches=(node:string,seen:Set<string>):boolean=>node===input.outputItemId||(!seen.has(node)&&(seen.add(node),edges.filter(e=>e.output===node).some(e=>reaches(e.component,seen))))
    if(input.components.some(c=>reaches(c.itemId,new Set())))throw new OperationsError('BOM_CYCLE','This recipe creates a circular component dependency.')
    if((await tx.execute(sql`SELECT id FROM production_bom WHERE ledger_id=${ledgerId}::uuid AND lower(code)=lower(${code}) AND (${input.id??null}::uuid IS NULL OR id<>${input.id??null}::uuid)`)).length)throw new OperationsError('CODE','That BOM code is already in use.')
    let id=input.id
    if(id){const [old]=await tx.execute<{version:number}>(sql`SELECT version FROM production_bom WHERE ledger_id=${ledgerId}::uuid AND id=${id}::uuid FOR UPDATE`);if(!old)throw new OperationsError('BOM','This BOM is unavailable.');if(old.version!==input.version)throw new OperationsError('STALE','This BOM changed. Reload before saving.')
      await tx.execute(sql`UPDATE production_bom SET code=${code},name=${name},output_item_id=${input.outputItemId}::uuid,output_quantity=${input.outputQuantity},notes=${notes},is_active=${input.isActive},version=version+1 WHERE id=${id}::uuid`)
      await tx.execute(sql`DELETE FROM production_bom_line WHERE bom_id=${id}::uuid`)
    } else {const [row]=await tx.execute<{id:string}>(sql`INSERT INTO production_bom(ledger_id,code,name,output_item_id,output_quantity,notes,is_active) VALUES(${ledgerId}::uuid,${code},${name},${input.outputItemId}::uuid,${input.outputQuantity},${notes},${input.isActive}) RETURNING id::text`);id=row.id}
    for(const c of input.components)await tx.execute(sql`INSERT INTO production_bom_line(ledger_id,bom_id,item_id,quantity) VALUES(${ledgerId}::uuid,${id}::uuid,${c.itemId}::uuid,${c.quantity})`)
    return id
  })
}
export async function createProductionOrder(me:UserRecord,ledgerId:string,input:{bomId:string;quantity:bigint;warehouseId:string;startDate:string;dueDate:string;notes:string;key:string}) {
  operationId(input.bomId);operationId(input.key);positive(input.quantity);operationDate(input.startDate);if(input.dueDate)operationDate(input.dueDate)
  if(input.dueDate&&input.dueDate<input.startDate)throw new OperationsError('DATE','Due date must be on or after the start date.')
  const notes=operationText(input.notes,'Notes',10000),hash=fingerprint({...input,notes})
  return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
    const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_order WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
    if(prior){if(prior.request_hash!==hash)throw new OperationsError('REPLAY','This request was already used with different values.');return prior.id}
    await initializeInventory(tx,ledgerId)
    await tx.execute(sql`SELECT set_config('app.inventory_write','on',true)`)
    const [bom]=await tx.execute<{output_item_id:string;output_quantity:string;version:number;track_serials:boolean}>(sql`SELECT b.output_item_id::text,b.output_quantity::text,b.version,i.track_serials FROM production_bom b JOIN inventory_item i ON i.id=b.output_item_id WHERE b.ledger_id=${ledgerId}::uuid AND b.id=${input.bomId}::uuid AND b.is_active AND i.is_active FOR SHARE OF b,i`)
    if(!bom)throw new OperationsError('BOM','Choose an active BOM with an active output.')
    if(bom.track_serials&&input.quantity%QUANTITY_SCALE)throw new OperationsError('SERIAL_QUANTITY','Serialized output uses whole units.')
    const [warehouse]=await tx.execute<{id:string}>(sql`SELECT w.id::text FROM inventory_warehouse w JOIN inventory_setting s ON s.ledger_id=w.ledger_id WHERE w.ledger_id=${ledgerId}::uuid AND w.is_active AND (CASE WHEN s.warehouses_enabled THEN w.id=${input.warehouseId||null}::uuid ELSE w.is_default END)`)
    if(!warehouse)throw new OperationsError('WAREHOUSE','Choose an active warehouse.')
    const lines=await tx.execute<{item_id:string;quantity:string;is_active:boolean;track_serials:boolean}>(sql`SELECT l.item_id::text,l.quantity::text,i.is_active,i.track_serials FROM production_bom_line l JOIN inventory_item i ON i.id=l.item_id WHERE l.bom_id=${input.bomId}::uuid`)
    if(!lines.length||lines.some(l=>!l.is_active))throw new OperationsError('BOM','All BOM components must be active.')
    const requirements=lines.map(l=>({...l,q:ceiling(input.quantity,BigInt(l.quantity),BigInt(bom.output_quantity))}))
    if(requirements.some(l=>l.q>9_000_000_000_000_000_000n||l.track_serials&&l.q%QUANTITY_SCALE))throw new OperationsError('QUANTITY','Scaled components must fit the supported range and use whole units for serialized items.')
    const [order]=await tx.execute<{id:string}>(sql`INSERT INTO production_order(ledger_id,sequence,bom_id,bom_version,output_item_id,warehouse_id,planned_quantity,start_date,due_date,notes,request_key,request_hash,created_by) SELECT ${ledgerId}::uuid,coalesce(max(sequence),0)+1,${input.bomId}::uuid,${bom.version},${bom.output_item_id}::uuid,${warehouse.id}::uuid,${input.quantity},${input.startDate}::date,${input.dueDate||null}::date,${notes},${input.key}::uuid,${hash},${s.email} FROM production_order WHERE ledger_id=${ledgerId}::uuid RETURNING id::text`)
    for(const l of requirements)await tx.execute(sql`INSERT INTO production_order_line(ledger_id,order_id,item_id,quantity) VALUES(${ledgerId}::uuid,${order.id}::uuid,${l.item_id}::uuid,${l.q})`)
    return order.id
  })
}
export type ProductionAction={orderId:string;version:number;kind:'material_issue'|'material_return'|'conversion_cost'|'completion'|'loss'|'cancel';date:string;itemId:string;sourceEventId:string;quantity:bigint;cost:bigint;batch:string;serials:string[];note:string;key:string;finance?:FinancialInput}
export async function recordProductionEvent(me:UserRecord,ledgerId:string,input:ProductionAction) {
  operationId(input.orderId);operationId(input.key);operationDate(input.date);operationAmount(input.cost)
  const note=operationText(input.note,'Reason / notes',10000,['conversion_cost','loss','cancel'].includes(input.kind)),hash=fingerprint({...input,note,serials:[...input.serials].sort()})
  if(!['material_issue','material_return','conversion_cost','completion','loss','cancel'].includes(input.kind))throw new OperationsError('KIND','Choose a production action.')
  if(['material_issue','material_return','completion'].includes(input.kind))positive(input.quantity)
  else if(input.quantity!==0n)throw new OperationsError('QUANTITY','This action does not change output quantity.')
  if(input.kind!=='conversion_cost'&&input.cost!==0n)throw new OperationsError('COST','Production cost is calculated from the order.')
  if(input.kind==='conversion_cost'&&input.cost===0n)throw new OperationsError('COST','Enter a positive labour or overhead cost.')
  return operationWrite(me,ledgerId,'/inventory',async(tx,s)=>{
    const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM production_event WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
    if(prior){if(prior.request_hash!==hash)throw new OperationsError('REPLAY','This request was already used with different values.');return prior.id}
    const [order]=await tx.execute<{output_item_id:string;warehouse_id:string;planned_quantity:string;start_date:string;status:string;version:number}>(sql`SELECT output_item_id::text,warehouse_id::text,planned_quantity::text,start_date::text,status,version FROM production_order WHERE ledger_id=${ledgerId}::uuid AND id=${input.orderId}::uuid FOR UPDATE`)
    if(!order)throw new OperationsError('ORDER','This production order is unavailable in this ledger.')
    if(order.status!=='in_progress')throw new OperationsError('ORDER_CLOSED','This production order is closed.')
    if(order.version!==input.version)throw new OperationsError('STALE','This order changed. Reload before recording the action.')
    await tx.execute(sql`SELECT set_config('app.inventory_write','on',true)`)
    const events=await tx.execute<ProductionEventRow>(sql`SELECT id::text,event_date::text,kind,item_id::text,quantity::text,cost::text,movement_id::text,source_event_id::text FROM production_event WHERE order_id=${input.orderId}::uuid ORDER BY event_date,created_at`)
    const latest=events.at(-1)?.event_date??order.start_date
    if(input.date<latest)throw new OperationsError('CHRONOLOGY',`Use ${latest} or later for this order.`)
    const wip=events.reduce((n,e)=>n+(['material_issue','conversion_cost','labour_accrual','labour_adjustment'].includes(e.kind)?BigInt(e.cost):-BigInt(e.cost)),0n),completed=events.filter(e=>e.kind==='completion').reduce((n,e)=>n+BigInt(e.quantity),0n),planned=BigInt(order.planned_quantity)
    const lines=await tx.execute<{item_id:string;quantity:string}>(sql`SELECT item_id::text,quantity::text FROM production_order_line WHERE order_id=${input.orderId}::uuid`)
    const issued=(id:string)=>events.filter(e=>e.item_id===id&&['material_issue','material_return'].includes(e.kind)).reduce((n,e)=>n+(e.kind==='material_issue'?BigInt(e.quantity):-BigInt(e.quantity)),0n)
    let itemId:string|null=null,movementId:string|null=null,cost=0n,status='in_progress',source:string|null=null
    const move:StockMovementInput={itemId:'',kind:'issue',date:input.date,quantity:input.quantity,cost:0n,fromWarehouseId:order.warehouse_id,toWarehouseId:'',batch:input.batch,serials:input.serials,reference:`Production ${input.orderId}`,note,key:input.key}
    if(input.kind==='material_issue') {
      operationId(input.itemId)
      if(!lines.some(l=>l.item_id===input.itemId))throw new OperationsError('COMPONENT','Choose a component in this order’s BOM snapshot.')
      itemId=input.itemId;movementId=await applyStockMovement(tx,ledgerId,s.email,{...move,itemId},true)
    } else if(input.kind==='material_return') {
      operationId(input.sourceEventId);const original=events.find(e=>e.id===input.sourceEventId&&e.kind==='material_issue')
      if(!original)throw new OperationsError('SOURCE','Choose a material issue from this order.')
      itemId=original.item_id!;source=original.id
      if((await tx.execute(sql`SELECT 1 FROM production_labour_cost_adjustment x JOIN production_labour_settlement st ON st.id=x.settlement_id WHERE x.order_id=${input.orderId}::uuid AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id)`)).length)throw new OperationsError('RETURN_SETTLEMENT','Reverse the payroll settlement affecting this WIP before returning materials, then settle again so the correction follows the returned stock.');
      const [available]=await tx.execute<{ok:boolean}>(sql`SELECT ${input.quantity}::numeric<=production_material_source_remaining(${source}::uuid,${input.date}::date) ok`);
      if(!available.ok)throw new OperationsError('RETURN_SOURCE','Return only the unused portion of this original issue; completed output already consumed part of it.');
      const returned=events.filter(e=>e.source_event_id===source).reduce((n,e)=>n+BigInt(e.quantity),0n),previousCost=events.filter(e=>e.source_event_id===source).reduce((n,e)=>n+BigInt(e.cost),0n)
      if(returned+input.quantity>BigInt(original.quantity))throw new OperationsError('RETURN','Return quantity exceeds the unreturned issue.')
      const line=lines.find(l=>l.item_id===itemId)!
      if(issued(itemId)-input.quantity<ceiling(BigInt(line.quantity),completed,planned))throw new OperationsError('RETURN','These materials are required for the completed output.')
      cost=roundRatio(BigInt(original.cost),returned+input.quantity,BigInt(original.quantity))-previousCost
      if(cost>wip)throw new OperationsError('WIP','Return cost exceeds the remaining WIP balance.')
      const tracked=await tx.execute<{batch:string;serial:string}>(sql`SELECT st.batch,st.serial FROM inventory_stock_change c JOIN inventory_stock st ON st.id=c.stock_id WHERE c.movement_id=${original.movement_id}::uuid AND c.quantity<0`)
      const previouslyReturned=await tx.execute<{serial:string}>(sql`SELECT st.serial FROM production_event e JOIN inventory_stock_change c ON c.movement_id=e.movement_id JOIN inventory_stock st ON st.id=c.stock_id WHERE e.source_event_id=${source}::uuid AND c.quantity>0 AND st.serial<>''`)
      if(input.serials.some(serial=>previouslyReturned.some(t=>t.serial===serial)))throw new OperationsError('RETURN','A serial number has already been returned from this issue.')
      if(tracked.some(t=>t.batch!==input.batch)||input.serials.some(serial=>!tracked.some(t=>t.serial===serial)))throw new OperationsError('TRACKING','Use the batch and serials from the original material issue.')
      movementId=await applyStockMovement(tx,ledgerId,s.email,{...move,itemId,kind:'adjust_in',cost,fromWarehouseId:'',toWarehouseId:order.warehouse_id,note:note||'Unused production material return'},true)
    } else if(input.kind==='completion') {
      if((await tx.execute(sql`SELECT 1 FROM production_time t WHERE t.order_id=${input.orderId}::uuid AND NOT t.cancelled AND t.work_date<=${input.date}::date AND NOT EXISTS(SELECT 1 FROM production_labour_accrual ac WHERE ac.time_id=t.id AND NOT EXISTS(SELECT 1 FROM production_labour_accrual_reversal v WHERE v.accrual_id=ac.id)) AND NOT EXISTS(SELECT 1 FROM production_payroll_allocation a WHERE a.time_id=t.id AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal r WHERE r.allocation_id=a.id))`)).length)throw new OperationsError('LABOUR_PENDING','Accrue pending production time or allocate confirmed payroll before completing output.')
      if(completed+input.quantity>planned)throw new OperationsError('OUTPUT','Completion exceeds the planned output quantity.')
      if(lines.some(l=>issued(l.item_id)<ceiling(BigInt(l.quantity),completed+input.quantity,planned)))throw new OperationsError('MATERIALS','Issue the BOM materials required for this completion first.')
      itemId=order.output_item_id;cost=roundRatio(wip,input.quantity,planned-completed)
      movementId=await applyStockMovement(tx,ledgerId,s.email,{...move,itemId,kind:'adjust_in',cost,fromWarehouseId:'',toWarehouseId:order.warehouse_id,note:note||'Production completion'},true)
      if(completed+input.quantity===planned)status='completed'
    } else if(input.kind==='conversion_cost')cost=input.cost
    else if(input.kind==='loss'){cost=wip;status='closed_loss'}
    else {if(wip!==0n||lines.some(l=>issued(l.item_id)!==0n)||completed!==0n)throw new OperationsError('CANCEL','Return all materials before cancelling, or close the remaining order as a production loss.');status='cancelled'}
    if(movementId){const [m]=await tx.execute<{cost:string}>(sql`SELECT cost::text FROM inventory_movement WHERE id=${movementId}::uuid`);cost=BigInt(m.cost)}
    const [event]=await tx.execute<{id:string}>(sql`INSERT INTO production_event(ledger_id,order_id,event_date,kind,item_id,movement_id,source_event_id,quantity,cost,note,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${input.orderId}::uuid,${input.date}::date,${input.kind},${itemId}::uuid,${movementId}::uuid,${source}::uuid,${input.quantity},${cost},${note},${input.key}::uuid,${hash},${s.email}) RETURNING id::text`)
    await tx.execute(sql`UPDATE production_order SET status=${status},version=version+1 WHERE id=${input.orderId}::uuid`)
    await postProductionEvent(tx,ledgerId,event.id,input.finance??{},s.email)
    return event.id
  })
}

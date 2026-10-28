import {add,negative,scale,ZERO,type Fraction} from './production-labour-math'

export type CostTarget={kind:'wip'|'stock'|'expense';id:string}
export type FlowSeed={eventId:string;target:CostTarget;value:Fraction}
export type FlowLayer={id:string;movement_id:string;item_id:string;warehouse_id:string;quantity:string;transfer_source_layer_id:string|null}
export type FlowAllocation={movement_id:string;layer_id:string;quantity:string}
export type FlowEvent={id:string;date:string;stamp:string;kind:string;order_id:string|null;movement_id:string|null;source_event_id:string|null;quantity:string;planned_quantity:string;item_id:string|null;from_warehouse_id:string|null;to_warehouse_id:string|null;cost_method:string;expense_account_id:string}

/** Replay quantity provenance for one cost component. MA follows the pool, not FIFO physical layers.
 * Seeds can be an accrual's unit weight, or signed settlement cents (for a later reversal).
 * A settlement correction in WIP is a separate conversion component; it is never returned as material.
 */
export function traceLabourCost(events:FlowEvent[],layers:FlowLayer[],allocations:FlowAllocation[],seeds:FlowSeed[]) {
 const held=new Map<string,Fraction>(),qty=new Map<string,bigint>(),wip=new Map<string,Map<string,Fraction>>(),expenses=new Map<string,Fraction>()
 const layerById=new Map(layers.map(l=>[l.id,l])),byMovement=new Map<string,FlowLayer[]>(),byAllocation=new Map<string,FlowAllocation[]>()
 const completed=new Map<string,bigint>(),issues=new Map<string,{quantity:bigint;returned:bigint;initial:Fraction;order:string}>()
 for(const l of layers)byMovement.set(l.movement_id,[...(byMovement.get(l.movement_id)??[]),l])
 for(const a of allocations)byAllocation.set(a.movement_id,[...(byAllocation.get(a.movement_id)??[]),a])
 const put=(map:Map<string,Fraction>,id:string,v:Fraction)=>map.set(id,add(map.get(id)??ZERO,v))
 const order=(id:string)=>{if(!wip.has(id))wip.set(id,new Map());return wip.get(id)!}
 const pool=(item:string,warehouse:string)=>layers.filter(l=>l.item_id===item&&l.warehouse_id===warehouse&&(qty.get(l.id)??0n)>0n)
 const rebalance=(item:string,warehouse:string)=>{const ls=pool(item,warehouse),q=ls.reduce((n,l)=>n+(qty.get(l.id)??0n),0n),v=ls.reduce((n,l)=>add(n,held.get(l.id)??ZERO),ZERO);for(const l of ls)held.set(l.id,scale(v,qty.get(l.id)!,q))}
 const incoming=(e:FlowEvent,v:Fraction,parts?:Map<string,Fraction>)=>{
  const ls=byMovement.get(e.movement_id??e.id)??[],total=ls.reduce((n,l)=>n+BigInt(l.quantity),0n)
  for(const l of ls){qty.set(l.id,BigInt(l.quantity));held.set(l.id,parts?parts.get(l.transfer_source_layer_id??'')??ZERO:scale(v,BigInt(l.quantity),total))}
  if(e.cost_method==='moving_average'&&e.item_id&&e.to_warehouse_id)rebalance(e.item_id,e.to_warehouse_id)
 }
 const outgoing=(e:FlowEvent)=>{
  const parts=new Map<string,Fraction>(),as=byAllocation.get(e.movement_id??e.id)??[],ls=pool(e.item_id!,e.from_warehouse_id!),total=ls.reduce((n,l)=>n+qty.get(l.id)!,0n)
  let taken=ZERO
  if(e.cost_method==='moving_average'){
   const value=ls.reduce((n,l)=>add(n,held.get(l.id)??ZERO),ZERO)
   taken=scale(value,BigInt(e.quantity),total)
   for(const a of as)parts.set(a.layer_id,scale(taken,BigInt(a.quantity),BigInt(e.quantity)))
   for(const l of ls)held.set(l.id,scale(held.get(l.id)??ZERO,total-BigInt(e.quantity),total))
  }else for(const a of as){const q=qty.get(a.layer_id)??0n;if(q<=0n)throw new Error('Cost flow layer has no available quantity');const v=scale(held.get(a.layer_id)??ZERO,BigInt(a.quantity),q);parts.set(a.layer_id,v);taken=add(taken,v);put(held,a.layer_id,negative(v))}
  for(const a of as)qty.set(a.layer_id,(qty.get(a.layer_id)??0n)-BigInt(a.quantity))
  if(e.cost_method==='moving_average'){
   // A physically exhausted FIFO layer may still carry pooled value: redistribute all kept components.
   const remaining=total-BigInt(e.quantity),keep=scale(ls.reduce((n,l)=>add(n,held.get(l.id)??ZERO),ZERO),1n,1n)
   for(const l of ls)held.set(l.id,remaining>0n?scale(keep,qty.get(l.id)??0n,remaining):ZERO)
  }
  return {taken,parts}
 }
 for(const e of events){
  const oid=e.order_id,moving=e.kind==='material_issue'||e.kind==='material_return'||e.kind==='completion'||e.order_id===null
  if(moving){
   if(e.kind==='material_issue'){const {taken}=outgoing(e);order(oid!).set(e.id,taken);issues.set(e.id,{quantity:BigInt(e.quantity),returned:0n,initial:taken,order:oid!})}
   else if(e.kind==='material_return'){
    const issue=issues.get(e.source_event_id!);if(!issue)throw new Error('Missing material source')
    const value=scale(issue.initial,BigInt(e.quantity),issue.quantity),current=order(oid!).get(e.source_event_id!)??ZERO
    // Returning material already absorbed into output is ambiguous: require a reviewed stock correction.
    if(value.n>0n&&current.n*value.d<value.n*current.d)throw new Error('Returned material cost was already consumed by output')
    put(order(oid!),e.source_event_id!,negative(value));issue.returned+=BigInt(e.quantity);incoming(e,value)
   }else if(e.kind==='completion'){
    const done=completed.get(oid!)??0n,remaining=BigInt(e.planned_quantity)-done;let out=ZERO
    for(const [key,value] of order(oid!)){const part=scale(value,BigInt(e.quantity),remaining);out=add(out,part);put(order(oid!),key,negative(part))}
    incoming(e,out);completed.set(oid!,done+BigInt(e.quantity))
   }else if(e.kind==='receipt'||e.kind==='adjust_in')incoming(e,ZERO)
   else {const {taken,parts}=outgoing(e);if(e.kind==='transfer')incoming(e,taken,parts);else put(expenses,e.expense_account_id,taken)}
  }else if(e.kind==='labour_accrual_return'){order(oid!).delete(`conversion:${e.source_event_id}`)}else if(e.kind==='loss'){for(const value of order(oid!).values())put(expenses,e.expense_account_id,value);order(oid!).clear()}
  for(const seed of seeds.filter(s=>s.eventId===e.id)){
   if(seed.target.kind==='wip')put(order(seed.target.id),`conversion:${e.id}`,seed.value)
   else if(seed.target.kind==='stock')put(held,seed.target.id,seed.value)
   else put(expenses,seed.target.id,seed.value)
  }
  if(e.kind==='labour_settlement')for(const l of layers)if((qty.get(l.id)??0n)>0n&&e.cost_method==='moving_average')rebalance(l.item_id,l.warehouse_id)
 }
 const result:{target:CostTarget;value:Fraction}[]=[]
 for(const [id,chunks] of wip){const value=[...chunks.values()].reduce(add,ZERO);if(value.n)result.push({target:{kind:'wip',id},value})}
 for(const [id,value] of held)if(value.n){if(!layerById.has(id)||(qty.get(id)??0n)<=0n)throw new Error('Cost component remains on an exhausted layer');result.push({target:{kind:'stock',id},value})}
 for(const [id,value] of expenses)if(value.n)result.push({target:{kind:'expense',id},value})
 result.sort((a,b)=>(a.target.kind+a.target.id).localeCompare(b.target.kind+b.target.id))
 const expected=seeds.reduce((n,s)=>add(n,s.value),ZERO),actual=result.reduce((n,r)=>add(n,r.value),ZERO)
 if(expected.n*actual.d!==actual.n*expected.d)throw new Error('Labour cost flow does not conserve its source')
 return result
}

/** All quantities are millionths; all costs are cents. Never use floating point. */
export type CostBalance = {id:string;quantity:bigint;cost:bigint}
export const roundRatio=(amount:bigint,numerator:bigint,denominator:bigint)=>{
  if(amount<0n||numerator<0n||denominator<=0n)throw new Error('Invalid cost ratio')
  return (amount*numerator+denominator/2n)/denominator
}
/** Cumulative rounding assigns every cent, including pools with tiny layers. */
export function distributeCost(cost:bigint,quantities:bigint[]) {
  const total=quantities.reduce((a,b)=>a+b,0n)
  if(total===0n){if(cost!==0n)throw new Error('Cost without quantity');return quantities.map(()=>0n)}
  let cumulative=0n,assigned=0n
  return quantities.map(q=>{cumulative+=q;const next=roundRatio(cost,cumulative,total),part=next-assigned;assigned=next;return part})
}
/** MA consumes receipt quantities for provenance while costing the pooled item. */
export function averageIssue(layers:CostBalance[],quantity:bigint) {
  const totalQuantity=layers.reduce((n,l)=>n+l.quantity,0n),totalCost=layers.reduce((n,l)=>n+l.cost,0n)
  if(quantity<=0n||quantity>totalQuantity)throw new Error('Insufficient stock')
  const issueCost=roundRatio(totalCost,quantity,totalQuantity)
  let need=quantity
  const taken=layers.map(l=>{const q=l.quantity<need?l.quantity:need;need-=q;return q})
  const left=layers.map((l,i)=>l.quantity-taken[i]),issued=distributeCost(issueCost,taken),kept=distributeCost(totalCost-issueCost,left)
  return {cost:issueCost,layers:layers.map((l,i)=>({id:l.id,quantity:taken[i],cost:issued[i],remaining:left[i],remainingCost:kept[i],revaluation:issued[i]+kept[i]-l.cost}))}
}

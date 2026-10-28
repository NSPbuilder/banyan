import {roundRatio} from './inventory-cost'
import {CCA_CLASSES,type CcaRule,type DepreciationPolicy} from './depreciation-types'
export const dayAfter=(date:string)=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10)
export const monthEnd=(month:string)=>new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10)
export function monthlyDepreciation(cost:bigint,accumulated:bigint,policy:DepreciationPolicy,from:string,to:string,monthOpeningAccumulated?:bigint) {
  const available=cost-BigInt(policy.residual_value)-accumulated;if(available<=0n||from>to)return 0n
  const end=monthEnd(from.slice(0,7)),days=BigInt(Number(end.slice(8))),active=BigInt(Number(to.slice(8))-Number(from.slice(8))+1)
  const age=(Number(from.slice(0,4))-Number(policy.start_date.slice(0,4)))*12+Number(from.slice(5,7))-Number(policy.start_date.slice(5,7))
  if(['straight_line','declining_balance'].includes(policy.method)&&age>=policy.life_months-1&&to===end)return available
  let charge=0n
  if(policy.method==='straight_line'){
    charge=age>=policy.life_months-1&&to===end?available:roundRatio(cost-BigInt(policy.residual_value)-BigInt(policy.opening_accumulated??0),active,BigInt(policy.life_months)*days)
  } else if(policy.method==='declining_balance')charge=roundRatio(cost-(monthOpeningAccumulated??accumulated),BigInt(policy.annual_rate_bp)*active,120000n*days)
  return charge>available?available:charge
}
export type CcaAddition={cost:bigint;acquiredOn:string;availableOn:string;rule:CcaRule}
type Fraction={n:bigint;d:bigint}
const maximum=(a:bigint,b=0n)=>a>b?a:b
/** Standard pools only. Special property facts require a reviewed manual maximum. */
function factor(classCode:string,a:CcaAddition):Fraction {
  if(a.rule==='aiip'){
    if(a.acquiredOn<='2018-11-20'||a.acquiredOn>='2025-01-01'||a.availableOn>='2028-01-01')throw new Error('AII dates do not qualify. Choose a standard or manual rule.')
  }else if(a.rule==='riip'){
    if(a.acquiredOn<'2025-01-01'||a.availableOn>='2034-01-01')throw new Error('RII dates do not qualify. Choose a standard or manual rule.')
  }else return {n:0n,d:1n}
  if(classCode==='50'){
    if(a.availableOn<'2027-01-01'&&(a.rule==='riip'||a.acquiredOn>'2024-04-15'))return {n:9n,d:11n}
    // Before 2024, Class 50 falls under the ordinary AII factor in 1100(2) A(a).
    return a.rule==='aiip'&&a.availableOn<'2024-01-01'?{n:1n,d:2n}:{n:0n,d:1n}
  }
  return (a.rule==='aiip'?a.availableOn<'2024-01-01':a.availableOn<'2030-01-01')?{n:1n,d:2n}:{n:0n,d:1n}
}
export function calculateCca(input:{classCode:string;rateBp:number;opening:bigint;additions:CcaAddition[];disposals:bigint;adjustment:bigint;days:number;poolClosed:boolean;manualMaximum?:bigint}) {
  const additions=input.additions.reduce((n,a)=>n+a.cost,0n),basis=input.opening+additions-input.disposals+input.adjustment
  if(basis<0n)return {additions,basis,maximum:0n,recapture:-basis,terminalLoss:0n}
  if(input.poolClosed)return {additions,basis,maximum:0n,recapture:0n,terminalLoss:basis}
  if(input.manualMaximum!==undefined){if(input.manualMaximum<0n||input.manualMaximum>basis)throw new Error('Manual maximum must be between zero and the available UCC.');return {additions,basis,maximum:input.manualMaximum,recapture:0n,terminalLoss:0n}}
  if(input.adjustment!==0n)throw new Error('A tax-basis adjustment requires a reviewed maximum CCA. Enter the maximum after reviewing assistance, corrections and special tax treatment.')
  const preset=CCA_CLASSES.find(c=>c.code===input.classCode)
  if(!preset?.standard||input.rateBp!==preset.rate)throw new Error('This class or rate requires a reviewed manual maximum.')
  if(input.additions.some(a=>a.rule==='manual'))throw new Error('A special first-year rule requires a reviewed manual maximum.')
  // Proceeds offset non-incentive additions, then AII, then RII (Schedule 8).
  const ordinary=input.additions.filter(a=>!['aiip','riip'].includes(a.rule)).reduce((n,a)=>n+a.cost,0n)
  let offset=maximum(input.disposals-ordinary),boostNumerator=0n,boostDenominator=1n
  for(const rule of ['aiip','riip'] as const){
    const eligible=input.additions.filter(a=>a.rule===rule)
    const factors=eligible.map(a=>factor(input.classCode,a))
    if(factors.some(f=>f.n*factors[0].d!==factors[0].n*f.d))throw new Error('Mixed incentive factors require a reviewed manual maximum.')
    const total=eligible.reduce((n,a)=>n+a.cost,0n),net=maximum(total-offset);offset=maximum(offset-total)
    if(factors.length){const f=factors[0];boostNumerator=boostNumerator*f.d+net*f.n*boostDenominator;boostDenominator*=f.d}
  }
  const halfAdditions=input.additions.filter(a=>a.rule==='half_year').reduce((n,a)=>n+a.cost,0n),half=maximum(halfAdditions-input.disposals)
  const numerator=(basis*2n-half)*boostDenominator+boostNumerator*2n
  const days=Math.min(input.days,365)
  const allowance=roundRatio(numerator,BigInt(input.rateBp)*BigInt(days),2n*boostDenominator*10000n*365n)
  return {additions,basis,maximum:allowance>basis?basis:allowance,recapture:0n,terminalLoss:0n}
}

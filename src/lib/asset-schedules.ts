import 'server-only'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {operationId} from './operations-scope'
import {depreciationAssets,planDepreciation} from './depreciation'
import {ccaRegister} from './cca'
import {deferredTaxReviews} from './deferred-tax'
import {deferredTaxAmounts,deferredTaxJournal} from './deferred-tax-math'
import {financeSetting} from './operations-finance'
import {calculateCca,dayAfter} from './depreciation-math'
import type {DepreciationAsset,DepreciationPolicy} from './depreciation-types'
import type {TaxJournalLine} from './deferred-tax-types'
export type AssetAnnualSchedule={start:string;end:string;status:'Recorded'|'Forecast';bookExpense:string;bookValue:string;maximum:string|null;claim:string|null;closingUcc:string|null;liability:string|null;potentialAsset:string|null;journal:TaxJournalLine[];reason:string;matchesBook:boolean;policyVersion:string}
const sum=(a:bigint[])=>a.reduce((n,x)=>n+x,0n)
type PolicyRevision={asset_id:string;effective_on:string;before_policy:DepreciationPolicy}
const policyRevisions=(ledgerId:string)=>db.execute<PolicyRevision>(sql`SELECT asset_id::text,effective_on::text,before_policy FROM asset_depreciation_policy_revision WHERE ledger_id=${ledgerId}::uuid ORDER BY effective_on`)
const beforeDay=(day:string)=>new Date(Date.parse(day+'T00:00:00Z')-86400000).toISOString().slice(0,10)
function projectedBook(a:DepreciationAsset,end:string,revisions:PolicyRevision[]){
 const entries=a.entries.filter(e=>e.entry_date<=end),accumulated=sum(entries.map(e=>BigInt(e.amount)))
 const policy=revisions.find(r=>r.asset_id===a.id&&r.effective_on>end)?.before_policy??a.policy
 const planned=planDepreciation({...a,policy,entries,accumulated:accumulated.toString()},end,true)
 const cumulative=accumulated+sum(planned.map(e=>e.amount))
 return {cumulative,bookValue:!a.disposed_on||a.disposed_on>end?BigInt(a.acquisition_cost)-cumulative:0n,manual:policy?.method==='manual'||!policy}
}
/** Read-only forecast. Pool-level CCA and deferred tax are never presented as
 * an individual asset's tax ownership; other assets in the pool are included. */
export async function assetFinanceSchedules(ledgerId:string,assetId:string,years?:number) {
 operationId(assetId)
 const [assets,tax,reviews,cfg,company,revisions]=await Promise.all([depreciationAssets(ledgerId),ccaRegister(ledgerId),deferredTaxReviews(ledgerId),financeSetting(ledgerId,'/assets'),db.execute<{month:number;day:number}>(sql`SELECT e.fiscal_year_end_month AS "month",e.fiscal_year_end_day AS "day" FROM ledger l JOIN entity e ON e.id=l.entity_id WHERE l.id=${operationId(ledgerId)}::uuid`),policyRevisions(ledgerId)])
 const asset=assets.find(a=>a.id===assetId);if(!asset)return null
 const assignment=tax.assignments.find(a=>a.asset_id===assetId),pool=tax.pools.find(p=>p.id===assignment?.pool_id)
 const count=Math.max(1,Math.min(200,years??Math.max(10,Math.ceil((asset.policy?.life_months??60)/12)+Number(asset.acquired_on.slice(0,4))-Number((pool?.start_date??asset.acquired_on).slice(0,4))+2)))
 const endFor=(start:string)=>{let year=Number(start.slice(0,4));const {month,day}=company[0];let end=`${year}-${String(month).padStart(2,'0')}-${String(Math.min(day,new Date(Date.UTC(year,month,0)).getUTCDate())).padStart(2,'0')}`;if(end<start){year++;end=`${year}-${String(month).padStart(2,'0')}-${String(Math.min(day,new Date(Date.UTC(year,month,0)).getUTCDate())).padStart(2,'0')}`}return end}
 const start=pool?.start_date??asset.acquired_on,through=endFor(`${Number(start.slice(0,4))+count-1}${start.slice(4)}`)
 const monthly=planDepreciation(asset,through).map(e=>({from:e.from,to:e.to,amount:e.amount.toString()}))
 if(!pool)return {monthly,annual:[] as AssetAnnualSchedule[],pool:null,rateBp:cfg?.tax_rate_bp??null,strategy:cfg?.cca_strategy??'maximum'}
 const assignments=tax.assignments.filter(a=>a.pool_id===pool.id),bookAssets=assets.filter(a=>assignments.some(x=>x.asset_id===a.id)),annual:AssetAnnualSchedule[]=[]
 let cursor=start,opening=BigInt(pool.opening_ucc),previousLiability=0n,previousAsset=0n,blocked=false
 const projected=(a:DepreciationAsset,end:string)=>projectedBook(a,end,revisions)
 for(let i=0;i<count;i++){
  const record=tax.years.find(y=>y.pool_id===pool.id&&y.start_date===cursor),end=record?.end_date??endFor(cursor),review=reviews.find(r=>r.pool_id===pool.id&&r.reporting_date===end),values=bookAssets.filter(a=>a.acquired_on<=end).map(a=>projected(a,end))
  const beforeStart=beforeDay(cursor)
  const bookExpense=sum(bookAssets.filter(a=>a.acquired_on<=end).map(a=>projected(a,end).cumulative-projected(a,beforeStart).cumulative)),bookValue=sum(values.map(v=>v.bookValue)),notes:string[]=[]
  let maximum:bigint|null=null,claim:bigint|null=null,closing:bigint|null=null,liability:bigint|null=null,potentialAsset:bigint|null=null,journal:TaxJournalLine[]=[],matchesBook=false
  if(values.some(v=>v.manual))notes.push('Manual or unconfigured book policies need reviewed amounts; the forecast holds their recorded carrying value.')
  try{
   if(record){maximum=BigInt(record.maximum_cca);claim=BigInt(record.claimed_cca);closing=BigInt(record.closing_ucc)}
   else{
    if(pool.calculation==='manual')throw new Error('This pool requires an annually reviewed manual CCA maximum.')
    if(blocked)throw new Error('A prior forecast year needs a reviewed CCA maximum before later UCC can be projected.')
    const additions=assignments.filter(a=>a.available_on>=cursor&&a.available_on<=end).map(a=>({cost:BigInt(a.tax_cost),acquiredOn:a.acquired_on,availableOn:a.available_on,rule:a.first_year_rule}))
    const disposals=sum(assignments.filter(a=>a.disposed_on&&a.disposed_on>=cursor&&a.disposed_on<=end).map(a=>BigInt(a.proceeds)<BigInt(a.tax_cost)?BigInt(a.proceeds):BigInt(a.tax_cost)))
    const days=Math.round((Date.parse(end)-Date.parse(cursor))/86400000)+1
    const result=calculateCca({classCode:pool.class_code,rateBp:pool.rate_bp,opening,additions,disposals,adjustment:0n,days,poolClosed:false})
    maximum=result.maximum;claim=cfg?.cca_strategy==='match_book'&&bookExpense<maximum?(bookExpense>0n?bookExpense:0n):maximum;closing=result.basis-claim+result.recapture-result.terminalLoss
    if(cfg?.cca_strategy==='match_book'&&bookExpense>maximum)notes.push('Book depreciation exceeds the permitted CCA maximum; only the maximum is suggested.')
   }
   if(record&&!review)notes.push('CCA is recorded; deferred tax remains an unposted annual-review forecast.')
   matchesBook=claim===bookExpense
   if(closing!==null){opening=closing
    const pending=sum(assignments.filter(a=>a.acquired_on<=end&&a.available_on>end&&(!a.disposed_on||a.disposed_on>end)).map(a=>BigInt(a.tax_cost)))
    if(review){liability=BigInt(review.liability);potentialAsset=BigInt(review.potential_asset);previousAsset=BigInt(review.recognized_asset);journal=review.journal;previousLiability=liability}
    else if(cfg?.tax_rate_note){const dt=deferredTaxAmounts(bookValue,closing+pending,cfg.tax_rate_bp,0n);liability=dt.liability;potentialAsset=dt.potentialAsset;journal=deferredTaxJournal(liability,0n,previousLiability,previousAsset,'profit_loss');previousLiability=liability;previousAsset=0n;if(potentialAsset>0n)notes.push('DTA is potential only; recognition requires a probable-taxable-profit review.')}
    else notes.push('Configure the reversal tax rate and basis in Finance to project deferred tax.')
   }
  }catch(e){blocked=true;notes.push(e instanceof Error?e.message:'Reviewed CCA maximum required.')}
  annual.push({start:cursor,end,status:record&&review?'Recorded':'Forecast',bookExpense:bookExpense.toString(),bookValue:(review?BigInt(review.book_value)+BigInt(review.book_adjustment):bookValue).toString(),maximum:maximum?.toString()??null,claim:claim?.toString()??null,closingUcc:closing?.toString()??null,liability:liability?.toString()??null,potentialAsset:potentialAsset?.toString()??null,journal,reason:notes.join(' '),matchesBook,policyVersion:record?.policy_version??'Current verified CCA catalogue'})
  cursor=dayAfter(end)
 }
 return {monthly,annual,pool,rateBp:cfg?.tax_rate_bp??null,strategy:cfg?.cca_strategy??'maximum'}
}

export async function ccaBookClaimSuggestion(ledgerId:string,poolId:string,start:string,end:string,maximum:bigint){
 const [book,tax,cfg,revisions]=await Promise.all([depreciationAssets(ledgerId),ccaRegister(ledgerId),financeSetting(ledgerId,'/assets'),policyRevisions(ledgerId)])
 const scoped=book.filter(a=>a.acquired_on<=end&&tax.assignments.some(x=>x.asset_id===a.id&&x.pool_id===poolId))
 const values=scoped.map(a=>projectedBook(a,end,revisions))
 const expense=sum(scoped.map((a,i)=>values[i].cumulative-projectedBook(a,beforeDay(start),revisions).cumulative))
 const claim=cfg?.cca_strategy==='match_book'?(expense<0n?0n:expense<maximum?expense:maximum):maximum
 return {claim,expense,strategy:cfg?.cca_strategy??'maximum',manual:values.some(a=>a.manual)}
}

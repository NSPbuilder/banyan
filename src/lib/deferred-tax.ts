import 'server-only'
import {postDeferredTax} from './operations-finance'
import {createHash} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import type {UserRecord} from './users'
import {operationWrite,operationId,operationAmount,operationText,OperationsError} from './operations-scope'
import {deferredTaxAmounts,deferredTaxJournal} from './deferred-tax-math'
import {CCA_POLICY} from './cca-policy'
import {planDepreciation} from './depreciation'
import type {DepreciationAsset,DepreciationPolicy,DepreciationEntry} from './depreciation-types'
import {TAX_RECOGNITION,type DeferredTaxInput,type DeferredTaxReview} from './deferred-tax-types'
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)
const hash=(v:unknown)=>createHash('sha256').update(json(v)).digest('hex')
const columns=sql`id::text,pool_id::text,cca_year_id::text,reporting_date::text,revision,rate_bp,rate_note,book_value::text,closing_ucc::text,pending_tax_cost::text,book_adjustment::text,tax_adjustment::text,tax_base::text,temporary_difference::text,liability::text,potential_asset::text,recognized_asset::text,previous_liability::text,previous_asset::text,recognition,note,policy_version,created_by,journal`
export function deferredTaxReviews(ledgerId:string){return db.execute<DeferredTaxReview>(sql`SELECT ${columns} FROM asset_deferred_tax_review WHERE ledger_id=${operationId(ledgerId)}::uuid ORDER BY reporting_date DESC,revision DESC,created_at DESC`)}
async function previewUsing(executor:Pick<Tx,'execute'>,ledgerId:string,input:DeferredTaxInput){
  operationId(ledgerId);operationId(input.ccaYearId)
  for(const n of [input.bookAdjustment,input.taxAdjustment,input.recognizedAsset,input.openingLiability,input.openingAsset])operationAmount(n<0n?-n:n)
  const rateNote=operationText(input.rateNote,'Reversal tax-rate basis',10000,true),note=operationText(input.note,'Scope and recognition review',10000,true)
  if(!input.scopeReviewed||!TAX_RECOGNITION[input.recognition])throw new OperationsError('REVIEW','Review pool scope, tax basis, recognition exceptions and recovery before recording.')
  const [year]=await executor.execute<{id:string;pool_id:string;end_date:string;closing_ucc:string;name:string;class_code:string;currency:string;policy_version:string|null}>(sql`SELECT y.id::text,y.pool_id::text,y.end_date::text,y.closing_ucc::text,p.name,p.class_code,l.currency,y.calculation_snapshot->'policy'->>'version' policy_version FROM asset_cca_year y JOIN asset_cca_pool p ON p.id=y.pool_id JOIN ledger l ON l.id=y.ledger_id WHERE y.ledger_id=${ledgerId}::uuid AND y.id=${input.ccaYearId}::uuid`)
  if(!year)throw new OperationsError('CCA_YEAR','Select a recorded CCA year in this ledger.')
  if(year.currency!=='CAD')throw new OperationsError('CURRENCY','Automatic book/tax reconciliation requires a CAD ledger. Review currency conversion outside this working paper.')
  const [previous]=await executor.execute<DeferredTaxReview>(sql`SELECT ${columns} FROM asset_deferred_tax_review WHERE pool_id=${year.pool_id}::uuid ORDER BY reporting_date DESC,revision DESC LIMIT 1`)
  if(previous&&previous.reporting_date>year.end_date)throw new OperationsError('ORDER','Only the latest reporting year can be corrected. Record later reviews in date order.')
  if(previous&&previous.reporting_date<year.end_date&&(await executor.execute(sql`SELECT 1 FROM asset_cca_year WHERE pool_id=${year.pool_id}::uuid AND end_date>${previous.reporting_date}::date AND end_date<${year.end_date}::date`)).length)throw new OperationsError('ORDER','Review each intervening recorded CCA year first.')
  const assets=await executor.execute<DepreciationAsset & {tax_cost:string;available_on:string;tax_disposed_on:string|null;assignment_version:number}>(sql`SELECT a.id::text,a.code,a.name,a.acquisition_cost::text,a.acquired_on::text,a.disposed_on::text,a.status,x.tax_cost::text,x.available_on::text,x.disposed_on::text tax_disposed_on,x.version assignment_version,coalesce((SELECT sum(amount) FROM asset_depreciation_entry e WHERE e.asset_id=a.id AND e.entry_date<=${year.end_date}::date),0)::text accumulated FROM asset_cca_assignment x JOIN fixed_asset a ON a.id=x.asset_id WHERE x.pool_id=${year.pool_id}::uuid AND a.acquired_on<=${year.end_date}::date ORDER BY a.id`)
  const policyRows=await executor.execute<{policy:DepreciationPolicy}>(sql`SELECT coalesce((SELECT before_policy FROM asset_depreciation_policy_revision r WHERE r.asset_id=p.asset_id AND r.effective_on>${year.end_date}::date ORDER BY r.effective_on LIMIT 1),to_jsonb(p)||jsonb_build_object('residual_value',p.residual_value::text,'opening_accumulated',p.opening_accumulated::text)) policy FROM asset_depreciation_policy p WHERE p.ledger_id=${ledgerId}::uuid`),policies=policyRows.map(r=>r.policy)
  const entries=await executor.execute<DepreciationEntry>(sql`SELECT id::text,asset_id::text,entry_date::text,period_start::text,period_end::text,kind,amount::text,note,created_by FROM asset_depreciation_entry WHERE ledger_id=${ledgerId}::uuid AND entry_date<=${year.end_date}::date ORDER BY entry_date DESC,created_at DESC`)
  const values=assets.map(a=>{
    const policy=policies.find(p=>p.asset_id===a.id)??null,owned=!a.disposed_on||a.disposed_on>year.end_date
    const asset={...a,policy,entries:entries.filter(e=>e.asset_id===a.id),net_book_value:(owned?BigInt(a.acquisition_cost)-BigInt(a.accumulated):0n).toString()}
    if(!policy)throw new OperationsError('POLICY',`Configure the book policy for ${a.code}, including an explicit manual or no-depreciation policy.`)
    if(planDepreciation(asset,year.end_date,true).length)throw new OperationsError('DEPRECIATION_PENDING',`Record book depreciation through ${year.end_date} for ${a.code} before reviewing deferred tax.`)
    return asset
  })
  const bookValue=values.reduce((n,a)=>n+BigInt(a.net_book_value),0n),pendingTaxCost=values.filter(a=>a.available_on>year.end_date&&(!a.tax_disposed_on||a.tax_disposed_on>year.end_date)).reduce((n,a)=>n+BigInt(a.tax_cost),0n)
  const taxBase=BigInt(year.closing_ucc)+pendingTaxCost+input.taxAdjustment
  const amounts=deferredTaxAmounts(bookValue+input.bookAdjustment,taxBase,input.rateBp,input.recognizedAsset)
  const previousLiability=BigInt(previous?.liability??input.openingLiability),previousAsset=BigInt(previous?.recognized_asset??input.openingAsset)
  if(previous&&(input.openingLiability!==0n||input.openingAsset!==0n))throw new OperationsError('OPENING','Opening balances apply only to the first review. Later reviews carry recorded balances.')
  const journal=deferredTaxJournal(amounts.liability,amounts.recognizedAsset,previousLiability,previousAsset,input.recognition)
  const revision=previous?.reporting_date===year.end_date?previous.revision+1:1
  const facts:DeferredTaxInput={...input,rateNote,note}
  const snapshot={year,assets:values,input:facts,previous:previous??null,policy:CCA_POLICY,bookValue,pendingTaxCost,taxBase,...amounts,journal,revision}
  return {year,assets:values,bookValue,pendingTaxCost,taxBase,...amounts,previousLiability,previousAsset,previousId:previous?.id??null,revision,journal,snapshot,hash:hash({...snapshot,input:{...facts,rateNote:undefined,note:undefined}})}
}
export function deferredTaxPreview(ledgerId:string,input:DeferredTaxInput){return previewUsing(db,ledgerId,input)}
export async function recordDeferredTaxReview(me:UserRecord,ledgerId:string,input:DeferredTaxInput & {key:string;expectedHash:string}){
  operationId(input.key)
  const requestHash=hash(input)
  return operationWrite(me,ledgerId,'/assets',async(tx,s)=>{
    const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM asset_deferred_tax_review WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
    if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This request was already used with different values.');return prior.id}
    // Strip request metadata: GET and POST must hash the same reviewed facts.
    const facts:DeferredTaxInput={ccaYearId:input.ccaYearId,rateBp:input.rateBp,rateNote:input.rateNote,bookAdjustment:input.bookAdjustment,taxAdjustment:input.taxAdjustment,recognizedAsset:input.recognizedAsset,openingLiability:input.openingLiability,openingAsset:input.openingAsset,recognition:input.recognition,scopeReviewed:input.scopeReviewed,note:input.note}
    const p=await previewUsing(tx,ledgerId,facts)
    if(p.hash!==input.expectedHash)throw new OperationsError('STALE','The working paper changed. Refresh and review it before recording.')
    const [row]=await tx.execute<{id:string}>(sql`INSERT INTO asset_deferred_tax_review(ledger_id,pool_id,cca_year_id,previous_review_id,reporting_date,revision,rate_bp,rate_note,book_value,closing_ucc,pending_tax_cost,book_adjustment,tax_adjustment,tax_base,temporary_difference,liability,potential_asset,recognized_asset,previous_liability,previous_asset,recognition,note,policy_version,calculation_snapshot,journal,request_key,request_hash,created_by)
      VALUES(${ledgerId}::uuid,${p.year.pool_id}::uuid,${p.year.id}::uuid,${p.previousId}::uuid,${p.year.end_date}::date,${p.revision},${input.rateBp},${input.rateNote.trim()},${p.bookValue},${p.year.closing_ucc}::bigint,${p.pendingTaxCost},${input.bookAdjustment},${input.taxAdjustment},${p.taxBase},${p.difference},${p.liability},${p.potentialAsset},${p.recognizedAsset},${p.previousLiability},${p.previousAsset},${input.recognition},${input.note.trim()},${CCA_POLICY.version},${json(p.snapshot)}::jsonb,${json(p.journal)}::jsonb,${input.key}::uuid,${requestHash},${s.email}) RETURNING id::text`)
    await postDeferredTax(tx,ledgerId,row.id,s.email)
    return row.id
  })
}

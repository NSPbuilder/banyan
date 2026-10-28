import 'server-only'
import {postAssetDepreciation,financeSetting} from './operations-finance'
import {createHash,randomUUID} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import type {UserRecord} from './users'
import {operationWrite,operationId,operationDate,operationAmount,operationText,OperationsError} from './operations-scope'
import {dayAfter,monthEnd,monthlyDepreciation} from './depreciation-math'
import type {DepreciationAsset,DepreciationPolicy,DepreciationEntry,DepreciationMethod} from './depreciation-types'
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)).digest('hex')
export async function depreciationAssets(ledgerId:string):Promise<DepreciationAsset[]> {
  const [assets,policies,entries]=await Promise.all([
    db.execute<Omit<DepreciationAsset,'policy'|'entries'>>(sql`SELECT a.id::text,a.code,a.name,a.acquisition_cost::text,a.acquired_on::text,a.disposed_on::text,a.status,coalesce(d.total,0)::text AS accumulated,(CASE WHEN a.disposed_on IS NOT NULL THEN 0 ELSE a.acquisition_cost-coalesce(d.total,0) END)::text AS net_book_value FROM fixed_asset a LEFT JOIN (SELECT asset_id,sum(amount) total FROM asset_depreciation_entry GROUP BY asset_id) d ON d.asset_id=a.id WHERE a.ledger_id=${operationId(ledgerId)}::uuid ORDER BY lower(a.code)`),
    db.execute<DepreciationPolicy>(sql`SELECT id::text,asset_id::text,method,start_date::text,residual_value::text,life_months,annual_rate_bp,version,opening_accumulated::text FROM asset_depreciation_policy WHERE ledger_id=${ledgerId}::uuid`),
    db.execute<DepreciationEntry>(sql`SELECT id::text,asset_id::text,entry_date::text,period_start::text,period_end::text,kind,amount::text,note,created_by FROM asset_depreciation_entry WHERE ledger_id=${ledgerId}::uuid ORDER BY entry_date DESC,created_at DESC`)
  ])
  return assets.map(a=>({...a,policy:policies.find(p=>p.asset_id===a.id)??null,entries:entries.filter(e=>e.asset_id===a.id)}))
}
export async function saveDepreciationPolicy(me:UserRecord,ledgerId:string,input:{assetId:string;version:number;method:DepreciationMethod;startDate:string;residualValue:bigint;lifeMonths:number;annualRateBp:number;revisionReason?:string}) {
  return operationWrite(me,ledgerId,'/assets',tx=>saveDepreciationPolicyInTransaction(tx,ledgerId,input))
}
export async function saveDepreciationPolicyInTransaction(tx:Tx,ledgerId:string,input:{assetId:string;version:number;method:DepreciationMethod;startDate:string;residualValue:bigint;lifeMonths:number;annualRateBp:number;revisionReason?:string}) {
  operationId(input.assetId);operationDate(input.startDate);operationAmount(input.residualValue)
  if(!['none','straight_line','declining_balance','manual'].includes(input.method)||!Number.isInteger(input.lifeMonths)||input.lifeMonths<1||input.lifeMonths>1200||!Number.isInteger(input.annualRateBp)||input.annualRateBp<1||input.annualRateBp>10000)throw new OperationsError('POLICY','Choose a method, life from 1 to 1,200 months, and annual rate above 0% up to 100%.')
    const [asset]=await tx.execute<{acquired_on:string;acquisition_cost:string}>(sql`SELECT acquired_on::text,acquisition_cost::text FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND id=${input.assetId}::uuid FOR UPDATE`)
    if(!asset)throw new OperationsError('ASSET','Choose an asset in this ledger.')
    if(input.startDate<asset.acquired_on||input.residualValue>BigInt(asset.acquisition_cost))throw new OperationsError('POLICY','Start date cannot precede acquisition, and residual cannot exceed cost.')
    const [old]=await tx.execute<DepreciationPolicy>(sql`SELECT id::text,asset_id::text,method,start_date::text,residual_value::text,life_months,annual_rate_bp,version,opening_accumulated::text FROM asset_depreciation_policy WHERE asset_id=${input.assetId}::uuid`)
    const finance=await financeSetting(ledgerId,'/assets',tx)
    if(!old&&finance?.connected_on&&input.startDate<finance.connected_on)throw new OperationsError('FINANCE_DATE','For an enrolled legacy asset, start the new policy on or after the Finance connection date. Review any opening accumulated amount separately.')
    if((old?.version??0)!==input.version)throw new OperationsError('STALE','This depreciation policy changed. Reload before saving.')
    const [current]=await transactionAssets(tx,ledgerId,input.assetId)
    const reason=input.revisionReason?.trim()?operationText(input.revisionReason,'Estimate change reason',10000,true):''
    let opening=0n
    if(reason&&old){
      const priorDate=new Date(Date.parse(input.startDate+'T00:00:00Z')-86400000).toISOString().slice(0,10)
      if(current.disposed_on||!input.startDate.endsWith('-01')||input.startDate<=old.start_date||current.entries.some(e=>e.entry_date>=input.startDate))throw new OperationsError('POLICY_HISTORY','A prospective estimate change starts on a later month’s first day, after all recorded entries.')
      if(planDepreciation(current,priorDate).length)throw new OperationsError('DEPRECIATION_PENDING','Record book depreciation through the previous month before changing estimates.')
      opening=BigInt(current.accumulated)
      if(input.residualValue>BigInt(asset.acquisition_cost)-opening)throw new OperationsError('POLICY','Revised residual cannot exceed the remaining carrying amount.')
      await tx.execute(sql`INSERT INTO asset_depreciation_policy_revision(ledger_id,asset_id,effective_on,reason,before_policy,after_policy,created_by) VALUES(${ledgerId}::uuid,${input.assetId}::uuid,${input.startDate}::date,${reason},${JSON.stringify(old)}::jsonb,${JSON.stringify({method:input.method,start_date:input.startDate,residual_value:input.residualValue.toString(),life_months:input.lifeMonths,annual_rate_bp:input.annualRateBp,opening_accumulated:opening.toString(),version:old.version+1})}::jsonb,current_setting('app.actor',true))`)
    }else if(current.entries.length||(await tx.execute(sql`SELECT 1 FROM asset_deferred_tax_review r JOIN asset_cca_assignment x ON x.pool_id=r.pool_id WHERE x.asset_id=${input.assetId}::uuid LIMIT 1`)).length)throw new OperationsError('POLICY_HISTORY','Recorded terms require a prospective estimate change with a reason. Historical entries remain fixed.')

    await tx.execute(sql`INSERT INTO asset_depreciation_policy(ledger_id,asset_id,method,start_date,residual_value,life_months,annual_rate_bp,opening_accumulated) VALUES(${ledgerId}::uuid,${input.assetId}::uuid,${input.method},${input.startDate}::date,${input.residualValue},${input.lifeMonths},${input.annualRateBp},${opening}) ON CONFLICT(ledger_id,asset_id) DO UPDATE SET method=EXCLUDED.method,start_date=EXCLUDED.start_date,residual_value=EXCLUDED.residual_value,life_months=EXCLUDED.life_months,annual_rate_bp=EXCLUDED.annual_rate_bp,opening_accumulated=EXCLUDED.opening_accumulated,version=asset_depreciation_policy.version+1`)
}
export function planDepreciation(asset:DepreciationAsset,through:string,partialClose=false) {
  const p=asset.policy;if(!p||!['straight_line','declining_balance'].includes(p.method))return []
  const lastAutomatic=asset.entries.find(e=>e.kind==='automatic')
  let cursor=lastAutomatic?dayAfter(lastAutomatic.period_end!):p.start_date
  if(cursor<p.start_date)cursor=p.start_date
  const stop=asset.disposed_on&&asset.disposed_on<through?asset.disposed_on:through
  let balance=BigInt(asset.accumulated);const result:Array<{from:string;to:string;amount:bigint}>=[]
  for(let i=0;i<1201&&cursor<=stop;i++){
    const end=monthEnd(cursor.slice(0,7)),to=end>stop?stop:end
    // Only completed months, or an asset's final disposal period, are posted.
    if(to!==end&&to!==asset.disposed_on&&!partialClose)break
    const amount=monthlyDepreciation(BigInt(asset.acquisition_cost),balance,p,cursor,to,balance-asset.entries.filter(e=>e.kind==='automatic'&&e.period_start?.slice(0,7)===cursor.slice(0,7)).reduce((n,e)=>n+BigInt(e.amount),0n))
    if(amount>0n){result.push({from:cursor,to,amount});balance+=amount}
    if(balance>=BigInt(asset.acquisition_cost)-BigInt(p.residual_value))break
    cursor=dayAfter(end)
  }
  return result
}
export async function runDepreciation(me:UserRecord,ledgerId:string,input:{through:string;assetId?:string;key:string;expectedHash:string}) {
  operationDate(input.through);operationId(input.key);if(input.assetId)operationId(input.assetId)
  const partialClose=monthEnd(input.through.slice(0,7))!==input.through
  if(partialClose&&!(await depreciationFiscalEnds(ledgerId)).includes(input.through))throw new OperationsError('MONTH','Choose a month end or a recorded fiscal year end.')
  return operationWrite(me,ledgerId,'/assets',async(tx,s)=>{
    const requestHash=hash(input)
    const [prior]=await tx.execute<{entry_count:number;request_hash:string}>(sql`SELECT entry_count,request_hash FROM asset_depreciation_run WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
    if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This run request was already used with different values.');return prior.entry_count}
    // Fetch using the transaction, including current policies/history, under the ledger lock.
    const assets=await transactionAssets(tx,ledgerId,input.assetId),plan=assets.map(a=>({asset:a,entries:planDepreciation(a,input.through,partialClose)})).filter(p=>p.entries.length)
    const digest=previewDigest(plan)
    if(digest!==input.expectedHash)throw new OperationsError('STALE','The depreciation preview changed. Reload and review it before recording.')
    let count=0
    for(const p of plan)for(const e of p.entries){const [row]=await tx.execute<{id:string}>(sql`INSERT INTO asset_depreciation_entry(ledger_id,asset_id,entry_date,period_start,period_end,kind,amount,note,policy_snapshot,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${p.asset.id}::uuid,${e.to}::date,${e.from}::date,${e.to}::date,'automatic',${e.amount},'Monthly book depreciation',${JSON.stringify(p.asset.policy)}::jsonb,${randomUUID()}::uuid,${hash([input.key,p.asset.id,e])},${s.email}) RETURNING id::text`);await postAssetDepreciation(tx,ledgerId,row.id,s.email);count++}
    await tx.execute(sql`INSERT INTO asset_depreciation_run(ledger_id,through_date,entry_count,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${input.through}::date,${count},${input.key}::uuid,${requestHash},${s.email})`)
    return count
  })
}
export async function transactionAssets(tx:Tx,ledgerId:string,assetId?:string):Promise<DepreciationAsset[]> {
  const assets=await tx.execute<Omit<DepreciationAsset,'policy'|'entries'>>(sql`SELECT a.id::text,a.code,a.name,a.acquisition_cost::text,a.acquired_on::text,a.disposed_on::text,a.status,coalesce((SELECT sum(amount) FROM asset_depreciation_entry WHERE asset_id=a.id),0)::text AS accumulated FROM fixed_asset a WHERE a.ledger_id=${ledgerId}::uuid AND (${assetId??null}::uuid IS NULL OR a.id=${assetId??null}::uuid) FOR UPDATE`)
  const policies=await tx.execute<DepreciationPolicy>(sql`SELECT id::text,asset_id::text,method,start_date::text,residual_value::text,life_months,annual_rate_bp,version,opening_accumulated::text FROM asset_depreciation_policy WHERE ledger_id=${ledgerId}::uuid`),entries=await tx.execute<DepreciationEntry>(sql`SELECT id::text,asset_id::text,entry_date::text,period_start::text,period_end::text,kind,amount::text,note FROM asset_depreciation_entry WHERE ledger_id=${ledgerId}::uuid ORDER BY entry_date DESC,created_at DESC`)
  return assets.sort((a,b)=>a.code.toLowerCase().localeCompare(b.code.toLowerCase())).map(a=>({...a,net_book_value:(a.disposed_on?0n:BigInt(a.acquisition_cost)-BigInt(a.accumulated)).toString(),policy:policies.find(p=>p.asset_id===a.id)??null,entries:entries.filter(e=>e.asset_id===a.id)}))
}
const previewDigest=(plan:{asset:DepreciationAsset;entries:{from:string;to:string;amount:bigint}[]}[])=>hash(plan.map(p=>[p.asset.id,p.asset.policy,p.asset.accumulated,p.entries]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))
export function depreciationPreview(assets:DepreciationAsset[],through:string,partialClose=false) {
  const plan=assets.map(a=>({asset:a,entries:planDepreciation(a,through,partialClose)})).filter(p=>p.entries.length)
  return {plan,hash:previewDigest(plan)}
}
export async function adjustDepreciation(me:UserRecord,ledgerId:string,input:{assetId:string;date:string;amount:bigint;note:string;key:string}) {
  operationId(input.assetId);operationId(input.key);operationDate(input.date);operationAmount(input.amount<0n?-input.amount:input.amount)
  if(input.amount===0n)throw new OperationsError('AMOUNT','Enter a non-zero adjustment.')
  const note=operationText(input.note,'Adjustment reason',10000,true),requestHash=hash({...input,note})
  return operationWrite(me,ledgerId,'/assets',async(tx,s)=>{
    const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM asset_depreciation_entry WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
    if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This request was already used with different values.');return prior.id}
    const [asset]=await transactionAssets(tx,ledgerId,input.assetId)
    if(!asset||!asset.policy)throw new OperationsError('POLICY','Configure this asset’s depreciation policy first.')
    if(input.date<asset.acquired_on||asset.disposed_on&&input.date>asset.disposed_on||asset.entries[0]&&input.date<asset.entries[0].entry_date)throw new OperationsError('DATE','Use a date within the asset’s ownership period and on or after its latest depreciation entry.')
    const priorMonthEnd=new Date(Date.UTC(Number(input.date.slice(0,4)),Number(input.date.slice(5,7))-1,0)).toISOString().slice(0,10)
    if(planDepreciation(asset,priorMonthEnd).length)throw new OperationsError('DEPRECIATION_PENDING','Record monthly depreciation through the previous month before entering this adjustment. For opening balances, set the policy start date after the opening balance date.')
    const balance=BigInt(asset.accumulated)+input.amount
    if(balance<0n||balance>BigInt(asset.acquisition_cost)-BigInt(asset.policy.residual_value))throw new OperationsError('BALANCE','Accumulated depreciation must stay between zero and cost less residual value.')
    const [entry]=await tx.execute<{id:string}>(sql`INSERT INTO asset_depreciation_entry(ledger_id,asset_id,entry_date,kind,amount,note,policy_snapshot,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${input.assetId}::uuid,${input.date}::date,'manual',${input.amount},${note},${JSON.stringify(asset.policy)}::jsonb,${input.key}::uuid,${requestHash},${s.email}) RETURNING id::text`)
    await postAssetDepreciation(tx,ledgerId,entry.id,s.email)
    return entry.id
  })
}

export function depreciationPolicyHistory(ledgerId:string,assetId:string){
 return db.execute<{id:string;effective_on:string;reason:string;before_policy:DepreciationPolicy;after_policy:DepreciationPolicy;created_by:string}>(sql`SELECT id::text,effective_on::text,reason,before_policy,after_policy,created_by FROM asset_depreciation_policy_revision WHERE ledger_id=${operationId(ledgerId)}::uuid AND asset_id=${operationId(assetId)}::uuid ORDER BY effective_on DESC`)
}

/** Disposal settles the final book period before removing its carrying value. */
export async function recordDisposalDepreciation(tx:Tx,ledgerId:string,assetId:string,date:string,actor:string) {
 const [asset]=await transactionAssets(tx,ledgerId,assetId)
 for(const e of planDepreciation(asset,date)){
  const key=randomUUID(),[row]=await tx.execute<{id:string}>(sql`INSERT INTO asset_depreciation_entry(ledger_id,asset_id,entry_date,period_start,period_end,kind,amount,note,policy_snapshot,request_key,request_hash,created_by)
   VALUES(${ledgerId}::uuid,${assetId}::uuid,${e.to}::date,${e.from}::date,${e.to}::date,'automatic',${e.amount},'Final book amortization on disposal',${JSON.stringify(asset.policy)}::jsonb,${key}::uuid,${hash([key,assetId,e])},${actor}) RETURNING id::text`)
  await postAssetDepreciation(tx,ledgerId,row.id,actor)
 }
}

export async function depreciationFiscalEnds(ledgerId:string){
 const rows=await db.execute<{end_date:string}>(sql`SELECT end_date::text FROM fiscal_year WHERE ledger_id=${operationId(ledgerId)}::uuid ORDER BY end_date DESC`)
 return rows.map(r=>r.end_date)
}

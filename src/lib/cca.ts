import 'server-only'
import {createHash} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import type {UserRecord} from './users'
import {operationWrite,operationId,operationDate,operationAmount,operationText,OperationsError} from './operations-scope'
import {CCA_POLICY} from './cca-policy'
import {calculateCca,dayAfter} from './depreciation-math'
import {CCA_CLASSES,type CcaPool,type CcaAssignment,type CcaYear,type CcaRule} from './depreciation-types'
const fingerprint=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)).digest('hex')
export async function ccaRegister(ledgerId:string) {
  const [pools,assignments,years]=await Promise.all([
    db.execute<CcaPool>(sql`SELECT p.id::text,p.name,p.class_code,p.rate_bp,p.calculation,p.opening_ucc::text,p.start_date::text,p.version,(SELECT closing_ucc::text FROM asset_cca_year WHERE pool_id=p.id ORDER BY end_date DESC LIMIT 1) AS latest_closing,(SELECT end_date::text FROM asset_cca_year WHERE pool_id=p.id ORDER BY end_date DESC LIMIT 1) AS latest_end FROM asset_cca_pool p WHERE p.ledger_id=${operationId(ledgerId)}::uuid ORDER BY lower(p.name)`),
    db.execute<CcaAssignment>(sql`SELECT x.id::text,x.asset_id::text,a.code AS asset_code,a.name AS asset_name,a.acquired_on::text,x.pool_id::text,x.tax_cost::text,x.available_on::text,x.first_year_rule,x.eligibility_note,x.disposed_on::text,x.proceeds::text,x.version FROM asset_cca_assignment x JOIN fixed_asset a ON a.id=x.asset_id WHERE x.ledger_id=${ledgerId}::uuid ORDER BY a.code`),
    db.execute<CcaYear>(sql`SELECT id::text,pool_id::text,start_date::text,end_date::text,opening_ucc::text,additions::text,disposals::text,basis_adjustment::text,maximum_cca::text,claimed_cca::text,recapture::text,terminal_loss::text,closing_ucc::text,note,created_by,calculation_snapshot->'policy'->>'version' policy_version FROM asset_cca_year WHERE ledger_id=${ledgerId}::uuid ORDER BY end_date DESC`)
  ])
  return {pools,assignments,years}
}
export async function saveCcaPool(me:UserRecord,ledgerId:string,input:{id?:string;version:number;name:string;classCode:string;rateBp:number;calculation:'standard'|'manual';openingUcc:bigint;startDate:string}) {
  return operationWrite(me,ledgerId,'/assets',tx=>saveCcaPoolInTransaction(tx,ledgerId,input))
}
export async function saveCcaPoolInTransaction(tx:Tx,ledgerId:string,input:{id?:string;version:number;name:string;classCode:string;rateBp:number;calculation:'standard'|'manual';openingUcc:bigint;startDate:string}) {
  if(input.id)operationId(input.id);operationDate(input.startDate);operationAmount(input.openingUcc)
  const name=operationText(input.name,'Pool name',240,true),classCode=operationText(input.classCode,'CCA class',30,true)
  if(!Number.isInteger(input.rateBp)||input.rateBp<1||input.rateBp>10000||!['standard','manual'].includes(input.calculation))throw new OperationsError('RATE','Enter a rate above 0% up to 100%.')
  const preset=CCA_CLASSES.find(c=>c.code===classCode)
  if(input.calculation==='standard'&&(!preset?.standard||preset.rate!==input.rateBp))throw new OperationsError('CCA_CLASS','Use the prescribed standard rate, or choose reviewed manual calculation for this pool.')
    if((await tx.execute(sql`SELECT 1 FROM asset_cca_pool WHERE ledger_id=${ledgerId}::uuid AND lower(name)=lower(${name}) AND (${input.id??null}::uuid IS NULL OR id<>${input.id??null}::uuid)`)).length)throw new OperationsError('NAME','That pool name is already in use.')
    if(input.id){const [old]=await tx.execute<{version:number}>(sql`SELECT version FROM asset_cca_pool WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid FOR UPDATE`);if(!old)throw new OperationsError('POOL','This pool is unavailable.');if(old.version!==input.version)throw new OperationsError('STALE','This pool changed. Reload before saving.')
      if((await tx.execute(sql`SELECT 1 FROM asset_cca_year WHERE pool_id=${input.id}::uuid LIMIT 1`)).length)throw new OperationsError('CCA_HISTORY','Pool terms are fixed after a tax year is recorded. Use an annual basis adjustment with a reason.')
      await tx.execute(sql`UPDATE asset_cca_pool SET name=${name},class_code=${classCode},rate_bp=${input.rateBp},calculation=${input.calculation},opening_ucc=${input.openingUcc},start_date=${input.startDate}::date,version=version+1 WHERE id=${input.id}::uuid`);return input.id
    }
    const [p]=await tx.execute<{id:string}>(sql`INSERT INTO asset_cca_pool(ledger_id,name,class_code,rate_bp,calculation,opening_ucc,start_date) VALUES(${ledgerId}::uuid,${name},${classCode},${input.rateBp},${input.calculation},${input.openingUcc},${input.startDate}::date) RETURNING id::text`);return p.id
}
/** Shared class pools start with the company's actual fiscal year, not a
 * shortened acquisition-date year. Exceptional vehicle classes stay separate. */
export async function assetCcaPool(tx:Tx,ledgerId:string,classCode:string,acquiredOn:string,assetCode:string) {
 const preset=CCA_CLASSES.find(c=>c.code===classCode)
 if(!preset)throw new OperationsError('CCA_CLASS','Choose a supported CCA class or configure a reviewed special pool first.')
 const [fy]=await tx.execute<{start_date:string}>(sql`SELECT start_date::text FROM fiscal_year WHERE ledger_id=${ledgerId}::uuid AND ${acquiredOn}::date BETWEEN start_date AND end_date`)
 if(!fy)throw new OperationsError('YEAR','Create the fiscal year covering this acquisition first.')
 if(classCode!=='10.1'){
  const [pool]=await tx.execute<{id:string}>(sql`SELECT id::text FROM asset_cca_pool p WHERE p.ledger_id=${ledgerId}::uuid AND class_code=${classCode} AND rate_bp=${preset.rate}
   AND start_date<=${acquiredOn}::date AND NOT EXISTS(SELECT 1 FROM asset_cca_year y WHERE y.pool_id=p.id AND y.end_date>=${acquiredOn}::date) ORDER BY start_date,id LIMIT 1`)
  if(pool)return pool.id
 }
 return saveCcaPoolInTransaction(tx,ledgerId,{version:0,name:`Class ${classCode} — ${classCode==='10.1'?assetCode:fy.start_date}`,classCode,rateBp:preset.rate,calculation:preset.standard?'standard':'manual',openingUcc:0n,startDate:fy.start_date})
}
export async function saveCcaAssignment(me:UserRecord,ledgerId:string,input:{assetId:string;poolId:string;version:number;taxCost:bigint;availableOn:string;rule:CcaRule;eligibilityNote:string;disposedOn:string;proceeds:bigint}) {
  return operationWrite(me,ledgerId,'/assets',tx=>saveCcaAssignmentInTransaction(tx,ledgerId,input))
}
export async function saveCcaAssignmentInTransaction(tx:Tx,ledgerId:string,input:{assetId:string;poolId:string;version:number;taxCost:bigint;availableOn:string;rule:CcaRule;eligibilityNote:string;disposedOn:string;proceeds:bigint}) {
  operationId(input.assetId);operationId(input.poolId);operationDate(input.availableOn);if(input.disposedOn)operationDate(input.disposedOn);operationAmount(input.taxCost);operationAmount(input.proceeds)
  const eligibility=operationText(input.eligibilityNote,'Tax basis / eligibility notes',10000,true)
  if(!['half_year','no_half_year','aiip','riip','manual'].includes(input.rule))throw new OperationsError('CCA_RULE','Choose a first-year rule.')
  if(input.disposedOn&&input.disposedOn<input.availableOn||!input.disposedOn&&input.proceeds!==0n)throw new OperationsError('DATE','Proceeds require a disposal date on or after availability.')
    const [asset]=await tx.execute<{acquired_on:string}>(sql`SELECT acquired_on::text FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND id=${input.assetId}::uuid FOR UPDATE`),[pool]=await tx.execute<{start_date:string;class_code:string}>(sql`SELECT start_date::text,class_code FROM asset_cca_pool WHERE ledger_id=${ledgerId}::uuid AND id=${input.poolId}::uuid`)
    if(!asset||!pool)throw new OperationsError('CCA_SCOPE','Choose an asset and pool in this ledger.')
    if(input.availableOn<asset.acquired_on)throw new OperationsError('DATE','Availability cannot precede acquisition.')
    const [old]=await tx.execute<CcaAssignment>(sql`SELECT id::text,pool_id::text,tax_cost::text,available_on::text,first_year_rule,disposed_on::text,proceeds::text,version FROM asset_cca_assignment WHERE asset_id=${input.assetId}::uuid`)
    const [review]=await tx.execute<{last:string|null}>(sql`SELECT max(reporting_date)::text AS last FROM asset_deferred_tax_review WHERE pool_id IN (${input.poolId}::uuid,${old?.pool_id??input.poolId}::uuid)`)
    if(review.last&&(!old&&asset.acquired_on<=review.last||old&&(old.pool_id!==input.poolId||BigInt(old.tax_cost)!==input.taxCost||old.available_on!==input.availableOn||old.first_year_rule!==input.rule)))throw new OperationsError('TAX_HISTORY','This assignment changes a recorded book/tax review. Use reviewed basis adjustments instead.')
    if((old?.version??0)!==input.version)throw new OperationsError('STALE','This tax assignment changed. Reload before saving.')
    if(pool.class_code==='10.1'&&(await tx.execute(sql`SELECT 1 FROM asset_cca_assignment WHERE pool_id=${input.poolId}::uuid AND asset_id<>${input.assetId}::uuid LIMIT 1`)).length)throw new OperationsError('CCA_CLASS','Class 10.1 requires a separate pool for each vehicle.')
    const [posted]=await tx.execute<{last:string|null}>(sql`SELECT max(end_date)::text AS last FROM asset_cca_year WHERE pool_id IN (${input.poolId}::uuid,${old?.pool_id??input.poolId}::uuid)`)
    if(posted.last){
      if(!old&&input.availableOn<=posted.last)throw new OperationsError('CCA_HISTORY','This assignment affects a recorded year. Use an annual basis adjustment or a new pool for the correction.')
      if(old&&(old.pool_id!==input.poolId||BigInt(old.tax_cost)!==input.taxCost||old.available_on!==input.availableOn||old.first_year_rule!==input.rule||old.disposed_on&&old.disposed_on<=posted.last&&(old.disposed_on!==input.disposedOn||BigInt(old.proceeds)!==input.proceeds)||input.disposedOn&&input.disposedOn<=posted.last&&(old.disposed_on!==input.disposedOn||BigInt(old.proceeds)!==input.proceeds)))throw new OperationsError('CCA_HISTORY','Recorded tax facts cannot be rewritten. Use an annual basis adjustment with a reason.')
    }
    // Validate incentive acquisition/availability dates even before a year preview.
    if(input.rule==='aiip'&&(asset.acquired_on<='2018-11-20'||asset.acquired_on>='2025-01-01'||input.availableOn>='2028-01-01')||input.rule==='riip'&&(asset.acquired_on<'2025-01-01'||input.availableOn>='2034-01-01'))throw new OperationsError('CCA_RULE','Acquisition or availability date does not meet the selected incentive window.')
    await tx.execute(sql`INSERT INTO asset_cca_assignment(ledger_id,asset_id,pool_id,tax_cost,available_on,first_year_rule,eligibility_note,disposed_on,proceeds) VALUES(${ledgerId}::uuid,${input.assetId}::uuid,${input.poolId}::uuid,${input.taxCost},${input.availableOn}::date,${input.rule},${eligibility},${input.disposedOn||null}::date,${input.proceeds}) ON CONFLICT(ledger_id,asset_id) DO UPDATE SET pool_id=EXCLUDED.pool_id,tax_cost=EXCLUDED.tax_cost,available_on=EXCLUDED.available_on,first_year_rule=EXCLUDED.first_year_rule,eligibility_note=EXCLUDED.eligibility_note,disposed_on=EXCLUDED.disposed_on,proceeds=EXCLUDED.proceeds,version=asset_cca_assignment.version+1`)
}
export type CcaYearInput={poolId:string;startDate:string;endDate:string;adjustment:bigint;manualMaximum?:bigint;poolClosed:boolean}
async function previewUsing(executor:Pick<Tx,'execute'>,ledgerId:string,input:CcaYearInput) {
  operationId(input.poolId);operationDate(input.startDate);operationDate(input.endDate);operationAmount(input.adjustment<0n?-input.adjustment:input.adjustment)
  const days=(Date.parse(input.endDate)-Date.parse(input.startDate))/86400000+1
  if(days<1||days>366)throw new OperationsError('DATE','A tax year must contain between 1 and 366 days.')
  const [pool]=await executor.execute<CcaPool>(sql`SELECT id::text,name,class_code,rate_bp,calculation,opening_ucc::text,start_date::text,version FROM asset_cca_pool WHERE ledger_id=${ledgerId}::uuid AND id=${input.poolId}::uuid`)
  if(!pool)throw new OperationsError('POOL','Choose a pool in this ledger.')
  const [previous]=await executor.execute<{end_date:string;closing_ucc:string}>(sql`SELECT end_date::text,closing_ucc::text FROM asset_cca_year WHERE pool_id=${input.poolId}::uuid ORDER BY end_date DESC LIMIT 1`)
  const expectedStart=previous?dayAfter(previous.end_date):pool.start_date
  if(input.startDate!==expectedStart)throw new OperationsError('CCA_YEAR',`The next tax year must start on ${expectedStart}.`)
  const assignments=await executor.execute<CcaAssignment>(sql`SELECT x.id::text,x.asset_id::text,x.tax_cost::text,x.available_on::text,x.first_year_rule,x.eligibility_note,x.disposed_on::text,x.proceeds::text,x.version,a.acquired_on::text FROM asset_cca_assignment x JOIN fixed_asset a ON a.id=x.asset_id WHERE x.pool_id=${input.poolId}::uuid ORDER BY x.id`)
  const additions=assignments.filter(a=>a.available_on>=input.startDate&&a.available_on<=input.endDate).map(a=>({cost:BigInt(a.tax_cost),acquiredOn:a.acquired_on,availableOn:a.available_on,rule:a.first_year_rule}))
  const disposals=assignments.filter(a=>a.disposed_on&&a.disposed_on>=input.startDate&&a.disposed_on<=input.endDate).reduce((n,a)=>n+(BigInt(a.proceeds)<BigInt(a.tax_cost)?BigInt(a.proceeds):BigInt(a.tax_cost)),0n)
  if(input.poolClosed&&assignments.some(a=>a.available_on<=input.endDate&&(!a.disposed_on||a.disposed_on>input.endDate)))throw new OperationsError('CCA_CLOSED','Dispose all assets in this pool before recording a terminal loss.')
  if(pool.calculation==='manual'&&input.manualMaximum===undefined)throw new OperationsError('CCA_MANUAL','Enter the reviewed maximum for this special class.')
  if(pool.calculation==='manual'&&input.poolClosed)throw new OperationsError('CCA_MANUAL','Special-class terminal loss and disposal rules require a reviewed basis adjustment; automatic terminal loss is unavailable.')
  const opening=BigInt(previous?.closing_ucc??pool.opening_ucc)
  const result=calculateCca({classCode:pool.class_code,rateBp:pool.rate_bp,opening,additions,disposals,adjustment:input.adjustment,days,poolClosed:input.poolClosed,manualMaximum:input.manualMaximum})
  if(pool.calculation==='manual'&&result.recapture>0n)throw new OperationsError('CCA_MANUAL','Review special-class disposal rules and enter the required basis adjustment before recording this year.')
  const facts:CcaYearInput={poolId:input.poolId,startDate:input.startDate,endDate:input.endDate,adjustment:input.adjustment,manualMaximum:input.manualMaximum,poolClosed:input.poolClosed}
  const snapshot={policy:CCA_POLICY,pool,input:facts,assignments,days,opening,disposals,...result}
  return {...result,pool,opening,disposals,days,hash:fingerprint(snapshot),snapshot}
}
export async function ccaPreview(ledgerId:string,input:CcaYearInput){return previewUsing(db,operationId(ledgerId),input)}
export async function recordCcaYear(me:UserRecord,ledgerId:string,input:CcaYearInput & {claim:bigint;note:string;key:string;expectedHash:string}) {
  operationId(input.key);operationAmount(input.claim)
  const note=operationText(input.note,'Tax review / adjustment reason',10000,true),requestHash=fingerprint({...input,note})
  return operationWrite(me,ledgerId,'/assets',async(tx,s)=>{
    const [prior]=await tx.execute<{id:string;request_hash:string}>(sql`SELECT id::text,request_hash FROM asset_cca_year WHERE ledger_id=${ledgerId}::uuid AND request_key=${input.key}::uuid`)
    if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This request was already used with different values.');return prior.id}
    const p=await previewUsing(tx,ledgerId,input)
    if(p.hash!==input.expectedHash)throw new OperationsError('STALE','The CCA preview changed. Reload and review before recording.')
    if(input.claim>p.maximum)throw new OperationsError('CCA_CLAIM','The claim cannot exceed the reviewed maximum.')
    const closing=p.basis-input.claim+p.recapture-p.terminalLoss
    const [year]=await tx.execute<{id:string}>(sql`INSERT INTO asset_cca_year(ledger_id,pool_id,start_date,end_date,opening_ucc,additions,disposals,basis_adjustment,maximum_cca,claimed_cca,recapture,terminal_loss,closing_ucc,note,calculation_snapshot,request_key,request_hash,created_by) VALUES(${ledgerId}::uuid,${input.poolId}::uuid,${input.startDate}::date,${input.endDate}::date,${p.opening},${p.additions},${p.disposals},${input.adjustment},${p.maximum},${input.claim},${p.recapture},${p.terminalLoss},${closing},${note},${JSON.stringify(p.snapshot,(_,v)=>typeof v==='bigint'?v.toString():v)}::jsonb,${input.key}::uuid,${requestHash},${s.email}) RETURNING id::text`)
    await tx.execute(sql`UPDATE asset_cca_pool SET version=version+1 WHERE id=${input.poolId}::uuid`)
    return year.id
  })
}

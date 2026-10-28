import 'server-only'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import type {UserRecord} from './users'
import {OperationsError,operationWrite,operationId,operationDate,operationText,operationAmount} from './operations-scope'
import {postEntryCore,type PostEntryLine,type SourceType} from './posting'
import {operationsReconciliation,operationsLatestDate,reconciliationHash} from './operations-reconciliation'
import type {OperationsSeat,FinanceSetting,FinanceAccount,FinancialInput,AssetGroup,FundingOption} from './operations-finance-types'
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x)

export async function ensureOperationsAccountsCore(tx:Tx,entityId:string,seat:OperationsSeat,actor:string) {
 try {await tx.execute(sql`SELECT ensure_operations_accounts(${entityId}::uuid,${seat},${actor})`)}
 catch(e){let cause:unknown=e;for(let i=0;i<8&&cause;i++){const message=cause instanceof Error?cause.message:'';if(message.startsWith('OPERATIONS_ACCOUNT_SETUP: '))throw new OperationsError('ACCOUNT_SETUP',message.slice(26));cause=(cause as {cause?:unknown}).cause}throw e}
}
export async function financeSetting(ledgerId:string,seat:OperationsSeat,on:Pick<Tx,'execute'>=db) {
 const [r]=await on.execute<FinanceSetting>(sql`SELECT id::text,seat,connected_on::text,funding_account_id::text,oci_account_id::text,equity_account_id::text,tax_rate_bp,tax_rate_note,cca_strategy,version FROM operations_finance_setting WHERE ledger_id=${operationId(ledgerId)}::uuid AND seat=${seat}`)
 return r??null
}
export async function financeAccounts(ledgerId:string,seat:OperationsSeat,on:Pick<Tx,'execute'>=db) {
 return on.execute<FinanceAccount>(sql`SELECT s.*,m.account_id::text,a.code||' — '||a.name account_label FROM ledger l
  CROSS JOIN operations_account_specs(${seat}) s LEFT JOIN operations_account m ON m.entity_id=l.entity_id AND m.seat=${seat} AND m.key=s.key
  LEFT JOIN account a ON a.id=m.account_id WHERE l.id=${operationId(ledgerId)}::uuid ORDER BY s.code`)
}
export function financialAccountOptions(ledgerId:string,on:Pick<Tx,'execute'>=db) {
 return on.execute<FundingOption>(sql`SELECT a.id::text,a.code||' — '||a.name label,a.account_type::text kind,
  coalesce((SELECT array_agg(role) FROM account_role WHERE account_id=a.id),'{}'::text[]) roles
  FROM account a JOIN ledger l ON l.entity_id=a.entity_id WHERE l.id=${operationId(ledgerId)}::uuid AND a.is_active AND a.is_postable AND cardinality(a.required_dimensions)=0
  AND NOT EXISTS(SELECT 1 FROM operations_account m JOIN operations_account_specs(m.seat) s ON s.key=m.key WHERE m.account_id=a.id AND s.controlled) ORDER BY a.code`)
}
export async function initializeOperationsFinance(me:UserRecord,ledgerId:string,seat:OperationsSeat) {
 return operationWrite(me,ledgerId,seat,async(tx,s)=>{await ensureOperationsAccountsCore(tx,s.entity_id,seat,s.email)})
}
export async function financialDay(tx:Tx,ledgerId:string,seat:OperationsSeat,date:string) {
 const setting=await financeSetting(ledgerId,seat,tx)
 if(setting?.connected_on&&operationDate(date)<setting.connected_on)throw new OperationsError('FINANCE_DATE',`Financial changes must be dated ${setting.connected_on} or later.`)
 return setting?.connected_on?setting:null
}
export async function requireFinanceConnected(ledgerId:string,seat:OperationsSeat) {
 const cfg=await financeSetting(ledgerId,seat)
 if(!cfg?.connected_on)throw new OperationsError('FINANCE_SETUP','Review the opening balances in Finance before recording financial business.')
 return cfg
}
export async function accountId(tx:Tx,ledgerId:string,seat:OperationsSeat,key:string) {
 const [r]=await tx.execute<{account_id:string}>(sql`SELECT m.account_id::text FROM operations_account m JOIN ledger l ON l.entity_id=m.entity_id WHERE l.id=${ledgerId}::uuid AND m.seat=${seat} AND m.key=${key}`)
 if(!r)throw new OperationsError('ACCOUNT_SETUP','Initialize the module accounts in Finance first.')
 return r.account_id
}
export async function reviewedCounterpart(tx:Tx,ledgerId:string,id:string|undefined,kinds:string[]= ['asset','liability','equity']) {
 if(!id)throw new OperationsError('FUNDING','Choose the account funding this business.')
 operationId(id)
 const [r]=await tx.execute<{account_type:string}>(sql`SELECT a.account_type::text FROM account a JOIN ledger l ON l.entity_id=a.entity_id
  WHERE l.id=${ledgerId}::uuid AND a.id=${id}::uuid AND a.is_active AND a.is_postable AND cardinality(a.required_dimensions)=0
   AND NOT EXISTS(SELECT 1 FROM operations_account m JOIN operations_account_specs(m.seat) s ON s.key=m.key WHERE m.account_id=a.id AND s.controlled) FOR SHARE OF a`)
 if(!r||!kinds.includes(r.account_type))throw new OperationsError('FUNDING','Choose an active posting account of the appropriate type, outside the controlled operations balances, without required dimensions.')
 return id
}
async function taxLines(tx:Tx,ledgerId:string,input:FinancialInput) {
 const tax=operationAmount(input.recoverableTax??0n)
 if(!tax){if(input.taxAccountId)throw new OperationsError('TAX','Enter recoverable tax when selecting its account.');return [] as PostEntryLine[]}
 const id=await reviewedCounterpart(tx,ledgerId,input.taxAccountId,['asset'])
 if(!(await tx.execute(sql`SELECT 1 FROM account_role WHERE account_id=${id}::uuid AND role IN ('gst_hst_recoverable','qst_pst_recoverable')`)).length)throw new OperationsError('TAX','Choose a GST/HST or PST/QST recoverable tax account.')
 return [{accountId:id,amount:tax}]
}
const sourceTypes:Record<string,SourceType>={opening:'operations_opening',asset_acquisition:'fixed_asset',asset_disposal:'fixed_asset',depreciation:'asset_depreciation',deferred_tax:'asset_deferred_tax',inventory:'inventory',production:'production'}
/** Exact immutable bridge: one source and one journal, committed together. */
export async function postOperationsEvent(tx:Tx,input:{ledgerId:string;seat:OperationsSeat;kind:keyof typeof sourceTypes;sourceId:string;date:string;actor:string;description:string;lines:PostEntryLine[];snapshot:unknown;movementId?:string;zeroReason?:string}) {
 const amounts=new Map<string,bigint>()
 for(const l of input.lines)amounts.set(l.accountId,(amounts.get(l.accountId)??0n)+l.amount)
 const lines=[...amounts].filter(([,n])=>n!==0n).map(([accountId,amount])=>({accountId,amount}))
 if(lines.reduce((n,l)=>n+l.amount,0n)!==0n)throw new OperationsError('BALANCE','The source journal is unbalanced.')
 const entry=lines.length?await postEntryCore(tx,{ledgerId:input.ledgerId,entryDate:input.date,description:input.description,sourceType:sourceTypes[input.kind],sourceId:input.sourceId,idempotencyKey:`operations:${input.ledgerId}:${input.kind}:${input.sourceId}`,actor:input.actor,lines}):null
 const [row]=await tx.execute<{id:string}>(sql`INSERT INTO operations_journal_event(ledger_id,seat,source_kind,source_id,event_date,entry_id,movement_id,lines,snapshot,no_entry_reason,created_by)
  VALUES(${input.ledgerId}::uuid,${input.seat},${input.kind},${input.sourceId}::uuid,${input.date}::date,${entry?.entry.id??null}::uuid,${input.movementId??null}::uuid,${json(lines)}::jsonb,${json(input.snapshot)}::jsonb,${entry?'':input.zeroReason??'No monetary change'},${input.actor}) RETURNING id::text`)
 return {id:row.id,entryId:entry?.entry.id??null}
}
export async function connectOperationsFinance(me:UserRecord,ledgerId:string,seat:OperationsSeat,input:{date:string;fundingAccountId:string;openingAccountId:string;expectedHash:string;taxRateBp:number;taxRateNote:string;ccaStrategy:'maximum'|'match_book';ociAccountId?:string;equityAccountId?:string}) {
 operationDate(input.date)
 if(!Number.isInteger(input.taxRateBp)||input.taxRateBp<0||input.taxRateBp>10000||!['maximum','match_book'].includes(input.ccaStrategy))throw new OperationsError('SETTINGS','Choose a valid tax rate and CCA strategy.')
 const note=operationText(input.taxRateNote,'Tax-rate basis',10000,seat==='/assets')
 return operationWrite(me,ledgerId,seat,async(tx,s)=>{
  await ensureOperationsAccountsCore(tx,s.entity_id,seat,s.email)
  if((await financeSetting(ledgerId,seat,tx))?.connected_on)throw new OperationsError('CONNECTED','This module is already connected. Reload Finance.')
  const latest=await operationsLatestDate(ledgerId,seat,tx)
  if(latest&&input.date<latest)throw new OperationsError('FINANCE_DATE',`Opening review must be on or after the latest recorded business date, ${latest}.`)
  if(seat==='/assets'){
   const {transactionAssets,planDepreciation}=await import('./depreciation')
   const before=new Date(Date.parse(input.date+'T00:00:00Z')-86400000).toISOString().slice(0,10)
   if((await transactionAssets(tx,ledgerId)).some(a=>planDepreciation(a,before).length))throw new OperationsError('DEPRECIATION_PENDING','Complete the existing book register through the month before connection in Review depreciation, then refresh opening balances. Those opening-register entries do not post a second historic journal.')
  }
  const rows=await operationsReconciliation(ledgerId,seat,input.date,tx)
  if(reconciliationHash(rows,input.date,latest)!==input.expectedHash)throw new OperationsError('STALE','Opening balances changed. Refresh and review the differences again.')
  const funding=await reviewedCounterpart(tx,ledgerId,input.fundingAccountId)
  const opening=await reviewedCounterpart(tx,ledgerId,input.openingAccountId,['equity','liability','asset'])
  if(input.ociAccountId)await reviewedCounterpart(tx,ledgerId,input.ociAccountId,['equity'])
  if(input.equityAccountId)await reviewedCounterpart(tx,ledgerId,input.equityAccountId,['equity'])
  const snapshot={date:input.date,latest,rows,openingAccountId:opening}
  const [cfg]=await tx.execute<{id:string}>(sql`INSERT INTO operations_finance_setting(ledger_id,seat,connected_on,connected_at,funding_account_id,oci_account_id,equity_account_id,tax_rate_bp,tax_rate_note,cca_strategy,opening_snapshot,created_by)
   VALUES(${ledgerId}::uuid,${seat},${input.date}::date,clock_timestamp(),${funding}::uuid,${input.ociAccountId??null}::uuid,${input.equityAccountId??null}::uuid,${input.taxRateBp},${note},${input.ccaStrategy},${json(snapshot)}::jsonb,${s.email}) RETURNING id::text`)
  if(seat==='/assets')await tx.execute(sql`INSERT INTO asset_ledger_assignment(ledger_id,asset_id,group_key,created_by)
   SELECT a.ledger_id,a.id,CASE WHEN lower(a.category)='land' THEN 'land' WHEN p.class_code='50' THEN 'computer' WHEN p.class_code IN ('10','10.1') THEN 'vehicle' WHEN p.class_code IN ('1','3','6') THEN 'building' ELSE 'machinery' END,${s.email}
   FROM fixed_asset a LEFT JOIN asset_cca_assignment x ON x.asset_id=a.id LEFT JOIN asset_cca_pool p ON p.id=x.pool_id WHERE a.ledger_id=${ledgerId}::uuid ON CONFLICT(ledger_id,asset_id) DO NOTHING`)
  const lines=rows.map(r=>({accountId:r.account_id!,amount:BigInt(r.difference)}))
  lines.push({accountId:opening,amount:-lines.reduce((n,l)=>n+l.amount,0n)})
  return postOperationsEvent(tx,{ledgerId,seat,kind:'opening',sourceId:cfg.id,date:input.date,actor:s.email,description:`${seat==='/assets'?'Fixed assets':'Inventory'} reviewed opening differences`,lines,snapshot,zeroReason:'Register values already agree with the general ledger'})
 })
}
export async function updateFinanceSettings(me:UserRecord,ledgerId:string,seat:OperationsSeat,input:{version:number;fundingAccountId:string;taxRateBp:number;taxRateNote:string;ccaStrategy:'maximum'|'match_book';ociAccountId:string;equityAccountId:string}) {
 if(!Number.isInteger(input.taxRateBp)||input.taxRateBp<0||input.taxRateBp>10000||!['maximum','match_book'].includes(input.ccaStrategy))throw new OperationsError('SETTINGS','Choose a valid tax rate and CCA strategy.')
 const note=operationText(input.taxRateNote,'Tax-rate basis',10000,seat==='/assets')
 return operationWrite(me,ledgerId,seat,async tx=>{
  const old=await financeSetting(ledgerId,seat,tx);if(!old?.connected_on)throw new OperationsError('FINANCE_SETUP','Connect the module first.')
  if(old.version!==input.version)throw new OperationsError('STALE','Settings changed. Reload before saving.')
  const funding=await reviewedCounterpart(tx,ledgerId,input.fundingAccountId)
  for(const id of [input.ociAccountId,input.equityAccountId])if(id)await reviewedCounterpart(tx,ledgerId,id,['equity'])
  await tx.execute(sql`UPDATE operations_finance_setting SET funding_account_id=${funding}::uuid,oci_account_id=${input.ociAccountId||null}::uuid,equity_account_id=${input.equityAccountId||null}::uuid,tax_rate_bp=${input.taxRateBp},tax_rate_note=${note},cca_strategy=${input.ccaStrategy},version=version+1 WHERE id=${old.id}::uuid`)
 })
}
export async function postAssetAcquisition(tx:Tx,ledgerId:string,assetId:string,group:AssetGroup,input:FinancialInput & {requestKey?:string},actor:string,requestHash?:string) {
 const [a]=await tx.execute<{acquisition_cost:string;acquired_on:string;code:string}>(sql`SELECT acquisition_cost::text,acquired_on::text,code FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND id=${assetId}::uuid`)
 const cfg=await financialDay(tx,ledgerId,'/assets',a.acquired_on);if(!cfg)return
 const funding=await reviewedCounterpart(tx,ledgerId,input.counterpartAccountId??cfg.funding_account_id??undefined)
 await tx.execute(sql`INSERT INTO asset_ledger_assignment(ledger_id,asset_id,group_key,funding_account_id,created_by) VALUES(${ledgerId}::uuid,${assetId}::uuid,${group},${funding}::uuid,${actor})`)
 const tax=await taxLines(tx,ledgerId,input),cost=BigInt(a.acquisition_cost)
 await postOperationsEvent(tx,{ledgerId,seat:'/assets',kind:'asset_acquisition',sourceId:assetId,date:a.acquired_on,actor,description:`Asset ${a.code} acquisition`,lines:[{accountId:await accountId(tx,ledgerId,'/assets',group),amount:cost},...tax,{accountId:funding,amount:-cost-tax.reduce((n,l)=>n+l.amount,0n)}],snapshot:{assetId,group,input,requestKey:input.requestKey,requestHash}})
}
export async function postAssetDisposal(tx:Tx,ledgerId:string,assetId:string,input:FinancialInput,actor:string) {
 const [a]=await tx.execute<{code:string;acquisition_cost:string;disposed_on:string;disposal_proceeds:string;group_key:AssetGroup;accum:string}>(sql`SELECT a.code,a.acquisition_cost::text,a.disposed_on::text,a.disposal_proceeds::text,x.group_key,coalesce((SELECT sum(amount) FROM asset_depreciation_entry WHERE asset_id=a.id),0)::text accum FROM fixed_asset a JOIN asset_ledger_assignment x ON x.asset_id=a.id WHERE a.ledger_id=${ledgerId}::uuid AND a.id=${assetId}::uuid`)
 if(!a?.disposed_on)return
 const cfg=await financialDay(tx,ledgerId,'/assets',a.disposed_on);if(!cfg)return
 const funding=await reviewedCounterpart(tx,ledgerId,input.counterpartAccountId??cfg.funding_account_id??undefined)
 const cost=BigInt(a.acquisition_cost),accum=BigInt(a.accum),proceeds=BigInt(a.disposal_proceeds)
 const lines:PostEntryLine[]=[{accountId:await accountId(tx,ledgerId,'/assets',a.group_key),amount:-cost},{accountId:funding,amount:proceeds},{accountId:await accountId(tx,ledgerId,'/assets','disposal'),amount:cost-accum-proceeds}]
 if(a.group_key!=='land')lines.push({accountId:await accountId(tx,ledgerId,'/assets',a.group_key+'_accumulated'),amount:accum})
 await postOperationsEvent(tx,{ledgerId,seat:'/assets',kind:'asset_disposal',sourceId:assetId,date:a.disposed_on,actor,description:`Asset ${a.code} disposal`,lines,snapshot:a})
}
export async function postAssetDepreciation(tx:Tx,ledgerId:string,id:string,actor:string) {
 const [e]=await tx.execute<{entry_date:string;amount:string;asset_id:string;group_key:AssetGroup}>(sql`SELECT e.entry_date::text,e.amount::text,e.asset_id::text,x.group_key FROM asset_depreciation_entry e JOIN asset_ledger_assignment x ON x.asset_id=e.asset_id WHERE e.ledger_id=${ledgerId}::uuid AND e.id=${id}::uuid`)
 if(!e)return
 if(!await financialDay(tx,ledgerId,'/assets',e.entry_date))return
 if(e.group_key==='land')throw new OperationsError('LAND','Land is not depreciable.')
 await postOperationsEvent(tx,{ledgerId,seat:'/assets',kind:'depreciation',sourceId:id,date:e.entry_date,actor,description:'Book amortization',lines:[{accountId:await accountId(tx,ledgerId,'/assets','depreciation'),amount:BigInt(e.amount)},{accountId:await accountId(tx,ledgerId,'/assets',e.group_key+'_accumulated'),amount:-BigInt(e.amount)}],snapshot:e})
}
export async function postDeferredTax(tx:Tx,ledgerId:string,id:string,actor:string) {
 const [r]=await tx.execute<{reporting_date:string;journal:{account:string;debit:string;credit:string}[];recognition:string}>(sql`SELECT reporting_date::text,journal,recognition FROM asset_deferred_tax_review WHERE ledger_id=${ledgerId}::uuid AND id=${id}::uuid`)
 const cfg=await financialDay(tx,ledgerId,'/assets',r.reporting_date);if(!cfg)return
 const counterpart=r.recognition==='profit_loss'?await accountId(tx,ledgerId,'/assets','deferred_expense'):await reviewedCounterpart(tx,ledgerId,(r.recognition==='oci'?cfg.oci_account_id:cfg.equity_account_id)??undefined,['equity'])
 const ids={'Deferred tax liability':await accountId(tx,ledgerId,'/assets','deferred_liability'),'Deferred tax asset':await accountId(tx,ledgerId,'/assets','deferred_asset')}
 const lines=r.journal.map(l=>({accountId:ids[l.account as keyof typeof ids]??counterpart,amount:BigInt(l.debit)-BigInt(l.credit)}))
 await postOperationsEvent(tx,{ledgerId,seat:'/assets',kind:'deferred_tax',sourceId:id,date:r.reporting_date,actor,description:'Annual deferred income tax review',lines,snapshot:r,zeroReason:'Reviewed deferred tax balances have no change'})
}
async function stockAccount(tx:Tx,ledgerId:string,itemId:string) {
 const [i]=await tx.execute<{kind:string}>(sql`SELECT kind FROM inventory_item WHERE ledger_id=${ledgerId}::uuid AND id=${itemId}::uuid`)
 if(!i)throw new OperationsError('ITEM','Choose an item in this ledger.')
 return accountId(tx,ledgerId,'/inventory',i.kind==='work_in_progress'?'wip':i.kind)
}
export async function postStockMovement(tx:Tx,ledgerId:string,id:string,input:FinancialInput,actor:string) {
 const [m]=await tx.execute<{movement_date:string;kind:string;cost:string;item_id:string;sequence:string}>(sql`SELECT movement_date::text,kind,cost::text,item_id::text,sequence::text FROM inventory_movement WHERE ledger_id=${ledgerId}::uuid AND id=${id}::uuid`)
 const cfg=await financialDay(tx,ledgerId,'/inventory',m.movement_date);if(!cfg)return
 const cost=BigInt(m.cost),stock=await stockAccount(tx,ledgerId,m.item_id),lines:PostEntryLine[]=[]
 if(m.kind==='receipt'){
  const funding=await reviewedCounterpart(tx,ledgerId,input.counterpartAccountId??cfg.funding_account_id??undefined),tax=await taxLines(tx,ledgerId,input)
  lines.push({accountId:stock,amount:cost},...tax,{accountId:funding,amount:-cost-tax.reduce((n,l)=>n+l.amount,0n)})
 }else if(m.kind!=='transfer'){
  if((input.recoverableTax??0n)!==0n||input.taxAccountId)throw new OperationsError('TAX','Recoverable tax belongs to a receipt.')
  const expense=input.counterpartAccountId?await reviewedCounterpart(tx,ledgerId,input.counterpartAccountId,['expense']):await accountId(tx,ledgerId,'/inventory',m.kind==='issue'?'cogs':'adjustment')
  const signed=m.kind==='adjust_in'?cost:-cost
  lines.push({accountId:stock,amount:signed},{accountId:expense,amount:-signed})
 }else if(input.counterpartAccountId||(input.recoverableTax??0n)!==0n||input.taxAccountId)throw new OperationsError('TRANSFER','A warehouse transfer does not change financial stage value.')
 await postOperationsEvent(tx,{ledgerId,seat:'/inventory',kind:'inventory',sourceId:id,date:m.movement_date,actor,description:`Stock movement ${m.sequence}`,lines,snapshot:{movement:m,input},movementId:id,zeroReason:m.kind==='transfer'?'Warehouse transfer preserves aggregate stage value':'Zero recorded cost'})
}
export async function postProductionEvent(tx:Tx,ledgerId:string,id:string,input:FinancialInput,actor:string) {
 const [e]=await tx.execute<{event_date:string;kind:string;cost:string;item_id:string|null;movement_id:string|null;order_id:string}>(sql`SELECT event_date::text,kind,cost::text,item_id::text,movement_id::text,order_id::text FROM production_event WHERE ledger_id=${ledgerId}::uuid AND id=${id}::uuid`)
 const cfg=await financialDay(tx,ledgerId,'/inventory',e.event_date);if(!cfg)return
 const wip=await accountId(tx,ledgerId,'/inventory','wip'),cost=BigInt(e.cost),lines:PostEntryLine[]=[]
 if(['material_issue','material_return','completion'].includes(e.kind)){
  const stock=await stockAccount(tx,ledgerId,e.item_id!),amount=e.kind==='material_issue'?cost:-cost
  lines.push({accountId:wip,amount},{accountId:stock,amount:-amount})
 }else if(e.kind==='conversion_cost'||e.kind==='labour_return'){
  const counterpart=await reviewedCounterpart(tx,ledgerId,input.counterpartAccountId??cfg.funding_account_id??undefined,e.kind==='labour_return'?['expense']:['asset','liability','equity','expense'])
  const amount=e.kind==='conversion_cost'?cost:-cost
  lines.push({accountId:wip,amount},{accountId:counterpart,amount:-amount})
 }else if(e.kind==='loss')lines.push({accountId:wip,amount:-cost},{accountId:await accountId(tx,ledgerId,'/inventory','adjustment'),amount:cost})
 if((input.recoverableTax??0n)!==0n||input.taxAccountId)throw new OperationsError('TAX','Production conversion uses capitalizable cost only; enter recoverable tax in the original purchase.')
 await postOperationsEvent(tx,{ledgerId,seat:'/inventory',kind:'production',sourceId:id,date:e.event_date,actor,description:`Production ${e.kind.replaceAll('_',' ')}`,lines,snapshot:{event:e,input},movementId:e.movement_id??undefined,zeroReason:e.kind==='cancel'?'Order cancelled without remaining materials or WIP':'Zero recorded cost or transfer within WIP'})
}

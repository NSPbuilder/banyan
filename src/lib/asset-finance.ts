import 'server-only'
import {createHash} from 'node:crypto'
import {sql} from 'drizzle-orm'
import type {UserRecord} from './users'
import type {AssetInput} from './asset-types'
import {operationWrite,operationId,OperationsError} from './operations-scope'
import {saveAssetInTransaction} from './assets'
import {saveDepreciationPolicyInTransaction,recordDisposalDepreciation} from './depreciation'
import {saveCcaAssignmentInTransaction,assetCcaPool} from './cca'
import {financeSetting,postAssetAcquisition,postAssetDisposal} from './operations-finance'
import type {AssetFinancialInput} from './operations-finance-types'
import type {CcaAssignment} from './depreciation-types'
type BookInput=Omit<Parameters<typeof saveDepreciationPolicyInTransaction>[2],'assetId'>
type TaxInput=Omit<Parameters<typeof saveCcaAssignmentInTransaction>[2],'assetId'|'poolId'> & {poolId?:string}
/** One authorized transaction: a refused financial policy leaves no orphan asset. */
export function saveAssetFinance(me:UserRecord,ledgerId:string,input:AssetInput,book?:BookInput,tax?:TaxInput,finance?:AssetFinancialInput){
  return operationWrite(me,ledgerId,'/assets',async(tx,s)=>{
    const requestKey=!input.id?finance?.requestKey:undefined
    const requestHash=requestKey?createHash('sha256').update(JSON.stringify({input,book,tax,finance},(_,v)=>typeof v==='bigint'?v.toString():v)).digest('hex'):undefined
    if(requestKey){operationId(requestKey)
      const [prior]=await tx.execute<{source_id:string;request_hash:string}>(sql`SELECT source_id::text,snapshot->>'requestHash' request_hash FROM operations_journal_event WHERE ledger_id=${ledgerId}::uuid AND source_kind='asset_acquisition' AND snapshot->>'requestKey'=${requestKey}`)
      if(prior){if(prior.request_hash!==requestHash)throw new OperationsError('REPLAY','This asset request was already used with different values.');return prior.source_id}
    }
    const cfg=await financeSetting(ledgerId,'/assets',tx)
    if(cfg?.connected_on&&!input.id){
      if(!finance||!book||finance.group!=='land'&&!tax)throw new OperationsError('POLICY','A new financed asset needs its account group, book method/useful life and CCA class.')
      if(!['land','building','machinery','vehicle','computer'].includes(finance.group))throw new OperationsError('GROUP','Choose an asset account group.')
      if(finance.group==='land'&&(book.method!=='none'||tax))throw new OperationsError('LAND','Land uses no book depreciation and is nondepreciable for CCA.')
    }
    const [before]=input.id?await tx.execute<{disposed_on:string|null}>(sql`SELECT disposed_on::text FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND id=${input.id}::uuid`):[]
    const id=await saveAssetInTransaction(tx,ledgerId,input)
    if(book)await saveDepreciationPolicyInTransaction(tx,ledgerId,{...book,assetId:id})
    if(tax){const poolId=tax.poolId??await assetCcaPool(tx,ledgerId,finance?.ccaClass??'',input.acquiredOn,input.code)
      if(cfg?.connected_on&&!input.id){const [p]=await tx.execute<{class_code:string}>(sql`SELECT class_code FROM asset_cca_pool WHERE ledger_id=${ledgerId}::uuid AND id=${poolId}::uuid`);if(!p||p.class_code!==finance?.ccaClass)throw new OperationsError('CCA_CLASS','The selected pool must match the asset’s CCA class.')}
      await saveCcaAssignmentInTransaction(tx,ledgerId,{...tax,poolId,assetId:id})}
    if(cfg?.connected_on&&!input.id)await postAssetAcquisition(tx,ledgerId,id,finance!.group,finance!,s.email,requestHash)
    if(cfg?.connected_on&&input.disposedOn&&!before?.disposed_on){
      if(input.id&&!tax){const [x]=await tx.execute<CcaAssignment>(sql`SELECT pool_id::text,version,tax_cost::text,available_on::text,first_year_rule,eligibility_note FROM asset_cca_assignment WHERE asset_id=${id}::uuid`)
        if(x)await saveCcaAssignmentInTransaction(tx,ledgerId,{assetId:id,poolId:x.pool_id,version:x.version,taxCost:BigInt(x.tax_cost),availableOn:x.available_on,rule:x.first_year_rule,eligibilityNote:x.eligibility_note,disposedOn:input.disposedOn,proceeds:input.disposalProceeds})}
      await recordDisposalDepreciation(tx,ledgerId,id,input.disposedOn,s.email)
      await postAssetDisposal(tx,ledgerId,id,finance??{},s.email)
    }
    return id
  })
}

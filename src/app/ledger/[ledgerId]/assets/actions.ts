'use server'
import { revalidatePath } from 'next/cache'
import type { FormState } from '@/app/actions'
import { requireLedger } from '@/lib/gate'
import { parseMoney } from '@/lib/money'
import { addAssetActivity, type AssetStatus } from '@/lib/assets'
import {saveDepreciationPolicy,adjustDepreciation,runDepreciation} from '@/lib/depreciation'
import {saveCcaPool,saveCcaAssignment,recordCcaYear} from '@/lib/cca'
import type {DepreciationMethod,CcaRule} from '@/lib/depreciation-types'
import {saveAssetFinance} from '@/lib/asset-finance'
import {recordDeferredTaxReview} from '@/lib/deferred-tax'
import type {TaxRecognition} from '@/lib/deferred-tax-types'
import { OperationsError } from '@/lib/operations-scope'
import {requireFinanceConnected} from '@/lib/operations-finance'
import {operationsFinanceError} from '@/lib/operations-finance-actions'
import type {AssetGroup} from '@/lib/operations-finance-types'
const g=(f:FormData,k:string)=>String(f.get(k)??'').trim()
const error=(e:unknown):FormState=>({error:e instanceof Error&&String((e as Error & {cause?:{message?:string}}).cause?.message??e.message).includes('BOOK_TAX_REVIEW_HISTORY')?'Book facts through a recorded tax review are fixed. Use a later dated book entry or a reviewed basis adjustment.':e instanceof OperationsError?e.message:e instanceof Error&&!('cause' in e)?e.message.split('\n')[0].slice(0,250):'Unable to save this record. Reload and review the fields before trying again.'})
export async function saveAssetAction(_prev:FormState,f:FormData):Promise<FormState> {
  const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/assets')
  try {
    if(!g(f,'assetId')||g(f,'disposedOn'))await requireFinanceConnected(ledgerId,'/assets')
    if(f.has('taxEnabled')&&!g(f,'taxCost'))throw new Error('Enter the CAD tax capital cost, including 0 when appropriate.')
    if(!g(f,'acquisitionCost'))throw new Error('Enter the acquisition cost, including 0 for a zero-cost asset.')
    const id=await saveAssetFinance(me,ledgerId,{id:g(f,'assetId')||undefined,version:Number(g(f,'version')),code:g(f,'code'),name:g(f,'name'),category:g(f,'category'),acquiredOn:g(f,'acquiredOn'),inServiceOn:g(f,'inServiceOn'),warrantyUntil:g(f,'warrantyUntil'),
      acquisitionCost:parseMoney(g(f,'acquisitionCost')),supplier:g(f,'supplier'),serialNumber:g(f,'serialNumber'),location:g(f,'location'),custodian:g(f,'custodian'),status:g(f,'status') as AssetStatus,disposedOn:g(f,'disposedOn'),disposalProceeds:parseMoney(g(f,'disposalProceeds')),notes:g(f,'notes')},!g(f,'assetId')&&f.has('bookEnabled')?{version:0,method:g(f,'bookMethod') as DepreciationMethod,startDate:g(f,'bookStart'),residualValue:parseMoney(g(f,'bookResidual')),lifeMonths:Number(g(f,'bookYears'))*12,annualRateBp:Number(parseMoney(g(f,'bookRate')||'20'))}:undefined,!g(f,'assetId')&&f.has('taxEnabled')?{poolId:g(f,'taxPool')||undefined,version:0,taxCost:parseMoney(g(f,'taxCost')),availableOn:g(f,'taxAvailable'),rule:g(f,'taxRule') as CcaRule,eligibilityNote:g(f,'taxNote'),disposedOn:g(f,'disposedOn'),proceeds:parseMoney(g(f,'disposalProceeds'))}:undefined,{group:g(f,'assetGroup') as AssetGroup,ccaClass:g(f,'taxClass'),requestKey:g(f,'requestKey')||undefined,counterpartAccountId:g(f,'counterpartAccountId')||undefined,recoverableTax:parseMoney(g(f,'recoverableTax')),taxAccountId:g(f,'taxAccountId')||undefined})
    revalidatePath(`/ledger/${ledgerId}`,'layout');revalidatePath(`/ledger/${ledgerId}/assets/${id}`)
    return {ok:g(f,'assetId')?'Asset updated.':'Asset added.'}
  }catch(e){return operationsFinanceError(e)}
}
export async function assetActivityAction(_prev:FormState,f:FormData):Promise<FormState> {
  const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/assets')
  try {
    await addAssetActivity(me,ledgerId,{assetId:g(f,'assetId'),date:g(f,'date'),kind:g(f,'kind'),note:g(f,'note'),cost:parseMoney(g(f,'cost')),key:g(f,'requestKey')})
    revalidatePath(`/ledger/${ledgerId}/assets/${g(f,'assetId')}`);return {ok:'Activity recorded.'}
  }catch(e){return error(e)}
}

const refresh=(ledgerId:string)=>revalidatePath(`/ledger/${ledgerId}`,'layout')
export async function depreciationPolicyAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/assets')
 try{await saveDepreciationPolicy(me,ledgerId,{assetId:g(f,'assetId'),version:Number(g(f,'version')),method:g(f,'method') as DepreciationMethod,startDate:g(f,'startDate'),residualValue:parseMoney(g(f,'residualValue')),lifeMonths:Number(g(f,'lifeMonths')||'60'),annualRateBp:Number(parseMoney(g(f,'annualRate')||'20')),revisionReason:g(f,'revisionReason')});refresh(ledgerId);return {ok:'Depreciation policy saved.'}}catch(e){return error(e)}
}
export async function depreciationAdjustAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/assets')
 try{await adjustDepreciation(me,ledgerId,{assetId:g(f,'assetId'),date:g(f,'date'),amount:parseMoney(g(f,'amount')),note:g(f,'note'),key:g(f,'requestKey')});refresh(ledgerId);return {ok:'Depreciation adjustment recorded; connected Finance posts its journal.'}}catch(e){return operationsFinanceError(e)}
}
export async function depreciationRunAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/assets')
 try{const count=await runDepreciation(me,ledgerId,{through:g(f,'through'),key:g(f,'requestKey'),expectedHash:g(f,'expectedHash')});refresh(ledgerId);return {ok:`Recorded ${count} monthly depreciation entries.`}}catch(e){return operationsFinanceError(e)}
}
export async function ccaPoolAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/assets')
 try{await saveCcaPool(me,ledgerId,{id:g(f,'poolId')||undefined,version:Number(g(f,'version')),name:g(f,'name'),classCode:g(f,'classCode'),rateBp:Number(parseMoney(g(f,'rate'))),calculation:g(f,'calculation') as 'standard'|'manual',openingUcc:parseMoney(g(f,'openingUcc')),startDate:g(f,'startDate')});refresh(ledgerId);return {ok:'CCA pool saved.'}}catch(e){return error(e)}
}
export async function ccaAssignmentAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/assets')
 try{if(!g(f,'taxCost'))throw new Error('Enter the CAD tax capital cost, including 0 when appropriate.');await saveCcaAssignment(me,ledgerId,{assetId:g(f,'assetId'),poolId:g(f,'poolId'),version:Number(g(f,'version')),taxCost:parseMoney(g(f,'taxCost')),availableOn:g(f,'availableOn'),rule:g(f,'rule') as CcaRule,eligibilityNote:g(f,'eligibilityNote'),disposedOn:g(f,'disposedOn'),proceeds:parseMoney(g(f,'proceeds'))});refresh(ledgerId);return {ok:'Asset tax assignment saved.'}}catch(e){return error(e)}
}
export async function ccaYearAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/assets')
 try{await recordCcaYear(me,ledgerId,{poolId:g(f,'poolId'),startDate:g(f,'startDate'),endDate:g(f,'endDate'),adjustment:parseMoney(g(f,'adjustment')),manualMaximum:g(f,'manualMaximum')?parseMoney(g(f,'manualMaximum')):undefined,poolClosed:f.has('poolClosed'),claim:parseMoney(g(f,'claim')),note:g(f,'note'),key:g(f,'requestKey'),expectedHash:g(f,'expectedHash')});refresh(ledgerId);return {ok:'CCA tax year recorded.'}}catch(e){return error(e)}
}

export async function deferredTaxAction(_prev:FormState,f:FormData):Promise<FormState>{
 const ledgerId=g(f,'ledgerId'),me=await requireLedger(ledgerId,'/assets')
 try{await requireFinanceConnected(ledgerId,'/assets');await recordDeferredTaxReview(me,ledgerId,{ccaYearId:g(f,'ccaYearId'),rateBp:Number(g(f,'rateBp')),rateNote:g(f,'rateNote'),bookAdjustment:BigInt(g(f,'bookAdjustment')),taxAdjustment:BigInt(g(f,'taxAdjustment')),recognizedAsset:BigInt(g(f,'recognizedAsset')),openingLiability:BigInt(g(f,'openingLiability')),openingAsset:BigInt(g(f,'openingAsset')),recognition:g(f,'recognition') as TaxRecognition,scopeReviewed:f.has('scopeReviewed'),note:g(f,'note'),key:g(f,'requestKey'),expectedHash:g(f,'expectedHash')});refresh(ledgerId);return {ok:'Deferred tax review recorded and its balance adjustment posted.'}}catch(e){return operationsFinanceError(e)}
}

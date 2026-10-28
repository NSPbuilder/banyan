'use server'
import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { redirect,unstable_rethrow } from 'next/navigation'
import { requireLedger,SESSION_COOKIE } from '@/lib/gate'
import { planningActor } from '@/lib/planning-access'
import { ImportError,importAmount } from '@/lib/import-csv'
import { proofFrom } from '@/lib/edit-proof'
import { EditConflict } from '@/lib/edit-leases'
import { beginImport,uploadImportFile,mapImport,validateImport,reviseImport,approveImport,runImportBatch,activateImport,cancelImportDraft } from '@/lib/ledger-import'
import { createBudget,previewBudget,applyBudgetPreview,changeBudgetState } from '@/lib/budgets'
import type { ImportFormat,ImportFileKind,ImportMode } from '@/lib/import-types'
import type { BudgetOperation } from '@/lib/budget-types'
import type { FormState } from './actions'
import { addDays } from '@/lib/recurrence-calendar'
export type PlanningState=FormState&{preview?:Awaited<ReturnType<typeof previewBudget>>}
export async function planningAction(_previous:PlanningState,f:FormData):Promise<PlanningState> {
 const get=(k:string)=>String(f.get(k)??'').trim(),ledgerId=get('ledgerId'),id=get('id'),command=get('command'),isBudget=command.startsWith('budget_'),seat=isBudget?'/reports':'/opening'
 if(!/^[0-9a-f-]{36}$/i.test(ledgerId)||id&&!/^[0-9a-f-]{36}$/i.test(id))return {error:'Choose an available company and document.'}
 await requireLedger(ledgerId,seat)
 const sessionToken=(await cookies()).get(SESSION_COOKIE)?.value??'',actor=planningActor(sessionToken),edit={sessionToken,proof:proofFrom(f),leaseRequired:true}
 const base=`/ledger/${ledgerId}${isBudget?'/reports/budgets':'/opening/migration'}`
 let result:{version?:string}|undefined,destination:string|undefined,notice='Saved. Review the current status.'
 try {
  switch(command) {
   case 'import_start': {
    const mode=get('mode') as ImportMode,cutoff=mode==='opening'?addDays(get('firstBusinessDay'),-1):get('cutoffDate')
    const run=await beginImport(ledgerId,actor,{mode,sourceSystem:get('sourceSystem'),sourceCompany:get('sourceCompany'),fromDate:mode==='opening'?cutoff:get('fromDate'),cutoffDate:cutoff,clearingAccountId:get('clearingAccountId')});destination=base+'/'+run.id;break
   }
   case 'import_upload': {
    const file=f.get('file');if(!(file instanceof File)||!file.size||file.size>8*1024*1024)throw new ImportError('FILE','Choose a UTF-8 CSV no larger than 8 MB.')
    const format=JSON.parse(get('format')) as ImportFormat
    result=await uploadImportFile(ledgerId,id,actor,edit,{kind:get('kind') as ImportFileKind,filename:file.name,bytes:Buffer.from(await file.arrayBuffer()),format});break
   }
   case 'import_map':result=await mapImport(ledgerId,id,actor,edit,{accounts:[...f].filter(([k,v])=>k.startsWith('account:')&&String(v)).map(([k,v])=>({source:k.slice(8),target:String(v)})),parties:[...f].filter(([k,v])=>k.startsWith('party:')&&String(v)).map(([k,v])=>({source:k.slice(6),target:String(v)}))});break
   case 'import_validate': {const v=await validateImport(ledgerId,id,actor,edit);result=v;notice=v.valid?'Validated. Review the source rows, opening delta and coverage before approval.':'Validation found blocking errors. Review the source-row report.';break}
   case 'import_revise':result=await reviseImport(ledgerId,id,actor,edit);break
   case 'import_cancel':result=await cancelImportDraft(ledgerId,id,actor,edit);break
   case 'import_approve':if(get('reviewed')!=='on')throw new ImportError('REVIEW','Confirm that you reviewed the source digest, coverage and opening delta.');result=await approveImport(ledgerId,id,actor,edit,get('digest'));break
   case 'import_batch':result=await runImportBatch(ledgerId,id,actor,edit,get('restoredReviewed')==='on'?get('digest'):undefined);break
   case 'import_activate':if(get('reconciled')!=='on')throw new ImportError('REVIEW','Confirm that you reviewed the zero-difference reconciliation and partial coverage.');result=await activateImport(ledgerId,id,actor,edit,get('digest'));break
   case 'budget_create':{const b=await createBudget(ledgerId,actor,{name:get('name'),fiscalYearId:get('fiscalYearId'),copyFromId:get('copyFromId')||undefined});destination=base+'/'+b.id;break}
   case 'budget_preview': {
    let operation:BudgetOperation
    switch(get('operationKind')) {
     case 'manual':operation={kind:'manual',cells:[...f].filter(([k,v])=>k.startsWith('cell:')&&String(v).trim()!=='').map(([k,v])=>{const [accountId,periodId]=k.slice(5).split(':');return {accountId,periodId,amount:String(importAmount(String(v).trim(),'decimal_dot'))}})};break
     case 'spread':operation={kind:'spread',accountId:get('adjustAccount'),annualAmount:String(importAmount(get('annualAmount'),'decimal_dot'))};break
     case 'percent':operation={kind:'percent',accountIds:f.getAll('adjustAccounts').map(String),periodIds:f.getAll('adjustPeriods').map(String),basisPoints:Number(importAmount(get('percent'),'decimal_dot'))};break
     case 'prefill':operation={kind:'prefill'};break
     case 'copy':operation={kind:'copy',sourceBudgetId:get('sourceBudgetId')};break
     default:throw new ImportError('OPERATION','Choose the budget operation to preview.')
    }
    return {preview:await previewBudget(ledgerId,id,actor,operation)}
   }
   case 'budget_apply':if(get('confirmOverwrite')!=='on')throw new ImportError('REVIEW','Confirm the displayed cell changes and overwrite count.');result=await applyBudgetPreview(ledgerId,id,actor,edit,JSON.parse(get('previewOperation')) as BudgetOperation,get('previewDigest'));break
   case 'budget_publish':result=await changeBudgetState(ledgerId,id,actor,edit,'published');break
   case 'budget_archive':result=await changeBudgetState(ledgerId,id,actor,edit,'archived');break
   default:throw new ImportError('COMMAND','Choose a supported migration or budget action.')
  }
 }catch(error){unstable_rethrow(error);return {error:error instanceof ImportError||error instanceof EditConflict?error.message:'The operation was refused. Review source fields, current periods and company setup; the current batch was not committed.',...(isBudget&&_previous.preview?{preview:_previous.preview}:{})}}
 revalidatePath(`/ledger/${ledgerId}`,'layout')
 if(destination)redirect(destination)
 return {ok:notice,version:result?.version}
}

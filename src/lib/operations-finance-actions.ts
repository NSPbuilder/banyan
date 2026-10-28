import 'server-only'
import {revalidatePath} from 'next/cache'
import type {UserRecord} from './users'
import type {FormState} from '@/app/actions'
import type {OperationsSeat} from './operations-finance-types'
import {initializeOperationsFinance,connectOperationsFinance,updateFinanceSettings} from './operations-finance'
import {parseMoney} from './money'
import {causesOf} from './db-errors'
const g=(f:FormData,k:string)=>String(f.get(k)??'').trim()
export function operationsFinanceError(e:unknown):FormState {
 const text=causesOf(e,6,' | ')
 if(/OPERATIONS_CONTROL_ACCOUNT|OPERATIONS_JOURNAL|OPERATIONS_FINANCIAL_HISTORY/.test(text))return {error:'Correct this business through its source workflow; the journal and recorded financial values must stay together.'}
 if(text.includes('OPERATIONS_RECONCILIATION'))return {error:'The business would leave a difference between the register and general ledger. Review Finance before saving.'}
 if(text.includes('PRODUCTION_LABOUR_PENDING'))return {error:'Allocate pending production time from confirmed payroll before completing output.'}
 if(text.includes('BOOK_TAX_REVIEW_HISTORY'))return {error:'Book facts through a recorded tax review are fixed. Use a later book entry or reviewed basis adjustment.'}
 return {error:e instanceof Error&&!('cause' in e)?e.message.split('\n')[0].slice(0,300):'Unable to save. Review the accounts, open fiscal periods and source records before trying again.'}
}
export async function financialSetupAction(me:UserRecord,ledgerId:string,seat:OperationsSeat,f:FormData,mode:'initialize'|'connect'|'settings'):Promise<FormState> {
 try{
  if(mode==='initialize')await initializeOperationsFinance(me,ledgerId,seat)
  else{
   const input={fundingAccountId:g(f,'fundingAccountId'),taxRateBp:Number(parseMoney(g(f,'taxRate')||'0')),taxRateNote:g(f,'taxRateNote'),ccaStrategy:(g(f,'ccaStrategy')||'maximum') as 'maximum'|'match_book',ociAccountId:g(f,'ociAccountId')||undefined,equityAccountId:g(f,'equityAccountId')||undefined}
   if(mode==='connect')await connectOperationsFinance(me,ledgerId,seat,{...input,date:g(f,'date'),openingAccountId:g(f,'openingAccountId'),expectedHash:g(f,'expectedHash')})
   else await updateFinanceSettings(me,ledgerId,seat,{...input,version:Number(g(f,'version')),ociAccountId:input.ociAccountId??'',equityAccountId:input.equityAccountId??''})
  }
  revalidatePath(`/ledger/${ledgerId}`,'layout')
  return {ok:mode==='initialize'?'GIFI-based module accounts are ready. Review opening balances below.':mode==='connect'?'Finance connected. Reviewed opening differences posted; future business saves post their journals.':'Financial settings saved.'}
 }catch(e){return operationsFinanceError(e)}
}

'use server'
import {cookies} from 'next/headers'
import {revalidatePath} from 'next/cache'
import {unstable_rethrow} from 'next/navigation'
import {requireLedger,SESSION_COOKIE} from '@/lib/gate'
import {requestActor,AutomationError} from '@/lib/automation-access'
import {IntegrationError} from '@/lib/integration-access'
import {saveCompanySmtp,saveCompanyReminderSchedule} from '@/lib/company-services'
import type {FormState} from '@/app/actions'
export async function companyServiceAction(_prev:FormState,f:FormData):Promise<FormState>{
  const get=(key:string)=>String(f.get(key)??'').trim(),ledgerId=get('ledgerId')
  await requireLedger(ledgerId,'/automation')
  const actor=requestActor((await cookies()).get(SESSION_COOKIE)?.value??'')
  try{
    if(get('command')==='smtp')await saveCompanySmtp(ledgerId,actor,{version:get('version'),senderEmail:get('senderEmail'),host:get('host'),port:Number(get('port')),secure:get('secure')==='true',username:get('username'),password:String(f.get('password')??''),clear:get('clear')==='on'})
    else if(get('command')==='schedule')await saveCompanyReminderSchedule(ledgerId,actor,{version:get('version'),days:get('days').split(',').map(d=>Number(d.trim())),startHour:Number(get('startHour')),endHour:Number(get('endHour'))})
    else throw new AutomationError('COMMAND','Choose a supported company setting.')
  }catch(error){unstable_rethrow(error);return {error:error instanceof AutomationError||error instanceof IntegrationError?error.message:'Settings could not be saved. Reload and check the current company configuration.'}}
  revalidatePath('/settings/services');revalidatePath('/settings');revalidatePath(`/ledger/${ledgerId}`,'layout')
  return {ok:'Company settings saved.'}
}

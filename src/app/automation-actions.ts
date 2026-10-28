'use server'
import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { redirect,unstable_rethrow } from 'next/navigation'
import { requireLedger,SESSION_COOKIE } from '@/lib/gate'
import { proofFrom } from '@/lib/edit-proof'
import { requestActor,configureAutomation,AutomationError,validId } from '@/lib/automation-access'
import { uploadInbox,reviewInbox } from '@/lib/inbox'
import { saveRecurring,generateOccurrence } from '@/lib/recurring'
import { createMailPreview,queueMail,saveReminder,togglePartyReminder } from '@/lib/mail'
import {incomeEmailPath,inboxPath} from '@/lib/workflow-links'
import { controlJob } from '@/lib/jobs'
import { EditConflict } from '@/lib/edit-leases'
import type { FormState } from './actions'
import type { DraftSnapshot } from '@/lib/automation-drafts'
import type { RecurrenceRule } from '@/lib/recurring'
import type { MailMessage } from '@/lib/mail'

export async function automationAction(_previous:FormState,f:FormData):Promise<FormState> {
  const get=(k:string)=>String(f.get(k)??'').trim(),ledgerId=get('ledgerId'),id=get('id')
  if(!validId(ledgerId)||id&&!validId(id))return {error:'Choose an available company and document.'}
  await requireLedger(ledgerId,'/automation')
  const sessionToken=(await cookies()).get(SESSION_COOKIE)?.value??'',actor=requestActor(sessionToken)
  const edit={sessionToken,proof:proofFrom(f),leaseRequired:true},base=`/ledger/${ledgerId}/automation`
  let destination:string|undefined,result:{version?:string}|undefined
  try {
    switch(get('command')) {
      case 'settings':await configureAutomation(ledgerId,actor,{version:get('version'),enabled:get('enabled')==='on',mailEnabled:get('mailEnabled')==='on',timezone:get('timezone'),senderEmail:get('senderEmail')});break
      case 'upload': {
        const file=f.get('file');if(!(file instanceof File)||!file.size)throw new AutomationError('FILE','Choose a PDF, JPEG or PNG receipt.')
        if(file.size>8*1024*1024)throw new AutomationError('FILE_SIZE','Choose a file up to 8 MB.')
        const item=await uploadInbox(ledgerId,actor,{name:file.name,type:file.type,bytes:Buffer.from(await file.arrayBuffer())},get('extract')==='on');destination=inboxPath(ledgerId,item.id);break
      }
      case 'review':result=await reviewInbox(ledgerId,id,actor,edit,f);break
      case 'recurring': {
        if(get('operation')==='generate'){result=await generateOccurrence(ledgerId,id,get('occurrence'),actor,edit);break}
        const saved=await saveRecurring(ledgerId,actor,{id:id||undefined,sourceId:get('sourceId'),documentType:get('documentType') as DraftSnapshot['type'],title:get('title'),
          rule:{frequency:get('frequency') as RecurrenceRule['frequency'],dayMode:get('dayMode') as RecurrenceRule['dayMode'],anchorDate:get('anchorDate'),dayOfMonth:Number(get('dayOfMonth'))},
          dueDays:Number(get('dueDays')),endDate:get('endDate')||undefined,maxOccurrences:get('maxOccurrences')?Number(get('maxOccurrences')):undefined,active:get('active')==='on'},id?edit:undefined)
        result='version' in saved?{version:saved.version as string}:undefined;if(!id)destination=base+'/recurring/'+saved.id;break
      }
      case 'generate':result=await generateOccurrence(ledgerId,id,get('occurrence'),actor,edit);break
      case 'preview': {
        const saved=await createMailPreview(ledgerId,actor,{kind:get('kind') as MailMessage['kind'],partyId:get('partyId'),invoiceId:get('invoiceId')||undefined,asOf:get('asOf'),periodFrom:get('periodFrom')||undefined,
          to:get('to'),cc:get('cc'),subject:get('subject'),body:get('body'),requestKey:get('requestKey'),parentId:get('parentId')||undefined,resendReason:get('resendReason')||undefined});destination=incomeEmailPath(ledgerId,saved.id);break
      }
      case 'send':await queueMail(ledgerId,id,actor);break
      case 'reminder-toggle':{const saved=await togglePartyReminder(ledgerId,get('partyId'),actor,get('enabled')==='on',id?edit:undefined);result='version' in saved?{version:saved.version as string}:undefined;break}
      case 'reminder': {
        const saved=await saveReminder(ledgerId,actor,{id:id||undefined,partyId:get('partyId'),enabled:get('enabled')==='on',paused:get('paused')==='on',reason:get('reason'),deferUntil:get('deferUntil')||undefined,
          days:get('days').split(',').map(v=>Number(v.trim())),startHour:Number(get('startHour')),endHour:Number(get('endHour')),usesCompanyDefaults:get('usesCompanyDefaults')==='on'},id?edit:undefined);result='version' in saved?{version:saved.version as string}:undefined;if(!id)destination=base+'/reminders/'+saved.id;break
      }
      case 'job':if(!['pause','retry'].includes(get('operation')))throw new AutomationError('OPERATION','Choose pause or retry.');await controlJob(ledgerId,id,actor,get('operation') as 'pause'|'retry');break
      default:throw new AutomationError('COMMAND','Choose a supported automation action.')
    }
  } catch(error) {
    unstable_rethrow(error)
    return {error:error instanceof AutomationError||error instanceof EditConflict?error.message:'The action could not be completed. Review the input and server configuration; the original record is retained.'}
  }
  revalidatePath(base,'layout')
  revalidatePath(`/ledger/${ledgerId}/income`,'layout');revalidatePath(`/ledger/${ledgerId}/parties`,'layout');revalidatePath('/settings/services')
  if(destination)redirect(destination)
  return {ok:'Saved. Review the current status and recorded target.',version:result?.version}
}

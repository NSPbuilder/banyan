'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { FormState } from '@/app/actions'
import { requireLedger, actorOf } from '@/lib/gate'
import { projectField as s, projectOptional as opt, projectLineRows, projectVersion, projectMoney } from '@/lib/project-forms'
import { createProject, updateProject, setProjectDeleted, saveProjectRecord, createProjectPayment, allocateProjectPayment, projectCompany, projectSentence, ProjectError } from '@/lib/project'
import { attachProjectFile, detachProjectFile, detachProjectPaymentFile } from '@/lib/project-attachments'
import { createProjectPartyFromForm } from '@/lib/project-party'
import { generateProjectInvoice } from '@/lib/project-invoices'
import { InvoiceError } from '@/lib/invoices'
import { InvoiceTemplateError } from '@/lib/invoice-templates'
import { projectFinanceOptions, projectFinanceLinks, saveProjectFinanceRecord, saveProjectFinancePayment, editProjectFinancePayment, allocateProjectFinancePayment, cancelProjectFinanceItem } from '@/lib/project-finance'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import type { UserRecord } from '@/lib/users'
import { ensureProjectAccounts,resolveProjectTaxAccounts } from '@/lib/project-accounts'

export async function generateProjectInvoiceAction(_prev:FormState,f:FormData):Promise<FormState> {
  const ledgerId=s(f,'ledgerId')
  const who=await requireLedger(ledgerId,'/projects')
  await requireLedger(ledgerId,'/invoices')
  let result:Awaited<ReturnType<typeof generateProjectInvoice>>
  try {
    result=await generateProjectInvoice(who,{ledgerId,projectId:s(f,'projectId'),recordId:s(f,'recordId'),version:projectVersion(f),
      issuedOn:s(f,'issuedOn'),dueOn:s(f,'dueOn'),controlAccountId:s(f,'controlAccountId'),
      template:opt(f,'template')})
  } catch(error) {
    return {error:error instanceof InvoiceError||error instanceof InvoiceTemplateError?error.message:projectSentence(error)}
  }
  revalidatePath(`/ledger/${ledgerId}/projects/${s(f,'projectId')}`)
  revalidatePath(`/ledger/${result.ledger_id}/invoices`)
  redirect(`/ledger/${result.ledger_id}/invoices/${result.invoice_id}`)
}

async function run(f:FormData,work:(base:{entityId:string;currency:string;actor:string},me:UserRecord)=>Promise<FormState>):Promise<FormState> {
  const ledgerId=s(f,'ledgerId')
  const who=await requireLedger(ledgerId,'/projects')
  try {
    const company=await projectCompany(ledgerId)
    const result=await work({entityId:company.id,currency:company.currency,actor:actorOf(who)},who)
    revalidatePath(`/ledger/${ledgerId}/projects`)
    const id=s(f,'projectId')
    if(id) revalidatePath(`/ledger/${ledgerId}/projects/${id}`)
    revalidatePath('/ledger/[ledgerId]/projects/[projectId]','page')
    for(const section of ['invoices','bills','expenses','income','entries'])revalidatePath(`/ledger/${ledgerId}/${section}`)
    return result
  } catch(error) { return {error:projectSentence(error)} }
}
export async function createProjectAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async base=>{
    await ensureProjectAccounts(base.entityId,base.actor)
    const id=await createProject({...base,code:s(f,'code'),name:s(f,'name'),customerPartyId:s(f,'customerPartyId'),site:opt(f,'site'),startDate:opt(f,'startDate'),endDate:opt(f,'endDate'),note:opt(f,'note')})
    return {ok:'Project created.',madeId:id}
  })
}
export async function createProjectPartyAction(_prev:FormState,f:FormData):Promise<FormState> {
  const ledgerId=s(f,'ledgerId')
  const who=await requireLedger(ledgerId,'/projects')
  try {
    const result=await createProjectPartyFromForm(f,actorOf(who))
    if(result.ok) {
      revalidatePath(`/ledger/${ledgerId}/projects`,'layout')
      revalidatePath(`/ledger/${ledgerId}/parties`)
    }
    return result
  } catch(error) {return {error:projectSentence(error)}}
}
export async function updateProjectAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async base=>{await updateProject({...base,projectId:s(f,'projectId'),version:projectVersion(f),name:s(f,'name'),site:opt(f,'site'),note:opt(f,'note'),status:s(f,'status')});return {ok:'Project updated.'}})
}
export async function deleteProjectAction(_prev:FormState,f:FormData):Promise<FormState> {
  const result=await run(f,async base=>{await setProjectDeleted({...base,projectId:s(f,'projectId'),version:projectVersion(f),deleted:true});return {ok:'Project deleted.'}})
  if(result.ok)redirect(`/ledger/${s(f,'ledgerId')}/projects`)
  return result
}
export async function restoreProjectAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async base=>{await setProjectDeleted({...base,projectId:s(f,'projectId'),version:projectVersion(f),deleted:false});return {ok:'Project restored.'}})
}
export async function saveProjectRecordAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async (base,me)=>{
    const kind=s(f,'kind')
    if(kind!=='revenue'&&kind!=='cost') throw new ProjectError('KIND','Choose revenue or cost.')
    const parsed=projectLineRows(f,kind)
    const payload:Parameters<typeof saveProjectRecord>[0]={...base,projectId:s(f,'projectId'),recordId:opt(f,'recordId'),version:opt(f,'recordId')?projectVersion(f):undefined,
      kind,partyId:opt(f,'partyId')||null,date:s(f,'date'),dueDate:opt(f,'dueDate'),reference:opt(f,'reference'),description:s(f,'description'),lines:parsed.map(r=>r.line),key:s(f,'submissionKey'),
      paid:s(f,'alreadyPaid')==='on'?{date:s(f,'paymentDate'),amount:opt(f,'paidAmount')?projectMoney(s(f,'paidAmount'),'Paid amount'):undefined,reference:opt(f,'paymentReference')}:undefined}
    const ledgerId=s(f,'ledgerId'),options=await projectFinanceOptions(me,ledgerId,base.entityId)
    const link=payload.recordId?(await projectFinanceLinks(base.entityId,payload.projectId)).find(l=>l.record_id===payload.recordId):undefined
    const integrated=!!link||!payload.recordId&&(kind==='revenue'?options.invoices:payload.paid?options.invoices||options.expenses:options.invoices)
    const paymentStages=f.has('paymentStages')?s(f,'paymentStages'):undefined
    if(paymentStages!==undefined&&(!integrated||kind!=='revenue'))throw new ProjectError('PAYMENT_STAGES','Payment stages apply to sales invoices only.')
    if(s(f,'accountingIntent')==='yes'&&!integrated)throw new ProjectError('NO_ACCESS','Accounting access changed. Refresh before saving; nothing was recorded.')
    const positions=f.getAll('linePosition').map(String)
    const originalPositions=f.has('linePosition')?parsed.map(r=>{
      const value=positions[r.index]
      if(value==='')return null
      if(!value||!/^[1-9]\d*$/.test(value)||Number(value)>200)throw new ProjectError('STALE_LINES','Reload this record before editing its lines.')
      return Number(value)
    }):undefined
    if(!integrated)resolveProjectTaxAccounts(options.taxAccounts,kind,payload.lines)
    const id=integrated?await saveProjectFinanceRecord(me,{...payload,ledgerId,originalPositions,controlAccountId:opt(f,'controlAccountId'),
      bankAccountId:opt(f,'bankAccountId'),paymentStages}):await saveProjectRecord(payload)
    let ok=kind==='revenue'?'Revenue record saved.':'Cost record saved.'
    if(integrated)ok=payload.paid?'Cost and payment posted.':payload.recordId?'Project and accounting record updated.':kind==='revenue'?'Revenue saved. Invoice posted.':'Cost saved. Purchase bill posted.'
    const file=f.get('file')
    if(file instanceof File && file.size) {
      try {if(file.size>20*1024*1024)throw new ProjectError('FILE','Choose a file up to 20 MB.');await attachProjectFile({...base,projectId:s(f,'projectId'),recordId:id,filename:file.name,mime:file.type,bytes:Buffer.from(await file.arrayBuffer())});ok+=' Supporting document archived.'}
      catch(error) {ok+=' The record is saved, but the file was not archived: '+projectSentence(error)+' Use Attachments to retry.'}
    }
    return {ok,madeId:id}
  })
}
export async function createProjectPaymentAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async (base,me)=>{
    const direction=s(f,'direction')
    if(direction!=='received'&&direction!=='paid') throw new ProjectError('DIRECTION','Choose Received or Paid.')
    const payload:Parameters<typeof createProjectPayment>[0]={...base,projectId:s(f,'projectId'),partyId:opt(f,'partyId')||null,direction,date:s(f,'date'),amount:projectMoney(s(f,'amount')),
      reference:opt(f,'reference'),note:opt(f,'note'),key:s(f,'submissionKey'),recordId:opt(f,'recordId'),allocation:opt(f,'allocation')?projectMoney(s(f,'allocation'),'Allocation amount'):undefined}
    const ledgerId=s(f,'ledgerId'),options=await projectFinanceOptions(me,ledgerId,base.entityId)
    const link=payload.recordId?(await projectFinanceLinks(base.entityId,payload.projectId)).find(l=>l.record_id===payload.recordId):undefined
    const integrated=!!link||!payload.recordId&&options.payments
    if(s(f,'accountingIntent')==='yes'&&!integrated)throw new ProjectError('NO_ACCESS','Accounting access changed. Refresh before saving; nothing was recorded.')
    const id=integrated?await saveProjectFinancePayment(me,{...payload,ledgerId,bankAccountId:s(f,'bankAccountId'),controlAccountId:opt(f,'controlAccountId')}):await createProjectPayment(payload)
    return {ok:direction==='received'?'Customer receipt recorded.':'Supplier payment recorded.',madeId:id}
  })
}
export async function allocateProjectPaymentAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async (base,me)=>{
    const payload={...base,projectId:s(f,'projectId'),paymentId:s(f,'paymentId'),recordId:s(f,'recordId'),amount:projectMoney(s(f,'amount')),key:s(f,'submissionKey')}
    const [managed]=await db.execute(sql`SELECT id FROM project_accounting_payment WHERE payment_id=${payload.paymentId}::uuid AND entity_id=${base.entityId}::uuid`)
    if(managed)await allocateProjectFinancePayment(me,{...payload,ledgerId:s(f,'ledgerId')})
    else await allocateProjectPayment(payload)
    return {ok:'Payment allocation recorded.'}
  })
}
export async function editProjectPaymentAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async (base,me)=>{
    const targets=f.getAll('allocationTarget').map(String),amounts=f.getAll('allocationAmount').map(String)
    if(targets.length!==amounts.length)throw new ProjectError('ALLOCATION','Allocation fields are incomplete. Reload before editing.')
    await editProjectFinancePayment(me,{...base,ledgerId:s(f,'ledgerId'),projectId:s(f,'projectId'),paymentId:s(f,'paymentId'),version:projectVersion(f),signature:s(f,'signature'),
      date:s(f,'date'),amount:projectMoney(s(f,'amount')),reference:opt(f,'reference'),note:opt(f,'note'),bankAccountId:opt(f,'bankAccountId'),controlAccountId:opt(f,'controlAccountId'),
      allocations:targets.map((target,i)=>({target,amount:projectMoney(amounts[i]||'0','Allocation amount')}))})
    return {ok:'Payment and balances updated.'}
  })
}
export async function voidProjectItemAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async (base,me)=>{
    const kind=s(f,'itemKind')
    if(kind!=='record'&&kind!=='payment'&&kind!=='allocation') throw new ProjectError('KIND','Choose an item to cancel.')
    await cancelProjectFinanceItem(me,{...base,ledgerId:s(f,'ledgerId'),projectId:s(f,'projectId'),id:s(f,'itemId'),kind,version:projectVersion(f),reason:s(f,'reason')})
    return {ok:'Entry cancelled.'}
  })
}
export async function attachProjectFileAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async base=>{
    const file=f.get('file')
    if(!(file instanceof File)||!file.size) throw new ProjectError('FILE','Choose a document to upload.')
    if(file.size>20*1024*1024)throw new ProjectError('FILE','Choose a file up to 20 MB.')
    await attachProjectFile({...base,projectId:s(f,'projectId'),recordId:opt(f,'recordId'),paymentId:opt(f,'paymentId'),filename:file.name,mime:file.type,bytes:Buffer.from(await file.arrayBuffer()),note:opt(f,'note')})
    return {ok:'Project document archived.'}
  })
}
export async function detachProjectFileAction(_prev:FormState,f:FormData):Promise<FormState> {
  return run(f,async base=>{
    const paymentId=opt(f,'paymentId')
    if(paymentId)await detachProjectPaymentFile(base.entityId,s(f,'projectId'),paymentId,s(f,'attachmentId'),base.actor)
    else await detachProjectFile(base.entityId,s(f,'projectId'),s(f,'attachmentId'),base.actor)
    return {ok:paymentId?'Attachment deleted.':'Attachment unlinked.'}
  })
}

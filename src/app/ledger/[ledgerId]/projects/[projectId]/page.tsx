import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { localToday } from '@/lib/today'
import { projectCompany, projectHead, projectParties, projectSummaries, projectRecords, projectPayments, projectAllocations, ProjectError } from '@/lib/project'
import { projectAttachments, projectStorageRoot, projectPaymentAttachments } from '@/lib/project-attachments'
import { ProjectDetail, projectActions } from '../ProjectScreen'
import { refuseForLedger } from '@/lib/access'
import { projectInvoiceLinks } from '@/lib/project-invoices'
import { projectFinanceOptions, projectFinanceLinks, withProjectPaymentEditing } from '@/lib/project-finance'

export const dynamic='force-dynamic'
export default async function ProjectPage({params,searchParams}:{params:Promise<{ledgerId:string;projectId:string}>;searchParams:Promise<Record<string,string|undefined>>}) {
  const {ledgerId,projectId}=await params
  const me=await requireLedger(ledgerId,'/projects')
  const company=await projectCompany(ledgerId)
  try {await projectHead(company.id,projectId)} catch(error) {if(error instanceof ProjectError)notFound();throw error}
  const q=await searchParams
  // Detail always shows the complete project; filtering remains in the list and exports.
  const [summaries,parties,records,payments,allocations,attachments]=await Promise.all([
    projectSummaries(company.id,{},projectId),projectParties(company.id),projectRecords(company.id,{},projectId),projectPayments(company.id,{},projectId),
    projectAllocations(company.id,projectId),projectAttachments(company.id,projectId),
  ])
  let storageReady=true;try{await projectStorageRoot()}catch{storageReady=false}
  const page=Math.min(Math.max(1,Number.parseInt(q.page||'1',10)||1),Math.max(1,Math.ceil(records.length/25)))
  if(!summaries[0])notFound()
  const mayGenerateInvoice=!(await refuseForLedger(me,ledgerId,'/invoices'))
  const invoiceLinks=mayGenerateInvoice?await projectInvoiceLinks(company.id,projectId):[]
  const finance=await projectFinanceOptions(me,ledgerId,company.id)
  const financeLinks=await projectFinanceLinks(company.id,projectId)
  const editablePayments=await withProjectPaymentEditing(company.id,projectId,payments)
  const paymentAttachmentErrors:Record<string,string>={}
  const paymentAttachments=Object.fromEntries(await Promise.all(payments.map(async pay=>{
    try{return [pay.id,await projectPaymentAttachments(company.id,projectId,pay.id)] as const}
    catch(error){if(!(error instanceof ProjectError))throw error;paymentAttachmentErrors[pay.id]=error.message;return [pay.id,[]] as const}
  })))
  return <ProjectDetail ledgerId={ledgerId} company={company} project={summaries[0]} parties={parties} records={records} payments={editablePayments} allocations={allocations} attachments={attachments} paymentAttachments={paymentAttachments} paymentAttachmentErrors={paymentAttachmentErrors} storageReady={storageReady} today={localToday()} actions={projectActions} page={page} mayGenerateInvoice={mayGenerateInvoice} invoiceLinks={invoiceLinks} finance={finance} financeLinks={financeLinks}/>
}

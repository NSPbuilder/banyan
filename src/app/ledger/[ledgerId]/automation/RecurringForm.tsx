'use client'
import { DateInput } from '@/components/DateInput'
import { useState } from 'react'
import { AutomationForm as ActionForm } from '@/components/AutomationForm'
import { EditLease } from '@/components/EditLease'
import { automationAction } from '@/app/automation-actions'
import { nextOccurrence,futureOccurrences,type RecurrenceRule } from '@/lib/recurrence-calendar'
import type { RecurringTemplate } from '@/lib/recurring'
import { BUTTON,FIELD,LABEL,QUIET } from '@/lib/ui'

export type RecurringSource={id:string;label:string;type:'sales'|'purchase'|'entry'}
export function RecurringForm({ledgerId,today,sources,template,lastDate}:{ledgerId:string;today:string;sources:RecurringSource[];template?:RecurringTemplate;lastDate?:string}) {
  const [type,setType]=useState(template?.document_type??'sales')
  const [rule,setRule]=useState<RecurrenceRule>({frequency:template?.frequency??'monthly',dayMode:template?.day_mode??'fixed',anchorDate:template?.anchor_date??today,dayOfMonth:template?.day_of_month??Number(today.slice(-2))})
  let dates:string[]=[],problem=''
  try{let first=nextOccurrence(rule),n=0;while(lastDate&&first<=lastDate){if(++n>100000)throw Error('Choose a newer start date.');first=nextOccurrence(rule,first)}dates=futureOccurrences(rule,first,6)}catch(error){problem=error instanceof Error?error.message:'Check the schedule.'}
  return <ActionForm action={automationAction}>
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="command" value="recurring"/>
    {template&&<><input type="hidden" name="id" value={template.id}/><EditLease resource={{ledgerId,type:'recurring',id:template.id}} version={template.version}/></>}
    <div className="mt-4 grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className={`${LABEL} sm:col-span-2`}>Title<input className={`${FIELD} w-full`} name="title" defaultValue={template?.title??''} required maxLength={200}/></label>
      <label className={LABEL}>Document type<select name="documentType" className={`${FIELD} w-full`} value={type} onChange={e=>setType(e.target.value as typeof type)} disabled={!!template}><option value="sales">Sales invoice draft</option><option value="purchase">Supplier bill draft</option><option value="entry">Manual journal draft</option></select>{template&&<input type="hidden" name="documentType" value={type}/>}</label>
      <label className={`${LABEL} sm:col-span-2 lg:col-span-3`}>{template?'Replace future draft fields from a source (optional)':'Source document'}<select key={type} name="sourceId" className={`${FIELD} w-full`} defaultValue="" required={!template}><option value="">{template?'Keep the saved template fields':'Choose a reviewed source in this ledger'}</option>{sources.filter(s=>s.type===type).map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
      <label className={LABEL}>Frequency<select name="frequency" className={`${FIELD} w-full`} value={rule.frequency} onChange={e=>setRule({...rule,frequency:e.target.value as RecurrenceRule['frequency'],dayMode:e.target.value==='weekly'?'fixed':rule.dayMode})}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select></label>
      <label className={LABEL}>Calendar rule<select name="dayMode" className={`${FIELD} w-full`} value={rule.dayMode} onChange={e=>setRule({...rule,dayMode:e.target.value as RecurrenceRule['dayMode']})}><option value="fixed">Fixed day (clamp short months)</option>{rule.frequency!=='weekly'&&<><option value="month_end">Month end</option><option value="last_weekday">Last Monday–Friday of month</option></>}</select></label>
      <label className={LABEL}>Day of month<input name="dayOfMonth" type="number" min={1} max={31} className={`${FIELD} w-full`} value={rule.dayOfMonth} onChange={e=>setRule({...rule,dayOfMonth:Number(e.target.value)})} required/></label>
      <label className={LABEL}>Start date<DateInput name="anchorDate" className={`${FIELD} w-full`} value={rule.anchorDate} onChange={e=>setRule({...rule,anchorDate:e.target.value})} required/></label>
      <label className={LABEL}>End date (optional)<DateInput name="endDate" className={`${FIELD} w-full`} defaultValue={template?.end_date??''}/></label>
      <label className={LABEL}>Maximum occurrences (optional)<input name="maxOccurrences" type="number" min={1} max={100000} className={`${FIELD} w-full`} defaultValue={template?.max_occurrences??''}/></label>
      <label className={LABEL}>Invoice or bill due after days<input name="dueDays" type="number" min={0} max={366} className={`${FIELD} w-full`} defaultValue={template?.due_days??30} required/></label>
      <label className="self-end"><input name="active" type="checkbox" defaultChecked={template?.active??false}/> Enable this template</label>
    </div>
    <div className="my-5 rounded-control border border-line p-4"><p className="font-medium">Next calendar dates</p><p className="mt-2 text-sm">{problem||dates.join(' · ')}</p><p className="mt-2 text-sm text-ink-muted">The last Monday–Friday rule excludes weekends; statutory holidays are not considered. Dates retain the company time zone. Each worker batch generates at most 12 drafts and keeps the remaining backlog.</p></div>
    <div className="flex flex-wrap gap-3"><button className={BUTTON}>{template?'Save template':'Create template'}</button>{template?.active&&<><input type="hidden" name="occurrence" value={template.next_date}/><button className={QUIET} name="operation" value="generate" formNoValidate>Generate next saved draft · {template.next_date}</button></>}</div>
  </ActionForm>
}

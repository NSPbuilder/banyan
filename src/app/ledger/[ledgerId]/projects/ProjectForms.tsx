'use client'
import { IconButton } from '@/components/IconButton'

import { DataTable } from '@/components/Table'

import { useState } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { Picker } from '@/components/Picker'
import { DateInput } from '@/components/DateInput'
import { FormFields, FORM_FIELD, FORM_FIELD_SHORT, FORM_FIELD_WIDE, FORM_FIELD_FULL } from '@/components/FormLayout'
import { Floating } from '@/components/Floating'
import { LineTaxes, TAX_FIELDS_GRID_COMPACT } from '@/components/LineTaxes'
import { BUTTON, FIELD, LABEL, QUIET, DANGER, QUIET_COMPACT, DANGER_COMPACT, REFUSAL } from '@/lib/ui'
import { formatMoney, moneyInput, parseMoney } from '@/lib/money'
import { TAX_CODES, computeEnteredTax, parseTaxOverride, type TaxCode } from '@/lib/tax-rates'
import { lineTaxCode } from '@/lib/forms'
import type { ProjectHead, ProjectRecordRow, ProjectPaymentRow, ProjectLine } from '@/lib/project'
import { PROJECT_CATEGORY_NAMES, PROJECT_COST_CATEGORIES } from '@/lib/project-accounting'
import type { ProjectFinanceOptions, ProjectFinanceLink } from '@/lib/project-finance'
import { projectTaxErrors, type ProjectTaxBindings } from '@/lib/project-tax'
import type { ProjectPaymentAttachment } from '@/lib/project-attachments'

export type ProjectActions={party:FormAction;create:FormAction;update:FormAction;delete:FormAction;restore:FormAction;record:FormAction;payment:FormAction;editPayment:FormAction;allocate:FormAction;void:FormAction;attach:FormAction;detach:FormAction}
export type PartyChoice={id:string;name:string;roles:string}
const input=`block mt-1 w-full ${FIELD}`
const field=`${LABEL} ${FORM_FIELD}`
const short=`${LABEL} ${FORM_FIELD_SHORT}`
const wide=`${LABEL} ${FORM_FIELD_WIDE}`
const full=`${LABEL} ${FORM_FIELD_FULL}`
const rowQuiet=QUIET_COMPACT+' shrink-0 whitespace-nowrap'
const rowDanger=DANGER_COMPACT+' shrink-0 whitespace-nowrap'
function AccountSelect({name,label,options,initial,required=false,hideLabel=false}:{name:string;label:string;options:Array<{id:string;label:string}>;initial?:string|null;required?:boolean;hideLabel?:boolean}) {
  return <label className={hideLabel?LABEL:field}><span className={hideLabel?'sr-only':undefined}>{label}</span><Picker name={name} ariaLabel={label} options={options} defaultValue={initial|| (options.length===1?options[0].id:'')} required={required} className={hideLabel?undefined:'mt-1'}/></label>
}
function Hidden({ledgerId,projectId}:{ledgerId:string;projectId?:string}) {return <><input type="hidden" name="ledgerId" value={ledgerId}/>{projectId&&<input type="hidden" name="projectId" value={projectId}/>}</>}
function PartySelect({ledgerId,action,role='supplier',parties,name='partyId',initial,onChange,required=true}:{ledgerId:string;action:FormAction;today?:string;role?:'customer'|'supplier';parties:PartyChoice[];name?:string;initial?:string|null;onChange?:(id:string)=>void;required?:boolean}) {
  const preferred=role==='supplier'?'Suppliers':'Customers'
  const options=parties.map(p=>({id:p.id,label:p.name,hint:p.roles,
    group:p.roles.includes(role)?preferred:p.roles.includes('supplier')?'Suppliers':p.roles.includes('customer')?'Customers':'Other Parties'}))
    .sort((a,b)=>(a.group===preferred?0:1)-(b.group===preferred?0:1)||a.group.localeCompare(b.group)||a.label.localeCompare(b.label))
  return <Picker name={name} options={options} defaultValue={onChange?undefined:initial||''} value={onChange?initial||'':undefined} required={required} onChange={onChange}
    ariaLabel={role==='customer'?'Customer':'Supplier / provider'} className="mt-1"
    create={{presentation:'party',title:role==='customer'?'New customer':'New supplier',action,
      hidden:{ledgerId,role},fields:[{name:'name',label:'Name',width:'15rem',takesTyped:true}]}}/>
}
export function NewProject({ledgerId,parties,action,newParty,today}:{ledgerId:string;parties:PartyChoice[];action:FormAction;newParty:FormAction;today:string}) {
  return <Floating label="New project" title="New project" buttonClassName={BUTTON}><ActionForm action={action} submit="Create project" working="Creating…" buttonClassName={BUTTON} className="mt-5 space-y-4" stickyActions>
    <Hidden ledgerId={ledgerId}/><FormFields>
      <label className={field}>Project code<input name="code" required maxLength={100} className={input}/></label>
      <label className={field}>Project name<input name="name" required maxLength={1000} className={input}/></label>
      <label className={full}>Customer<PartySelect ledgerId={ledgerId} action={newParty} today={today} role="customer" parties={parties} name="customerPartyId"/></label>
      <label className={full}>Site / address<input name="site" className={input}/></label>
      <label className={short}>Start date<DateInput  name="startDate" className={input}/></label>
      <label className={short}>Expected end date<DateInput  name="endDate" className={input}/></label>
    </FormFields><label className={full}>Notes<textarea name="note" rows={3} className={input}/></label>
  </ActionForm></Floating>
}
export function EditProject({ledgerId,project,action}:{ledgerId:string;project:ProjectHead;action:FormAction}) {
  return <Floating label={project.status==='archived'?'Restore project':'Edit project'} title="Edit project" buttonClassName={QUIET}><ActionForm action={action} submit="Save project" working="Saving…" className="mt-5 space-y-4" buttonClassName={BUTTON} stickyActions>
    <Hidden ledgerId={ledgerId} projectId={project.id}/><input type="hidden" name="version" value={project.version}/>
    <label className={field}>Project name<input name="name" required defaultValue={project.name} className={input}/></label>
    <label className={field}>Site / address<input name="site" defaultValue={project.site||''} className={input}/></label>
    <label className={field}>Status<select name="status" defaultValue={project.status==='archived'?'active':project.status} className={input}><option value="planned">Planned</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option></select></label>
    <label className={full}>Notes<textarea name="note" defaultValue={project.note||''} rows={3} className={input}/></label>
  </ActionForm></Floating>
}
export function ProjectDeleteForm({ledgerId,project,action,restore=false}:{ledgerId:string;project:ProjectHead;action:FormAction;restore?:boolean}) {
  return <Floating label={restore?'Restore':'Delete'} title={restore?'Restore project':'Delete project'} ariaLabel={`${restore?'Restore':'Delete'} ${project.name}`} buttonClassName={restore?QUIET:DANGER}>
    <ActionForm action={action} submit={restore?'Restore project':'Delete project'} working={restore?'Restoring…':'Deleting…'} buttonClassName={restore?BUTTON:DANGER} className="mt-5 space-y-4">
      <Hidden ledgerId={ledgerId} projectId={project.id}/><input type="hidden" name="version" value={project.version}/>
      <p className="font-medium">{project.code} · {project.name}</p>
      {!restore&&<p className="text-sm">Move to Deleted projects. Records, payments and documents are retained.</p>}
    </ActionForm>
  </Floating>
}
export function RecordForm({ledgerId,project,parties,action,newParty,kind,today,submissionKey,record,finance:availableFinance,link}:{ledgerId:string;project:ProjectHead;parties:PartyChoice[];action:FormAction;newParty:FormAction;kind:'revenue'|'cost';today:string;submissionKey:string;record?:ProjectRecordRow;finance?:ProjectFinanceOptions;link?:ProjectFinanceLink}) {
  type Row={kind:ProjectLine['kind'];description:string;base:string;taxCode:TaxCode;gst?:string;pst?:string;key:number}
  const empty:Row={kind:kind==='revenue'?'revenue':'material',description:'',base:'',taxCode:'OUT_OF_SCOPE',key:0}
  const initial:Row[]=record?record.lines.map((l,i)=>({kind:l.kind,description:l.description,base:moneyInput(BigInt(l.base)),key:i,
    taxCode:l.taxCode||(BigInt(l.gst)>0n?(BigInt(l.pst)>0n?'GST_PST':'GST'):BigInt(l.pst)>0n?'PST':'OUT_OF_SCOPE'),
    gst:moneyInput(BigInt(l.gst)),pst:moneyInput(BigInt(l.pst))})):[empty]
  const [rows,setRows]=useState(initial)
  const [date,setDate]=useState(record?.record_date||today)
  const [next,setNext]=useState(rows.length)
  const [generation,setGeneration]=useState(0)
  const [alreadyPaid,setAlreadyPaid]=useState(false)
  const [paymentStages,setPaymentStages]=useState(!!link?.payment_stages)
  const finance=availableFinance&&(kind==='revenue'?availableFinance.invoices:record?true:alreadyPaid?availableFinance.invoices||availableFinance.expenses:availableFinance.invoices)?availableFinance:undefined
  const label=record?'Edit':kind==='revenue'?'Add revenue':'Add cost'
  const choices=record?.party_id&&!parties.some(p=>p.id===record.party_id)?[...parties,{id:record.party_id,name:record.party,roles:'historical Party'}]:parties
  const setRow=(key:number,patch:Partial<Row>)=>setRows(current=>current.map(row=>row.key===key?{...row,...patch}:row))
  const figures=(row:Row)=>{try{return computeEnteredTax(parseMoney(row.base),row.taxCode,false,date,{gst:parseTaxOverride(row.gst),pst:parseTaxOverride(row.pst)})}catch{return null}}
  const totals=rows.map(figures),total=totals.every(Boolean)?totals.reduce((n,t)=>n+t!.total,0n):null
  const taxBindings:ProjectTaxBindings=availableFinance?{accounts:{...availableFinance.taxAccounts.accounts},errors:availableFinance.taxAccounts.errors}:{accounts:{},errors:{}}
  if(link&&availableFinance) {
    const gst=(kind==='revenue'?availableFinance.gstPayable:availableFinance.gstRecoverable).find(a=>a.id===link.gst_account_id)
    const pst=(kind==='revenue'?availableFinance.pstPayable:availableFinance.pstRecoverable).find(a=>a.id===link.pst_account_id)
    if(gst)taxBindings.accounts[kind==='revenue'?'gst_hst_payable':'gst_hst_recoverable']=gst
    if(pst)taxBindings.accounts[kind==='revenue'?'qst_pst_payable':'qst_pst_recoverable']=pst
  }
  const taxErrors=availableFinance?projectTaxErrors(taxBindings,kind,rows.map((l,i)=>({taxCode:l.taxCode,gst:totals[i]?.gst||0n,pst:totals[i]?.pst||0n,pstRecoverable:0n}))):[]
  const accountLabel=(row:Row)=>record&&initial[row.key]?.kind===row.kind&&link?.account_ids[row.key]
    ?[...finance!.revenue,...finance!.cost].find(a=>a.id===link.account_ids[row.key])?.label||'Original account'
    :finance?.itemAccounts[row.kind]?.label||'Assigned on save'
  return <Floating label={label} title={label} buttonClassName={record?rowQuiet:BUTTON} ariaLabel={record?`Edit ${record.description||kind+' on '+record.record_date}`:undefined} wide={kind==='revenue'}>
    <ActionForm action={action} submit={finance?(record?'Save changes':'Save and post'):'Save record'} working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-5" stickyActions
      onSucceeded={()=>{setGeneration(n=>n+1);setAlreadyPaid(false);if(!record){setRows(initial);setNext(initial.length);setDate(today);setPaymentStages(false)}}}>
      <Hidden ledgerId={ledgerId} projectId={project.id}/><input type="hidden" name="kind" value={kind}/><input type="hidden" name="submissionKey" value={`${submissionKey}:${generation}`}/>
      <input type="hidden" name="accountingIntent" value={finance?'yes':'no'}/>
      {record&&<><input type="hidden" name="recordId" value={record.id}/><input type="hidden" name="version" value={record.version}/></>}
      {record&&link?.status==='posted'&&!link.expense_entry_id&&BigInt(record.settled)>0n&&<p className="text-metadata text-ink-muted">Changing financial details releases existing payment allocations. Updating payment stages alone keeps them.</p>}
      <FormFields>
        {kind==='revenue'?<><input type="hidden" name="partyId" value={project.customer_party_id}/><p className="w-full text-sm">Customer: <strong>{project.customer}</strong></p></>:
          <label className={wide}>Supplier / provider<PartySelect ledgerId={ledgerId} action={newParty} today={record?.record_date||today} parties={choices} initial={record?.party_id} required={rows.some(l=>l.kind!=='other')}/></label>}
        <label className={short}>{kind==='revenue'?'Revenue date':'Cost date'}<DateInput name="date" required value={date} onChange={e=>setDate(e.target.value)} className={input}/></label>
        <label className={short}>Due date<DateInput name="dueDate"  defaultValue={record?.due_date||''} className={input}/></label>
        <label className={field}>{kind==='cost'?'Supplier invoice #':'Reference'}<input name="reference" defaultValue={record?.reference||''} maxLength={1000} className={input}/></label>
        <label className={full}>{kind==='revenue'?'Revenue summary':'Description'} <span className="font-normal text-ink-muted">(optional)</span><input name="description" maxLength={1000} defaultValue={record?.description||''} className={input}/></label>
      </FormFields>
      {finance&&<FormFields>
        {!link?.expense_entry_id&&<AccountSelect name="controlAccountId" label={kind==='revenue'?'Receivables account':'Payables account'} options={kind==='revenue'?finance.receivable:finance.payable} initial={link?.control_account_id} required={!alreadyPaid}/>}
        {link?.expense_entry_id&&<AccountSelect name="bankAccountId" label="Paid from" options={finance.bank} initial={link.bank_account_id} required/>}
      </FormFields>}
      {taxErrors.map(message=><p key={message} role="alert" className={REFUSAL}>{message}</p>)}
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        <DataTable density="reading" className="w-full text-sm"><thead><tr className="text-left text-xs text-neutral-500">
          <th className="px-1 py-2">{kind==='cost'?'Category':'Line'}</th>{finance&&<th className="px-1 py-2">Account</th>}{kind==='revenue'&&<th className="px-1 py-2">Description</th>}<th className="px-1 py-2 text-right">Net</th><th className="px-1 py-2">Tax code</th><th className="px-1 py-2"><span className={TAX_FIELDS_GRID_COMPACT}><span className="text-right">GST</span><span className="text-right">PST</span></span></th><th className="px-1 py-2 text-right">Total</th><th className="px-1 py-2"><span className="sr-only">Remove</span></th>
        </tr></thead><tbody>{rows.map((l,i)=><tr key={l.key}>
          <td className="px-1 py-2"><input type="hidden" name="linePosition" value={record&&l.key<initial.length?l.key+1:''}/>{kind==='cost'?<select name="lineKind" value={l.kind} onChange={e=>setRow(l.key,{kind:e.target.value as ProjectLine['kind']})} className={`${FIELD} w-48`} aria-label={`Line ${i+1} category`}>{PROJECT_COST_CATEGORIES.map(k=><option key={k} value={k}>{PROJECT_CATEGORY_NAMES[k]}</option>)}</select>:<><input type="hidden" name="lineKind" value="revenue"/>{i+1}</>}</td>
          {finance&&<td className="px-1 py-2 text-metadata text-ink-secondary tabular-nums" data-auto-account={l.kind}>
            <span title={accountLabel(l)}><span aria-hidden="true">{accountLabel(l).split(' — ')[0]}</span><span className="sr-only">{accountLabel(l)}</span></span>
          </td>}
          {kind==='revenue'&&<td className="px-1 py-2"><input name="lineDescription" value={l.description} onChange={e=>setRow(l.key,{description:e.target.value})} maxLength={1000} className={`${FIELD} min-w-40 w-full`} aria-label={`Line ${i+1} description`}/></td>}
          <td className="px-1 py-2"><input name="base" inputMode="decimal" value={l.base} onChange={e=>setRow(l.key,{base:e.target.value})} className={`${FIELD} w-20 text-right tabular-nums`} aria-label={`Line ${i+1} base`}/></td>
          <td className="px-1 py-2"><select name={lineTaxCode(i)} value={l.taxCode} onChange={e=>setRow(l.key,{taxCode:e.target.value as TaxCode,gst:undefined,pst:undefined})} className={`${FIELD} w-28`} aria-label={`Line ${i+1} tax code`}>{TAX_CODES.map(t=><option key={t.code} value={t.code}>{t.label}</option>)}</select></td>
          <td className="px-1 py-2"><LineTaxes compact index={i} amount={l.base} code={l.taxCode} inclusive={false} on={date} gst={l.gst} pst={l.pst} fieldClass={FIELD} onChange={(tax,value)=>setRow(l.key,{[tax]:value})} onReset={()=>setRow(l.key,{gst:undefined,pst:undefined})}/></td>
          <td className="px-1 py-2 text-right tabular-nums whitespace-nowrap">{figures(l)?formatMoney(figures(l)!.total):'—'}</td>
          <td className="px-1 py-2"><IconButton icon="delete" disabled={rows.length===1} label={`Remove line ${i+1}`} onClick={()=>setRows(r=>r.filter(x=>x.key!==l.key))}/></td>
        </tr>)}</tbody></DataTable>
      </div>
      <div className="flex items-center justify-between gap-4"><button type="button" className={QUIET} onClick={()=>{setRows(r=>[...r,{...empty,key:next}]);setNext(n=>n+1)}}>Add line</button><p className="text-sm font-semibold tabular-nums">Total {project.currency} {total===null?'—':formatMoney(total)}</p></div>
      {kind==='cost'&&!record&&<fieldset className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" name="alreadyPaid" checked={alreadyPaid} onChange={e=>setAlreadyPaid(e.target.checked)}/>Already paid</label>
        {alreadyPaid&&<FormFields className="mt-3">
          <label className={short}>Payment date<DateInput name="paymentDate" required defaultValue={today} className={input}/></label>
          <label className={short}>Paid amount ({project.currency})<input name="paidAmount" inputMode="decimal" className={input}/></label>
          <label className={field}>Payment reference<input name="paymentReference" className={input}/></label>
          {finance&&<AccountSelect name="bankAccountId" label="Paid from" options={finance.bank} required/>}
        </FormFields>}
      </fieldset>}
      {kind==='revenue'&&finance&&(!record||link?.invoice_id)&&<fieldset className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={paymentStages} onChange={e=>setPaymentStages(e.target.checked)}/>Payment in stages <span className="font-normal text-ink-muted">(optional)</span></label>
        {record&&!paymentStages&&<input type="hidden" name="paymentStages" value=""/>}
        <div hidden={!paymentStages} className="mt-3 space-y-2">
          <label className={full}>Payment stages<textarea name="paymentStages" defaultValue={link?.payment_stages||''} disabled={!paymentStages} maxLength={4000} rows={4} className={input}
            placeholder={'Deposit: 30% on confirmation\nProgress payment: 40% after stage 1\nFinal payment: 30% on completion'}/></label>
          <p className="text-caption text-ink-muted">Printed on this invoice. For information only.</p>
        </div>
      </fieldset>}
      <label className={full}>Supporting document · 20 MB max<input type="file" name="file" className={`${input} text-sm`}/></label>
    </ActionForm>
  </Floating>
}
export function PaymentForm({ledgerId,project,parties,records,action,newParty,today,direction,submissionKey,initialRecord,finance}:{ledgerId:string;project:ProjectHead;parties:PartyChoice[];records:ProjectRecordRow[];action:FormAction;newParty:FormAction;today:string;direction:'received'|'paid';submissionKey:string;initialRecord?:ProjectRecordRow;finance?:ProjectFinanceOptions}) {
  const initialParty=initialRecord?initialRecord.party_id:(direction==='received'?project.customer_party_id:'')
  const [party,setParty]=useState(initialParty)
  const [generation,setGeneration]=useState(0)
  const available=records.filter(r=>r.party_id===party && (r.kind==='revenue')===(direction==='received') && BigInt(r.outstanding)>0n)
  const label=initialRecord?(direction==='received'?'Receive':'Pay'):(direction==='received'?'Receive customer payment':'Pay supplier')
  return <Floating label={label} title={label} buttonClassName={initialRecord?rowQuiet:QUIET} ariaLabel={initialRecord?`${label} for ${initialRecord.description||initialRecord.kind+' on '+initialRecord.record_date}`:undefined}><ActionForm action={action} submit={finance?'Save and post payment':label} working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-4" stickyActions onSucceeded={()=>{setGeneration(n=>n+1);setParty(initialParty)}}>
    <Hidden ledgerId={ledgerId} projectId={project.id}/><input type="hidden" name="direction" value={direction}/><input type="hidden" name="submissionKey" value={`${submissionKey}:${generation}`}/>
    <input type="hidden" name="accountingIntent" value={finance?'yes':'no'}/>
    {direction==='received'?<><input type="hidden" name="partyId" value={project.customer_party_id}/><p className="text-sm">Customer: <strong>{project.customer}</strong></p></>:initialRecord&&!initialRecord.party_id?<><input type="hidden" name="partyId" value=""/><p className="text-sm">{initialRecord.description}</p></>:
      <label className={wide}>Supplier / provider<PartySelect ledgerId={ledgerId} action={newParty} today={today} parties={parties} initial={party} onChange={setParty}/></label>}
    <FormFields><label className={short}>Payment date<DateInput name="date"  required defaultValue={today} className={input}/></label>
      <label className={short}>Amount ({project.currency})<input name="amount" inputMode="decimal" required defaultValue={initialRecord?moneyInput(BigInt(initialRecord.outstanding)):''} className={input}/></label>
      <label className={field}>Reference<input name="reference" className={input}/></label></FormFields>
    {finance&&<FormFields><AccountSelect name="bankAccountId" label={direction==='received'?'Deposited to':'Paid from'} options={finance.bank} required/>
      <AccountSelect name="controlAccountId" label={direction==='received'?'Receivables account':'Payables account'} options={direction==='received'?finance.receivable:finance.payable}/>
      </FormFields>}
    <label className={wide}>Allocate to record<select name="recordId" defaultValue={initialRecord?.id||''} key={party} className={input}><option value="">Keep as unallocated advance</option>{available.map(r=><option key={r.id} value={r.id}>{r.description||r.kind+' on '+r.record_date} · {formatMoney(BigInt(r.outstanding))} outstanding</option>)}</select></label>
    <label className={short}>Allocation amount<input name="allocation" inputMode="decimal" className={input}/></label>
    <label className={full}>Notes<textarea name="note" rows={2} className={input}/></label>
  </ActionForm></Floating>
}
export function EditPaymentForm({ledgerId,project,payment,action,finance,supporting}:{ledgerId:string;project:ProjectHead;payment:ProjectPaymentRow;action:FormAction;finance?:ProjectFinanceOptions;supporting?:PaymentSupportingOptions}) {
  const edit=payment.edit!
  const [amount,setAmount]=useState(moneyInput(BigInt(edit.amount))),[date,setDate]=useState(payment.payment_date)
  const [allocations,setAllocations]=useState(edit.allocations.map(a=>moneyInput(BigInt(a.amount))))
  let available:bigint|null=null
  try {available=parseMoney(amount)-allocations.reduce((n,a)=>n+parseMoney(a||'0'),0n)}catch{}
  const needsBill=edit.source==='quick_expense'&&(date!==payment.payment_date||amount!==moneyInput(BigInt(edit.amount))||available!==0n)
  return <Floating label="Edit" title={payment.direction==='received'?'Edit receipt':'Edit payment'} ariaLabel={`Edit ${payment.direction} payment on ${payment.payment_date} for ${payment.party}`} buttonClassName={rowQuiet}>
    <ActionForm action={action} submit="Save changes" working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-4" stickyActions>
      <Hidden ledgerId={ledgerId} projectId={project.id}/><input type="hidden" name="paymentId" value={payment.id}/><input type="hidden" name="version" value={payment.version}/><input type="hidden" name="signature" value={edit.signature}/>
      <p className="text-sm">{payment.party} · {payment.direction==='received'?'Receipt':'Payment'}</p>
      {edit.amount!==payment.amount&&<p className="text-metadata text-ink-muted">Shared accounting payment. All allocations are shown below.</p>}
      <FormFields>
        <label className={short}>Payment date<DateInput name="date" value={date} onChange={e=>setDate(e.target.value)} required className={input}/></label>
        <label className={short}>Amount ({project.currency})<input name="amount" required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} className={`${input} text-right tabular-nums`}/></label>
        <label className={field}>Reference<input name="reference" defaultValue={payment.reference||''} maxLength={1000} className={input}/></label>
      </FormFields>
      {edit.source&&finance&&<FormFields>
        <AccountSelect name="bankAccountId" label={payment.direction==='received'?'Deposited to':'Paid from'} options={finance.bank} initial={edit.bankAccountId} required/>
        {needsBill&&<AccountSelect name="controlAccountId" label="Payables account" options={finance.payable} required/>}
      </FormFields>}
      {needsBill&&<p className="text-metadata text-ink-muted">This correction separates the cost into a posted bill and payment.</p>}
      {!!edit.allocations.length&&<fieldset className="min-w-0 space-y-2"><legend className="mb-2 text-label font-medium">Allocations</legend>
        {edit.allocations.map((a,i)=><label key={a.target} className="flex w-128 max-w-full items-center justify-between gap-4 text-sm"><span className="min-w-0 truncate" title={a.label}>{a.label}</span><input type="hidden" name="allocationTarget" value={a.target}/><input name="allocationAmount" aria-label={`Allocation to ${a.label}`} inputMode="decimal" value={allocations[i]} onChange={e=>setAllocations(old=>old.map((v,n)=>n===i?e.target.value:v))} className={`${FIELD} w-32 shrink-0 text-right tabular-nums`}/></label>)}
      </fieldset>}
      <p role="status" className={`text-sm tabular-nums ${available!==null&&available<0n?'text-red-700 dark:text-red-300':'text-ink-secondary'}`}>{available===null?'Enter valid amounts.':available<0n?'Allocations exceed the payment by '+formatMoney(-available):'Unallocated '+project.currency+' '+formatMoney(available)}</p>
      <label className={full}>Notes<textarea name="note" defaultValue={edit.note||''} rows={2} className={input}/></label>
    </ActionForm>
    {supporting&&<section className="mt-6 border-t border-line-subtle pt-5" aria-label="Payment attachments">
      <h3 className="mb-3 text-label font-medium">Attachments</h3>
      <PaymentSupporting ledgerId={ledgerId} projectId={project.id} paymentId={payment.id} {...supporting}/>
    </section>}
  </Floating>
}
export function AllocateForm({ledgerId,project,payment,records,action,submissionKey}:{ledgerId:string;project:ProjectHead;payment:ProjectPaymentRow;records:ProjectRecordRow[];action:FormAction;submissionKey:string}) {
  const [generation,setGeneration]=useState(0)
  return <Floating label="Allocate" title="Allocate existing payment" buttonClassName={rowQuiet}><ActionForm action={action} submit="Allocate payment" working="Saving…" className="mt-5 space-y-4" buttonClassName={BUTTON} stickyActions onSucceeded={()=>setGeneration(n=>n+1)}>
    <Hidden ledgerId={ledgerId} projectId={project.id}/><input type="hidden" name="paymentId" value={payment.id}/>
    <input type="hidden" name="submissionKey" value={`${submissionKey}:${generation}`}/>
    <p>{payment.party}: {formatMoney(BigInt(payment.unallocated))} available.</p>
    <label className={wide}>Record<select name="recordId" required className={input}><option value="">Choose a record…</option>{records.filter(r=>r.party_id===payment.party_id&&(r.kind==='revenue')===(payment.direction==='received')&&BigInt(r.outstanding)>0n).map(r=><option key={r.id} value={r.id}>{r.description} · {formatMoney(BigInt(r.outstanding))}</option>)}</select></label>
    <label className={short}>Amount<input name="amount" required inputMode="decimal" className={input}/></label>
  </ActionForm></Floating>
}
export function VoidForm({ledgerId,projectId,id,version,kind,description,action,label='Cancel'}:{ledgerId:string;projectId:string;id:string;version:number;kind:'record'|'payment'|'allocation';description:string;action:FormAction;label?:string}) {
  return <Floating label={label} title={label==='Cancel cost'?'Cancel paid cost':'Cancel erroneous entry'} buttonClassName={rowDanger} ariaLabel={`${label} erroneous ${description}`}><ActionForm action={action} submit={label==='Cancel cost'?'Cancel cost and payment':'Cancel erroneous entry'} working="Cancelling…" buttonClassName={DANGER} className="mt-5 space-y-4">
    <Hidden ledgerId={ledgerId} projectId={projectId}/><input type="hidden" name="itemKind" value={kind}/><input type="hidden" name="itemId" value={id}/><input type="hidden" name="version" value={version}/>
    <p className="text-sm">{description}</p><p className="text-sm">{label==='Cancel cost'?'The paid cost and its expense will be cancelled together.':'Allocations are cancelled; retained payments become advances.'}</p>
    <label className={full}>Reason<textarea name="reason" required rows={3} className={input}/></label>
  </ActionForm></Floating>
}
export function AttachmentForm({ledgerId,project,records,payments,action}:{ledgerId:string;project:ProjectHead;records:ProjectRecordRow[];payments:ProjectPaymentRow[];action:FormAction}) {
  return <Floating label="Upload document" title="Project document" buttonClassName={QUIET}><ActionForm action={action} submit="Upload document" working="Uploading…" buttonClassName={BUTTON} className="mt-5 space-y-4" stickyActions>
    <Hidden ledgerId={ledgerId} projectId={project.id}/><label className={field}>Revenue / cost record<select name="recordId" className={input}><option value="">Project document</option>{records.map(r=><option key={r.id} value={r.id}>{r.description} · {r.party}</option>)}</select></label>
    <label className={field}>Payment<select name="paymentId" className={input}><option value="">None</option>{payments.map(p=><option key={p.id} value={p.id}>{p.payment_date} · {p.party} · {formatMoney(BigInt(p.amount))}</option>)}</select></label>
    <label className={field}>File (up to 20 MB)<input type="file" name="file" required className={input}/></label><label className={field}>Note<input name="note" className={input}/></label>
  </ActionForm></Floating>
}

type PaymentSupportingOptions={files:ProjectPaymentAttachment[];action:FormAction;detach:FormAction;allowUpload:boolean;allowDelete:boolean;error?:string}
type PaymentSupportingProps=PaymentSupportingOptions&{ledgerId:string;projectId:string;paymentId:string}

function PaymentSupporting({ledgerId,projectId,paymentId,files,action,detach,allowUpload,allowDelete,error}:PaymentSupportingProps) {
  const base=`/ledger/${ledgerId}/projects/${projectId}/payments/${paymentId}/attachments`
  return <div className="space-y-4">
      <p className="text-sm text-ink-muted">Attachments save immediately. PDFs and images are included after this Receipt.</p>
      {error&&<p role="status" className={REFUSAL}>{error}</p>}
      <ul className="space-y-2 text-sm">{files.map(file=><li key={file.source+file.id} className="flex items-start justify-between gap-3">
        <a href={base+'/'+file.id} target="_blank" rel="noreferrer" className="min-w-0 break-words underline">{file.filename}</a>
        {allowDelete&&<Floating label="Delete" title="Delete attachment" ariaLabel={`Delete ${file.filename}`} buttonClassName={rowDanger}>
          <ActionForm action={detach} submit="Delete attachment" working="Deleting…" buttonClassName={DANGER} className="mt-5 space-y-4">
            <Hidden ledgerId={ledgerId} projectId={projectId}/><input type="hidden" name="paymentId" value={paymentId}/><input type="hidden" name="attachmentId" value={file.id}/>
            <p className="break-words font-medium">{file.filename}</p>
            <p className="text-sm">Remove this file from the payment and future Receipt PDFs?{file.source==='accounting'&&' This also removes it from Income / Expenses.'}</p>
          </ActionForm>
        </Floating>}
      </li>)}{!files.length&&!error&&<li className="text-ink-muted">No supporting documents yet.</li>}</ul>
      {allowUpload&&<ActionForm action={action} submit="Attach" working="Uploading…" buttonClassName={BUTTON} className="space-y-4" stickyActions>
        <Hidden ledgerId={ledgerId} projectId={projectId}/><input type="hidden" name="paymentId" value={paymentId}/>
        <label className={full}>Supporting document (up to 20 MB)<input type="file" name="file" required accept="application/pdf,image/*,.pdf,.heic,.heif,.tif,.tiff" className={input}/></label>
      </ActionForm>}
    </div>
}

export function PaymentAttachments(props:PaymentSupportingProps) {
  return <Floating label={`Attachments (${props.files.length})`} title="Payment attachments" buttonClassName={rowQuiet}>
    <div className="mt-5"><PaymentSupporting {...props}/></div>
  </Floating>
}

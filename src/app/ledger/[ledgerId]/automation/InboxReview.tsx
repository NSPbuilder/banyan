'use client'
import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import { useState } from 'react'
import Link from 'next/link'
import { AutomationForm as ActionForm } from '@/components/AutomationForm'
import { EditLease } from '@/components/EditLease'
import { automationAction } from '@/app/automation-actions'
import { InvoiceLines } from '../invoices/InvoiceLines'
import { initialRows,type RowState } from '@/lib/invoice-rows'
import type { Choice } from '@/lib/forms'
import type { Proposal } from '@/lib/bill-reading'
import type { InboxItem } from '@/lib/inbox'
import { moneyInput } from '@/lib/money'
import { BUTTON,FIELD,LABEL,QUIET } from '@/lib/ui'

export function InboxReview({ledgerId,item,proposal,accounts,parties,currency,today,targets}:{ledgerId:string;item:InboxItem;proposal:Proposal|null;accounts:Array<Choice&{code:string;type:string}>;parties:Choice[];currency:string;today:string;targets:Array<Choice&{type:'invoice'|'entry'}>}) {
  const [linkType,setLinkType]=useState<'invoice'|'entry'>('invoice')
  const [type,setType]=useState(proposal?.suggests==='sale'?'sales':proposal?.suggests==='expense'?'expense':'purchase')
  const [date,setDate]=useState(proposal?.issuedOn??today),[inclusive,setInclusive]=useState(false)
  const [rows,setRows]=useState<RowState>(()=>proposal?.lines.length?{nextKey:proposal.lines.length,rows:proposal.lines.map((l,i)=>({key:i,account:accounts.find(a=>a.code===l.accountCode)?.id??'',description:l.description,amount:moneyInput(BigInt(l.amount)),taxCode:l.taxCode}))}:initialRows(1))
  const file=`/ledger/${ledgerId}/automation/inbox/${item.id}/file`,finished=['converted','ignored'].includes(item.status)
  return <>
    <div className="mb-4 flex flex-wrap items-center gap-3"><span className="text-sm">{item.status.replaceAll('_',' ')}</span><a className={QUIET} href={file+'?download=1'}>Download original</a>
      {item.target_invoice_id&&<Link className={QUIET} href={`/ledger/${ledgerId}/invoices/${item.target_invoice_id}`}>Recorded document</Link>}
      {item.target_entry_id&&<Link className={QUIET} href={`/ledger/${ledgerId}/entries/${item.target_entry_id}`}>Recorded entry</Link>}</div>
    {item.last_error&&<p className="mb-4 text-sm text-ink-muted">{item.last_error}</p>}
    {item.duplicate_reason&&<p className="mb-4 text-sm font-medium">Possible duplicate: {item.duplicate_reason}</p>}
    {proposal&&<div className="mb-4 rounded-control border border-line p-3 text-sm"><p>AI suggestion: {proposal.suggests} · party: {proposal.party||'unread'} · currency: {proposal.currency||'unread'}</p><p>{proposal.notes}</p><p>Check every field against the original. Suggestions have not created accounting.</p></div>}
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
      <section className="min-w-0"><h2 className="mb-2 font-medium">Original · {item.filename}</h2>
        {/* eslint-disable-next-line @next/next/no-img-element -- Private receipt routes require the browser's session cookie; the image optimizer cannot fetch them. */}
        {item.mime==='application/pdf'?<iframe src={file} title="Original receipt" className="h-[36rem] w-full rounded-control border border-line"/>:<img src={file} alt="Original receipt" className="max-h-[36rem] w-full object-contain"/>}
        <p className="mt-2 text-sm text-ink-muted">One complete receipt per conversion. A PDF containing separate receipts must be split manually.</p>
      </section>
      <section className="min-w-0"><h2 className="mb-2 font-medium">Review in this ledger</h2>
        {finished?<p className="text-sm">This source is finished. Its recorded target and original remain available.</p>:<ActionForm action={automationAction}>
          <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="command" value="review"/><input type="hidden" name="id" value={item.id}/>
          <EditLease resource={{ledgerId,type:'inbox',id:item.id}} version={item.version}/>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className={LABEL}>Draft type<select name="targetType" className={`${FIELD} w-full`} value={type} onChange={e=>setType(e.target.value)}><option value="purchase">Supplier bill draft</option><option value="sales">Sales invoice draft</option><option value="expense">Paid expense draft</option><option value="entry">Link manual journal</option></select></label>
            <label className={LABEL}>Supplier or customer<Picker name="partyId" options={parties} placeholder="Choose the actual party" ariaLabel="Supplier or customer" required/></label>
            <label className={LABEL}>Issue date<DateInput name="issuedOn" className={`${FIELD} w-full`} value={date} onChange={e=>setDate(e.target.value)} required/></label>
            <label className={LABEL}>Due date<DateInput name="dueOn" className={`${FIELD} w-full`} defaultValue={proposal?.dueOn??today} required={type!=='expense'&&type!=='entry'}/></label>
            <label className={LABEL}>Currency<input name="currency" className={`${FIELD} w-full`} defaultValue={proposal?.currency||currency} required/></label>
            <label className={LABEL}>Original reference<input name="theirRef" className={`${FIELD} w-full`} defaultValue={proposal?.documentRef??''}/></label>
            <label className={LABEL}>Receivable or payable account<Picker name="controlAccountId" options={accounts.filter(a=>a.type==='asset'||a.type==='liability')} ariaLabel="Receivable or payable account" placeholder="Choose control account" required={type==='sales'||type==='purchase'}/></label>
            <label className={LABEL}>Original total<input name="total" className={`${FIELD} w-full`} inputMode="decimal" defaultValue={proposal?.total?moneyInput(BigInt(proposal.total)):''} required/></label>
            <label className={LABEL}>Already paid?<select name="paid" className={`${FIELD} w-full`} defaultValue="" required><option value="">Confirm from original</option><option value="no">No</option><option value="yes">Yes</option></select></label>
            <label className={LABEL}>Actual payment account<Picker name="paymentAccountId" options={accounts.filter(a=>a.type==='asset'||a.type==='liability')} ariaLabel="Actual payment account" placeholder="Choose actual account" required={type==='expense'}/></label>
            <label className={`${LABEL} sm:col-span-2`}>Description<input name="note" className={`${FIELD} w-full`}/></label>
            <label className={LABEL}>Typed amounts<select name="amounts" className={`${FIELD} w-full`} value={inclusive?'inclusive':'exclusive'} onChange={e=>setInclusive(e.target.value==='inclusive')}><option value="exclusive">Before tax</option><option value="inclusive">Include tax</option></select></label>
          </div>
          <InvoiceLines state={rows} setState={setRows} lineAccounts={accounts} fieldClass={FIELD} issuedOn={date} inclusive={inclusive}/>
          <label className={`${LABEL} mt-4`}>Why this is a separate transaction (if a duplicate is flagged)<textarea name="duplicateOverride" className={`${FIELD} w-full`} rows={2}/></label>
          <button name="operation" value="create" className={`${BUTTON} mt-4`}>Create reviewed draft</button>
          <div className="mt-6 border-t border-line pt-4"><h3 className="font-medium">Existing accounting or non-transaction</h3>
            <label className={`${LABEL} mt-2`}>Existing record type<select name="linkType" className={`${FIELD} w-full`} value={linkType} onChange={e=>setLinkType(e.target.value as typeof linkType)}><option value="invoice">Invoice or supplier bill</option><option value="entry">Journal or bank accounting</option></select></label><label className={`${LABEL} mt-2`}>Existing accounting<select key={linkType} name="targetId" className={`${FIELD} w-full`} defaultValue=""><option value="">Choose the existing transaction</option>{targets.filter(t=>t.type===linkType).map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
            <button name="operation" value="link" formNoValidate className={`${QUIET} mt-2`}>Link existing accounting</button>
            <label className={`${LABEL} mt-3`}>Reason to ignore<input name="reason" className={`${FIELD} w-full`}/></label><button name="operation" value="ignore" formNoValidate className={`${QUIET} mt-2`}>Ignore with reason</button>
          </div>
        </ActionForm>}
      </section>
    </div>
  </>
}

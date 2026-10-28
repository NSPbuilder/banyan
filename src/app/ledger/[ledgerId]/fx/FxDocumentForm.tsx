'use client'
import { DateInput } from '@/components/DateInput'

import { useState } from 'react'
import { Picker } from '@/components/Picker'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { FIELD, QUIET } from '@/lib/ui'
import { TAX_CODES } from '@/lib/tax-rates'

type Account = { id: string; code: string; name: string; roles: string[] }
type Party = { id: string; name: string; roles: string[] }

export function FxDocumentForm({ ledgerId, currencies, accounts, parties, date, requestKey, action }: {
  ledgerId: string; currencies: string[]; accounts: Account[]; parties: Party[]; date: string; requestKey: string; action: FormAction
}) {
  const [kind, setKind] = useState('sales_invoice'), [currency, setCurrency] = useState(currencies[0] ?? '')
  const [lines, setLines] = useState([0]), [next, setNext] = useState(1)
  const purchase = kind.startsWith('purchase'), partyRole = purchase ? 'supplier' : 'customer'
  const controls = accounts.filter(a => a.roles.includes(purchase ? 'trade_payables' : 'trade_receivables'))
  return <ActionForm action={action} submit="Save & post" working="Saving…" className="mt-4 space-y-4" buttonClassName={QUIET}>
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="op" value="document"/><input type="hidden" name="requestKey" value={requestKey}/>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label>Document type<select name="kind" value={kind} onChange={e=>setKind(e.target.value)} className={`${FIELD} mt-1 w-full`}>
        <option value="sales_invoice">Sales invoice</option><option value="purchase_invoice">Supplier bill</option><option value="sales_credit">Customer credit note</option><option value="purchase_credit">Supplier credit note</option>
      </select></label>
      <label>Original currency<select name="currency" value={currency} onChange={e=>setCurrency(e.target.value)} className={`${FIELD} mt-1 w-full`}>{currencies.map(c=><option key={c}>{c}</option>)}</select></label>
      <label>Party<Picker key={partyRole} name="partyId" required ariaLabel="Document party" className="mt-1 w-full" options={parties.filter(p=>p.roles.includes(partyRole)).map(p=>({id:p.id,label:p.name}))}/></label>
      <label>Control account<Picker key={partyRole+'control'} name="controlAccountId" required ariaLabel="Control account" className="mt-1 w-full" options={controls.map(a=>({id:a.id,label:`${a.code} ${a.name}`}))}/></label>
      <label>Issue date<DateInput  name="issuedOn" required defaultValue={date} className={`${FIELD} mt-1 w-full`}/></label>
      <label>Due date<DateInput  name="dueOn" required defaultValue={date} className={`${FIELD} mt-1 w-full`}/></label>
      <label>Document number<input name="number" className={`${FIELD} mt-1 w-full`} placeholder="Optional"/></label>
      <label>Their reference<input name="theirRef" className={`${FIELD} mt-1 w-full`}/></label>
    </div>
    <p className="text-sm text-ink-secondary">Enter what each line adds to the document in {currency}. A credit note uses positive line values too.</p>
    <div className="space-y-2">{lines.map((id,index)=><div key={id} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_8rem_8rem_auto]">
      <label>Account {index+1}<Picker name="lineAccount" required ariaLabel={`Line ${index+1} account`} className="mt-1 w-full" options={accounts.filter(a=>!a.roles.some(r=>['trade_receivables','trade_payables','cash_and_cash_equivalents'].includes(r))).map(a=>({id:a.id,label:`${a.code} ${a.name}`}))}/></label>
      <label>Description {index+1}<input name="lineDescription" className={`${FIELD} mt-1 w-full`}/></label>
      <label>Amount {index+1}<input name="lineAmount" inputMode="decimal" required className={`${FIELD} mt-1 w-full`}/></label>
      <label>Tax {index+1}<select name="lineTax" defaultValue="OUT_OF_SCOPE" className={`${FIELD} mt-1 w-full`}>{TAX_CODES.map(t=><option key={t.code} value={t.code}>{t.code}</option>)}</select></label>
      <button type="button" disabled={lines.length===1} onClick={()=>setLines(lines.filter(x=>x!==id))} className={QUIET} aria-label={`Remove line ${index+1}`}>Remove</button>
    </div>)}</div>
    <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={lines.length>=200} className={QUIET} onClick={()=>{setLines([...lines,next]);setNext(next+1)}}>Add line</button><label><input type="checkbox" name="inclusive" value="yes"/> Entered amounts include tax</label></div>
    <details><summary className="cursor-pointer text-sm">Actual issue rate / source evidence</summary><p className="my-2 text-sm text-ink-secondary">Leave blank to use the latest saved BOC quote on or before the issue date, up to seven days earlier.</p><div className="grid gap-3 sm:grid-cols-3">
      <label>CAD per 1 {currency}<input name="rate" inputMode="decimal" className={`${FIELD} mt-1 w-full`}/></label>
      <label>Rate date<DateInput name="rateDate"  className={`${FIELD} mt-1 w-full`}/></label>
      <label>Rate evidence<input name="rateEvidence" className={`${FIELD} mt-1 w-full`} placeholder="Bank advice or other reference"/></label>
    </div></details>
    <label className="block">Note<textarea name="note" rows={2} className={`${FIELD} mt-1 w-full`}/></label>
    <button type="submit" name="saveMode" value="draft" className={QUIET}>Save draft</button>
  </ActionForm>
}

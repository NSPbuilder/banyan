'use client'
import { useEffect,useRef,useState } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { Floating } from '@/components/Floating'
import { DateInput } from '@/components/DateInput'
import { FormSection, FormFields, FORM_FIELD, FORM_FIELD_SHORT, FORM_FIELD_FULL } from '@/components/FormLayout'
import { BUTTON, QUIET, FIELD, LABEL } from '@/lib/ui'
import { moneyInput } from '@/lib/money'
import type { AssetRow, AssetStatus } from '@/lib/asset-types'

import {AssetFinanceFields} from './AssetFinanceFields'
import type {CcaPool} from '@/lib/depreciation-types'
import { ASSET_STATUSES } from '@/lib/asset-types'
import {OperationsFinanceFields} from '@/components/OperationsFinanceFields'
import type {FinanceSetting,FundingOption} from '@/lib/operations-finance-types'
const input=`${FIELD} mt-1 block w-full`,label=`${LABEL} ${FORM_FIELD}`,short=`${LABEL} ${FORM_FIELD_SHORT}`
export function AssetForm({ledgerId,currency,today,asset,action,pools=[],finance,accounts=[],requestKey}:{ledgerId:string;currency:string;today:string;asset?:AssetRow;action:FormAction;pools?:CcaPool[];finance?:FinanceSetting|null;accounts?:FundingOption[];requestKey?:string}) {
  const [status,setStatus]=useState<AssetStatus>(asset?.status??'in_use'),[cost,setCost]=useState(asset?moneyInput(BigInt(asset.acquisition_cost)):'0.00'),[date,setDate]=useState(asset?.acquired_on??today),[financeKey,setFinanceKey]=useState(0),[service,setService]=useState(asset?.in_service_on??'')
  const [key,setKey]=useState(requestKey)
  const savedRoot=useRef<HTMLDivElement>(null)
  useEffect(()=>{if(financeKey>0)savedRoot.current?.querySelector('form')?.dispatchEvent(new CustomEvent('figtree:form-saved',{bubbles:true}))},[financeKey])
  return <Floating label={asset?'Edit asset':'Add asset'} title={asset?'Edit asset':'Add asset'} buttonClassName={asset?QUIET:BUTTON}><div ref={savedRoot}>
    <ActionForm action={action} submit={asset?'Save changes':'Add asset'} working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-6" stickyActions onSucceeded={()=>{setStatus(asset?.status??'in_use');setCost(asset?moneyInput(BigInt(asset.acquisition_cost)):'0.00');setDate(asset?.acquired_on??today);setService(asset?.in_service_on??'');setFinanceKey(n=>n+1);setKey(crypto.randomUUID())}}>
      <input type="hidden" name="ledgerId" value={ledgerId}/>{!asset&&<input type="hidden" name="requestKey" value={key}/>} {asset&&<><input type="hidden" name="assetId" value={asset.id}/><input type="hidden" name="version" value={asset.version}/></>}
      <FormSection title="Asset identity"><FormFields>
        <label className={short}>Asset code<input name="code" required maxLength={60} defaultValue={asset?.code} className={input}/></label>
        <label className={label}>Asset name<input name="name" required maxLength={240} defaultValue={asset?.name} className={input}/></label>
        <label className={label}>Category<input name="category" maxLength={120} placeholder="Machinery, vehicles, equipment…" defaultValue={asset?.category} className={input}/></label>
        <label className={label}>Serial number<input name="serialNumber" maxLength={120} defaultValue={asset?.serial_number} className={input}/></label>
      </FormFields></FormSection>
      <FormSection title="Acquisition"><FormFields>
        <label className={short}>Acquired on<DateInput name="acquiredOn" required readOnly={!!asset&&!!finance?.connected_on} value={date} onChange={e=>setDate(e.target.value)} className={input}/></label>
        <label className={short}>In service on<DateInput name="inServiceOn" value={service} onChange={e=>setService(e.target.value)} className={input}/></label>
        <label className={short}>Acquisition cost ({currency})<input name="acquisitionCost" required readOnly={!!asset&&!!finance?.connected_on} inputMode="decimal" value={cost} onChange={e=>setCost(e.target.value)} className={`${input} text-right tabular-nums`}/></label>
        <label className={label}>Supplier<input name="supplier" maxLength={240} defaultValue={asset?.supplier} className={input}/></label>
        <label className={short}>Warranty until<DateInput name="warrantyUntil" defaultValue={asset?.warranty_until??''} className={input}/></label>
      </FormFields></FormSection>
      <FormSection title="Custody and status"><FormFields>
        <label className={label}>Location<input name="location" maxLength={240} defaultValue={asset?.location} className={input}/></label>
        <label className={label}>Custodian / responsible person<input name="custodian" maxLength={240} defaultValue={asset?.custodian} className={input}/></label>
        <label className={short}>Status<select aria-label="Status" name="status" value={status} onChange={e=>setStatus(e.target.value as AssetStatus)} className={input}>{Object.entries(ASSET_STATUSES).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></label>
        {status==='disposed'?<>
          <label className={short}>Disposed on<DateInput name="disposedOn" required defaultValue={asset?.disposed_on??today} className={input}/></label>
          <label className={short}>Disposal proceeds ({currency})<input name="disposalProceeds" required inputMode="decimal" defaultValue={asset?moneyInput(BigInt(asset.disposal_proceeds)):'0.00'} className={`${input} text-right tabular-nums`}/></label>
        </>:<input type="hidden" name="disposalProceeds" value="0"/>}
      </FormFields></FormSection>
      {(!asset||status==='disposed'&&!asset.disposed_on)&&<OperationsFinanceFields options={accounts} defaultFunding={finance?.funding_account_id} currency={currency} label={asset?'Proceeds account':'Funding account'} tax={!asset}/>}
      {!asset&&<AssetFinanceFields key={financeKey} currency={currency} date={service||date} cost={cost} pools={pools}/>}
      <label className={`${LABEL} ${FORM_FIELD_FULL}`}>Notes<textarea name="notes" rows={3} maxLength={10000} defaultValue={asset?.notes} className={input}/></label>
    </ActionForm></div>
  </Floating>
}
export function AssetActivityForm({ledgerId,asset,currency,today,requestKey,action}:{ledgerId:string;asset:AssetRow;currency:string;today:string;requestKey:string;action:FormAction}) {
  const [key,setKey]=useState(requestKey)
  return <Floating label="Record activity" title="Record asset activity" buttonClassName={QUIET}>
    <ActionForm action={action} submit="Record activity" working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-4" stickyActions onSucceeded={()=>setKey(crypto.randomUUID())}>
      <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="assetId" value={asset.id}/><input type="hidden" name="requestKey" value={key}/>
      <p className="text-body">{asset.code} · {asset.name}</p><FormFields>
        <label className={short}>Date<DateInput name="date" required min={asset.acquired_on} max={asset.disposed_on??undefined} defaultValue={asset.disposed_on&&today>asset.disposed_on?asset.disposed_on:today} className={input}/></label>
        <label className={short}>Activity<select aria-label="Activity" name="kind" className={input}><option value="maintenance">Maintenance</option><option value="inspection">Inspection</option><option value="note">Note</option></select></label>
        <label className={short}>Cost ({currency})<input name="cost" required inputMode="decimal" defaultValue="0.00" className={`${input} text-right tabular-nums`}/></label>
      </FormFields><label className={`${LABEL} ${FORM_FIELD_FULL}`}>Activity note<textarea name="note" required rows={4} maxLength={10000} className={input}/></label>
    </ActionForm>
  </Floating>
}

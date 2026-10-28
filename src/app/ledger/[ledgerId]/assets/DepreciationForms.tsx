'use client'
import {useState} from 'react'
import {Floating} from '@/components/Floating'
import {ActionForm,type FormAction} from '@/components/ActionForm'
import {DateInput} from '@/components/DateInput'
import {FormFields,FORM_FIELD,FORM_FIELD_SHORT} from '@/components/FormLayout'
import {BUTTON,QUIET,FIELD,LABEL} from '@/lib/ui'
import {dayAfter,monthEnd} from '@/lib/depreciation-math'
import {formatMoney,moneyInput} from '@/lib/money'
import {DEPRECIATION_METHODS,type DepreciationAsset,type DepreciationMethod} from '@/lib/depreciation-types'
const field=`${FIELD} mt-1 block w-full`,label=`${LABEL} ${FORM_FIELD}`,short=`${LABEL} ${FORM_FIELD_SHORT}`
export function DepreciationPolicyForm({ledgerId,asset,currency,action}:{ledgerId:string;asset:DepreciationAsset;currency:string;action:FormAction}) {
  const policy=asset.policy,[method,setMethod]=useState<DepreciationMethod>(policy?.method??'straight_line'),locked=asset.entries.length>0,[prospective,setProspective]=useState(asset.entries.length>0)
  const latestDate=[asset.entries[0]?.entry_date,policy?.start_date,asset.acquired_on].filter((d):d is string=>!!d).sort().at(-1)!,nextStart=dayAfter(monthEnd(latestDate.slice(0,7))),elapsed=policy?(Number(nextStart.slice(0,4))-Number(policy.start_date.slice(0,4)))*12+Number(nextStart.slice(5,7))-Number(policy.start_date.slice(5,7)):0,remainingLife=Math.max(1,(policy?.life_months??60)-elapsed)
  return <Floating label={policy?'Policy':'Set depreciation'} title={`Depreciation policy · ${asset.code}`} buttonClassName={QUIET} ariaLabel={`Depreciation policy for ${asset.name}`}><ActionForm action={action} submit={prospective?'Save estimate change':'Save policy'} working="Saving…" buttonClassName={BUTTON} className="mt-5 space-y-5" stickyActions>
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="assetId" value={asset.id}/><input type="hidden" name="version" value={policy?.version??0}/>
    {policy&&<label className="flex items-center gap-3 text-body"><input type="checkbox" checked={prospective} disabled={locked} onChange={e=>setProspective(e.target.checked)} className="size-4 shrink-0"/>Change estimates prospectively</label>}{prospective&&<p className="text-body text-ink-secondary">Recorded entries stay fixed. The revised policy depreciates the remaining carrying amount from a later month. Record depreciation through the previous month first.</p>}
    <fieldset className="space-y-5"><FormFields><label className={label}>Method<select aria-label="Method" name="method" value={method} onChange={e=>setMethod(e.target.value as DepreciationMethod)} className={field}>{Object.entries(DEPRECIATION_METHODS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label className={short}>{prospective?'Effective from':'Depreciation starts'}<DateInput key={String(prospective)} name="startDate" required defaultValue={prospective?nextStart:policy?.start_date??asset.acquired_on} className={field}/></label></FormFields>
      <FormFields><label className={short}>Residual value ({currency})<input name="residualValue" required inputMode="decimal" defaultValue={policy?moneyInput(BigInt(policy.residual_value)):'0.00'} className={field}/></label>{['straight_line','declining_balance'].includes(method)&&<label className={short}>{prospective?'Remaining useful life (months)':'Useful life (months)'}<input name="lifeMonths" type="number" required min={1} max={1200} defaultValue={prospective?remainingLife:policy?.life_months??60} className={field}/></label>}{method==='declining_balance'&&<label className={short}>Annual rate (%)<input name="annualRate" required inputMode="decimal" defaultValue={policy?moneyInput(BigInt(policy.annual_rate_bp)):'20.00'} className={field}/></label>}</FormFields>
    </fieldset>{prospective&&<label className={LABEL}>Estimate change reason<textarea name="revisionReason" required rows={3} maxLength={10000} className={field}/></label>}
    <p className="max-w-prose text-metadata text-ink-muted">Monthly book depreciation prorates the first and disposal months by calendar days and stops at residual value. Automatic methods settle the residual balance at the end of useful life. Partial fiscal closes retain their own period; the next monthly charge continues from the following day. Canadian CCA is managed separately.</p>
  </ActionForm></Floating>
}
export function DepreciationAdjustmentForm({ledgerId,asset,currency,today,requestKey,action}:{ledgerId:string;asset:DepreciationAsset;currency:string;today:string;requestKey:string;action:FormAction}) {
  const [key,setKey]=useState(requestKey)
  return <Floating label="Manual adjustment" title={`Adjust depreciation · ${asset.code}`} buttonClassName={QUIET} ariaLabel={`Adjust depreciation for ${asset.name}`}><ActionForm action={action} submit="Record adjustment" working="Recording…" buttonClassName={BUTTON} className="mt-5 space-y-5" stickyActions onSucceeded={()=>setKey(crypto.randomUUID())}>
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="assetId" value={asset.id}/><input type="hidden" name="requestKey" value={key}/>
    <FormFields><label className={short}>Date<DateInput name="date" required defaultValue={asset.disposed_on??today} className={field}/></label><label className={label}>Adjustment ({currency})<input name="amount" required inputMode="decimal" className={field}/></label></FormFields>
    <p className="text-body text-ink-secondary">Positive amounts increase accumulated depreciation. Negative amounts reverse it. Current accumulated depreciation: {formatMoney(BigInt(asset.accumulated))}; net book value: {formatMoney(BigInt(asset.net_book_value))}.</p>
    <label className={LABEL}>Reason<textarea name="note" required rows={4} maxLength={10000} className={field}/></label><p className="text-metadata text-ink-muted">Record monthly depreciation through the previous month before a correction. For opening balances, set the policy start date after the opening balance date. It updates this register and retains the original entries.</p>
  </ActionForm></Floating>
}
export function DepreciationRunForm({ledgerId,through,count,total,currency,hash,requestKey,action}:{ledgerId:string;through:string;count:number;total:string;currency:string;hash:string;requestKey:string;action:FormAction}) {
  return <Floating label="Record depreciation" title="Record reviewed depreciation" buttonClassName={BUTTON}><ActionForm action={action} submit="Record depreciation" working="Recording…" buttonClassName={BUTTON} className="mt-5 space-y-5" stickyActions>
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="through" value={through}/><input type="hidden" name="requestKey" value={requestKey}/><input type="hidden" name="expectedHash" value={hash}/><p className="text-body">Record {count} monthly entries through {through}, totaling {formatMoney(BigInt(total))} {currency}.</p><p className="text-metadata text-ink-muted">The amounts below are rechecked before recording. Connected Finance posts the corresponding journals when this batch is confirmed. Before connection, the batch prepares opening register history only.</p>
  </ActionForm></Floating>
}

'use client'
import styles from './AssetFinance.module.css'
import {useState} from 'react'
import {DateInput} from '@/components/DateInput'
import {FormSection,FormFields,FORM_FIELD,FORM_FIELD_SHORT,FORM_FIELD_FULL} from '@/components/FormLayout'
import {FIELD,LABEL} from '@/lib/ui'
import {CCA_CLASSES,CCA_RULES,DEPRECIATION_METHODS,type CcaPool} from '@/lib/depreciation-types'
import {ASSET_GROUPS,type AssetGroup} from '@/lib/operations-finance-types'
const field=`${FIELD} mt-1 block w-full`,short=`${LABEL} ${FORM_FIELD_SHORT}`,label=`${LABEL} ${FORM_FIELD}`
export function AssetFinanceFields({currency,date,cost,pools}:{currency:string;date:string;cost:string;pools:CcaPool[]}){
 const [group,setGroup]=useState<AssetGroup>('machinery'),[method,setMethod]=useState('straight_line'),[ccaClass,setClass]=useState('8'),land=group==='land'
 return <div className={styles.finance}>
  <FormSection title="Account and book schedule"><FormFields>
   <label className={label}>Asset account group<select aria-label="Asset account group" name="assetGroup" value={group} onChange={e=>setGroup(e.target.value as AssetGroup)} className={field}>{Object.entries(ASSET_GROUPS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
   <input type="hidden" name="bookEnabled" value="on"/>
   {land?<><input type="hidden" name="bookMethod" value="none"/><input type="hidden" name="bookYears" value="1"/><p className="text-body text-ink-secondary">Land is nondepreciable for book and CCA purposes.</p></>:<>
    <label className={label}>Book method<select aria-label="Book method" name="bookMethod" value={method} onChange={e=>setMethod(e.target.value)} className={field}>{Object.entries(DEPRECIATION_METHODS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
    <label className={short}>Useful life (years)<input name="bookYears" type="number" min={1} max={100} step={1} required defaultValue={5} className={field}/></label>
    {method==='declining_balance'&&<label className={short}>Book annual rate (%)<input name="bookRate" required inputMode="decimal" defaultValue="20.00" className={field}/></label>}
   </>}
   <label className={short}>Book depreciation starts<DateInput name="bookStart" required defaultValue={date} className={field}/></label>
   <label className={short}>Residual value ({currency})<input name="bookResidual" required inputMode="decimal" defaultValue={land?cost:'0.00'} className={field}/></label>
  </FormFields><p className="max-w-prose text-metadata text-ink-muted">Use expected consumption and useful life for book amortization. Monthly charges are previewed and confirmed before posting. Future schedules are forecasts.</p></FormSection>
  {!land&&<FormSection title="CCA tax schedule"><FormFields><input type="hidden" name="taxEnabled" value="on"/>
   <label className={label}>CCA class<select aria-label="CCA class" name="taxClass" required value={ccaClass} onChange={e=>setClass(e.target.value)} className={field}>{CCA_CLASSES.map(c=><option key={c.code} value={c.code}>Class {c.code} · {c.label}{!c.standard?' · reviewed maximum':''}</option>)}</select></label>
   <label className={label}>CCA pool<select key={ccaClass} aria-label="CCA pool" name="taxPool" defaultValue="" className={field}><option value="">Create or reuse a class pool automatically</option>{pools.filter(p=>p.class_code===ccaClass).map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
   <label className={short}>Tax capital cost (CAD)<input name="taxCost" required inputMode="decimal" defaultValue={currency==='CAD'?cost:''} className={field}/></label>
   <label className={short}>Tax available for use<DateInput name="taxAvailable" required defaultValue={date} className={field}/></label>
   <label className={label}>Tax first-year rule<select aria-label="Tax first-year rule" name="taxRule" className={field}>{Object.entries(CCA_RULES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
   <label className={`${LABEL} ${FORM_FIELD_FULL}`}>Tax basis / eligibility notes<textarea name="taxNote" required maxLength={10000} rows={3} className={field}/></label>
  </FormFields><p className="max-w-prose text-metadata text-ink-muted">Review eligible cost, business use and first-year rules. Finance settings choose maximum CCA or a permitted book-matching claim. Special classes require a reviewed annual maximum.</p></FormSection>}
 </div>
}

'use client'
import {FormFields,FormSection,FORM_FIELD,FORM_FIELD_SHORT} from './FormLayout'
import {FIELD,LABEL} from '@/lib/ui'
import type {FundingOption} from '@/lib/operations-finance-types'
export function OperationsFinanceFields({options,defaultFunding,currency,label='Funding account',kinds=['asset','liability','equity'],tax=false,optional=false}:{options:FundingOption[];defaultFunding?:string|null;currency:string;label?:string;kinds?:string[];tax?:boolean;optional?:boolean}) {
 const field=`${FIELD} mt-1 block w-full`
 return <FormSection title="Journal entry"><FormFields>
  <label className={`${LABEL} ${FORM_FIELD}`}>{label}<select aria-label={label} name="counterpartAccountId" required={!optional} defaultValue={defaultFunding??''} className={field}><option value="">{optional?'Use the configured expense account':'Choose an account…'}</option>{options.filter(a=>kinds.includes(a.kind)).map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
  {tax&&<><label className={`${LABEL} ${FORM_FIELD_SHORT}`}>Recoverable tax ({currency})<input name="recoverableTax" inputMode="decimal" defaultValue="0.00" className={`${field} text-right tabular-nums`}/></label><label className={`${LABEL} ${FORM_FIELD}`}>Recoverable tax account<select aria-label="Recoverable tax account" name="taxAccountId" defaultValue="" className={field}><option value="">No recoverable tax</option>{options.filter(a=>a.roles.some(r=>['gst_hst_recoverable','qst_pst_recoverable'].includes(r))).map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select></label></>}
 </FormFields><p className="max-w-prose text-metadata text-ink-muted">Saving posts the source and journal together. Capitalized cost excludes separately entered recoverable tax; include nonrecoverable tax in cost.</p></FormSection>
}

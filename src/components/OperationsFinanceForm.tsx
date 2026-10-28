'use client'
import {ActionForm,type FormAction} from './ActionForm'
import {FormFields,FormSection,FORM_FIELD,FORM_FIELD_SHORT,FORM_FIELD_FULL} from './FormLayout'
import {FIELD,LABEL,BUTTON} from '@/lib/ui'
import type {FinanceSetting,FundingOption,OperationsSeat} from '@/lib/operations-finance-types'
import {moneyInput} from '@/lib/money'
export function OperationsFinanceForm({ledgerId,seat,date,hash,setting,options,action}:{ledgerId:string;seat:OperationsSeat;date:string;hash:string;setting:FinanceSetting|null;options:FundingOption[];action:FormAction}) {
 const connected=!!setting?.connected_on,field=`${FIELD} mt-1 block w-full`
 const account=(name:string,label:string,defaultValue:string,kind:string[],optional=false)=><label className={`${LABEL} ${FORM_FIELD}`}>{label}<select aria-label={label} name={name} required={!optional} defaultValue={defaultValue} className={field}><option value="">{optional?'Use P&L only':'Choose an account…'}</option>{options.filter(a=>kind.includes(a.kind)).map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
 return <ActionForm action={action} submit={connected?'Save financial settings':'Connect and post reviewed differences'} working="Saving…" buttonClassName={BUTTON} className="space-y-6" stickyActions>
  <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="date" value={date}/><input type="hidden" name="expectedHash" value={hash}/><input type="hidden" name="version" value={setting?.version??0}/>
  <FormSection title={connected?'Default accounts':'Opening review'}><FormFields>
   {account('fundingAccountId','Default funding account',setting?.funding_account_id??'',['asset','liability','equity'])}
   {!connected&&account('openingAccountId','Opening difference counterpart','',['equity','liability','asset'])}
  </FormFields><p className="max-w-prose text-metadata text-ink-muted">{connected?'Acquisitions and receipts use this default; review or change the account for each business.':`Connection date ${date}. Confirm the account balances and each difference above. Only those differences are posted; existing financial history is retained.`}</p></FormSection>
  {seat==='/assets'&&<FormSection title="CCA and deferred tax"><FormFields>
   <label className={`${LABEL} ${FORM_FIELD}`}>CCA claim strategy<select aria-label="CCA claim strategy" name="ccaStrategy" defaultValue={setting?.cca_strategy??'maximum'} className={field}><option value="maximum">Suggest maximum permitted CCA</option><option value="match_book">Match book depreciation within the CCA limit</option></select></label>
   <label className={`${LABEL} ${FORM_FIELD_SHORT}`}>Forecast reversal tax rate (%)<input name="taxRate" required inputMode="decimal" defaultValue={moneyInput(BigInt(setting?.tax_rate_bp??0))} className={field}/></label>
   <label className={`${LABEL} ${FORM_FIELD_FULL}`}>Reversal tax-rate basis<textarea name="taxRateNote" rows={2} required maxLength={10000} defaultValue={setting?.tax_rate_note} className={field}/></label>
   {account('ociAccountId','OCI tax counterpart (optional)',setting?.oci_account_id??'',['equity'],true)}
   {account('equityAccountId','Equity tax counterpart (optional)',setting?.equity_account_id??'',['equity'],true)}
  </FormFields><p className="max-w-prose text-metadata text-ink-muted">CCA matching remains conditional on each year’s permitted maximum. Forecasts use this reviewed rate; each annual deferred-tax working paper confirms the applicable reversal rate and DTA recognition.</p></FormSection>}
 </ActionForm>
}

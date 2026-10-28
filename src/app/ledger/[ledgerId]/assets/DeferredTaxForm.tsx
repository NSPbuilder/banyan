'use client'
import styles from './AssetFinance.module.css'
import {ActionForm,type FormAction} from '@/components/ActionForm'
import {FormSection,FormFields,FORM_FIELD,FORM_FIELD_FULL} from '@/components/FormLayout'
import {BUTTON,FIELD,LABEL} from '@/lib/ui'
import {formatMoney} from '@/lib/money'
import type {DeferredTaxInput,TaxJournalLine} from '@/lib/deferred-tax-types'
import {useState} from 'react'
type Serialized=Omit<DeferredTaxInput,'bookAdjustment'|'taxAdjustment'|'recognizedAsset'|'openingLiability'|'openingAsset'> & {bookAdjustment:string;taxAdjustment:string;recognizedAsset:string;openingLiability:string;openingAsset:string}
export function TaxJournal({lines}:{lines:TaxJournalLine[]}){return lines.length?<div className="overflow-x-auto"><table className="w-full min-w-96 text-body"><thead><tr className="border-b border-line-subtle"><th className="py-2 text-left font-medium">Suggested account</th><th className="text-right font-medium">Debit (CAD)</th><th className="text-right font-medium">Credit (CAD)</th></tr></thead><tbody>{lines.map((l,i)=><tr key={i} className="border-b border-line-subtle"><td className="py-3 pr-4">{l.account}</td><td className="text-right tabular-nums">{l.debit==='0'?'—':formatMoney(BigInt(l.debit))}</td><td className="text-right tabular-nums">{l.credit==='0'?'—':formatMoney(BigInt(l.credit))}</td></tr>)}</tbody></table></div>:<p className="text-body text-ink-muted">No balance movement. No journal adjustment is suggested.</p>}
export function DeferredTaxForm({ledgerId,input,hash,requestKey,action,rateNote}:{ledgerId:string;input:Serialized;hash:string;requestKey:string;action:FormAction;rateNote?:string}){
 const [key,setKey]=useState(requestKey)
 return <ActionForm action={action} submit="Record reviewed working paper" working="Recording…" buttonClassName={BUTTON} className={`${styles.finance} space-y-5`} onSucceeded={()=>setKey(crypto.randomUUID())}>
 <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="requestKey" value={key}/><input type="hidden" name="expectedHash" value={hash}/>{Object.entries(input).filter(([k])=>!['scopeReviewed','rateNote','note'].includes(k)).map(([k,v])=><input key={k} type="hidden" name={k} value={String(v)}/>)}
 <FormSection title="Confirm the accounting review"><FormFields><label className={`${LABEL} ${FORM_FIELD}`}>Reversal tax-rate basis<textarea name="rateNote" defaultValue={rateNote} required maxLength={10000} rows={3} placeholder="Applicable enacted or substantively enacted federal/provincial rate, expected reversal and source" className={`${FIELD} mt-1 block w-full`}/></label><label className={`${LABEL} ${FORM_FIELD}`}>Scope and recognition review<textarea name="note" required maxLength={10000} rows={3} placeholder="Pool scope, basis adjustments, recovery through use/sale, recognition exceptions and DTA recoverability" className={`${FIELD} mt-1 block w-full`}/></label><label className={`${FORM_FIELD_FULL} flex items-start gap-3 text-body`}><input type="checkbox" name="scopeReviewed" required className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]"/><span>I reviewed the complete book/tax scope, recognition exceptions, expected recovery, tax rate and any recognized deferred tax asset.</span></label></FormFields></FormSection>
 <p className="text-metadata text-ink-muted">Confirmation records this working paper and posts its reviewed balance adjustment through the connected fixed-asset accounts. A zero movement retains a source record without a journal.</p>
 </ActionForm>
}

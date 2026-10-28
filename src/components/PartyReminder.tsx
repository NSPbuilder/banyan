import Link from 'next/link'
import {AutomationForm} from './AutomationForm'
import {EditLease} from './EditLease'
import {automationAction} from '@/app/automation-actions'
import type {ReminderRule} from '@/lib/mail'
import {serviceSettingsPath,customerEmailPath} from '@/lib/workflow-links'
import {QUIET} from '@/lib/ui'
export function PartyReminder({ledgerId,partyId,email,rule}:{ledgerId:string;partyId:string;email:string|null;rule?:ReminderRule}){
  return <section className="mt-6 border-t border-line pt-4" aria-label="Customer reminders"><h2 className="mb-3 text-section-title font-semibold">Payment reminders</h2>
    <AutomationForm action={automationAction}>
      <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="partyId" value={partyId}/><input type="hidden" name="id" value={rule?.id??''}/><input type="hidden" name="command" value="reminder-toggle"/>
      {rule&&<EditLease resource={{ledgerId,type:'reminder',id:rule.id}} version={rule.version}/>}
      <div className="flex flex-wrap items-center gap-4"><label><input type="checkbox" role="switch" name="enabled" defaultChecked={rule?.enabled??false} disabled={!email&&!rule?.enabled}/> Enable payment reminders</label><button className={QUIET}>Save reminder preference</button><Link className="text-sm underline" href={serviceSettingsPath(ledgerId,'reminders')}>Reminder settings</Link></div>
      {!email&&<p className="mt-2 text-sm" role="status">Add a primary customer email to enable reminders. <Link className="underline" href={customerEmailPath(ledgerId,partyId)}>Add email address</Link></p>}
      {rule?.paused&&<p className="mt-2 text-metadata text-ink-muted">Paused: {rule.pause_reason} <Link className="underline" href={`/ledger/${ledgerId}/automation/reminders/${rule.id}`}>Review pause</Link></p>}
      {rule?.defer_until&&<p className="mt-2 text-metadata text-ink-muted">Deferred through {rule.defer_until}.</p>}
    </AutomationForm>
  </section>
}

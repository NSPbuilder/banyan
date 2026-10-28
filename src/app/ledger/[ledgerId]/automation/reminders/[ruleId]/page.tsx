import { DateInput } from '@/components/DateInput'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireAutomationLedger } from '@/lib/automation-gate'
import { reminderColumns,type ReminderRule } from '@/lib/mail'
import { BusinessWorkspace as AutomationShell } from '@/components/BusinessWorkspace'
import { AutomationForm as ActionForm } from '@/components/AutomationForm'
import { EditLease } from '@/components/EditLease'
import { automationAction } from '@/app/automation-actions'
import { BUTTON,FIELD,LABEL } from '@/lib/ui'
export const dynamic='force-dynamic'
export default async function ReminderDetail({params}:{params:Promise<{ledgerId:string;ruleId:string}>}) {
  const {ledgerId,ruleId}=await params;await requireAutomationLedger(ledgerId,['/invoices'])
  const [r]=await db.execute<ReminderRule>(sql`SELECT ${reminderColumns} FROM reminder_rule WHERE id=${ruleId}::uuid AND ledger_id=${ledgerId}::uuid`);if(!r)notFound()
  const [p]=await db.execute<{name:string}>(sql`SELECT name FROM party WHERE id=${r.party_id}::uuid`)
  return <AutomationShell context="Settings" ledgerId={ledgerId} title={`Reminders · ${p.name}`}><ActionForm action={automationAction}>
    <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="command" value="reminder"/><input type="hidden" name="id" value={r.id}/><input type="hidden" name="partyId" value={r.party_id}/>
    <EditLease resource={{ledgerId,type:'reminder',id:r.id}} version={r.version}/>
    <div className="mt-4 grid max-w-3xl gap-4 sm:grid-cols-2">
      <label className={LABEL}>Overdue days<input name="days" className={`${FIELD} w-full`} defaultValue={r.days.join(',')} required/></label>
      <label className={LABEL}>Defer through (promise to pay)<DateInput name="deferUntil" className={`${FIELD} w-full`} defaultValue={r.defer_until??''}/></label>
      <label className={LABEL}>Local start hour<input name="startHour" type="number" min={0} max={23} className={`${FIELD} w-full`} defaultValue={r.start_hour} required/></label><label className={LABEL}>Local end hour<input name="endHour" type="number" min={1} max={24} className={`${FIELD} w-full`} defaultValue={r.end_hour} required/></label>
      <input type="hidden" name="enabled" value={r.enabled?'on':''}/><label><input name="usesCompanyDefaults" type="checkbox" defaultChecked={r.uses_company_defaults}/> Use company reminder schedule</label><label><input name="paused" type="checkbox" defaultChecked={r.paused}/> Pause for dispute or review</label>
      <p className="text-metadata text-ink-muted sm:col-span-2">Overdue days and hours below apply only when the company schedule is off. Enable or disable reminders in this customer’s Party record.</p>
      <label className={`${LABEL} sm:col-span-2`}>Pause, dispute or promise reason<textarea name="reason" className={`${FIELD} w-full`} rows={3} defaultValue={r.pause_reason??''}/></label>
    </div><button className={`${BUTTON} mt-5`}>Save customer rule</button>
  </ActionForm></AutomationShell>
}

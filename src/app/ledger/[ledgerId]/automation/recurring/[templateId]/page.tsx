import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireAutomationLedger } from '@/lib/automation-gate'
import { AutomationShell } from '@/components/AutomationShell'
import { templateColumns,type RecurringTemplate } from '@/lib/recurring'
import { companyClock } from '@/lib/automation-access'
import { nextOccurrence } from '@/lib/recurrence-calendar'
import { RecurringForm,type RecurringSource } from '../../RecurringForm'
export const dynamic='force-dynamic'
export default async function RecurringDetail({params}:{params:Promise<{ledgerId:string;templateId:string}>}) {
  const {ledgerId,templateId}=await params;await requireAutomationLedger(ledgerId,['/invoices','/entries'])
  const [t]=await db.execute<RecurringTemplate>(sql`SELECT ${templateColumns} FROM recurring_template WHERE id=${templateId}::uuid AND ledger_id=${ledgerId}::uuid`);if(!t)notFound()
  const [setting]=await db.execute<{timezone:string}>(sql`SELECT coalesce(s.timezone,'America/Vancouver') AS timezone FROM ledger l LEFT JOIN automation_setting s ON s.entity_id=l.entity_id WHERE l.id=${ledgerId}::uuid`)
  const occurrences=await db.execute<{id:string;scheduled_for:string;template_version:string;target_invoice_id:string|null;target_entry_id:string|null}>(sql`SELECT id::text,scheduled_for::text,template_version::text,target_invoice_id::text,target_entry_id::text FROM recurring_occurrence WHERE template_id=${t.id}::uuid ORDER BY scheduled_for DESC LIMIT 200`)
  const sources=await db.execute<RecurringSource>(sql`SELECT id::text,coalesce(number,their_ref,'Unnumbered')||' · '||issued_on::text AS label,direction AS type FROM invoice WHERE ledger_id=${ledgerId}::uuid AND status IN ('draft','posted') AND document_kind='invoice'
    AND NOT EXISTS(SELECT 1 FROM project_accounting_link WHERE invoice_id=invoice.id)
    UNION ALL SELECT id::text,coalesce(entry_no,'Draft')||' · '||description AS label,'entry' AS type FROM journal_entry WHERE ledger_id=${ledgerId}::uuid AND source_type='manual' AND status IN ('draft','posted') ORDER BY label LIMIT 500`)
  const today=companyClock(setting.timezone).date;let date=t.next_date,backlog=0
  while(date<=today&&(!t.end_date||date<=t.end_date)&&(t.max_occurrences===null||backlog+t.occurrence_count<t.max_occurrences)&&backlog<100000){backlog++;date=nextOccurrence({frequency:t.frequency,dayMode:t.day_mode,anchorDate:t.anchor_date,dayOfMonth:t.day_of_month},date)}
  return <AutomationShell ledgerId={ledgerId} title={t.title}>
    <p className="mb-4 text-sm">{t.active?'Enabled':'Paused'} · {setting.timezone} · next {t.next_date} · backlog {backlog}{backlog?' occurrences from '+t.next_date+' through '+today:''}</p>
    {t.last_error&&<p className="mb-4 text-sm">{t.last_error}</p>}
    <RecurringForm ledgerId={ledgerId} template={t} sources={sources} today={today} lastDate={occurrences[0]?.scheduled_for}/>
    <h2 className="mb-2 mt-6 font-medium">Generated drafts</h2><div className="divide-y divide-line">{occurrences.map(o=><div key={o.id} className="flex flex-wrap justify-between gap-3 py-3"><span>{o.scheduled_for} · template version {o.template_version}</span>{o.target_invoice_id?<Link className="underline" href={`/ledger/${ledgerId}/invoices/${o.target_invoice_id}`}>Draft document</Link>:o.target_entry_id?<Link className="underline" href={`/ledger/${ledgerId}/entries/${o.target_entry_id}`}>Draft journal</Link>:<span>Original target was removed; this occurrence will not generate again.</span>}</div>)}</div>
  </AutomationShell>
}

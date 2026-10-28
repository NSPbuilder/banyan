import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireAutomationLedger } from '@/lib/automation-gate'
import { AutomationShell } from '@/components/AutomationShell'
import { templateColumns,type RecurringTemplate } from '@/lib/recurring'
import { companyClock } from '@/lib/automation-access'
import { RecurringForm,type RecurringSource } from '../RecurringForm'
export const dynamic='force-dynamic'
export default async function RecurringPage({params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params;await requireAutomationLedger(ledgerId,['/invoices','/entries'])
  const [setting]=await db.execute<{timezone:string}>(sql`SELECT coalesce(s.timezone,'America/Vancouver') AS timezone FROM ledger l LEFT JOIN automation_setting s ON s.entity_id=l.entity_id WHERE l.id=${ledgerId}::uuid`)
  const rows=await db.execute<RecurringTemplate>(sql`SELECT ${templateColumns} FROM recurring_template WHERE ledger_id=${ledgerId}::uuid ORDER BY title`)
  const sources=await db.execute<RecurringSource>(sql`SELECT id::text,coalesce(number,their_ref,'Unnumbered')||' · '||issued_on::text||' · '||direction AS label,direction AS type FROM invoice WHERE ledger_id=${ledgerId}::uuid AND status IN ('draft','posted') AND document_kind='invoice'
    AND NOT EXISTS(SELECT 1 FROM project_accounting_link WHERE invoice_id=invoice.id)
    UNION ALL SELECT id::text,coalesce(entry_no,'Draft')||' · '||description AS label,'entry' AS type FROM journal_entry WHERE ledger_id=${ledgerId}::uuid AND source_type='manual' AND status IN ('draft','posted') ORDER BY label LIMIT 500`)
  return <AutomationShell ledgerId={ledgerId} title="Recurring drafts">
    <div className="mb-6 divide-y divide-line">{rows.map(t=><div key={t.id} className="flex flex-wrap justify-between gap-3 py-3"><Link className="font-medium underline" href={`/ledger/${ledgerId}/automation/recurring/${t.id}`}>{t.title}</Link><span className="text-sm">{t.active?'Enabled':'Paused'} · next {t.next_date} · {t.occurrence_count} generated</span>{t.last_error&&<p className="w-full text-sm">{t.last_error}</p>}</div>)}{!rows.length&&<p>No recurring templates yet.</p>}</div>
    <h2 className="mb-3 font-medium">New recurring template</h2><RecurringForm ledgerId={ledgerId} sources={sources} today={companyClock(setting.timezone).date}/>
  </AutomationShell>
}

import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireLedger } from '@/lib/gate'
import { BusinessWorkspace as AutomationShell } from '@/components/BusinessWorkspace'
import { AutomationForm as ActionForm } from '@/components/AutomationForm'
import { automationAction } from '@/app/automation-actions'
import { BUTTON,FIELD } from '@/lib/ui'
export const dynamic='force-dynamic'
export default async function InboxPage({params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params;await requireLedger(ledgerId,'/automation')
  const rows=await db.execute<{id:string;filename:string;status:string;duplicate_reason:string|null;target_invoice_id:string|null;target_entry_id:string|null}>(sql`SELECT id::text,filename,status,duplicate_reason,target_invoice_id::text,target_entry_id::text FROM inbox_item WHERE ledger_id=${ledgerId}::uuid ORDER BY created_at DESC LIMIT 200`)
  return <AutomationShell context="AI" ledgerId={ledgerId} title="Receipt inbox">
    <ActionForm action={automationAction}>
      <input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="command" value="upload"/>
      <div className="flex flex-wrap items-center gap-3"><label>Receipt <input name="file" type="file" className={FIELD} accept=".pdf,.png,.jpg,.jpeg" required/></label>
        <label><input type="checkbox" name="extract" defaultChecked/> Use my saved AI service</label><button className={BUTTON}>Upload receipt</button></div>
      <p className="mt-2 text-sm text-ink-muted">PDF, JPEG or PNG · up to 8 MB · PDF up to 30 pages. Split separate receipts before upload. Manual review is available without AI.</p>
    </ActionForm>
    <div className="mt-6 divide-y divide-line">{rows.map(row=><div key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div><Link className="font-medium underline" href={`/ledger/${ledgerId}/readings/inbox/${row.id}`}>{row.filename}</Link>{row.duplicate_reason&&<p className="text-sm text-ink-muted">Possible duplicate — review required</p>}</div>
      <div className="flex gap-3 text-sm"><span>{row.status.replaceAll('_',' ')}</span>{row.target_invoice_id&&<Link className="underline" href={`/ledger/${ledgerId}/invoices/${row.target_invoice_id}`}>Recorded document</Link>}{row.target_entry_id&&<Link className="underline" href={`/ledger/${ledgerId}/entries/${row.target_entry_id}`}>Recorded entry</Link>}</div>
    </div>)}{!rows.length&&<p className="py-5 text-ink-muted">No receipts uploaded in this ledger.</p>}</div>
  </AutomationShell>
}

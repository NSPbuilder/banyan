import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireAutomationLedger } from '@/lib/automation-gate'
import { BusinessWorkspace as AutomationShell } from '@/components/BusinessWorkspace'
import { BUTTON } from '@/lib/ui'
export const dynamic='force-dynamic'
export default async function MailPage({params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params;await requireAutomationLedger(ledgerId,['/invoices'])
  const rows=await db.execute<{id:string;subject:string;status:string;recipients:string[];created_at:string;last_error:string|null}>(sql`SELECT id::text,subject,status,recipients,created_at::text,last_error FROM email_message WHERE ledger_id=${ledgerId}::uuid ORDER BY created_at DESC LIMIT 200`)
  return <AutomationShell context="Income" ledgerId={ledgerId} title="Customer email"><Link className={BUTTON} href={`/ledger/${ledgerId}/income/email/new`}>Preview customer email</Link>
    <p className="my-4 text-sm text-ink-muted">SMTP accepted means the provider accepted the envelope. Delivery is not confirmed without a provider receipt. Unknown results require a provider check before any new send.</p>
    <div className="divide-y divide-line">{rows.map(m=><div key={m.id} className="flex flex-wrap justify-between gap-3 py-3"><div><Link className="font-medium underline" href={`/ledger/${ledgerId}/income/email/${m.id}`}>{m.subject}</Link><p className="text-sm text-ink-muted">{m.recipients.join(', ')}</p>{m.last_error&&<p className="text-sm">{m.last_error}</p>}</div><span className="text-sm">{m.status.replaceAll('_',' ')} · {m.created_at.slice(0,10)}</span></div>)}{!rows.length&&<p>No email previews or sends yet.</p>}</div>
  </AutomationShell>
}

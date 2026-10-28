import Link from 'next/link'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireAutomationLedger } from '@/lib/automation-gate'
import { mailColumns,type MailMessage } from '@/lib/mail'
import { BusinessWorkspace as AutomationShell } from '@/components/BusinessWorkspace'
import { AutomationForm as ActionForm } from '@/components/AutomationForm'
import { automationAction } from '@/app/automation-actions'
import { BUTTON,QUIET } from '@/lib/ui'
export const dynamic='force-dynamic'
export default async function MailDetail({params}:{params:Promise<{ledgerId:string;messageId:string}>}) {
  const {ledgerId,messageId}=await params;await requireAutomationLedger(ledgerId,['/invoices'])
  const [m]=await db.execute<MailMessage>(sql`SELECT ${mailColumns} FROM email_message WHERE id=${messageId}::uuid AND ledger_id=${ledgerId}::uuid`);if(!m)notFound()
  return <AutomationShell context="Income" ledgerId={ledgerId} title="Email preview and record">
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><section className="min-w-0 space-y-3">
      <p>Status: <strong>{m.status.replaceAll('_',' ')}</strong></p>{m.last_error&&<p className="text-sm">{m.last_error}</p>}
      <dl className="space-y-2 break-words text-sm"><div><dt className="text-ink-muted">From</dt><dd>{m.snapshot.from}</dd></div><div><dt className="text-ink-muted">To</dt><dd>{m.recipients.join(', ')}</dd></div><div><dt className="text-ink-muted">Cc</dt><dd>{m.cc.join(', ')||'None'}</dd></div><div><dt className="text-ink-muted">Subject</dt><dd className="font-medium">{m.subject}</dd></div><div><dt className="text-ink-muted">Message</dt><dd className="whitespace-pre-wrap">{m.body}</dd></div><div><dt className="text-ink-muted">Prepared</dt><dd>{m.snapshot.generatedAt} · as of {m.snapshot.asOf}</dd></div></dl>
      <a className={QUIET} href={`/ledger/${ledgerId}/income/email/${m.id}/file`}>Download approved PDF</a>
      {m.status==='preview'&&<ActionForm action={automationAction}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="command" value="send"/><input type="hidden" name="id" value={m.id}/><button className={BUTTON}>Send email</button></ActionForm>}
      {['accepted','delivery_unknown','bounced','failed','skipped','paused'].includes(m.status)&&<Link className={QUIET} href={`/ledger/${ledgerId}/income/email/new?parent=${m.id}`}>Prepare a new explicit send</Link>}
      {m.status==='delivery_unknown'&&<p className="text-sm">The provider may have accepted this email. Check its records before authorizing another send. This job will not retry automatically.</p>}
    </section><iframe title="Approved email attachment" className="h-[36rem] w-full rounded-control border border-line" src={`/ledger/${ledgerId}/income/email/${m.id}/file?preview=1`}/></div>
  </AutomationShell>
}

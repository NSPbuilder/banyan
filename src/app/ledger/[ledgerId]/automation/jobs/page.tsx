import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { requireLedger } from '@/lib/gate'
import { AutomationShell } from '@/components/AutomationShell'
import { AutomationForm as ActionForm } from '@/components/AutomationForm'
import { automationAction } from '@/app/automation-actions'
import { QUIET } from '@/lib/ui'
export const dynamic='force-dynamic'
export default async function JobsPage({params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params,me=await requireLedger(ledgerId,'/automation')
  const rows=await db.execute<{id:string;job_type:string;status:string;attempt:number;max_attempts:number;last_error:string|null;run_at:string}>(sql`SELECT id::text,job_type,status,attempt,max_attempts,last_error,run_at::text FROM background_job WHERE ledger_id=${ledgerId}::uuid AND (${me.kind!=='user'} OR actor_user_id=${me.id}::uuid) ORDER BY created_at DESC LIMIT 200`)
  const [heartbeat]=await db.execute<{last:string|null}>(sql`SELECT max(heartbeat_at)::text AS last FROM automation_worker`)
  return <AutomationShell ledgerId={ledgerId} title="Back desk"><p className="mb-4 text-sm">Last worker heartbeat: {heartbeat.last??'No worker has run'}. Installation {process.env.AUTOMATION_ENABLED==='true'?'enabled':'paused'}.</p>
    <div className="divide-y divide-line">{rows.map(j=><section key={j.id} className="flex flex-wrap items-start justify-between gap-3 py-4"><div><p className="font-medium">{j.job_type.replaceAll('_',' ')}</p><p className="mt-1 text-sm">{j.status.replaceAll('_',' ')} · attempt {j.attempt}/{j.max_attempts} · scheduled {j.run_at}</p>{j.last_error&&<p className="mt-2 max-w-3xl text-sm">{j.last_error}</p>}</div>
      {!['succeeded','skipped','delivery_unknown'].includes(j.status)&&<ActionForm action={automationAction}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="command" value="job"/><input type="hidden" name="id" value={j.id}/><div className="flex gap-2"><button className={QUIET} name="operation" value="pause">Pause</button>{j.job_type!=='email_send'&&['failed','paused'].includes(j.status)&&<button className={QUIET} name="operation" value="retry">Retry with current authorization</button>}</div></ActionForm>}
    </section>)}{!rows.length&&<p>No tasks in this ledger.</p>}</div>
  </AutomationShell>
}

import 'server-only'
import { sql } from 'drizzle-orm'
import type { Tx } from './acting'

/** Whole-database restore boundary. Call before serving users or workers. */
export async function pauseRestoredAutomation(tx:Tx) {
  const [mcp]=await tx.execute<{present:boolean}>(sql`SELECT to_regclass('public.mcp_credential') IS NOT NULL AS present`)
  if(mcp.present)await tx.execute(sql`UPDATE mcp_credential SET revoked_at=COALESCE(revoked_at,clock_timestamp())`)
  const [integrations]=await tx.execute<{present:boolean}>(sql`SELECT to_regclass('public.payment_connection') IS NOT NULL AS present`)
  if(integrations.present){
    await tx.execute(sql`UPDATE payment_connection SET enabled=false,verified_at=NULL,binding_attached=false,version=version+1`)
    await tx.execute(sql`UPDATE inbound_connection SET enabled=false,binding_attached=false,version=version+1`)
    await tx.execute(sql`UPDATE portal_invitation SET revoked_at=COALESCE(revoked_at,clock_timestamp())`)
    await tx.execute(sql`UPDATE portal_session SET revoked_at=COALESCE(revoked_at,clock_timestamp())`)
    await tx.execute(sql`UPDATE checkout_request SET status='needs_accounting_review',checkout_url=NULL,last_error='Restored database: reconcile current provider objects before resuming.' WHERE status IN ('creating','open')`)
  }
  const [imports]=await tx.execute<{present:boolean}>(sql`SELECT to_regclass('public.migration_run') IS NOT NULL AS present`)
  if(imports.present)await tx.execute(sql`UPDATE migration_run SET status='restored_paused',actor_user_id=NULL,last_error='Restored database: review the current source digest and reauthorize.' WHERE status NOT IN ('active','cancelled','draft')`)
  const [exists]=await tx.execute<{present:boolean}>(sql`SELECT to_regclass('public.background_job') IS NOT NULL AS present`)
  if(!exists.present)return {paused:false}
  await tx.execute(sql`UPDATE automation_setting SET enabled=false,mail_enabled=false,version=version+1`)
  await tx.execute(sql`UPDATE recurring_template SET active=false,last_error='Restored database: review and authorize this template again.'`)
  await tx.execute(sql`UPDATE reminder_rule SET enabled=false,paused=true,pause_reason='Restored database: review and authorize reminders again.'`)
  await tx.execute(sql`UPDATE inbox_item SET status='needs_review',last_error='Extraction interrupted by restore. Manual review is available.' WHERE status='processing'`)
  await tx.execute(sql`UPDATE background_job SET status=CASE WHEN job_type='email_send' AND status='running' THEN 'delivery_unknown' ELSE 'paused' END,
    generation=generation+1,locked_until=NULL,last_error='Restored database: review before creating fresh authorization.' WHERE status IN ('queued','running','paused')`)
  await tx.execute(sql`UPDATE email_message SET status=CASE WHEN status='sending' THEN 'delivery_unknown' ELSE 'paused' END,
    last_error='Restored database: create a fresh approved preview.' WHERE status IN ('preview','queued','sending','paused')`)
  await tx.execute(sql`DELETE FROM automation_worker`)
  return {paused:true}
}

import 'server-only'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Tx } from './acting'
import { auditRow } from './audit-row'
import { AutomationError,automationScope,automationAudit,type AutomationActor,type AutomationScope } from './automation-access'

export type Job={id:string;entity_id:string;ledger_id:string;actor_user_id:string|null;request_id:string;worker_id:string|null;
  job_type:'inbox_extract'|'recurring_draft'|'email_send'|'payment_event';payment_event_id:string|null;inbox_item_id:string|null;recurring_template_id:string|null;
  email_message_id:string|null;scheduled_for:string|null;status:string;generation:string;attempt:number;max_attempts:number}
const jobColumns=sql.raw('id::text,entity_id::text,ledger_id::text,actor_user_id::text,request_id::text,worker_id::text,job_type,payment_event_id::text,inbox_item_id::text,recurring_template_id::text,email_message_id::text,scheduled_for::text,status,generation::text,attempt,max_attempts')
export async function enqueueJob(tx:Tx,s:AutomationScope,input:{type:Job['job_type'];key:string;inboxId?:string;templateId?:string;emailId?:string;scheduledFor?:string;eventId?:string}) {
  const [created]=await tx.execute<{id:string}>(sql`INSERT INTO background_job(entity_id,ledger_id,actor_user_id,request_id,job_type,dedupe_key,inbox_item_id,recurring_template_id,email_message_id,scheduled_for,payment_event_id)
    VALUES (${s.entity_id}::uuid,${s.ledgerId}::uuid,${s.userId}::uuid,${s.actor.requestId}::uuid,${input.type},${input.key},
      ${input.inboxId??null}::uuid,${input.templateId??null}::uuid,${input.emailId??null}::uuid,${input.scheduledFor??null}::date,${input.eventId??null}::uuid)
    ON CONFLICT(entity_id,ledger_id,job_type,dedupe_key) DO NOTHING RETURNING id::text`)
  if(created)return created.id
  const [prior]=await tx.execute<Job>(sql`SELECT ${jobColumns} FROM background_job WHERE entity_id=${s.entity_id}::uuid
    AND ledger_id=${s.ledgerId}::uuid AND job_type=${input.type} AND dedupe_key=${input.key}`)
  if(prior.inbox_item_id!==(input.inboxId??null)||prior.recurring_template_id!==(input.templateId??null)||prior.email_message_id!==(input.emailId??null)
    ||prior.scheduled_for!==(input.scheduledFor??null)||prior.payment_event_id!==(input.eventId??null))throw new AutomationError('IDEMPOTENCY_CONFLICT','This work key was already used for different input.')
  return prior.id
}
export async function workerHeartbeat(workerId:string) {
  await db.execute(sql`INSERT INTO automation_worker(id) VALUES (${workerId}::uuid)
    ON CONFLICT(id) DO UPDATE SET heartbeat_at=clock_timestamp()`)
}
export async function claimJob(workerId:string):Promise<Job|null> {
  if(process.env.AUTOMATION_ENABLED!=='true')return null
  return db.transaction(async tx=>{
    // Serialize claims per company, then count active leases. Multiple workers
    // cannot each observe the same spare slot and exceed the company limit.
    const [company]=await tx.execute<{entity_id:string;max_concurrency:number}>(sql`
      SELECT s.entity_id::text,s.max_concurrency FROM automation_setting s JOIN entity e ON e.id=s.entity_id
      WHERE s.enabled AND e.archived_at IS NULL AND EXISTS(SELECT 1 FROM background_job j
        WHERE j.entity_id=s.entity_id AND ((j.status='queued' AND j.run_at<=clock_timestamp())
          OR (j.status='running' AND j.locked_until<=clock_timestamp())))
        AND ((SELECT count(*) FROM background_job j WHERE j.entity_id=s.entity_id
          AND j.status='running' AND j.locked_until>clock_timestamp())<s.max_concurrency
          OR EXISTS(SELECT 1 FROM background_job j WHERE j.entity_id=s.entity_id AND j.status='running' AND j.locked_until<=clock_timestamp()))
      ORDER BY (SELECT min(run_at) FROM background_job j WHERE j.entity_id=s.entity_id AND j.status IN ('queued','running'))
      LIMIT 1 FOR UPDATE OF s SKIP LOCKED`)
    if(!company)return null
    const expired=await tx.execute<Job>(sql`SELECT ${jobColumns} FROM background_job WHERE entity_id=${company.entity_id}::uuid
      AND status='running' AND locked_until<=clock_timestamp() FOR UPDATE SKIP LOCKED`)
    for(const j of expired) {
      const state=j.job_type==='email_send'?'delivery_unknown':j.attempt>=j.max_attempts?'failed':'queued'
      await tx.execute(sql`UPDATE background_job SET status=${state},generation=generation+1,locked_until=NULL,
        last_error=${state==='delivery_unknown'?'Worker lease expired; SMTP may already have accepted this message. Reconcile before any resend.':'Worker lease expired.'}
        WHERE id=${j.id}::uuid`)
      if(j.email_message_id)await tx.execute(sql`UPDATE email_message SET status='delivery_unknown',last_error='Worker lease expired; provider result unknown.' WHERE id=${j.email_message_id}::uuid`)
      await auditRow(tx,{actor:'automation worker',action:'job_lease_expired',table:'background_job',recordId:j.id,
        entityId:j.entity_id,ledgerId:j.ledger_id,scope:'company',after:{status:state},context:{source:'job',actorType:'worker',actorId:j.worker_id,authorizedBy:j.actor_user_id,requestId:j.request_id}})
    }
    const [active]=await tx.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM background_job
      WHERE entity_id=${company.entity_id}::uuid AND status='running' AND locked_until>clock_timestamp()`)
    if(active.n>=company.max_concurrency)return null
    const [next]=await tx.execute<Job>(sql`SELECT ${jobColumns} FROM background_job WHERE entity_id=${company.entity_id}::uuid
      AND status='queued' AND run_at<=clock_timestamp() AND attempt<max_attempts
      ORDER BY CASE job_type WHEN 'email_send' THEN 0 WHEN 'recurring_draft' THEN 1 ELSE 2 END,run_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)
    if(!next)return null
    const [claimed]=await tx.execute<Job>(sql`UPDATE background_job SET status='running',attempt=attempt+1,generation=generation+1,
      locked_until=clock_timestamp()+interval '120 seconds',worker_id=${workerId}::uuid WHERE id=${next.id}::uuid RETURNING ${jobColumns}`)
    return claimed
  })
}
export const jobActor=(j:Job):AutomationActor=>({source:'job',userId:j.actor_user_id,requestId:j.request_id,workerId:j.worker_id??undefined})
export async function lockClaim(tx:Tx,j:Job) {
  const rows=await tx.execute(sql`SELECT 1 FROM background_job WHERE id=${j.id}::uuid AND status='running'
    AND generation=${j.generation}::bigint AND locked_until>clock_timestamp() FOR UPDATE`)
  if(!rows.length)throw new AutomationError('STALE_WORKER','This worker no longer owns the task.')
}
export async function completeJob(tx:Tx,j:Job,result:unknown,status='succeeded') {
  await lockClaim(tx,j)
  await tx.execute(sql`UPDATE background_job SET status=${status},locked_until=NULL,result=${JSON.stringify(result)}::jsonb,
    last_error=NULL WHERE id=${j.id}::uuid AND generation=${j.generation}::bigint`)
}
export async function failJob(j:Job,error:unknown,state:'failed'|'delivery_unknown'|'paused'|'retry'='failed') {
  const message=error instanceof AutomationError?error.message.slice(0,800):'Task failed. Review its input or server configuration; original data is retained.'
  return db.transaction(async tx=>{
    const rows=await tx.execute(sql`UPDATE background_job SET
      status=${state==='retry'&&j.attempt<j.max_attempts?'queued':state==='retry'?'failed':state},
      run_at=clock_timestamp()+${Math.min(3600,30*2**j.attempt)}*interval '1 second',locked_until=NULL,last_error=${message}
      WHERE id=${j.id}::uuid AND status='running' AND generation=${j.generation}::bigint AND locked_until>clock_timestamp() RETURNING id`)
    if(!rows.length)return {updated:false}
    if(j.email_message_id)await tx.execute(sql`UPDATE email_message SET status=${state==='retry'&&j.attempt<j.max_attempts?'queued':state==='retry'?'failed':state},last_error=${message} WHERE id=${j.email_message_id}::uuid`)
    if(j.inbox_item_id)await tx.execute(sql`UPDATE inbox_item SET status='failed',last_error=${message},version=version+1 WHERE id=${j.inbox_item_id}::uuid AND status<>'converted'`)
    await auditRow(tx,{actor:'automation worker',action:'job_attempt_failed',table:'background_job',recordId:j.id,
      entityId:j.entity_id,ledgerId:j.ledger_id,scope:'company',after:{status:state,attempt:j.attempt},reason:message,
      context:{source:'job',actorType:'worker',actorId:j.worker_id,authorizedBy:j.actor_user_id,requestId:j.request_id}})
    return {updated:true}
  })
}
export async function controlJob(ledgerId:string,id:string,actor:AutomationActor,operation:'pause'|'retry') {
  return db.transaction(async tx=>{
    const s=await automationScope(tx,ledgerId,actor)
    const [j]=await tx.execute<Job>(sql`SELECT ${jobColumns} FROM background_job WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid FOR UPDATE`)
    if(!j || (s.kind==='user'&&j.actor_user_id!==s.userId))throw new AutomationError('NO_ACCESS','This task is unavailable to you.')
    if(j.status==='delivery_unknown'||j.status==='succeeded')throw new AutomationError('NO_RETRY','Accepted or unknown external work cannot be retried. Inspect the original message and create a new explicit authorization if needed.')
    if(operation==='retry'&&j.job_type==='email_send')throw new AutomationError('NEW_MAIL_APPROVAL','Prepare a new approved email preview for a manual resend. Definite temporary failures retry automatically within their attempt limit.')
    if(operation==='retry'&&!['failed','paused'].includes(j.status))throw new AutomationError('STATE','Pause or wait for the current attempt first.')
    if(operation==='pause'&&j.job_type==='email_send'&&j.status==='running') {
      await tx.execute(sql`UPDATE background_job SET status='delivery_unknown',generation=generation+1,locked_until=NULL,
        last_error='Paused during SMTP delivery; provider result must be reconciled.' WHERE id=${id}::uuid`)
      await tx.execute(sql`UPDATE email_message SET status='delivery_unknown',last_error='Paused during SMTP delivery; provider result must be reconciled.' WHERE id=${j.email_message_id}::uuid`)
      await automationAudit(tx,s,'job_paused_unknown','background_job',id)
      return
    }
    await tx.execute(sql`UPDATE background_job SET status=${operation==='pause'?'paused':'queued'},generation=generation+1,
      attempt=CASE WHEN ${operation==='retry'} THEN 0 ELSE attempt END,actor_user_id=CASE WHEN ${operation==='retry'} THEN ${s.userId}::uuid ELSE actor_user_id END,
      request_id=CASE WHEN ${operation==='retry'} THEN ${s.actor.requestId}::uuid ELSE request_id END,locked_until=NULL,last_error=NULL,run_at=clock_timestamp() WHERE id=${id}::uuid`)
    if(j.email_message_id)await tx.execute(sql`UPDATE email_message SET status=${operation==='pause'?'paused':'queued'},last_error=NULL WHERE id=${j.email_message_id}::uuid`)
    if(j.inbox_item_id&&operation==='pause')await tx.execute(sql`UPDATE inbox_item SET status='needs_review',last_error='Extraction paused; manual review is available.' WHERE id=${j.inbox_item_id}::uuid AND status='processing'`)
    await automationAudit(tx,s,'job_'+operation,'background_job',id)
  })
}
export const newWorkerId=()=>randomUUID()

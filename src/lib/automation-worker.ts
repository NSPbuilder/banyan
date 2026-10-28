import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { workerHeartbeat,claimJob,failJob,newWorkerId,type Job } from './jobs'
import { queueRecurring,runRecurring } from './recurring'
import { runInbox } from './inbox'
import { queueReminders,runMail } from './mail'
import { AutomationError } from './automation-access'
import { auditRow } from './audit-row'
import {runPaymentEvent,expireInvalidatedCheckouts} from './payment-events'

/** A failure cannot overwrite an authorization edited after failJob committed. */
export async function pauseFailedRecurring(job:Job,workerId:string,reason:string) {
  if(!job.recurring_template_id)return false
  return db.transaction(async tx=>{
    const current=await tx.execute(sql`SELECT id FROM background_job WHERE id=${job.id}::uuid
      AND generation=${job.generation}::bigint AND status='paused' FOR UPDATE`)
    if(!current.length)return false
    await tx.execute(sql`UPDATE recurring_template SET active=false,last_error=${reason} WHERE id=${job.recurring_template_id}::uuid`)
    await auditRow(tx,{actor:'automation worker',action:'recurring_paused',table:'recurring_template',recordId:job.recurring_template_id!,entityId:job.entity_id,ledgerId:job.ledger_id,scope:'company',reason,context:{source:'job',actorType:'worker',actorId:workerId,authorizedBy:job.actor_user_id,requestId:job.request_id}})
    return true
  })
}

/** Run a bounded batch. An OS scheduler owns repetition and process restart. */
export async function automationBatch(max=12,workerId=newWorkerId()) {
  await (await import('./module-compatibility')).assertDeploymentModules()
  if(!Number.isInteger(max)||max<1||max>12)throw new AutomationError('BATCH','A worker batch must contain 1–12 attempts.')
  if(process.env.AUTOMATION_ENABLED!=='true')return {paused:true,workerId,attempts:0}
  await workerHeartbeat(workerId)
  await expireInvalidatedCheckouts(max,workerId)
  await queueReminders(new Date(),max,workerId)
  let attempts=0
  for(;attempts<max;attempts++) {
    await queueRecurring(new Date(),max,workerId)
    const job=await claimJob(workerId)
    if(!job)break
    try {
      if(job.job_type==='recurring_draft')await runRecurring(job)
      else if(job.job_type==='inbox_extract')await runInbox(job)
      else if(job.job_type==='payment_event')await runPaymentEvent(job)
      else await runMail(job)
    } catch(error) {
      const revoked=error instanceof AutomationError&&['ACTOR_REVOKED','COMPANY_UNAVAILABLE','MODULE_DISABLED','NO_ACCESS','PAUSED','MAIL_PAUSED'].includes(error.code)
      const invalidReference=error instanceof AutomationError&&['ACCOUNT','PARTY','CURRENCY','UNBALANCED','TAX','SOURCE','TEMPLATE','SCHEDULE'].includes(error.code)
      if(error instanceof AutomationError&&error.code==='STALE_WORKER')continue
      const outcome=await failJob(job,error,revoked||invalidReference?'paused':job.job_type==='email_send'?'failed':'retry')
      if(outcome.updated&&job.recurring_template_id&&(invalidReference||revoked))await pauseFailedRecurring(job,workerId,error instanceof AutomationError?error.message:'Review template references.')
    }
    await workerHeartbeat(workerId)
  }
  return {paused:false,workerId,attempts}
}

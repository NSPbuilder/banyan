import 'server-only'
import { randomUUID } from 'node:crypto'
import { auditRow } from './audit-row'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import type { Tx } from './acting'
import { AutomationError,automationScope,automationAudit,companyClock,type AutomationActor } from './automation-access'
import { captureDraftSnapshot,createSnapshotDraft,validateDraftSnapshot,validBusinessDate,type DraftSnapshot } from './automation-drafts'
import { enqueueJob,lockClaim,completeJob,jobActor,type Job } from './jobs'
import { withDocumentWrite } from './edit-leases'
import type { EditContext } from './edit-proof'

import { nextOccurrence,validateRule,type RecurrenceRule } from './recurrence-calendar'
export { nextOccurrence,validateRule,futureOccurrences,type RecurrenceRule } from './recurrence-calendar'
export type RecurringTemplate={id:string;entity_id:string;ledger_id:string;actor_user_id:string|null;title:string;document_type:DraftSnapshot['type'];snapshot:DraftSnapshot;
  frequency:RecurrenceRule['frequency'];day_mode:RecurrenceRule['dayMode'];anchor_date:string;next_date:string;day_of_month:number;end_date:string|null;
  max_occurrences:number|null;occurrence_count:number;due_days:number;active:boolean;version:string;last_error:string|null}
export const templateColumns=sql.raw('id::text,entity_id::text,ledger_id::text,actor_user_id::text,title,document_type,snapshot,frequency,day_mode,anchor_date::text,next_date::text,day_of_month,end_date::text,max_occurrences,occurrence_count,due_days,active,version::text,last_error')
const asRule=(t:RecurringTemplate):RecurrenceRule=>({frequency:t.frequency,dayMode:t.day_mode,anchorDate:t.anchor_date,dayOfMonth:t.day_of_month})
export async function saveRecurring(ledgerId:string,actor:AutomationActor,input:{id?:string;sourceId:string;documentType:DraftSnapshot['type'];title:string;rule:RecurrenceRule;dueDays:number;endDate?:string;maxOccurrences?:number;active:boolean},edit?:EditContext) {
  validateRule(input.rule)
  if(!input.title.trim()||input.title.length>200||!Number.isInteger(input.dueDays)||input.dueDays<0||input.dueDays>366
    ||(input.maxOccurrences!==undefined&&(!Number.isInteger(input.maxOccurrences)||input.maxOccurrences<1||input.maxOccurrences>100000)))throw new AutomationError('TEMPLATE','Enter a title, valid terms and occurrence limit.')
  if(input.endDate && validBusinessDate(input.endDate)<input.rule.anchorDate)throw new AutomationError('END_DATE','The end date precedes the start.')
  const command=async(tx:Tx)=>{
    const s=await automationScope(tx,ledgerId,actor,{seat:input.documentType==='entry'?'/entries':'/invoices'})
    const [existing]=input.id?await tx.execute<RecurringTemplate>(sql`SELECT ${templateColumns} FROM recurring_template WHERE id=${input.id}::uuid AND ledger_id=${ledgerId}::uuid FOR UPDATE`):[]
    if(input.id&&(!existing||existing.document_type!==input.documentType))throw new AutomationError('TEMPLATE','The template is unavailable or its document type changed.')
    const snapshot=input.sourceId?await captureDraftSnapshot(tx,s,input.documentType,input.sourceId):existing?.snapshot
    if(!snapshot)throw new AutomationError('SOURCE','Choose an existing source document.')
    const first=nextOccurrence(input.rule);await validateDraftSnapshot(tx,s,snapshot,first)
    let id=input.id
    if(id) {
      const [old]=await tx.execute<RecurringTemplate>(sql`SELECT ${templateColumns} FROM recurring_template WHERE id=${id}::uuid AND ledger_id=${ledgerId}::uuid FOR UPDATE`)
      if(!old||old.document_type!==input.documentType)throw new AutomationError('TEMPLATE','The template is unavailable or its document kind changed.')
      // A changed rule starts only after the latest generated business date.
      const [past]=await tx.execute<{last:string|null}>(sql`SELECT max(scheduled_for)::text AS last FROM recurring_occurrence WHERE template_id=${id}::uuid`)
      let next=first;let advances=0;while(past.last&&next<=past.last){if(++advances>100000)throw new AutomationError('SCHEDULE','Choose a newer start date.');next=nextOccurrence(input.rule,next)}
      await tx.execute(sql`UPDATE recurring_template SET title=${input.title.trim()},snapshot=${JSON.stringify(snapshot)}::jsonb,
        frequency=${input.rule.frequency},day_mode=${input.rule.dayMode},anchor_date=${input.rule.anchorDate}::date,day_of_month=${input.rule.dayOfMonth},next_date=${next}::date,
        end_date=${input.endDate??null}::date,max_occurrences=${input.maxOccurrences??null},due_days=${input.dueDays},active=${input.active},last_error=NULL,actor_user_id=${s.userId}::uuid WHERE id=${id}::uuid`)
      // A queued date belongs to the reviewed future rule. Fence any older
      // claim; reuse its stable key only when it is still the next date.
      await tx.execute(sql`UPDATE background_job SET
        status=CASE WHEN scheduled_for<>${next}::date THEN 'skipped' WHEN ${input.active} THEN 'queued' ELSE 'paused' END,
        generation=generation+1,locked_until=NULL,
        attempt=CASE WHEN scheduled_for=${next}::date THEN 0 ELSE attempt END,
        run_at=CASE WHEN scheduled_for=${next}::date THEN clock_timestamp() ELSE run_at END,
        actor_user_id=CASE WHEN scheduled_for=${next}::date THEN ${s.userId}::uuid ELSE actor_user_id END,
        request_id=CASE WHEN scheduled_for=${next}::date THEN ${s.actor.requestId}::uuid ELSE request_id END,
        last_error='Template edited: older worker authorization replaced.'
        WHERE recurring_template_id=${id}::uuid AND status IN ('queued','running','paused','failed','skipped')`)
    } else {
      const [row]=await tx.execute<{id:string}>(sql`INSERT INTO recurring_template(entity_id,ledger_id,actor_user_id,title,document_type,snapshot,frequency,day_mode,anchor_date,next_date,day_of_month,end_date,max_occurrences,due_days,active)
        VALUES (${s.entity_id}::uuid,${ledgerId}::uuid,${s.userId}::uuid,${input.title.trim()},${input.documentType},${JSON.stringify(snapshot)}::jsonb,
          ${input.rule.frequency},${input.rule.dayMode},${input.rule.anchorDate}::date,${first}::date,${input.rule.dayOfMonth},${input.endDate??null}::date,${input.maxOccurrences??null},${input.dueDays},${input.active}) RETURNING id::text`);id=row.id
    }
    await automationAudit(tx,s,'recurring_saved','recurring_template',id,{rule:input.rule,active:input.active,sourceId:input.sourceId})
    return {id}
  }
  if(input.id) {
    if(!edit)throw new AutomationError('EDIT_PROOF','An existing template needs its version and live edit lease.')
    return withDocumentWrite({ledgerId,type:'recurring',id:input.id},edit,command)
  }
  return db.transaction(command)
}
async function generate(tx:Tx,ledgerId:string,templateId:string,date:string,actor:AutomationActor,j?:Job) {
  const s=await automationScope(tx,ledgerId,actor,{enabled:true})
  if(j)await lockClaim(tx,j)
  const [t]=await tx.execute<RecurringTemplate>(sql`SELECT ${templateColumns} FROM recurring_template WHERE id=${templateId}::uuid AND ledger_id=${ledgerId}::uuid FOR UPDATE`)
  if(!t)throw new AutomationError('TEMPLATE','This recurring template is unavailable.')
  await automationScope(tx,ledgerId,actor,{enabled:true,seat:t.document_type==='entry'?'/entries':'/invoices'})
  const [old]=await tx.execute<{id:string;target_invoice_id:string|null;target_entry_id:string|null}>(sql`
    SELECT id::text,target_invoice_id::text,target_entry_id::text FROM recurring_occurrence WHERE entity_id=${s.entity_id}::uuid
      AND ledger_id=${ledgerId}::uuid AND template_id=${templateId}::uuid AND scheduled_for=${date}::date`)
  if(old){if(j)await completeJob(tx,j,{occurrenceId:old.id});return {occurrenceId:old.id,invoiceId:old.target_invoice_id,entryId:old.target_entry_id,replayed:true}}
  if(!t.active||date!==t.next_date||t.end_date&&date>t.end_date||t.max_occurrences!==null&&t.occurrence_count>=t.max_occurrences)
    throw new AutomationError('SCHEDULE','This occurrence is paused, finished or no longer the next scheduled business date.')
  const target=await createSnapshotDraft(tx,s,t.snapshot,date,t.due_days)
  const [occurrence]=await tx.execute<{id:string}>(sql`INSERT INTO recurring_occurrence(entity_id,ledger_id,template_id,scheduled_for,template_version,template_snapshot,timezone,target_invoice_id,target_entry_id)
    VALUES (${s.entity_id}::uuid,${ledgerId}::uuid,${templateId}::uuid,${date}::date,${t.version}::bigint,${JSON.stringify(t.snapshot)}::jsonb,
      ${s.setting!.timezone},${target.invoiceId}::uuid,${target.entryId}::uuid) RETURNING id::text`)
  const next=nextOccurrence(asRule(t),date),finished=!!(t.end_date&&next>t.end_date||t.max_occurrences!==null&&t.occurrence_count+1>=t.max_occurrences)
  await tx.execute(sql`UPDATE recurring_template SET next_date=${next}::date,occurrence_count=occurrence_count+1,active=${!finished},last_error=NULL WHERE id=${templateId}::uuid`)
  await automationAudit(tx,s,'recurring_draft_created','recurring_occurrence',occurrence.id,{scheduledFor:date,templateId,templateVersion:t.version,...target})
  if(j)await completeJob(tx,j,{occurrenceId:occurrence.id,...target})
  return {occurrenceId:occurrence.id,...target,replayed:false}
}
export const generateOccurrence=(ledgerId:string,id:string,date:string,actor:AutomationActor,edit:EditContext)=>withDocumentWrite({ledgerId,type:'recurring',id},edit,tx=>generate(tx,ledgerId,id,validBusinessDate(date),actor))
export async function runRecurring(j:Job) {return db.transaction(tx=>generate(tx,j.ledger_id,j.recurring_template_id!,j.scheduled_for!,jobActor(j),j))}
export async function queueRecurring(at=new Date(),limit=12,workerId=randomUUID()) {
  if(process.env.AUTOMATION_ENABLED!=='true')return 0
  // Interleave companies and omit dates already represented by a durable job.
  const templates=await db.execute<RecurringTemplate>(sql`WITH candidates AS (
    SELECT t.*,row_number() OVER (PARTITION BY t.entity_id ORDER BY t.next_date,t.id) AS company_order
    FROM recurring_template t JOIN automation_setting a ON a.entity_id=t.entity_id AND a.enabled
    WHERE t.active AND NOT EXISTS (SELECT 1 FROM background_job j WHERE j.recurring_template_id=t.id AND j.scheduled_for=t.next_date)
  ) SELECT ${templateColumns} FROM candidates ORDER BY company_order,next_date,id LIMIT 2000`)
  let queued=0
  for(const t of templates) {
    if(queued>=limit)break
    const [setting]=await db.execute<{timezone:string;enabled:boolean}>(sql`SELECT timezone,enabled FROM automation_setting WHERE entity_id=${t.entity_id}::uuid`)
    if(!setting?.enabled || t.next_date>companyClock(setting.timezone,at).date)continue
    try {await db.transaction(async tx=>{
      const s=await automationScope(tx,t.ledger_id,{source:'job',userId:t.actor_user_id,requestId:randomUUID(),workerId},{enabled:true,seat:t.document_type==='entry'?'/entries':'/invoices'})
      await enqueueJob(tx,s,{type:'recurring_draft',key:`${t.id}:${t.next_date}`,templateId:t.id,scheduledFor:t.next_date})
    });queued++} catch(error) {
      if(error instanceof AutomationError)await db.transaction(async tx=>{const changed=await tx.execute(sql`UPDATE recurring_template SET active=false,last_error=${error.message} WHERE id=${t.id}::uuid AND version=${t.version}::bigint RETURNING id`);if(changed.length)await auditRow(tx,{actor:'automation scheduler',action:'recurring_paused',table:'recurring_template',recordId:t.id,entityId:t.entity_id,ledgerId:t.ledger_id,scope:'company',reason:error.message,context:{source:'job',actorType:'worker',actorId:workerId,authorizedBy:t.actor_user_id}})})
      else throw error
    }
  }
  return queued
}

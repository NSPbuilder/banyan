import 'server-only'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Tx } from './acting'
import { liveAuth } from './auth-security'
import { auditRow } from './audit-row'

import { AutomationError } from './automation-errors'
export { AutomationError } from './automation-errors'
export type AutomationActor = { source:'ui'; sessionToken:string; requestId:string }
  | { source:'job'; userId:string|null; requestId:string; workerId?:string }
export const requestActor=(sessionToken:string):AutomationActor=>({source:'ui',sessionToken,requestId:randomUUID()})
export const validId=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

export async function automationScope(tx:Tx,ledgerId:string,actor:AutomationActor,
  options:{enabled?:boolean;mail?:boolean;seat?:string}={}) {
  if(!validId(ledgerId))throw new AutomationError('NO_LEDGER','Choose an available company.')
  const who=actor.source==='ui' ? await liveAuth(tx,actor.sessionToken) :
    (await tx.execute<{user_id:string;email:string;kind:string}>(sql`SELECT id::text AS user_id,email,kind FROM app_user
      WHERE id=${actor.userId}::uuid AND is_active
        AND (${process.env.AUTH_ADMIN_MFA_REQUIRED!=='true'} OR kind='user' OR mfa_secret_ciphertext IS NOT NULL)
      FOR SHARE`))[0]
  if(!who)throw new AutomationError('ACTOR_REVOKED','The person who authorized this work is unavailable. Review its authorization.')
  const [ledger]=await tx.execute<{entity_id:string;name:string;currency:string}>(sql`
    SELECT e.id::text AS entity_id,e.name,l.currency FROM entity e JOIN ledger l ON l.entity_id=e.id
    WHERE l.id=${ledgerId}::uuid AND e.archived_at IS NULL FOR SHARE OF e`)
  if(!ledger)throw new AutomationError('COMPANY_UNAVAILABLE','This company is archived or unavailable.')
  for(const seat of new Set(['/automation',...(options.seat?[options.seat]:[])])) {
    const [company]=await tx.execute<{enabled:boolean}>(sql`SELECT enabled FROM company_module_access
      WHERE entity_id=${ledger.entity_id}::uuid AND module=${seat} FOR SHARE`)
    if(company && !company.enabled)throw new AutomationError('MODULE_DISABLED','This company has disabled the required module.')
    if(who.kind==='user') {
      const grants=await tx.execute(sql`SELECT 1 FROM user_entity_module_access
        WHERE user_id=${who.user_id}::uuid AND entity_id=${ledger.entity_id}::uuid AND module=${seat} FOR SHARE`)
      if(!grants.length)throw new AutomationError('NO_ACCESS','The required company/module permission is no longer available.')
    }
  }
  const [setting]=await tx.execute<{enabled:boolean;mail_enabled:boolean;timezone:string;sender_email:string|null;version:string}>(sql`
    SELECT enabled,mail_enabled,timezone,sender_email,version::text FROM automation_setting
    WHERE entity_id=${ledger.entity_id}::uuid FOR SHARE`)
  if(options.enabled && (!setting?.enabled || process.env.AUTOMATION_ENABLED!=='true'))
    throw new AutomationError('PAUSED','Automation is paused for this installation or company.')
  if(options.mail && !setting?.mail_enabled)throw new AutomationError('MAIL_PAUSED','Company email is disabled.')
  await acting(tx,who.email)
  return {...ledger,ledgerId,userId:who.user_id,email:who.email,kind:who.kind,setting,actor}
}
export type AutomationScope=Awaited<ReturnType<typeof automationScope>>
export function automationAudit(tx:Tx,s:AutomationScope,action:string,table:string,id:string,after?:unknown,reason?:string) {
  return auditRow(tx,{actor:s.email,action,table,recordId:id,entityId:s.entity_id,ledgerId:s.ledgerId,scope:'company',
    after,reason,context:{source:s.actor.source,actorType:s.actor.source==='job'?'worker':'user',actorId:s.actor.source==='job'?(s.actor.workerId??'scheduler'):s.userId,authorizedBy:s.actor.source==='job'?s.userId:undefined,requestId:s.actor.requestId}})
}
export function validTimezone(zone:string) {
  try{new Intl.DateTimeFormat('en',{timeZone:zone}).format();return zone}catch{throw new AutomationError('TIMEZONE','Choose a valid IANA time zone.')}
}
export function companyClock(zone:string,at=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(at)
  const get=(kind:string)=>parts.find(p=>p.type===kind)?.value??''
  return {date:`${get('year')}-${get('month')}-${get('day')}`,hour:Number(get('hour'))}
}
export async function configureAutomation(ledgerId:string,actor:AutomationActor,input:{version:string;enabled:boolean;mailEnabled:boolean;timezone:string;senderEmail:string}) {
  validTimezone(input.timezone)
  if(input.senderEmail && !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.senderEmail))throw new AutomationError('EMAIL','Enter a single valid sender email address.')
  return db.transaction(async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('company-service:'||(SELECT entity_id::text FROM ledger WHERE id=${ledgerId}::uuid),0))`)
    const s=await automationScope(tx,ledgerId,actor)
    if(s.kind==='user')throw new AutomationError('OWNER_REQUIRED','Only a company administrator can enable automation and email.')
    const [previous]=await tx.execute<{version:string}>(sql`SELECT version::text FROM automation_setting WHERE entity_id=${s.entity_id}::uuid FOR UPDATE`)
    if((previous?.version??'0')!==input.version)throw new AutomationError('STALE','Settings changed. Reload before saving.')
    await tx.execute(sql`INSERT INTO automation_setting(entity_id,enabled,mail_enabled,timezone,sender_email)
      VALUES (${s.entity_id}::uuid,${input.enabled},${input.mailEnabled},${input.timezone},${input.senderEmail||null})
      ON CONFLICT(entity_id) DO UPDATE SET enabled=EXCLUDED.enabled,mail_enabled=EXCLUDED.mail_enabled,
        timezone=EXCLUDED.timezone,sender_email=EXCLUDED.sender_email,version=automation_setting.version+1,updated_at=clock_timestamp()`)
    if(!input.enabled || !input.mailEnabled)await tx.execute(sql`WITH paused AS (UPDATE background_job SET status='paused',generation=generation+1,locked_until=NULL,
      last_error='Company automation or email paused; review before resuming.'
      WHERE entity_id=${s.entity_id}::uuid AND status='queued' AND (${!input.enabled} OR job_type='email_send') RETURNING email_message_id)
      UPDATE email_message SET status='paused',last_error='Company automation or email paused; prepare a fresh approved send.'
      WHERE id IN (SELECT email_message_id FROM paused WHERE email_message_id IS NOT NULL)`)
    await automationAudit(tx,s,'automation_configured','automation_setting',s.entity_id,{enabled:input.enabled,mailEnabled:input.mailEnabled,timezone:input.timezone})
  })
}

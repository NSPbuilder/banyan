import 'server-only'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {automationScope,automationAudit,AutomationError,type AutomationActor} from './automation-access'
import {sealIntegration,openIntegration} from './payment-provider'
import type {Tx} from './acting'

export type CompanyServices={version:string;sender_email:string|null;smtp_host:string|null;smtp_port:number;smtp_secure:boolean;smtp_username:string|null;has_password:boolean;reminder_days:number[];reminder_start_hour:number;reminder_end_hour:number;enabled:boolean;mail_enabled:boolean;timezone:string}
export const serviceColumns=sql.raw('version::text,sender_email,smtp_host,smtp_port,smtp_secure,smtp_username,smtp_password_ciphertext IS NOT NULL AS has_password,reminder_days,reminder_start_hour,reminder_end_hour,enabled,mail_enabled,timezone')
export const serviceDefaults:CompanyServices={version:'0',sender_email:null,smtp_host:null,smtp_port:587,smtp_secure:false,smtp_username:null,has_password:false,reminder_days:[3,7,14],reminder_start_hour:9,reminder_end_hour:17,enabled:false,mail_enabled:false,timezone:'America/Vancouver'}
export async function companyServices(ledgerId:string,actor:AutomationActor){
  return db.transaction(async tx=>{const s=await automationScope(tx,ledgerId,actor);const [row]=await tx.execute<CompanyServices>(sql`SELECT ${serviceColumns} FROM automation_setting WHERE entity_id=${s.entity_id}::uuid`);return {setting:row??serviceDefaults,canConfigure:s.kind!=='user',encryptionReady:(process.env.INTEGRATION_KEY_SECRET??'').trim().length>=32}})
}
async function lockSettings(tx:Tx,ledgerId:string,actor:AutomationActor,version:string){
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('company-service:'||(SELECT entity_id::text FROM ledger WHERE id=${ledgerId}::uuid),0))`)
  const s=await automationScope(tx,ledgerId,actor)
  if(s.kind==='user')throw new AutomationError('OWNER_REQUIRED','Only a company administrator can change service settings.')
  // Serialize creation and updates before scope read locks.
  const [row]=await tx.execute<{version:string;smtp_host:string|null;smtp_username:string|null;smtp_password_ciphertext:Buffer|null}>(sql`SELECT version::text,smtp_host,smtp_username,smtp_password_ciphertext FROM automation_setting WHERE entity_id=${s.entity_id}::uuid FOR UPDATE`)
  if((row?.version??'0')!==version)throw new AutomationError('STALE','Company settings changed. Reload before saving.')
  if(!row)await tx.execute(sql`INSERT INTO automation_setting(entity_id) VALUES(${s.entity_id}::uuid)`)
  return {s,row}
}
export function validateReminderSchedule(days:number[],startHour:number,endHour:number){
  if(!days.length||days.length>12||days.some(d=>!Number.isInteger(d)||d<1||d>365)||new Set(days).size!==days.length||!Number.isInteger(startHour)||!Number.isInteger(endHour)||startHour<0||endHour>24||startHour>=endHour)
    throw new AutomationError('REMINDER_RULE','Choose 1–12 distinct overdue days (1–365) and a valid local sending window.')
}
export async function saveCompanyReminderSchedule(ledgerId:string,actor:AutomationActor,input:{version:string;days:number[];startHour:number;endHour:number}){
  validateReminderSchedule(input.days,input.startHour,input.endHour)
  return db.transaction(async tx=>{const {s}=await lockSettings(tx,ledgerId,actor,input.version)
    await tx.execute(sql`UPDATE automation_setting SET reminder_days=${sql.param(input.days)},reminder_start_hour=${input.startHour},reminder_end_hour=${input.endHour},version=version+1,updated_at=clock_timestamp() WHERE entity_id=${s.entity_id}::uuid`)
    await automationAudit(tx,s,'company_reminder_schedule_saved','automation_setting',s.entity_id,{days:input.days,startHour:input.startHour,endHour:input.endHour})
  })
}
export async function saveCompanySmtp(ledgerId:string,actor:AutomationActor,input:{version:string;senderEmail:string;host:string;port:number;secure:boolean;username:string;password:string;clear:boolean}){
  const host=input.host.trim(),user=input.username.trim(),sender=input.senderEmail.trim()
  if(!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(sender)||sender.length>254)throw new AutomationError('EMAIL','Enter a valid sender email address.')
  if(!input.clear&&(!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|::1)$/.test(host)||host.length>253||!Number.isInteger(input.port)||input.port<1||input.port>65535))throw new AutomationError('SMTP_CONFIG','Enter an SMTP host name and a port from 1 to 65535.')
  if(user.length>320||input.password.length>4096)throw new AutomationError('SMTP_CONFIG','Check the SMTP username and password length.')
  return db.transaction(async tx=>{const {s,row}=await lockSettings(tx,ledgerId,actor,input.version)
    let encrypted:Buffer|null=null
    if(!input.clear&&user){
      if(input.password)encrypted=sealIntegration(input.password,s.entity_id,'smtp-password')
      else if(row?.smtp_password_ciphertext&&row.smtp_username===user&&row.smtp_host===host){openIntegration(row.smtp_password_ciphertext,s.entity_id,'smtp-password');encrypted=row.smtp_password_ciphertext}
      else throw new AutomationError('SMTP_CONFIG','Enter the password when changing the SMTP host or username.')
    }
    await tx.execute(sql`UPDATE automation_setting SET sender_email=${sender},smtp_host=${input.clear?null:host},smtp_port=${input.port},smtp_secure=${input.secure},smtp_username=${input.clear?null:user||null},smtp_password_ciphertext=${encrypted},version=version+1,updated_at=clock_timestamp() WHERE entity_id=${s.entity_id}::uuid`)
    await automationAudit(tx,s,'company_smtp_saved','automation_setting',s.entity_id,{host:input.clear?null:host,port:input.port,secure:input.secure,senderEmail:sender,hasPassword:!!encrypted})
  })
}
/** Server-only transport credentials. UI queries never select the cipher. */
export async function companySmtpTransportConfig(entityId:string){
  const [row]=await db.execute<{smtp_host:string|null;smtp_port:number;smtp_secure:boolean;smtp_username:string|null;smtp_password_ciphertext:Buffer|null}>(sql`SELECT smtp_host,smtp_port,smtp_secure,smtp_username,smtp_password_ciphertext FROM automation_setting WHERE entity_id=${entityId}::uuid`)
  if(!row?.smtp_host)return null
  return {host:row.smtp_host,port:row.smtp_port,secure:row.smtp_secure,user:row.smtp_username??undefined,password:row.smtp_username?openIntegration(row.smtp_password_ciphertext,entityId,'smtp-password'):undefined}
}

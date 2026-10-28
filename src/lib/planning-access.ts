import 'server-only'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { acting,type Tx } from './acting'
import { liveAuth } from './auth-security'
import { auditRow } from './audit-row'
import { ImportError } from './import-csv'

export type PlanningActor={sessionToken:string;requestId:string}
export const planningActor=(sessionToken:string):PlanningActor=>({sessionToken,requestId:randomUUID()})
export async function planningScope(tx:Tx,ledgerId:string,actor:PlanningActor,seat:'/opening'|'/reports',admin=false) {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ledgerId))throw new ImportError('LEDGER','Choose an available company.')
  const user=await liveAuth(tx,actor.sessionToken)
  if(admin&&user.kind==='user')throw new ImportError('ADMIN','Only an owner or administrator may approve or activate a migration.')
  const [ledger]=await tx.execute<{entity_id:string;name:string;currency:string}>(sql`SELECT e.id::text AS entity_id,e.name,l.currency FROM ledger l JOIN entity e ON e.id=l.entity_id WHERE l.id=${ledgerId}::uuid AND e.archived_at IS NULL FOR SHARE OF e`)
  if(!ledger)throw new ImportError('COMPANY','This company is unavailable or archived.')
  const [module]=await tx.execute<{enabled:boolean}>(sql`SELECT enabled FROM company_module_access WHERE entity_id=${ledger.entity_id}::uuid AND module=${seat} FOR SHARE`)
  if(module&&!module.enabled)throw new ImportError('MODULE','This company has disabled the required module.')
  if(user.kind==='user'&&!(await tx.execute(sql`SELECT 1 FROM user_entity_module_access WHERE user_id=${user.user_id}::uuid AND entity_id=${ledger.entity_id}::uuid AND module=${seat} FOR SHARE`)).length)throw new ImportError('ACCESS','Your current company/module permission does not allow this operation.')
  await acting(tx,user.email)
  return {...ledger,ledgerId,userId:user.user_id,email:user.email,kind:user.kind,actor}
}
export type PlanningScope=Awaited<ReturnType<typeof planningScope>>
export function planningAudit(tx:Tx,s:PlanningScope,action:string,table:string,id:string,after?:unknown,reason?:string) {
  return auditRow(tx,{actor:s.email,action,table,recordId:id,entityId:s.entity_id,ledgerId:s.ledgerId,scope:'company',after,reason,context:{source:'ui',actorType:'user',actorId:s.userId,requestId:s.actor.requestId}})
}

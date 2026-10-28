import 'server-only'
import {randomUUID} from 'node:crypto'
import {sql} from 'drizzle-orm'
import type {Tx} from './acting'
import {acting} from './acting'
import {auditRow} from './audit-row'
import {automationScope,type AutomationActor,type AutomationScope} from './automation-access'

export class IntegrationError extends Error {
  constructor(readonly code:string,message:string,readonly status=400){super(message);this.name='IntegrationError'}
}
export const integrationId=(id:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
export const integrationActor=(sessionToken:string):AutomationActor=>({source:'ui',sessionToken,requestId:randomUUID()})
export async function integrationScope(tx:Tx,ledgerId:string,actor:AutomationActor,kind:'payment'|'inbound',admin=false) {
  const scope=await automationScope(tx,ledgerId,actor,kind==='payment'?{seat:'/invoices'}:{})
  if(admin&&scope.kind==='user')throw new IntegrationError('ADMIN','Only a company administrator can configure external services.')
  if(scope.kind==='user'&&!(await tx.execute(sql`SELECT 1 FROM user_entity_access WHERE user_id=${scope.userId}::uuid AND entity_id=${scope.entity_id}::uuid FOR SHARE`)).length)
    throw new IntegrationError('ACCESS','Your current company permission does not allow this operation.',403)
  return scope
}
export function integrationAudit(tx:Tx,s:AutomationScope,action:string,table:string,id:string,after?:unknown,reason?:string) {
  return auditRow(tx,{actor:s.email,action,table,recordId:id,entityId:s.entity_id,ledgerId:s.ledgerId,scope:'company',after,reason,
    context:{source:s.actor.source,actorType:s.actor.source==='ui'?'user':'worker',actorId:s.actor.source==='ui'?s.userId:s.actor.workerId,
      authorizedBy:s.actor.source==='job'?s.userId:undefined,requestId:s.actor.requestId}})
}
export async function deliveryAudit(tx:Tx,scope:{entity_id:string;ledger_id:string;id:string},provider:'stripe'|'postmark',action:string,table:string,id:string,after?:unknown) {
  await acting(tx,provider+' verified delivery')
  return auditRow(tx,{actor:provider+' verified delivery',action,table,recordId:id,entityId:scope.entity_id,ledgerId:scope.ledger_id,scope:'company',after,
    context:{source:'webhook',actorType:'provider',actorId:scope.id,requestId:randomUUID()}})
}

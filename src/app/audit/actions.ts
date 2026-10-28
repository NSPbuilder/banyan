'use server'
import {cookies} from 'next/headers'
import {revalidatePath} from 'next/cache'
import {requireOwner,SESSION_COOKIE} from '@/lib/gate'
import {createAuditCheckpoint,verifyAuditAsOwner} from '@/lib/audit-chain'
import {assertCheckpoint,type AuditCheckpoint} from '@/lib/audit-chain-types'
export type AuditState={ok?:string;error?:string;checkpointId?:string}
export async function auditAction(_previous:AuditState,form:FormData):Promise<AuditState>{
  await requireOwner()
  const token=(await cookies()).get(SESSION_COOKIE)?.value??'',op=String(form.get('operation')??'')
  try{
    if(op==='checkpoint'){
      const c=await createAuditCheckpoint(token);return {ok:'Checkpoint created. Download it and keep it outside this database.',checkpointId:c.id}
    }
    let checkpoint:AuditCheckpoint|undefined
    if(op==='compare'){
      const f=form.get('checkpoint');if(!(f instanceof File)||f.size===0||f.size>1048576)throw Error('Choose a checkpoint JSON file up to 1 MiB.')
      const value=JSON.parse(await f.text());assertCheckpoint(value);checkpoint=value
    }else if(op!=='verify')throw Error('Choose a verification operation.')
    const result=await verifyAuditAsOwner(token,checkpoint)
    revalidatePath('/audit')
    if(!result.ok)return {error:result.issues.map(i=>`${i.scope} · ${i.sequence??'—'} · ${i.type}`).join('; ')}
    return {ok:checkpoint?'Audit verified against the supplied independently retained checkpoint.':'Audit verified. Tail completeness has no independent checkpoint proof.'}
  }catch(e){return {error:e instanceof Error?e.message:'Audit verification unavailable.'}}
}

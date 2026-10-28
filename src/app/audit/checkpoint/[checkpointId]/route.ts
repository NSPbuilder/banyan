import {guardRoute} from '@/lib/gate'
import {db} from '@/db/client'
import {sql} from 'drizzle-orm'
export async function GET(_request:Request,{params}:{params:Promise<{checkpointId:string}>}){
  const who=await guardRoute({owner:true});if(who instanceof Response)return who
  const {checkpointId}=await params
  if(!/^[a-f0-9-]{36}$/i.test(checkpointId))return new Response('Invalid checkpoint.',{status:400})
  const [c]=await db.execute<{document:unknown}>(sql`SELECT document FROM audit_checkpoint WHERE id=${checkpointId}::uuid`)
  if(!c)return new Response('Checkpoint not found.',{status:404})
  return new Response(JSON.stringify(c.document,null,2)+'\n',{headers:{'content-type':'application/json','content-disposition':`attachment; filename="figtree-audit-${checkpointId}.json"`,'cache-control':'private, no-store'}})
}

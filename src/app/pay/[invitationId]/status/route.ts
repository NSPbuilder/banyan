import {cookies} from 'next/headers'
import {guardRoute} from '@/lib/gate'
import {PORTAL_COOKIE,portalInvoice} from '@/lib/customer-portal'
import {integrationFailure,PRIVATE_HEADERS} from '@/lib/integration-http'
export async function GET(_request:Request,{params}:{params:Promise<{invitationId:string}>}){
  try{const {invitationId}=await params,token=(await cookies()).get(PORTAL_COOKIE)?.value??''
    const who=await guardRoute({portal:{id:invitationId,token}});if(who instanceof Response)return who
    return Response.json(await portalInvoice(token,invitationId),{headers:PRIVATE_HEADERS})
  }catch(error){return integrationFailure(error)}
}

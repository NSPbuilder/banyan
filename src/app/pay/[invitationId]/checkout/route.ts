import {cookies} from 'next/headers'
import {guardRoute} from '@/lib/gate'
import {PORTAL_COOKIE} from '@/lib/customer-portal'
import {startCheckout} from '@/lib/online-payments'
import {boundedBody,integrationFailure,PRIVATE_HEADERS} from '@/lib/integration-http'
export async function POST(request:Request,{params}:{params:Promise<{invitationId:string}>}){
  try{const {invitationId}=await params,token=(await cookies()).get(PORTAL_COOKIE)?.value??''
    const who=await guardRoute({portal:{id:invitationId,token,write:true}});if(who instanceof Response)return who
    const body=JSON.parse((await boundedBody(request,1024)).toString('utf8')||'{}')
    if(!body||Array.isArray(body)||Object.keys(body).length)return Response.json({error:'Payment amount and scope are calculated by the server.'},{status:400,headers:PRIVATE_HEADERS})
    return Response.json(await startCheckout(invitationId,token),{headers:PRIVATE_HEADERS})
  }catch(error){return integrationFailure(error)}
}

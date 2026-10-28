import {guardRoute} from '@/lib/gate'
import {PORTAL_COOKIE} from '@/lib/customer-portal'
import {boundedBody,integrationFailure,PRIVATE_HEADERS} from '@/lib/integration-http'
import {NextResponse} from 'next/server'
export async function POST(request:Request,{params}:{params:Promise<{invitationId:string}>}){
  try{
    const {invitationId}=await params,p=JSON.parse((await boundedBody(request,1024)).toString('utf8'))
    const result=await guardRoute({portalExchange:{id:invitationId,token:typeof p?.token==='string'?p.token:''}})
    if(result instanceof Response)return result
    const response=NextResponse.json({opened:true},{headers:PRIVATE_HEADERS})
    response.cookies.set(PORTAL_COOKIE,result.session,{httpOnly:true,secure:true,sameSite:'strict',path:'/pay/'+invitationId,maxAge:1200})
    return response
  }catch(error){return integrationFailure(error)}
}

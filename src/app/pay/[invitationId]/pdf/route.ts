import {cookies} from 'next/headers'
import {guardRoute} from '@/lib/gate'
import {PORTAL_COOKIE,portalPdf} from '@/lib/customer-portal'
import {pdfResponse} from '@/lib/pdf-reports'
import {IntegrationError} from '@/lib/integration-access'
import {integrationFailure,PRIVATE_HEADERS} from '@/lib/integration-http'
export async function GET(_request:Request,{params}:{params:Promise<{invitationId:string}>}){
  try{const {invitationId}=await params,token=(await cookies()).get(PORTAL_COOKIE)?.value??''
    const scope=await guardRoute({portal:{id:invitationId,token}});if(scope instanceof Response)return scope
    if(scope.status!=='posted')throw new IntegrationError('VOID','This invoice is void. Contact the sender for its current document.',409)
    const response=pdfResponse(await portalPdf(token,invitationId));for(const [key,value] of Object.entries(PRIVATE_HEADERS))response.headers.set(key,value)
    return response
  }catch(error){return integrationFailure(error)}
}

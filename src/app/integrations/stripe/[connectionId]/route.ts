import {guardRoute} from '@/lib/gate'
import {boundedBody,integrationFailure,PRIVATE_HEADERS} from '@/lib/integration-http'
export async function POST(request:Request,{params}:{params:Promise<{connectionId:string}>}){
  try{const {connectionId}=await params,body=await boundedBody(request,1024*1024)
    const result=await guardRoute({delivery:{provider:'stripe',id:connectionId,body,credential:request.headers.get('stripe-signature')}})
    if(result instanceof Response)return result
    return Response.json({received:true},{headers:PRIVATE_HEADERS})
  }catch(error){return integrationFailure(error)}
}

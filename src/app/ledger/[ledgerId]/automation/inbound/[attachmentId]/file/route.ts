import {cookies} from 'next/headers'
import {guardRoute,SESSION_COOKIE} from '@/lib/gate'
import {integrationActor} from '@/lib/integration-access'
import {inboundFile} from '@/lib/inbound-mail'
import {integrationFailure,PRIVATE_HEADERS} from '@/lib/integration-http'
export async function GET(_request:Request,{params}:{params:Promise<{ledgerId:string;attachmentId:string}>}){
  const who=await guardRoute();if(who instanceof Response)return who
  try{const {ledgerId,attachmentId}=await params,file=await inboundFile(ledgerId,attachmentId,integrationActor((await cookies()).get(SESSION_COOKIE)?.value??''))
    return new Response(new Uint8Array(file.bytes),{headers:{...PRIVATE_HEADERS,'content-type':file.mime,'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name)}})
  }catch(error){return integrationFailure(error)}
}

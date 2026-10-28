import 'server-only'
import {IntegrationError} from './integration-access'
export const PRIVATE_HEADERS={'cache-control':'private, no-store, max-age=0','referrer-policy':'no-referrer','x-robots-tag':'noindex, nofollow','x-content-type-options':'nosniff'}
export async function boundedBody(request:Request,max:number){
  const length=request.headers.get('content-length')
  if(length&&(!/^\d+$/.test(length)||Number(length)>max))throw new IntegrationError('SIZE','Request is too large.',413)
  const reader=request.body?.getReader();if(!reader)return Buffer.alloc(0)
  const chunks:Buffer[]=[];let total=0
  try{for(;;){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>max){await reader.cancel();throw new IntegrationError('SIZE','Request is too large.',413)}chunks.push(Buffer.from(value))}}finally{reader.releaseLock()}
  return Buffer.concat(chunks)
}
export function integrationFailure(error:unknown){
  return Response.json({error:error instanceof IntegrationError?error.message:'The service could not complete this operation. Try again or contact the sender.'},{status:error instanceof IntegrationError?error.status:503,headers:PRIVATE_HEADERS})
}

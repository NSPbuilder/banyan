import { guardRoute } from '@/lib/gate'
import { targetInboxFile } from '@/lib/inbox'
export const dynamic='force-dynamic'
export async function GET(_request:Request,{params}:{params:Promise<{ledgerId:string;invoiceId:string;itemId:string}>}) {
  const who=await guardRoute();if(who instanceof Response)return who
  const {ledgerId,invoiceId,itemId}=await params
  try {
    const file=await targetInboxFile(ledgerId,'invoice',invoiceId,itemId)
    if(!file)return new Response('Original source unavailable; check its attachment backup.',{status:404})
    return new Response(new Uint8Array(file.bytes),{headers:{'Content-Type':file.mime,'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'self'; base-uri 'none'"}})
  } catch {return new Response('Original source unavailable.',{status:404})}
}

import { guardRoute } from '@/lib/gate'
import { cookies } from 'next/headers'
import { requireLedger,SESSION_COOKIE } from '@/lib/gate'
import { requestActor,AutomationError } from '@/lib/automation-access'
import { inboxFile } from '@/lib/inbox'
export const dynamic='force-dynamic'
export async function GET(request:Request,{params}:{params:Promise<{ledgerId:string;itemId:string}>}) {
  const who=await guardRoute();if(who instanceof Response)return who
  const {ledgerId,itemId}=await params;await requireLedger(ledgerId,'/automation')
  try {
    const file=await inboxFile(ledgerId,itemId,requestActor((await cookies()).get(SESSION_COOKIE)?.value??''))
    return new Response(new Uint8Array(file.bytes),{headers:{'Content-Type':file.mime,'Content-Disposition':`${new URL(request.url).searchParams.has('download')?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'self'; base-uri 'none'"}})
  } catch(error) {return new Response(error instanceof AutomationError?error.message:'Source unavailable.',{status:404})}
}

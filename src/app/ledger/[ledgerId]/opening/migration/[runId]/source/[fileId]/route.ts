import { cookies } from 'next/headers'
import { guardRoute,requireLedger,SESSION_COOKIE } from '@/lib/gate'
import { planningActor } from '@/lib/planning-access'
import { importSourceFile } from '@/lib/ledger-import'
export async function GET(_r:Request,{params}:{params:Promise<{ledgerId:string;runId:string;fileId:string}>}) {
 const who=await guardRoute();if(who instanceof Response)return who
 const {ledgerId,runId,fileId}=await params;await requireLedger(ledgerId,'/opening')
 const f=await importSourceFile(ledgerId,runId,fileId,planningActor((await cookies()).get(SESSION_COOKIE)?.value??''))
 return new Response(new Uint8Array(f.bytes),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})
}

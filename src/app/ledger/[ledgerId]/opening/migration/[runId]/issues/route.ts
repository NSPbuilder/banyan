import { cookies } from 'next/headers'
import { guardRoute,requireLedger,SESSION_COOKIE } from '@/lib/gate'
import { planningActor } from '@/lib/planning-access'
import { importDetail } from '@/lib/ledger-import'
export async function GET(_r:Request,{params}:{params:Promise<{ledgerId:string;runId:string}>}) {
 const who=await guardRoute();if(who instanceof Response)return who
 const {ledgerId,runId}=await params;await requireLedger(ledgerId,'/opening')
 const d=await importDetail(ledgerId,runId,planningActor((await cookies()).get(SESSION_COOKIE)?.value??'')),issues=(d.run.validation.issues??[]) as Array<{level:string;code:string;message:string;fileId?:string;sourceLines?:number[]}>
 const cell=(s:unknown)=>'"'+String(s??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"'
 const csv=[['level','code','filename','source_lines','message'].map(cell).join(','),...issues.map(i=>[i.level,i.code,d.files.find(f=>f.id===i.fileId)?.filename??'',i.sourceLines?.join(';')??'',i.message].map(cell).join(','))].join('\r\n')
 return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="migration-issues.csv"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})
}

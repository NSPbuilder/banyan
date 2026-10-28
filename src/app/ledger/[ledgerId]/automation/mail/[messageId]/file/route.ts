import { guardRoute } from '@/lib/gate'
import { cookies } from 'next/headers'
import { requireAutomationLedger } from '@/lib/automation-gate'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { SESSION_COOKIE } from '@/lib/gate'
import { automationScope,requestActor } from '@/lib/automation-access'
import { readBlobBytes } from '@/lib/attachments'
export const dynamic='force-dynamic'
export async function GET(request:Request,{params}:{params:Promise<{ledgerId:string;messageId:string}>}) {
  const who=await guardRoute();if(who instanceof Response)return who
  const {ledgerId,messageId}=await params;await requireAutomationLedger(ledgerId,['/invoices'])
  const token=(await cookies()).get(SESSION_COOKIE)?.value??''
  const result=await db.transaction(async tx=>{
    const s=await automationScope(tx,ledgerId,requestActor(token),{seat:'/invoices'})
    const [m]=await tx.execute<{attachment_sha256:string;attachment_name:string}>(sql`SELECT attachment_sha256,attachment_name FROM email_message WHERE id=${messageId}::uuid AND ledger_id=${ledgerId}::uuid`)
    return m?{company:s.name,m}:null
  })
  if(!result)return new Response('Approved PDF unavailable.',{status:404})
  const bytes=await readBlobBytes(result.company,result.m.attachment_sha256)
  if(!bytes||createHash('sha256').update(bytes).digest('hex')!==result.m.attachment_sha256)return new Response('Approved PDF is missing or damaged; restore its file backup.',{status:404})
  return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':`${new URL(request.url).searchParams.has('preview')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(result.m.attachment_name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})
}

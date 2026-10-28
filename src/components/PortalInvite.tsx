import {cookies} from 'next/headers'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {SESSION_COOKIE} from '@/lib/gate'
import {integrationScope,integrationActor} from '@/lib/integration-access'
import {AutomationForm} from './AutomationForm'
import {integrationAction} from '@/app/integration-actions'
import {BUTTON,QUIET} from '@/lib/ui'
export async function PortalInvite({ledgerId,invoiceId,version}:{ledgerId:string;invoiceId:string;version:string}){
  const token=(await cookies()).get(SESSION_COOKIE)?.value??''
  try{await db.transaction(tx=>integrationScope(tx,ledgerId,integrationActor(token),'payment'))}catch{return null}
  const invitations=await db.execute<{id:string;expires_at:string;revoked:boolean}>(sql`SELECT id::text,expires_at::text,revoked_at IS NOT NULL AS revoked FROM portal_invitation WHERE ledger_id=${ledgerId}::uuid AND invoice_id=${invoiceId}::uuid ORDER BY created_at DESC LIMIT 20`)
  return <section className="mt-6 border-t border-line pt-4"><h2 className="mb-2 font-medium">Customer invoice link</h2><p className="mb-3 text-sm text-ink-muted">A link opens only this invoice. It expires after seven days and can be revoked.</p>
    <AutomationForm action={integrationAction}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="id" value={invoiceId}/><input type="hidden" name="invoiceVersion" value={version}/><button className={BUTTON} name="command" value="portal-invite">Create invoice link</button></AutomationForm>
    {invitations.map(i=><div className="mt-3 flex flex-wrap items-center gap-3 text-sm" key={i.id}><span>{i.revoked?'Revoked':'Expires '+i.expires_at}</span>{!i.revoked&&<AutomationForm action={integrationAction}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="id" value={i.id}/><button className={QUIET} name="command" value="portal-revoke">Revoke link</button></AutomationForm>}</div>)}
  </section>
}

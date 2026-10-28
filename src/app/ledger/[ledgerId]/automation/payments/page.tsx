import Link from 'next/link'
import {cookies} from 'next/headers'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {requireLedger,SESSION_COOKIE} from '@/lib/gate'
import {integrationActor} from '@/lib/integration-access'
import {paymentOverview} from '@/lib/online-payments'
import {AutomationShell} from '@/components/AutomationShell'
import {serviceSettingsPath} from '@/lib/workflow-links'
import {AutomationForm} from '@/components/AutomationForm'
import {integrationAction} from '@/app/integration-actions'
import {BUTTON,FIELD,LABEL} from '@/lib/ui'
import {formatMoney} from '@/lib/money'
export const dynamic='force-dynamic'
export default async function Payments({params}:{params:Promise<{ledgerId:string}>}){
  const {ledgerId}=await params;await requireLedger(ledgerId,['/automation','/invoices'])
  const actor=integrationActor((await cookies()).get(SESSION_COOKIE)?.value??''),view=await paymentOverview(ledgerId,actor)
  const requests=await db.execute<{id:string;stripe_checkout_id:string|null;status:string;last_error:string|null}>(sql`SELECT id::text,stripe_checkout_id,status,last_error FROM checkout_request WHERE ledger_id=${ledgerId}::uuid ORDER BY created_at DESC LIMIT 50`)
  const c=view.connection
  return <AutomationShell ledgerId={ledgerId} title="Online payments">
    <p className="mb-4 text-sm text-ink-muted">CAD card payments · {c?.enabled?'New payments enabled':'New payments disabled'} · {String(c?.mode??'Not configured')} · Merchant {String(c?.stripe_account_id??'Unverified')}</p>
    <Link className="inline-flex text-sm underline" href={serviceSettingsPath(ledgerId,'payments')}>Open Stripe settings</Link>
    {c&&<section className="mt-6 border-t border-line pt-4"><h2 className="mb-3 font-medium">Webhook and reconciliation</h2><p className="mb-3 break-all text-sm">Webhook path: /integrations/stripe/{String(c.id)}</p>
      <AutomationForm action={integrationAction}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="id" value={String(c.id)}/><label className={LABEL}>Missing Stripe event ID<input className={`${FIELD} ml-3`} name="eventId" placeholder="evt_…" required/></label><button className={`${BUTTON} ml-3`} name="command" value="payment-event">Pull event</button></AutomationForm>
    </section>}
    <section className="mt-6 border-t border-line pt-4"><h2 className="mb-3 font-medium">Processor transactions</h2><p className="mb-3 text-sm text-ink-muted">Confirm actual fees, refunds and paid payouts against their originals and bank records. Disputes remain under review; no loss is inferred.</p>
      {view.transactions.length===0?<p>No processor transactions received.</p>:view.transactions.map(t=><div key={String(t.id)} className="border-b border-line py-3"><p className="break-all">{String(t.kind)} · {String(t.currency)} {formatMoney(BigInt(String(t.amount)))} · {String(t.status)} · {String(t.provider_object_id)}</p><p className="text-sm text-ink-muted">{String(t.occurred_at)} {String(t.review_reason??'')}</p>
        {t.entry_id?<Link className="text-sm underline" href={`/ledger/${ledgerId}/entries/${t.entry_id}`}>Recorded entry</Link>:['fee','payout','refund'].includes(String(t.kind))&&<AutomationForm action={integrationAction}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="id" value={String(t.id)}/><button className={`${BUTTON} mt-2`} name="command" value="payment-confirm">Confirm current provider movement</button></AutomationForm>}
      </div>)}
    </section>
    <section className="mt-6"><h2 className="mb-3 font-medium">Saved Checkout requests</h2>{requests.map(r=><div className="border-b border-line py-3" key={r.id}><p>{r.status} · {r.stripe_checkout_id??'Provider result unknown'}</p><p className="text-sm text-ink-muted">{r.last_error}</p><AutomationForm action={integrationAction}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="id" value={r.id}/>{r.stripe_checkout_id?<button className={`${BUTTON} mt-2`} name="command" value="payment-reconcile">Reconcile current Checkout</button>:<><label className={LABEL}>Original provider session<input className={FIELD} name="sessionId" placeholder="cs_…" required/></label><button className={`${BUTTON} ml-3`} name="command" value="payment-recover">Recover original request</button></>}</AutomationForm></div>)}</section>
    <section className="mt-6"><h2 className="mb-3 font-medium">Payment jobs</h2>{view.jobs.map(j=><p className="text-sm" key={String(j.id)}>{String(j.status)} · {String(j.last_error??'')}</p>)}</section>
  </AutomationShell>
}

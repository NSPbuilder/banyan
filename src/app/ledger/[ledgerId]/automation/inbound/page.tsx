import Link from 'next/link'
import {cookies} from 'next/headers'
import {requireLedger,SESSION_COOKIE} from '@/lib/gate'
import {integrationActor} from '@/lib/integration-access'
import {inboundOverview} from '@/lib/inbound-mail'
import {AutomationShell} from '@/components/AutomationShell'
import {serviceSettingsPath} from '@/lib/workflow-links'
export const dynamic='force-dynamic'
export default async function Inbound({params}:{params:Promise<{ledgerId:string}>}){
  const {ledgerId}=await params;await requireLedger(ledgerId,'/automation')
  const view=await inboundOverview(ledgerId,integrationActor((await cookies()).get(SESSION_COOKIE)?.value??'')),c=view.connection
  return <AutomationShell ledgerId={ledgerId} title="Inbound documents"><p className="mb-4 text-sm text-ink-muted">Postmark · {c?.enabled?'Enabled':'Disabled'} · Maximum 10 attachments, 6 MiB decoded total. Review every original before accounting.</p>
    <Link className="inline-flex text-sm underline" href={serviceSettingsPath(ledgerId,'inbound')}>Open inbound email settings</Link>
    {c&&<section className="mt-6 border-t border-line pt-4"><h2 className="mb-3 font-medium">Forwarding route</h2><p className="break-all">{String(c.alias_address??'Rotate and rebind the restored alias.')}</p><p className="mt-2 break-all text-sm">Webhook path: /integrations/postmark/{String(c.id)}</p><p className="mt-2 text-sm text-ink-muted">Configure this Postmark server with HTTPS and the saved Basic Auth credentials. Restrict ingress to Postmark’s published IPs at the deployment firewall.</p></section>}
    <section className="mt-6 border-t border-line pt-4"><h2 className="mb-3 font-medium">Received messages</h2>{view.messages.length===0?<p>No inbound messages received.</p>:view.messages.map(m=><article className="border-b border-line py-4" key={String(m.id)}><h3 className="font-medium">{String(m.subject)||'No subject'}</h3><p className="break-all text-sm">{String(m.sender)} · {String(m.status)} · {String(m.received_at)}</p><p className="my-2 text-sm text-ink-muted">{String(m.note)}</p>{(m.attachments as Array<Record<string,unknown>>).map(a=><div className="my-2 flex flex-wrap gap-3 text-sm" key={String(a.id)}><span>{String(a.filename)} · {String(a.status)} · {String(a.reason)}</span>{!!a.inboxId&&<Link className="underline" href={`/ledger/${ledgerId}/automation/inbox/${a.inboxId}`}>Review in inbox</Link>}{a.downloadable===true&&<a className="underline" href={`/ledger/${ledgerId}/automation/inbound/${a.id}/file`}>Original file</a>}</div>)}</article>)}</section>
  </AutomationShell>
}

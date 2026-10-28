import Link from 'next/link'
import {cookies} from 'next/headers'
import {sql} from 'drizzle-orm'
import {notFound} from 'next/navigation'
import {db} from '@/db/client'
import {requireLedger,SESSION_COOKIE} from '@/lib/gate'
import {ledgerHead} from '@/lib/ledger-head'
import {requestActor} from '@/lib/automation-access'
import {companyServices} from '@/lib/company-services'
import {paymentOverview} from '@/lib/online-payments'
import {inboundOverview} from '@/lib/inbound-mail'
import {serviceSettingsPath} from '@/lib/workflow-links'
import {ModuleTabs} from '@/components/ModuleTabs'
import {SettingsFrame} from '@/components/SettingsFrame'
import {settingsContext} from '@/lib/settings-context'
import {CompanyServiceForm} from '@/components/CompanyServiceForms'
import {IntegrationSettings} from '@/components/IntegrationSettings'
const sections=[['email','Email (SMTP)'],['payments','Payments (Stripe)'],['reminders','Reminders'],['inbound','Inbound email'],['execution','Execution']] as const
export const dynamic='force-dynamic'
export default async function ServiceSettings({searchParams}:{searchParams:Promise<{ledger?:string;section?:string}>}){
  const q=await searchParams,ledgerId=q.ledger??'',section=q.section??'email'
  const me=await requireLedger(ledgerId,'/automation'),head=await ledgerHead(ledgerId)
  if(!head||!sections.some(([key])=>key===section))notFound()
  const actor=requestActor((await cookies()).get(SESSION_COOKIE)?.value??''),view=await companyServices(ledgerId,actor)
  const settings=await settingsContext(me,ledgerId)
  const integration=section==='payments'?await paymentOverview(ledgerId,actor):section==='inbound'?await inboundOverview(ledgerId,actor):null
  const accounts=section==='payments'?await db.execute<{id:string;label:string;type:string}>(sql`SELECT id::text,code||' — '||name AS label,account_type AS type FROM account WHERE entity_id=${head.entity_id}::uuid AND is_active AND is_postable ORDER BY code`):[]
  const rules=section==='reminders'?await db.execute<{id:string;party_id:string;name:string;uses_company_defaults:boolean}>(sql`SELECT r.id::text,r.party_id::text,p.name,r.uses_company_defaults FROM reminder_rule r JOIN party p ON p.id=r.party_id WHERE r.ledger_id=${ledgerId}::uuid ORDER BY p.name`):[]
  return <SettingsFrame view={settings} active="services">
      <h2 className="text-section-title font-semibold">Company services</h2>
      <ModuleTabs className="my-4" label="Company service settings" items={sections.map(([key,label])=>({label,href:serviceSettingsPath(ledgerId,key),selected:section===key}))}/>
      {!view.canConfigure?<p>Only a company administrator can change these settings.</p>:section==='payments'||section==='inbound'?<>
        <IntegrationSettings ledgerId={ledgerId} kind={section==='payments'?'payment':'inbound'} connection={integration!.connection} accounts={accounts} canConfigure={integration!.canConfigure}/>
        <p className="mt-4 text-metadata text-ink-muted">{section==='payments'?<Link className="underline" href={`/ledger/${ledgerId}/automation/payments`}>Review payments and reconciliation</Link>:<Link className="underline" href={`/ledger/${ledgerId}/automation/inbound`}>View forwarding address and received messages</Link>}</p>
      </>:<CompanyServiceForm ledgerId={ledgerId} setting={view.setting} kind={section as 'email'|'reminders'|'execution'} encryptionReady={view.encryptionReady}/>}
      {section==='email'&&<p className="mt-4 text-metadata text-ink-muted">Email is {view.setting.mail_enabled?'enabled':'disabled'} for this company. <Link className="underline" href={serviceSettingsPath(ledgerId,'execution')}>Execution settings</Link></p>}
      {section==='reminders'&&rules.length>0&&<section className="mt-6 border-t border-line pt-4"><h2 className="text-section-title font-semibold">Customer exceptions and pauses</h2><div className="divide-y divide-line">{rules.map(r=><div key={r.id} className="flex flex-wrap justify-between gap-3 py-3"><Link className="underline" href={`/ledger/${ledgerId}/automation/reminders/${r.id}`}>{r.name}</Link><span className="text-metadata text-ink-muted">{r.uses_company_defaults?'Company schedule':'Custom schedule retained'}</span></div>)}</div></section>}
    </SettingsFrame>
}

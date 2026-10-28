import Link from 'next/link'
import {notFound} from 'next/navigation'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {requireUser} from '@/lib/gate'
import {mayOpenEntity} from '@/lib/access'
import {hasWebDavSeat,webdavCredentialStatus} from '@/lib/webdav-credentials'
import {panelStateFrom,secretIsSet,serviceState} from '@/lib/ai-service'
import {settingsContext} from '@/lib/settings-context'
import {SettingsFrame,settingsTabs} from '@/components/SettingsFrame'
import {ServicePanel} from '../ledger/[ledgerId]/assistant/ServicePanel'
import {saveAppearanceAction,saveAiServiceAction,clearAiServiceAction} from '@/app/actions'
import {AppearanceForm} from './AppearanceForm'
import {WebDavSettings} from './WebDavSettings'
import {webdavCredentialAction} from './webdav-actions'
import {moduleSettingsPanels} from '@/lib/settings-extensions'
import {GHOST,QUIET} from '@/lib/ui'

export const dynamic='force-dynamic'
export const metadata={title:'Settings'}

export default async function Settings({searchParams}:PageProps<'/settings'>){
  const me=await requireUser(),q=await searchParams,view=await settingsContext(me,q.ledger)
  const {ledger,access,seats}=view,section=typeof q.section==='string'?q.section:'appearance'
  if(!settingsTabs(view).some(t=>t.key===section&&section!=='services'&&section!=='security'))notFound()
  let webdavCompanies:Array<{id:string;name:string;active:boolean}>=[]
  if(section==='files'){
    const entities=await db.execute<{id:string;name:string}>(sql`SELECT e.id::text,e.name FROM entity e WHERE ${mayOpenEntity(me,sql`e.id`)} ORDER BY e.code`)
    const active=await webdavCredentialStatus(me.id)
    webdavCompanies=entities.filter(e=>access.byEntity===null||hasWebDavSeat(access.byEntity.get(e.id)??new Set())).map(e=>({...e,active:active.has(e.id)}))
  }
  const ai=section==='ai'&&view.canConfigureAi?panelStateFrom(await serviceState(me.id)):null
  return <SettingsFrame view={view} active={section}>
    {section==='appearance'&&<AppearanceForm current={{theme:me.theme,mode:me.appearance_mode,liquidTint:me.liquid_tint}} action={saveAppearanceAction}/>}
    {section==='ai'&&(ledger&&ai?<ServicePanel ledgerId={ledger.id} state={ai} secretSet={secretIsSet()} saveAction={saveAiServiceAction} clearAction={clearAiServiceAction}/>:<p className="text-body text-ink-secondary">AI settings require access to an AI workflow in a company. Ask an owner for access.</p>)}
    {section==='documents'&&<>
      {(me.kind==='superadmin'||seats.includes('/invoices'))&&<section className="max-w-2xl"><h2 className="text-section-title font-semibold">Invoice templates</h2><div className="mt-3 flex flex-wrap gap-3">
        {ledger&&seats.includes('/invoices')&&<Link href={`/ledger/${ledger.id}/invoices/templates`} className={GHOST}>Company defaults</Link>}
        {me.kind==='superadmin'&&<Link href="/settings/invoice-templates" className={QUIET}>Manage templates</Link>}
      </div></section>}
      {await moduleSettingsPanels({section,user:me,ledger})}
    </>}
    {section==='files'&&<WebDavSettings companies={webdavCompanies} email={me.email} action={webdavCredentialAction}/>}
    {section==='administration'&&<section><h2 className="text-section-title font-semibold">Company access</h2><Link href="/settings/company-access" className={`${QUIET} mt-3`}>Manage modules</Link></section>}
  </SettingsFrame>
}

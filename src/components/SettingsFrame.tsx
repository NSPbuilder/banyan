import type {ReactNode} from 'react'
import {ApplicationFrame} from './ApplicationFrame'
import {GlobalNavigation} from './GlobalNavigation'
import {NavRail} from './NavRail'
import {PageHeader} from './PageHeader'
import {ModuleTabs} from './ModuleTabs'
import {personalSettingsPath,type SettingsContext} from '@/lib/settings-context'
import {serviceSettingsPath} from '@/lib/workflow-links'

export function settingsTabs({user,ledger,seats}:SettingsContext){
  const id=ledger?.id??null,query=id?'?ledger='+id:''
  return [
    {key:'appearance',label:'Appearance',href:personalSettingsPath(id)},
    {key:'ai',label:'AI',href:personalSettingsPath(id,'ai')},
    ...(user.is_owner||seats.includes('/invoices')?[{key:'documents',label:'Documents',href:personalSettingsPath(id,'documents')}]:[]),
    ...(user.webdav_enabled?[{key:'files',label:'Files',href:personalSettingsPath(id,'files')}]:[]),
    ...(id&&seats.includes('/automation')?[{key:'services',label:'Company services',href:serviceSettingsPath(id)}]:[]),
    {key:'security',label:'Security',href:'/settings/security'+query},
    ...(user.kind==='superadmin'?[{key:'administration',label:'Administration',href:personalSettingsPath(id,'administration')}]:[]),
  ]
}
export function SettingsFrame({view,active,children}:{view:SettingsContext;active:string;children:ReactNode}){
  const {user,ledger,seats}=view
  return <ApplicationFrame navigation={ledger?<NavRail ledgerId={ledger.id} entityName={ledger.entity} seats={seats}/>:<GlobalNavigation owner={user.is_owner}/>} context={ledger?{name:ledger.entity,code:ledger.entity_code,currency:ledger.currency}:{name:'Workspace'}}>
    <main className="w-full max-w-5xl px-8 py-6 font-sans">
      <PageHeader title="Settings" backTo="/companies" backLabel="Back to Companies" context={<>{user.display_name} · {user.email}</>}/>
      <ModuleTabs className="my-4" label="Settings categories" items={settingsTabs(view).map(item=>({...item,selected:item.key===active}))}/>
      {children}
    </main>
  </ApplicationFrame>
}

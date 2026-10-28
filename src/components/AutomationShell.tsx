import type { ReactNode } from 'react'
import { PageHeader } from './PageHeader'
import { LEDGER_NAV } from '@/lib/nav'
import { WorkspaceTabs } from './WorkspaceTabs'

export function AutomationShell({ledgerId,title,children}:{ledgerId:string;title:string;children:ReactNode}) {
  return <main className="w-full min-w-0 px-8 py-6 font-sans" data-automation-workspace>
    <PageHeader title={title} context="Back desk" backTo={`/ledger/${ledgerId}/automation/jobs`} backLabel="Back desk"/>
    <WorkspaceTabs label="Back desk workspaces" className="my-4" items={
      (LEDGER_NAV.find(n=>n.path==='/automation')?.flyout ?? []).map(({label,path})=>({label,href:`/ledger/${ledgerId}${path}`}))
    }/>{children}
  </main>
}

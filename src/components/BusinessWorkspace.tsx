import type {ReactNode} from 'react'
import {PageHeader} from './PageHeader'
import {WorkspaceTabs} from './WorkspaceTabs'
import {AiModeNav} from './AiModeNav'
import {requireUser} from '@/lib/gate'
import {refuseFor,refuseForLedger} from '@/lib/access'
import {incomeEmailPath,inboxPath,serviceSettingsPath} from '@/lib/workflow-links'
export async function BusinessWorkspace({ledgerId,title,context,children}:{ledgerId:string;title:string;context:'Income'|'AI'|'Settings';children:ReactNode}){
  const me=await requireUser()
  // Read & add is a declared route, not a stored '/readings' module grant.
  const showRead=context==='AI'&&!(await refuseFor(me,`/ledger/${ledgerId}/readings`))
  const aiBack=showRead?`/ledger/${ledgerId}/readings`:inboxPath(ledgerId)
  return <main className="w-full min-w-0 px-8 py-6 font-sans">
    <PageHeader title={title} context={context} backTo={context==='Income'?`/ledger/${ledgerId}/income`:context==='AI'?aiBack:serviceSettingsPath(ledgerId)} backLabel={context}/>
    {context==='AI'?<AiModeNav ledgerId={ledgerId} active="inbox" showAsk={!(await refuseForLedger(me,ledgerId,'/assistant'))} showRead={showRead} showInbox/>:context==='Income'?<WorkspaceTabs className="my-4" label="Income workspaces" items={[{label:'Income',href:`/ledger/${ledgerId}/income`},{label:'Invoices',href:`/ledger/${ledgerId}/invoices`},{label:'Email',href:incomeEmailPath(ledgerId)}]}/>:null}
    <div className="mt-4">{children}</div>
  </main>
}

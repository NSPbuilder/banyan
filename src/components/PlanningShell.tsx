import type { ReactNode } from 'react'
import { PageHeader } from './PageHeader'
export function PlanningShell({ledgerId,title,back,children}:{ledgerId:string;title:string;back:string;children:ReactNode}) {
 return <main className="mx-auto w-full max-w-none px-8 py-10 font-sans"><PageHeader title={title} backTo={`/ledger/${ledgerId}${back}`} backLabel="Back"/>{children}</main>
}

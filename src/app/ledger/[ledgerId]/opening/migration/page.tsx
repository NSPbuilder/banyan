import Link from 'next/link'
import { cookies } from 'next/headers'
import { requireLedger,SESSION_COOKIE } from '@/lib/gate'
import { planningActor } from '@/lib/planning-access'
import { planningLists } from '@/lib/budgets'
import { PlanningShell } from '@/components/PlanningShell'
import { planningAction } from '@/app/planning-actions'
import { MigrationStart } from './MigrationForm'
export const dynamic='force-dynamic'
export default async function Migration({params}:{params:Promise<{ledgerId:string}>}) {
 const {ledgerId}=await params;await requireLedger(ledgerId,'/opening')
 const lists=await planningLists(ledgerId,planningActor((await cookies()).get(SESSION_COOKIE)?.value??''),'/opening')
 return <PlanningShell ledgerId={ledgerId} title="CSV migration" back="/opening"><p className="my-4 text-sm text-ink-muted">Use a new, empty company. Prepare accounts, party roles and open fiscal periods first. Choose opening balances or complete historical GL. QuickBooks-specific adaptation is deferred.</p>
 <ul className="mb-6 divide-y divide-line">{lists.runs.map(r=><li className="py-3" key={r.id}><Link href={`/ledger/${ledgerId}/opening/migration/${r.id}`} className="underline">{r.mode} · {r.status}</Link></li>)}</ul>
 {!lists.runs.some(r=>r.status!=='cancelled')&&<MigrationStart ledgerId={ledgerId} accounts={lists.accounts} action={planningAction}/>}</PlanningShell>
}

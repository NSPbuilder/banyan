import Link from 'next/link'
import { cookies } from 'next/headers'
import { requireLedger,SESSION_COOKIE } from '@/lib/gate'
import { planningActor } from '@/lib/planning-access'
import { planningLists } from '@/lib/budgets'
import { PlanningShell } from '@/components/PlanningShell'
import { AutomationForm } from '@/components/AutomationForm'
import { planningAction } from '@/app/planning-actions'
import { FIELD,LABEL,BUTTON } from '@/lib/ui'
export const dynamic='force-dynamic'
export default async function Budgets({params}:{params:Promise<{ledgerId:string}>}) {
 const {ledgerId}=await params;await requireLedger(ledgerId,'/reports');const lists=await planningLists(ledgerId,planningActor((await cookies()).get(SESSION_COOKIE)?.value??''),'/reports')
 return <PlanningShell ledgerId={ledgerId} title="Budgets" back="/reports"><p className="my-4 text-sm text-ink-muted">Plan by account and fiscal period. Published budgets are retained; revisions begin with a new draft. Actuals use the current P&L basis.</p>
 <ul className="mb-6 divide-y divide-line">{lists.budgets.map(b=><li key={b.id} className="py-3"><Link className="underline" href={`/ledger/${ledgerId}/reports/budgets/${b.id}`}>{b.name}</Link> · {b.status} · {lists.years.find(y=>y.id===b.fiscal_year_id)?.name}</li>)}</ul>
 <AutomationForm action={planningAction}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="command" value="budget_create"/><div className="grid max-w-3xl gap-4 sm:grid-cols-3"><label className={LABEL}>Draft name<input className={`${FIELD} w-full`} name="name" required maxLength={200}/></label><label className={LABEL}>Fiscal year<select name="fiscalYearId" className={`${FIELD} w-full`} required>{lists.years.map(y=><option key={y.id} value={y.id}>{y.name}</option>)}</select></label><label className={LABEL}>Copy baseline in same year (optional)<select name="copyFromId" className={`${FIELD} w-full`} defaultValue=""><option value="">Blank draft</option>{lists.budgets.map(b=><option key={b.id} value={b.id}>{b.name} · {b.status}</option>)}</select></label></div><button className={`${BUTTON} mt-4`}>Create protected draft</button></AutomationForm></PlanningShell>
}

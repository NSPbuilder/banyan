import { cookies } from 'next/headers'
import { requireLedger,SESSION_COOKIE } from '@/lib/gate'
import { planningActor } from '@/lib/planning-access'
import { budgetDetail,planningLists } from '@/lib/budgets'
import { PlanningShell } from '@/components/PlanningShell'
import { planningAction } from '@/app/planning-actions'
import { BudgetForm } from '../BudgetForm'
export const dynamic='force-dynamic'
export default async function Budget({params}:{params:Promise<{ledgerId:string;budgetId:string}>}) {
 const {ledgerId,budgetId}=await params;await requireLedger(ledgerId,'/reports');const actor=planningActor((await cookies()).get(SESSION_COOKIE)?.value??''),d=await budgetDetail(ledgerId,budgetId,actor),lists=await planningLists(ledgerId,actor,'/reports')
 return <PlanningShell ledgerId={ledgerId} title={d.budget.name} back="/reports/budgets"><p className="my-4 text-sm">{d.budget.status} · version {d.budget.version} · {lists.years.find(y=>y.id===d.budget.fiscal_year_id)?.name}</p><BudgetForm ledgerId={ledgerId} detail={d} budgets={lists.budgets} action={planningAction}/></PlanningShell>
}

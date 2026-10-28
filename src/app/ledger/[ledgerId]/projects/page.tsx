import { requireLedger } from '@/lib/gate'
import { projectCompany, projectParties, projectSummaries, projectFilters, ProjectError } from '@/lib/project'
import { REFUSAL } from '@/lib/ui'
import { ProjectList, projectActions } from './ProjectScreen'

export const dynamic='force-dynamic'
export default async function ProjectsPage({params,searchParams}:{params:Promise<{ledgerId:string}>;searchParams:Promise<Record<string,string|undefined>>}) {
  const {ledgerId}=await params
  await requireLedger(ledgerId,'/projects')
  const company=await projectCompany(ledgerId)
  let filters
  try {const q=await searchParams;filters=projectFilters({q:q.q,from:q.from,to:q.to,customer:q.customer,supplier:q.supplier,status:q.status,deleted:q.deleted})}
  catch(error) {if(error instanceof ProjectError)return <p role="alert" className={REFUSAL}>{error.message}</p>;throw error}
  const [parties,projects]=await Promise.all([projectParties(company.id),projectSummaries(company.id,filters)])
  return <ProjectList ledgerId={ledgerId} company={company} projects={projects} filters={filters} parties={parties} actions={projectActions}/>
}

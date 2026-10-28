import { guardRoute } from '@/lib/gate'
import { projectCompany, projectFilters, projectHead, ProjectError } from '@/lib/project'
import { projectExport } from '@/lib/project-export'

export async function GET(request:Request,{params}:{params:Promise<{ledgerId:string}>}) {
  const who=await guardRoute();if(who instanceof Response)return who
  try {
    const {ledgerId}=await params,company=await projectCompany(ledgerId),query=new URL(request.url).searchParams
    const format=query.get('format')||'csv',what=query.get('what')||'summary',project=query.get('project')||undefined
    if(!['csv','xlsx'].includes(format)||!['summary','accounting','records','lines','payments','parties','balances','allocations','taxes'].includes(what))return new Response('Unknown Project export.',{status:400})
    if(project)await projectHead(company.id,project)
    const filters=projectFilters(Object.fromEntries(['q','from','to','customer','supplier','status','kind','settlement','tax'].map(k=>[k,query.get(k)||undefined])))
    const body=await projectExport(company.id,company.name,filters,project,what,format)
    return new Response(typeof body==='string'?body:new Uint8Array(body),{headers:{'Content-Type':format==='csv'?'text/csv; charset=utf-8':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="project-${what}.${format}"`,'Cache-Control':'no-store'}})
  } catch(error) {return new Response(error instanceof ProjectError?error.message:'Project export failed.',{status:error instanceof ProjectError?400:500})}
}

import { guardRoute } from '@/lib/gate'
import { projectCompany, projectHead, projectId, ProjectError } from '@/lib/project'
import { projectAttachments, readProjectBlob } from '@/lib/project-attachments'

export async function GET(_request:Request,{params}:{params:Promise<{ledgerId:string;attachmentId:string}>}) {
  const who=await guardRoute();if(who instanceof Response)return who
  try {
    const {ledgerId,attachmentId}=await params,company=await projectCompany(ledgerId)
    projectId(attachmentId)
    const a=(await projectAttachments(company.id)).find(row=>row.id===attachmentId)
    if(!a)return new Response('Document not found.',{status:404})
    await projectHead(company.id,a.project_id)
    const bytes=await readProjectBlob(company.id,a.project_id,a.sha256)
    if(!bytes)return new Response('Document bytes are missing from the Project store.',{status:404})
    return new Response(new Uint8Array(bytes),{headers:{'Content-Type':a.mime,'Content-Disposition':`attachment; filename="project-document"; filename*=UTF-8''${encodeURIComponent(a.uploaded_filename).replace(/'/g,'%27')}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})
  } catch(error) {
    if(error instanceof ProjectError&&error.code==='NO_PROJECT')return new Response('Document not found.',{status:404})
    return new Response('Project document could not be read.',{status:503})
  }
}

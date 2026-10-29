import { guardRoute } from '@/lib/gate'
import { projectCompany, ProjectError } from '@/lib/project'
import { projectPaymentAttachmentTarget, readProjectPaymentAttachment } from '@/lib/project-attachments'

/** A Project-only seat may read this payment's proof, never arbitrary entry files. */
export async function GET(_request:Request,{params}:{params:Promise<{ledgerId:string;projectId:string;paymentId:string;attachmentId:string}>}) {
  const who=await guardRoute();if(who instanceof Response)return who
  try {
    const {ledgerId,projectId,paymentId,attachmentId}=await params,company=await projectCompany(ledgerId)
    const target=await projectPaymentAttachmentTarget(company.id,projectId,paymentId)
    if(target.ledger_id&&target.ledger_id!==ledgerId.toLowerCase())return new Response('Document not found.',{status:404})
    const file=await readProjectPaymentAttachment(company.id,projectId,paymentId,attachmentId)
    if(!file)return new Response('Document not found.',{status:404})
    const inline=/^(application\/pdf|image\/(png|jpeg|webp|gif|tiff|heic|heif|avif))$/.test(file.mime)
    return new Response(new Uint8Array(file.bytes),{headers:{
      'Content-Type':inline?file.mime:'application/octet-stream',
      'Content-Disposition':`${inline?'inline':'attachment'}; filename="payment-proof"; filename*=UTF-8''${encodeURIComponent(file.filename).replace(/'/g,'%27')}`,
      'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
    }})
  } catch(error) {
    if(error instanceof ProjectError&&error.code!=='FILE'&&error.code!=='STORAGE')return new Response('Document not found.',{status:404})
    return new Response('The supporting document could not be read.',{status:503,headers:{'Cache-Control':'no-store'}})
  }
}

import {guardRoute} from '@/lib/gate'
import {GET as approvedPdf} from '../../../../automation/mail/[messageId]/file/route'
export const dynamic='force-dynamic'
export async function GET(request:Request,context:{params:Promise<{ledgerId:string;messageId:string}>}){
  const who=await guardRoute();if(who instanceof Response)return who
  return approvedPdf(request,context)
}

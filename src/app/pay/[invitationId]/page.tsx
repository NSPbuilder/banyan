import {requirePortalConfirmation} from '@/lib/gate'
import {Portal} from './Portal'
export const dynamic='force-dynamic'
export const metadata={title:'Invoice',robots:{index:false,follow:false}}
export default async function InvoiceLink({params}:{params:Promise<{invitationId:string}>}){
  const {invitationId}=await params
  if(!await requirePortalConfirmation(invitationId))return <main className="mx-auto max-w-xl px-6 py-12"><p>This invoice link is unavailable. Ask its sender for a new link.</p></main>
  return <main className="mx-auto max-w-xl px-6 py-12"><h1 className="mb-6 text-2xl font-medium">Your invoice</h1><Portal invitationId={invitationId}/></main>
}

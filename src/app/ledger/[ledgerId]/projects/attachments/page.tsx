import { redirect } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
export default async function ProjectAttachmentIndex({params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params
  await requireLedger(ledgerId,'/projects')
  redirect(`/ledger/${ledgerId}/projects`)
}

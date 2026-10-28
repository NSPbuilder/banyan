import { redirect } from 'next/navigation'
import { requireLedger } from '@/lib/gate'

/** No screen of its own: a trimmed receipt URL lands on the Project (N25). */
export default async function PaymentsIndex({params}:{params:Promise<{ledgerId:string;projectId:string}>}) {
  const {ledgerId,projectId}=await params;await requireLedger(ledgerId,'/projects')
  redirect(`/ledger/${ledgerId}/projects/${projectId}`)
}

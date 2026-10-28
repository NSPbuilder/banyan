import { redirect } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
export default async function SourceIndex({params}:{params:Promise<{ledgerId:string;entryId:string}>}) {
  const {ledgerId,entryId}=await params;await requireLedger(ledgerId,'/entries')
  redirect(`/ledger/${ledgerId}/entries/${entryId}`)
}

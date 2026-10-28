import {requireLedger} from '@/lib/gate'
import {redirect} from 'next/navigation'
export default async function InboundSource({params}:{params:Promise<{ledgerId:string}>}){
  const {ledgerId}=await params;await requireLedger(ledgerId,'/automation');redirect(`/ledger/${ledgerId}/automation/inbound`)
}

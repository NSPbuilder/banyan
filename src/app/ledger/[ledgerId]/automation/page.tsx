import {redirect} from 'next/navigation'
import {requireLedger} from '@/lib/gate'
export const dynamic='force-dynamic'
export default async function BackDesk({params}:{params:Promise<{ledgerId:string}>}){const {ledgerId}=await params;await requireLedger(ledgerId,'/automation');redirect(`/ledger/${ledgerId}/automation/jobs`)}

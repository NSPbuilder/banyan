import { redirect } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
export default async function MigrationSources({params}:{params:Promise<{ledgerId:string;runId:string}>}) {
 const {ledgerId,runId}=await params;await requireLedger(ledgerId,'/opening')
 redirect(`/ledger/${ledgerId}/opening/migration/${runId}`)
}

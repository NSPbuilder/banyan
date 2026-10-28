import { redirect } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
export default async function SourceIndex({params}:{params:Promise<{ledgerId:string;invoiceId:string}>}) {
  const {ledgerId,invoiceId}=await params;await requireLedger(ledgerId,'/invoices')
  redirect(`/ledger/${ledgerId}/invoices/${invoiceId}`)
}

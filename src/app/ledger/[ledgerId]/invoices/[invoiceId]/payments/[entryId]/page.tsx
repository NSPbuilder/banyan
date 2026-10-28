import { redirect } from 'next/navigation'
import { requireLedger } from '@/lib/gate'

/** No screen of its own: a trimmed receipt URL lands on the invoice (N25). */
export default async function PaymentIndex({params}:{params:Promise<{ledgerId:string;invoiceId:string}>}) {
  const {ledgerId,invoiceId}=await params;await requireLedger(ledgerId,'/invoices')
  redirect(`/ledger/${ledgerId}/invoices/${invoiceId}`)
}

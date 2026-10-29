import { redirect } from 'next/navigation'
import { requireLedger } from '@/lib/gate'

/** A trimmed file URL returns to its payment, like the surrounding indexes. */
export default async function PaymentAttachmentsIndex({params}:{params:Promise<{ledgerId:string;projectId:string;paymentId:string}>}) {
  const {ledgerId,projectId,paymentId}=await params
  await requireLedger(ledgerId,'/projects')
  redirect(`/ledger/${ledgerId}/projects/${projectId}#payment-${paymentId}`)
}

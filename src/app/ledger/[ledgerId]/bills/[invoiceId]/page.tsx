import { requireUser } from '@/lib/gate'
import { DetailBody } from '../../invoices/[invoiceId]/DetailBody'

export const dynamic = 'force-dynamic'

export default async function BillPage({ params }: { params: Promise<{ ledgerId: string; invoiceId: string }> }) {
  await requireUser()
  const { ledgerId, invoiceId } = await params
  return <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
    <DetailBody ledgerId={ledgerId} invoiceId={invoiceId} direction="purchase" crumb />
  </main>
}

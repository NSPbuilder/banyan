import { requireUser } from '@/lib/gate'
import { DetailBody } from './DetailBody'

export const dynamic = 'force-dynamic'

/**
 * The deep link: the same body the overlay floats over, framed as a full
 * page. `DetailBody` holds everything; this file may add furniture only —
 * and the way back is furniture the body has to place, because only it knows
 * which direction this document belongs to.
 */
export default async function OneInvoice({
  params,
}: { params: Promise<{ ledgerId: string; invoiceId: string }> }) {
  await requireUser()

  const { ledgerId, invoiceId } = await params

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <DetailBody ledgerId={ledgerId} invoiceId={invoiceId} crumb />
    </main>
  )
}

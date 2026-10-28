
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { EditInvoiceBody } from './EditInvoiceBody'

export const dynamic = 'force-dynamic'

/** The deep link: same body as the overlay, framed as a full page. */
export default async function EditInvoicePage({
  params,
}: { params: Promise<{ ledgerId: string; invoiceId: string }> }) {
  await requireUser()

  const { ledgerId, invoiceId } = await params
  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={`/ledger/${ledgerId}/invoices/${invoiceId}`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to the document</ToolAction></Link>
      <EditInvoiceBody ledgerId={ledgerId} invoiceId={invoiceId} />
    </main>
  )
}

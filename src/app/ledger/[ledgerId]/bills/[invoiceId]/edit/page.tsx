import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { EditInvoiceBody } from '../../../invoices/[invoiceId]/edit/EditInvoiceBody'

export const dynamic = 'force-dynamic'

export default async function EditBillPage({ params }: { params: Promise<{ ledgerId: string; invoiceId: string }> }) {
  await requireUser()
  const { ledgerId, invoiceId } = await params
  return <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
    <Link href={`/ledger/${ledgerId}/bills/${invoiceId}`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to the bill</ToolAction></Link>
    <EditInvoiceBody ledgerId={ledgerId} invoiceId={invoiceId} direction="purchase" />
  </main>
}

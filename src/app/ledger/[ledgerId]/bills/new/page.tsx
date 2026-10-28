import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { NewInvoiceBody } from '../../invoices/new/NewInvoiceBody'

export const dynamic = 'force-dynamic'

export default async function NewBillPage({ params, searchParams }: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ reading?: string; copy?: string }>
}) {
  await requireUser()
  const { ledgerId } = await params
  const { reading, copy } = await searchParams
  return <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
    <Link href={reading ? `/ledger/${ledgerId}/readings` : `/ledger/${ledgerId}/bills`} className={TOOL_BUTTON} title="Back">
      <ToolAction kind="back">{reading ? 'Back to AI' : 'Back to Supplier bills'}</ToolAction>
    </Link>
    <NewInvoiceBody ledgerId={ledgerId} readingId={reading} copyId={copy} direction="purchase" />
  </main>
}

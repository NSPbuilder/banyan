
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { NewInvoiceBody } from './NewInvoiceBody'

export const dynamic = 'force-dynamic'

/** The deep link: same body as the overlay, framed as a full page. */
export default async function NewInvoicePage({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ reading?: string; direction?: string; copy?: string }> }) {
  await requireUser()

  const { ledgerId } = await params
  // `?reading=<id>`: open filled in from a reading (0064) — a purchase bill, or
  // with `&direction=sales` a sales invoice (2026-09-15).
  const { reading, direction, copy } = await searchParams
  if (direction === 'purchase' || reading && direction !== 'sales') {
    const query = new URLSearchParams()
    if (reading) query.set('reading', reading)
    if (copy) query.set('copy', copy)
    redirect(`/ledger/${ledgerId}/bills/new${query.size ? '?' + query.toString() : ''}`)
  }

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <Link href={reading ? `/ledger/${ledgerId}/readings` : `/ledger/${ledgerId}/invoices`}
            className={TOOL_BUTTON} title="Back"><ToolAction kind="back">{reading ? 'Back to AI' : 'Back to Invoices'}</ToolAction></Link>
      <NewInvoiceBody ledgerId={ledgerId} readingId={reading} direction="sales" copyId={copy} />
    </main>
  )
}

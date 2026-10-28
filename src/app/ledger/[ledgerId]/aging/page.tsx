
import { PageHeading } from '@/components/DialogHeading'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import { requireUser } from '@/lib/gate'
import { notFound } from 'next/navigation'
import { BUCKETS, aging } from '@/lib/aging'
import { localToday } from '@/lib/today'
import { AgingScreen } from './AgingScreen'
import { DateInput } from '@/components/DateInput'
import { ledgerHead } from '@/lib/ledger-head'
import { FIELD, QUIET } from '@/lib/ui'

export const dynamic = 'force-dynamic'

export default async function AgingPage({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ asOf?: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const { asOf: asked } = await searchParams

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  // The local day, not the UTC one — `R47` and `today.ts` explain why, and an
  // aging report dated tomorrow puts everything one day older than it is.
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asked ?? '') ? asked! : localToday()

  const [ar, ap] = await Promise.all([
    aging(ledgerId, 'trade_receivables', asOf),
    aging(ledgerId, 'trade_payables', asOf),
  ])

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeading className="mt-2" title={<>Aging</>} />
      <p className="mt-1 max-w-2xl text-sm text-neutral-500">
        Read from the ledger as at {asOf}.
      </p>

      <form className="mt-6 flex flex-wrap items-end gap-2" method="get">
        <label className="text-xs text-neutral-500">
          <span className="block">As at</span>
          <DateInput name="asOf" defaultValue={asOf}
                 className={`mt-1 ${FIELD}`} />
        </label>
        <button type="submit" className={QUIET}>
          Show
        </button>
        <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 pb-1 text-sm print:hidden">
          <a href={`/ledger/${ledgerId}/aging/pdf?asOf=${asOf}`} target="_blank"
             className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">Download PDF</ToolAction></a>
          <a href={`/ledger/${ledgerId}/aging/pdf?asOf=${asOf}&format=xlsx`}
             className={TOOL_BUTTON} title="Download Excel"><ToolAction kind="xlsx">Download Excel</ToolAction></a>
        </span>
      </form>

      <AgingScreen ledgerId={ledgerId} buckets={BUCKETS} ar={ar} ap={ap} />
    </main>
  )
}

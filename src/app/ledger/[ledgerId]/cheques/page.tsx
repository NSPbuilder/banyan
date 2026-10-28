
import { PageHeading } from '@/components/DialogHeading'

import { DataTable } from '@/components/Table'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { chequesForLedger } from '@/lib/cheques'
import { formatMoney } from '@/lib/money'
import { BUTTON, PAGE_HEADER } from '@/lib/ui'

export const dynamic = 'force-dynamic'

export default async function ChequesPage({ params }: { params: Promise<{ ledgerId: string }> }) {
  await requireUser()
  const { ledgerId } = await params
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()
  const rows = await chequesForLedger(ledgerId)
  return <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
    <div className={`mt-2 ${PAGE_HEADER}`}>
      <PageHeading title={<>Cheques</>} />
      <Link href={`/ledger/${ledgerId}/cheques/new`} className={BUTTON}>New cheque</Link>
    </div>
    <p className="mt-1 text-sm text-neutral-500">{head.entity}</p>

    {rows.length === 0 ? <p className="mt-10 text-sm text-neutral-500">No cheques yet.</p> :
      <DataTable density="reading" className="mt-8 w-full text-sm">
        <thead><tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
          <th className="py-2">Number</th><th>Date</th><th>Payee</th><th>Bank</th>
          <th>Source</th><th className="text-right">Amount</th><th className="text-right">Status</th><th className="text-right">Action</th>
        </tr></thead>
        <tbody>{rows.map((c) => <tr key={c.id} className="border-b border-neutral-200 dark:border-neutral-800">
          <td className="py-3 font-mono"><Link className="underline" href={`/ledger/${ledgerId}/cheques/${c.id}`}>{c.number}</Link></td>
          <td>{c.cheque_date}</td><td>{c.payee}</td><td>{c.bank_code}</td>
          <td className="capitalize">{c.source_kind}</td>
          <td className="text-right font-mono tabular-nums">{formatMoney(BigInt(c.amount))}</td>
          <td className="text-right text-neutral-500">{c.status === 'void' ? 'Void' : c.source_status !== 'posted' ? 'Source cancelled' : c.source_matches ? 'Issued' : 'Source changed'}</td>
          <td className="text-right">{c.status === 'issued' && c.source_status === 'posted' && c.source_matches &&
            <Link className="underline" href={`/ledger/${ledgerId}/cheques/${c.id}#edit-cheque`}>Edit</Link>}</td>
        </tr>)}</tbody>
      </DataTable>}
  </main>
}

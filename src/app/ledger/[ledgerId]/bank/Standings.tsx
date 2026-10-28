
import { DataTable } from '@/components/Table'
import { formatNumber } from '@/lib/numbers'
import Link from 'next/link'
import type { AccountStanding } from '@/lib/bank'

/**
 * Where each bank account stands — one table, read from either door. The
 * columns are the same; which link comes first is the only difference, so the
 * two landings cannot describe an account two ways.
 */
export function Standings({ ledgerId, standings, door }: {
  ledgerId: string
  standings: AccountStanding[]
  door: 'feed' | 'reconcile'
}) {
  if (standings.length === 0) {
    return (
      <p className="mt-6 text-sm text-neutral-500">
        No bank rows on file yet. Read a file in and choose the account it belongs to.
      </p>
    )
  }
  const th = 'py-2 pr-4 font-medium'
  return (
    <DataTable density="reading" className="mt-6 w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
          <th className={th}>Account</th>
          <th className={`${th} text-right`}>Rows</th>
          <th className={`${th} text-right`}>To review</th>
          <th className={th}>Newest statement</th>
          <th className={th}>Reconciled through</th>
          <th className="py-2 font-medium" />
        </tr>
      </thead>
      <tbody>
        {standings.map((a) => {
          const base = `/ledger/${ledgerId}/bank/${a.id}`
          const feed = <Link href={base} className="underline">Bank feed</Link>
          const recon = <Link href={`${base}/reconcile`} className="underline">Reconcile</Link>
          return (
            <tr key={a.id} className="border-b border-neutral-200 dark:border-neutral-800">
              <td className="py-2 pr-4">{a.code} — {a.name}</td>
              <td className="py-2 pr-4 text-right font-mono tabular-nums">{a.rows}</td>
              <td className={`py-2 pr-4 text-right font-mono tabular-nums ${a.review > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-neutral-400'}`}>
                {formatNumber(a.review)}
              </td>
              <td className="py-2 pr-4 font-mono text-xs">{a.newestStatement ?? <span className="text-neutral-400">none</span>}</td>
              <td className="py-2 pr-4 font-mono text-xs">
                {a.finishedThrough ?? <span className="text-neutral-400">not yet</span>}
              </td>
              <td className="py-2 text-xs">
                <span className="flex gap-3">
                  {door === 'feed' ? <>{feed}{recon}</> : <>{recon}{feed}</>}
                </span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </DataTable>
  )
}

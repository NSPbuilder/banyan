'use client'

import { DataTable } from '@/components/Table'

import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import type { Aging, Bucket } from '@/lib/aging'

/**
 * Who owes what, and for how long.
 *
 * The columns come from the same `BUCKETS` list the SQL builds its sums from —
 * two lists would eventually put a figure under a heading it does not belong
 * to, and every total would still add up.
 *
 * The two lines under the table are not decoration. "What the accounts say" is
 * the same question asked a different way, and printing both is the only reason
 * a reader can trust the first: a report derived from the ledger that disagreed
 * with the ledger would otherwise look exactly like one that agreed.
 */
export function AgingScreen({
  ledgerId, buckets, ar, ap,
}: {
  ledgerId: string
  buckets: Bucket[]
  ar: Aging
  ap: Aging
}) {
  return (
    <>
      <Side ledgerId={ledgerId} buckets={buckets} data={ar} statements
            title="Owed to us" empty="Nobody owes anything as at this date." />
      <Side ledgerId={ledgerId} buckets={buckets} data={ap}
            title="Owed by us" empty="Nothing outstanding as at this date." />
    </>
  )
}

function Side({
  ledgerId, buckets, data, title, empty, statements,
}: {
  ledgerId: string; buckets: Bucket[]; data: Aging; title: string; empty: string
  /** Receivables only: a statement is OUR document to a customer. */
  statements?: boolean
}) {
  const summed = data.totals.reduce((s, b) => s + b, 0n)
  const agrees = summed + data.unattributed === data.controlBalance

  // Every figure opens the open items behind it: a party's bucket, a party's
  // total (no bucket), a bucket's column (no party), the unattributed amount.
  const drill = (opts: { party?: string; bucket?: number } = {}) =>
    `/ledger/${ledgerId}/breakdown?kind=aging&role=${data.role}&asOf=${data.asOf}` +
    (opts.party !== undefined ? `&party=${opts.party}` : '') +
    (opts.bucket !== undefined ? `&bucket=${opts.bucket}` : '')

  return (
    <section className="mt-10">
      <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">{title}</h2>

      {data.rows.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">{empty}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <DataTable density="reading" className="w-full min-w-[42rem] text-sm">
            <tbody>
              <tr className="border-b border-neutral-300 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
                <td className="py-1">Party</td>
                {buckets.map((b) => (
                  <td key={b.label} className="py-1 text-right">{b.label}</td>
                ))}
                <td className="py-1 text-right">Total</td>
              </tr>
              {data.rows.map((r) => (
                <tr key={r.party_id} className="border-b border-neutral-200 dark:border-neutral-800">
                  <td className="py-2">
                    <Link href={`/ledger/${ledgerId}/parties/${r.party_id}`} className="hover:underline">
                      {r.party_name}
                    </Link>
                    {statements && (
                      <Link href={`/ledger/${ledgerId}/parties/${r.party_id}/statement`}
                            className="ml-2 text-xs text-neutral-500 underline hover:text-neutral-800 dark:hover:text-neutral-200">
                        statement
                      </Link>
                    )}
                  </td>
                  {r.buckets.map((amount, i) => (
                    <td key={buckets[i].label}
                        className="py-2 text-right font-mono tabular-nums text-neutral-600 dark:text-neutral-400">
                      {amount === 0n ? '' : (
                        <Link href={drill({ party: r.party_id, bucket: i })} className="hover:underline">
                          {formatMoney(amount)}
                        </Link>
                      )}
                    </td>
                  ))}
                  <td className="py-2 text-right font-mono tabular-nums">
                    <Link href={drill({ party: r.party_id })} className="hover:underline">
                      {formatMoney(r.total)}
                    </Link>
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-2 text-xs uppercase tracking-wide text-neutral-500">All of them</td>
                {data.totals.map((amount, i) => (
                  <td key={buckets[i].label} className="py-2 text-right font-mono tabular-nums">
                    {amount === 0n ? '' : (
                      <Link href={drill({ bucket: i })} className="hover:underline">
                        {formatMoney(amount)}
                      </Link>
                    )}
                  </td>
                ))}
                <td className="py-2 text-right font-mono tabular-nums">
                  <Link href={drill()} className="hover:underline">{formatMoney(summed)}</Link>
                </td>
              </tr>
            </tbody>
          </DataTable>
        </div>
      )}

      <dl className="mt-3 space-y-1 text-xs text-neutral-500">
        <div className="flex gap-2">
          <dt>What the accounts say</dt>
          <dd className="font-mono tabular-nums">{formatMoney(data.controlBalance)}</dd>
        </div>
        {data.unattributed !== 0n && (
          <div className="flex gap-2">
            <dt className="text-amber-700 dark:text-amber-500">Owed by nobody</dt>
            <dd className="font-mono tabular-nums text-amber-700 dark:text-amber-500">
              <Link href={drill({ party: 'none' })} className="hover:underline">
                {formatMoney(data.unattributed)}
              </Link>
            </dd>
            <dd>— on the control account with no party named, so it is in no row above</dd>
          </div>
        )}
        {!agrees && (
          <div className="text-red-700 dark:text-red-400">
            The rows and the accounts disagree. That should not be possible — both
            are the same journal lines — so something above is not what it says.
          </div>
        )}
      </dl>
    </section>
  )
}

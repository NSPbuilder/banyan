
import { PageHeading } from '@/components/DialogHeading'

import { DataTable } from '@/components/Table'
import { formatNumber } from '@/lib/numbers'
import { requireUser } from '@/lib/gate'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { search } from '@/lib/search'
import { formatMoney } from '@/lib/money'
import { SearchBox } from '@/components/SearchBox'
import { ledgerHead } from '@/lib/ledger-head'

export const dynamic = 'force-dynamic'

/**
 * One box, everything the books know.
 *
 * The page runs no query of its own: `search()` is the derivation and this
 * file lays it out. What it must be careful about is the ledger — every hit
 * is a link into THIS company, and `SR9` is the check that says the search
 * never reached into another one.
 */
export default async function Search({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ q?: string }>
}) {
  await requireUser()

  const { ledgerId } = await params
  const { q = '' } = await searchParams

  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const { query, hits } = await search(ledgerId, q)
  const kinds = [...new Set(hits.map((h) => h.kind))]

  return (
    <main className="mx-auto w-full max-w-none px-8 py-10 font-sans">
      <PageHeading className="mt-2" title={<>Search</>} />
      <p className="mt-1 text-sm text-neutral-500">{head.entity}</p>

      <div className="mt-6 max-w-xl">
        <SearchBox label="Search this company" value={query.text} autoFocus
                   />
      </div>

      {query.text && (
        <p className="mt-3 text-xs text-neutral-500">
          {hits.length === 0 ? 'Nothing found.' : `${formatNumber(hits.length)} ${hits.length === 1 ? 'hit' : 'hits'}`}
          {query.cents.length > 0 && (
            <> · read as an amount: {query.cents.map((c) => formatMoney(c)).join(' or ')}</>
          )}
          {query.date && <> · read as a date: {query.date}</>}
        </p>
      )}

      {kinds.map((kind) => (
        <section key={kind} className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">{kind}</h2>
          <DataTable density="reading" className="mt-2 w-full text-sm">
            <tbody>
              {hits.filter((h) => h.kind === kind).map((h, i) => (
                <tr key={i} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="w-28 py-2 pr-3 align-top font-mono text-xs text-neutral-500">
                    {h.date ?? ''}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <Link href={`/ledger/${ledgerId}${h.href}`} className="hover:underline">
                      {h.title}
                    </Link>
                    <div className="text-xs text-neutral-500">{h.detail}</div>
                  </td>
                  <td className="w-32 py-2 text-right align-top font-mono tabular-nums">
                    {h.amount === null ? '' : formatMoney(BigInt(h.amount), { sign: 'accounting' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </section>
      ))}
    </main>
  )
}

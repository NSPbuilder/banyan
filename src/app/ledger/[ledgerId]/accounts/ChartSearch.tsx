'use client'

import { formatNumber } from '@/lib/numbers'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { matchesAccountSearch } from '@/lib/forms'
import { chartTree, withAncestors } from '@/lib/chart-tree'
import { Money } from '@/components/AccountingData'
import { RoleEditor } from './RoleEditor'
import type { TaggableRole } from '@/lib/forms'
import { FIELD, LABEL, GHOST, tableIndent } from '@/lib/ui'
import { DataTable, TableViewport } from '@/components/Table'
import { FilterBar } from '@/components/FormLayout'

export type ChartRow = {
  id: string; version?:string; code: string; name: string; account_type: string; normal_balance: string
  is_postable: boolean; is_active: boolean; parent_code: string | null
  roles: string[] | null; role_labels: string[] | null; balance: string
}

const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const
const TYPE_LABEL: Record<string, string> = {
  asset: 'Assets', liability: 'Liabilities', equity: 'Equity',
  revenue: 'Income', expense: 'Expenses',
}
const NORMAL: Record<string, string> = {
  asset: 'debit', expense: 'debit', liability: 'credit', equity: 'credit', revenue: 'credit',
}

export function ChartSearch({
  ledgerId, accounts, roles,
}: { ledgerId: string; accounts: ChartRow[]; roles: TaggableRole[] }) {
  const [query, setQuery] = useState('')
  /**
   * WHAT MATCHED, and what has to be drawn to show where it lives.
   *
   * Searching "fuel" should answer "Vehicle expenses → Fuel", not a bare Fuel
   * with no hint of where it sits — so the ancestors of every match are drawn
   * too. They are context, not matches: the count says how many matched, and
   * the rows themselves are dimmed, or the screen would claim to have found
   * accounts the person did not ask for.
   */
  const matched = useMemo(
    () => accounts.filter((a) => matchesAccountSearch(a, query)),
    [accounts, query])
  const shown = useMemo(() => withAncestors(accounts, matched), [accounts, matched])
  const isMatch = useMemo(() => new Set(matched.map((a) => a.id)), [matched])

  return (
    <>
      <FilterBar actions={<span className="text-metadata text-ink-muted">
        {query ? `${formatNumber(matched.length)} of ${formatNumber(accounts.length)}` : `${formatNumber(accounts.length)} accounts`}
      </span>}>
        <label className={`w-full max-w-sm ${LABEL}`}>Search accounts
          <input type="search" value={query} aria-label="Search chart of accounts"
            onChange={(e) => setQuery(e.target.value)} className={`mt-1 w-full ${FIELD}`} />
        </label>
      </FilterBar>

      {matched.length === 0 && (
        <div className="py-5 text-label text-ink-muted" role="status"><p>No accounts match “{query}”.</p><button type="button" className={`mt-2 ${GHOST}`} onClick={() => setQuery('')}>Clear search</button></div>
      )}

      {TYPE_ORDER.map((type) => {
        // One tree per type, which is the whole chart's tree: 0078 refuses a
        // parent of another type, so no branch is ever split across sections.
        const rows = chartTree(shown.filter((a) => a.account_type === type))
        if (rows.length === 0) return null
        return (
          <section key={type} className="mt-5">
            <h2 className="mb-2 text-section-title font-semibold">
              {TYPE_LABEL[type]}
            </h2>
            <TableViewport label={`${TYPE_LABEL[type]} accounts`}>
            <DataTable className="min-w-[44rem]">
              <thead><tr><th className="w-24 text-left">Code</th><th className="text-left">Account</th><th className="w-2/5 text-left">Statement roles</th><th className="w-32 text-right">Balance</th></tr></thead>
              <tbody>
                {rows.map(({ row: a, depth }) => (
                  <tr data-row key={a.id} className={`border-b border-neutral-200 align-top dark:border-neutral-800 ${
                    isMatch.has(a.id) ? '' : 'opacity-50'}`}>
                    {/* Indented by DEPTH, not by anything read off the code:
                        codes are the CRA's vocabulary (GIFI) and say nothing
                        about the tree. `paddingLeft` rather than a margin so
                        the cell's own border stays where the column is. */}
                    <td className="w-20 whitespace-nowrap py-2 font-mono" style={tableIndent(depth, 1.1)}>
                      <Link href={`/ledger/${ledgerId}/accounts/${a.id}`} className="hover:underline">
                        {a.code}
                      </Link>
                    </td>
                    <td className="py-2 pr-3" style={{ paddingLeft: `${depth * 1.1}rem` }}>
                      <Link href={`/ledger/${ledgerId}/accounts/${a.id}`} className="hover:underline">
                        {a.name}
                      </Link>
                      {!a.is_postable && <span className="ml-2 text-xs text-neutral-500">heading</span>}
                      {!a.is_active && <span className="ml-2 text-xs text-neutral-500">inactive</span>}
                      {a.normal_balance !== NORMAL[type] && (
                        <span className="ml-2 text-xs text-neutral-500">contra</span>
                      )}
                    </td>
                    <td className="w-2/5 py-2">
                      <RoleEditor
                        ledgerId={ledgerId} accountId={a.id} accountType={a.account_type} version={a.version}
                        current={a.roles ?? []} currentLabels={a.role_labels ?? []} roles={roles}
                      />
                    </td>
                    {/* The figure sits LAST, right-aligned (owner, 2026-09-03)
                        — it was squeezed between the name and the roles. A
                        position for the balance-sheet types, read the way the
                        account normally sits; P&L balances belong to a period
                        and live on the reports. */}
                    <td className="w-32 py-2 text-right font-mono text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
                      {['asset', 'liability', 'equity'].includes(type) ? (
                        <Link href={`/ledger/${ledgerId}/accounts/${a.id}`} className="hover:underline">
                          <Money cents={a.normal_balance === 'debit' ? BigInt(a.balance) : -BigInt(a.balance)} />
                        </Link>
                      ) : <Money cents={null} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
            </TableViewport>
          </section>
        )
      })}
    </>
  )
}

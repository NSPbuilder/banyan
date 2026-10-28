'use client'

import { DataTable } from '@/components/Table'

import { useState } from 'react'
import { formatMoney } from '@/lib/money'

/**
 * An entry's lines on the journal list, folded past the second.
 *
 * A pay run touches a dozen accounts and a store receipt touches three, and
 * the list showed every line of every one — so finding an entry meant
 * scrolling past the ones you had already rejected (owner, 2026-09-07:
 * 「有的比较长的journal会占用比较大的上下空间」).
 *
 * TWO LINES, because two is what an entry is: something went somewhere and
 * came from somewhere. Anything past that is the shape of this particular
 * entry, and the entry's own page is where you read it.
 *
 * The count is on the button rather than under it, so a folded entry still
 * says how much it is hiding — a fold that does not is a line you have to
 * open to find out whether you wanted it.
 */

const SHOWN = 2

export function EntryLines({
  accounts, names, debits, credits,
}: { accounts: string[]; names: string[]; debits: string[]; credits: string[] }) {
  const [open, setOpen] = useState(false)
  const hidden = accounts.length - SHOWN
  const rows = open ? accounts : accounts.slice(0, SHOWN)
  // Built without a template literal on purpose: the mutation battery anchors
  // its blocks on whole source lines, and a line carrying `${…}` cannot be
  // one (mutations.sh).
  const plural = hidden === 1 ? ' more line…' : ' more lines…'
  const moreLabel = String(hidden) + plural

  return (
    <DataTable density="reading" className="ui-line-preview mt-1 w-full max-w-lg text-xs text-neutral-500">
      <tbody>
        {rows.map((code, i) => (
          <tr key={i}>
            <td className="w-14 py-0.5 font-mono">{code}</td>
            <td className="py-0.5 pr-4">{names[i]}</td>
            <td className="w-24 py-0.5 text-right tabular-nums">
              {debits[i] !== '0' ? formatMoney(BigInt(debits[i])) : ''}
            </td>
            <td className="w-24 py-0.5 text-right tabular-nums">
              {credits[i] !== '0' ? formatMoney(BigInt(credits[i])) : ''}
            </td>
          </tr>
        ))}
        {hidden > 0 && (
          <tr>
            <td colSpan={4} className="py-0.5">
              <button type="button" onClick={() => setOpen(!open)}
                      className="text-xs text-neutral-500 hover:text-clay-700 hover:underline dark:hover:text-clay-300">
                {open ? 'Show less' : moreLabel}
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </DataTable>
  )
}

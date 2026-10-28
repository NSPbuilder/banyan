'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { HIDE_ZEROS } from '@/lib/reporting-view'

/**
 * "Only accounts with a figure", on a report.
 *
 * A chart has accounts nobody has posted to this year — a tax account for a
 * registration that came later, the equipment nobody bought yet — and every
 * one of them takes a line on the trial balance and in the general ledger
 * (owner, 2026-09-07). Hiding them is a READING choice, not a fact about the
 * books, so it lives in the URL: the report that gets shared, printed or
 * bookmarked is the report that was looked at.
 *
 * `replace` with `scroll: false`, like the range picker: refining what is on
 * this page is not going somewhere else, and pushing it would make Back mean
 * "show the zeros again" instead of "leave".
 */
export function ZeroFilter() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const on = params.get(HIDE_ZEROS) === '1'

  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-500">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString())
          if (e.target.checked) next.set(HIDE_ZEROS, '1')
          else next.delete(HIDE_ZEROS)
          const q = next.toString()
          router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false })
        }}
      />
      Only accounts with a figure
    </label>
  )
}

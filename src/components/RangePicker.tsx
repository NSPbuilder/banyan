'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { rangePresets } from '@/lib/date-range'
import { DateInput } from '@/components/DateInput'
import { FIELD, LABEL } from '@/lib/ui'

/**
 * From–to, with the four presets, everywhere a screen reads a span.
 *
 * Navigation is `router.replace(..., { scroll: false })`: picking a range is
 * refining the page you are READING, and the first version of the overview
 * used plain links whose navigation threw the reader back to the top of the
 * page on every click — the complaint that created this component.
 */
/**
 * A picked date only counts once it is whole AND real. The native date field
 * hands back '' while the reader is still choosing, and a year box accepts
 * five digits — either way what must not happen is navigating into a database
 * date cast with a shape nothing can parse. Pure integer arithmetic; no Date
 * object, whose UTC parsing is the R47 family of bugs.
 */
const isoDay = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
}

export function RangePicker({ from, to, today, allFrom, clearable }: {
  from: string; to: string; today: string
  /** The books' first day. When given, offers "All time" — that day through
   *  today, so a cumulative report can show its whole history in one click. */
  allFrom?: string
  /** Offer an "All" button that removes the range — for registers whose
   *  natural default is the whole history, not a month. */
  clearable?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const presets = rangePresets(today)

  const go = (nextFrom: string, nextTo: string) => {
    const q = new URLSearchParams(search.toString())
    q.delete('page')
    if (nextFrom || nextTo) {
      q.set('from', nextFrom)
      q.set('to', nextTo)
    } else {
      q.delete('from')
      q.delete('to')
    }
    const qs = q.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const selected = clearable && !from && !to ? 'all'
    : presets.find((p) => p.from === from && p.to === to)?.key
      ?? (allFrom && from === allFrom && to === today ? 'all-time' : 'custom')

  return (
    <div className="range-picker flex min-w-0 flex-wrap items-end gap-2 print:hidden">
      <label className={`${LABEL} flex flex-col gap-1`}>
        Period
        <select aria-label="Period preset" value={selected} className={FIELD}
          onChange={(e) => {
            const value = e.target.value
            if (value === 'all') go('', '')
            else if (value === 'all-time' && allFrom) go(allFrom, today)
            else {
              const preset = presets.find((p) => p.key === value)
              if (preset) go(preset.from, preset.to)
            }
          }}>
          {clearable && <option value="all">All</option>}
          {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          {allFrom && <option value="all-time">All time</option>}
          <option value="custom">Custom</option>
        </select>
      </label>
      <div className="range-dates flex min-w-0 flex-wrap gap-2" role="group" aria-label="Custom date range">
        <label className={`${LABEL} flex flex-col gap-1`}>
          From
          <DateInput defaultValue={from} key={`f-${from}`}
            onChange={(e) => isoDay(e.target.value) && go(e.target.value, to)} className={FIELD} />
        </label>
        <label className={`${LABEL} flex flex-col gap-1`}>
          To
          <DateInput defaultValue={to} key={`t-${to}`}
            onChange={(e) => isoDay(e.target.value) && go(from, e.target.value)} className={FIELD} />
        </label>
      </div>
    </div>
  )
}

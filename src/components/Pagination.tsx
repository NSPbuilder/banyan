import Link from 'next/link'
import { QUIET_COMPACT } from '@/lib/ui'
import { formatNumber } from '@/lib/numbers'

export function Pagination({ page, previous, next, count, total, pageSize, label = 'Pagination' }: {
  page: number; previous?: string; next?: string; count: number; total?: number; pageSize?: number; label?: string
}) {
  const caption = total !== undefined && pageSize ? `${formatNumber((page - 1) * pageSize + 1)}–${formatNumber(Math.min(page * pageSize, total))} of ${formatNumber(total)} · Page ${page} of ${Math.max(1, Math.ceil(total / pageSize))}`
    : `Page ${formatNumber(page)} · ${formatNumber(count)} records`
  return <>
  {total !== undefined && <p className="hidden print:block text-metadata">Displayed records: {caption}</p>}
  <nav aria-label={label} className="mt-3 flex flex-wrap items-center justify-between gap-3 text-metadata text-ink-muted print:hidden">
    <span className="tabular-nums">{caption}</span>
    <div className="flex gap-2">
      {previous ? <Link href={previous} scroll={false} className={QUIET_COMPACT}>Previous</Link> : <button className={QUIET_COMPACT} disabled>Previous</button>}
      {next ? <Link href={next} scroll={false} className={QUIET_COMPACT}>Next</Link> : <button className={QUIET_COMPACT} disabled>Next</button>}
    </div>
  </nav></>
}

import type { HTMLAttributes } from 'react'
import { formatMoney } from '@/lib/money'

/** Exact cents stay bigint. Null is inapplicable; zero is a real 0.00. */
export function Money({ cents, sign = 'accounting', currency, className = '', ...props }: {
  cents: bigint | string | null; sign?: 'accounting' | 'minus'; currency?: string; className?: string
} & HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={`ui-money whitespace-nowrap tabular-nums ${className}`}>
    {cents === null ? '—' : <>{currency && <span className="mr-1 text-metadata text-ink-muted">{currency}</span>}{formatMoney(BigInt(cents), { sign })}</>}
  </span>
}

/** Date-only values never pass through a timezone conversion. */
export function DateText({ value }: { value: string }) {
  return <time dateTime={value} className="whitespace-nowrap tabular-nums">{value}</time>
}

/** Timestamps display an explicit zone; retain the source precision in the tooltip. */
export function TimestampText({ value }: { value: string | null }) {
  if (!value) return <span className="text-ink-muted">Never</span>
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return <span title={value}>—</span>
  return <time dateTime={date.toISOString()} title={value} className="whitespace-nowrap tabular-nums">
    {date.toISOString().slice(0, 19).replace('T', ' ')} <span className="text-caption text-ink-muted">UTC</span>
  </time>
}

export function AccountLabel({ code, name }: { code: string; name: string }) {
  return <span className="inline-flex min-w-0 items-baseline gap-2" title={`${code} · ${name}`}>
    <span className="shrink-0 whitespace-nowrap font-mono text-metadata">{code}</span>
    <span>{name}</span>
  </span>
}

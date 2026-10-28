import { RE_READ_AFTER_DAYS, daysSinceRead, figuresOnOrNull } from '@/lib/tax-rates'

/**
 * Compact period-specific rates, with a warning when their check is overdue.
 *
 * `on` is the period's own end date, so a return filed for an earlier period
 * shows the figures that period was worked out with rather than today's.
 */
export function FiguresRead({ on, today }: { on: string; today: string }) {
  // NOTHING, not a crash. `to` comes off the address bar unchecked, so a period
  // that predates every figure on file used to 500 a screen that rendered
  // before this component existed (independent critic, 2026-09-12).
  const found = figuresOnOrNull(on)
  if (!found) return null
  const { rates, scale } = found
  const oldest = Math.max(daysSinceRead(rates.readOn, today), daysSinceRead(scale.readOn, today))
  const stale = oldest >= RE_READ_AFTER_DAYS
  return (
    <span role={stale ? 'status' : undefined} className={`text-xs ${stale
      ? 'font-medium text-amber-800 dark:text-amber-300' : 'text-neutral-500'}`}>
      GST {String(rates.gst)}% · PST {String(rates.pst)}% · Effective {rates.from}
      {stale && ' · Rate check overdue'}
    </span>
  )
}

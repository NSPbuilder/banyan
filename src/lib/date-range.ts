/**
 * Date ranges as data, client-safe — the presets every range picker offers.
 *
 * Presets are CALENDAR ranges computed from the local day (the repo's clock
 * rule: never UTC). Screens whose figures live in fiscal periods snap the
 * chosen range to the periods that cover it and say so — snapping is the
 * screen's business; the picker only picks.
 */
export type DateRange = { from: string; to: string }

export const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`
const monthEnd = (y: number, m: number) => new Date(y, m, 0).getDate()

/** `today` is a local YYYY-MM-DD (from `localToday()`); never a UTC slice. */
export function rangePresets(today: string): Array<{ key: string; label: string } & DateRange> {
  const [y, m] = today.split('-').map(Number)
  const prevY = m === 1 ? y - 1 : y
  const prevM = m === 1 ? 12 : m - 1
  return [
    { key: 'this-month', label: 'This month',
      from: iso(y, m, 1), to: iso(y, m, monthEnd(y, m)) },
    { key: 'last-month', label: 'Last month',
      from: iso(prevY, prevM, 1), to: iso(prevY, prevM, monthEnd(prevY, prevM)) },
    { key: 'this-year', label: 'This year',
      from: iso(y, 1, 1), to: iso(y, 12, 31) },
    { key: 'last-year', label: 'Last year',
      from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31) },
  ]
}

/**
 * The ONE spelling of a span's name. The screen headings and the CSV headers
 * both read this; critic round 1 found "Feb – Mar" on screen and "Feb to Mar"
 * in the file, two hand-kept spellings of one range.
 */
export function spanLabel(fromName: string, toName: string): string {
  return fromName === toName ? fromName : `${fromName} – ${toName}`
}

/** The day after an ISO date, as an ISO date — for ranges inclusive at both ends. */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

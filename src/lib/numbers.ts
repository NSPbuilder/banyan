const NUMBER_DISPLAY = new Intl.NumberFormat('en-CA', { useGrouping: true, maximumFractionDigits: 20 })

/** English display grouping, preserving exact decimal strings and bigint values. */
export function formatNumber(value: string | number | bigint): string {
  if (typeof value === 'number') {
    return NUMBER_DISPLAY.format(value)
  }
  const text = String(value)
  const match = /^([+-]?)(\d+)(\.\d+)?$/.exec(text)
  if (!match) return text
  return match[1] + match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (match[3] ?? '')
}

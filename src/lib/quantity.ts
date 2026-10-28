/** Exact quantities in millionths of a unit. Client-safe; never use floats. */
export const QUANTITY_SCALE = 1_000_000n
export function parseQuantity(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim())
  if (!m) throw new Error('Enter a non-negative quantity with at most 6 decimal places.')
  const n = BigInt(m[1]) * QUANTITY_SCALE + BigInt((m[2] ?? '').padEnd(6, '0'))
  if (n > 9_000_000_000_000_000_000n) throw new Error('Quantity is too large.')
  return n
}
export function quantityInput(value: bigint | string): string {
  const n = BigInt(value), abs = n < 0n ? -n : n
  const fraction = (abs % QUANTITY_SCALE).toString().padStart(6, '0').replace(/0+$/, '')
  return `${n < 0n ? '-' : ''}${abs / QUANTITY_SCALE}${fraction ? '.' + fraction : ''}`
}
export function formatQuantity(value: bigint | string): string {
  const [whole, fraction] = quantityInput(value).split('.')
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '')
}

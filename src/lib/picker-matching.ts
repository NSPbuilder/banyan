/** Fold case and spacing; every typed word may appear anywhere in the label or hint. */
const plain = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export function matches(option: { label: string; hint?: string }, typed: string): boolean {
  const words = plain(typed).split(' ').filter(Boolean)
  if (words.length === 0) return true
  const hay = plain(option.label + ' ' + (option.hint ?? ''))
  return words.every((w) => hay.includes(w))
}

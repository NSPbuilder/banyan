/** Target is the row's final position, after removing it from its old slot. */
export function moveLineTo<T>(rows: T[], from: number, to: number): T[] {
  if (!Number.isInteger(from) || !Number.isInteger(to)
    || from < 0 || from >= rows.length || to < 0 || to >= rows.length || from === to) return rows
  const next = [...rows]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row)
  return next
}

/**
 * THE SHAPE OF THE CHART, as a pure function of its rows.
 *
 * `account.parent_id` groups the chart and nothing else — statements read
 * roles, never the tree (0001, 0078) — so every consequence of a parent is a
 * drawing decision, and every drawing decision is here rather than inside a
 * component. RoleEditor taught that lesson at some cost: a `.filter()` that
 * lived inside a component was a rule no check could reach, and it silently
 * deleted a family of roles for a week.
 *
 * Nothing in this file imports anything. A check calls it directly.
 */

/** The little a row must carry to have a place in the tree. */
export type ChartLike = { id: string; code: string; parent_code: string | null }

export type TreeRow<T> = { row: T; depth: number }

/** Codes sort as text: the chart is read in code order at every level. */
const byCode = (a: ChartLike, b: ChartLike) => a.code.localeCompare(b.code)

/**
 * The rows in the order they are drawn, each with how far it is indented.
 *
 * A row whose parent is not in `rows` is drawn at the top level rather than
 * dropped. That happens for a real reason — the chart screen builds one tree
 * per account type, and a search shows a subset — and the alternative is a
 * screen that silently omits an account, which is the worst thing a chart of
 * accounts can do.
 *
 * EVERY ROW COMES BACK, exactly once. A cycle cannot be written (0078 refuses
 * it), but if one ever existed, its members would be unreachable from any root
 * and would vanish from the chart without a word; instead they are appended at
 * the top level. Nothing here trusts the database to be well-formed.
 */
export function chartTree<T extends ChartLike>(rows: T[]): TreeRow<T>[] {
  const present = new Map(rows.map((r) => [r.code, r]))
  const kids = new Map<string, T[]>()
  const roots: T[] = []

  for (const r of rows) {
    const parent = r.parent_code && present.has(r.parent_code) ? r.parent_code : null
    if (parent === null) roots.push(r)
    else kids.set(parent, [...(kids.get(parent) ?? []), r])
  }
  roots.sort(byCode)
  for (const list of kids.values()) list.sort(byCode)

  const out: TreeRow<T>[] = []
  const drawn = new Set<string>()
  const walk = (r: T, depth: number) => {
    if (drawn.has(r.id)) return
    drawn.add(r.id)
    out.push({ row: r, depth })
    for (const k of kids.get(r.code) ?? []) walk(k, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  for (const r of rows) if (!drawn.has(r.id)) { drawn.add(r.id); out.push({ row: r, depth: 0 }) }
  return out
}

/**
 * The matched rows, plus every ancestor needed to reach them.
 *
 * Searching "fuel" should answer "Vehicle expenses → Fuel", not a bare Fuel
 * with no hint of where it lives. The ancestors are context, not matches — the
 * screen counts and marks them as such.
 */
export function withAncestors<T extends ChartLike>(rows: T[], matched: T[]): T[] {
  const present = new Map(rows.map((r) => [r.code, r]))
  const keep = new Set(matched.map((r) => r.id))
  for (const m of matched) {
    let at = m.parent_code
    const walked = new Set<string>()
    while (at && !walked.has(at)) {
      walked.add(at)
      const p = present.get(at)
      if (!p) break
      keep.add(p.id)
      at = p.parent_code
    }
  }
  return rows.filter((r) => keep.has(r.id))
}

/**
 * Every code below this one, however deep.
 *
 * What the parent list on the account form must refuse to offer: an account
 * cannot sit under its own sub-account. 0078 refuses that anyway — this is so
 * the person is never shown the choice that would be refused.
 */
export function descendantCodes<T extends ChartLike>(rows: T[], code: string): string[] {
  const kids = new Map<string, string[]>()
  for (const r of rows) {
    if (!r.parent_code) continue
    kids.set(r.parent_code, [...(kids.get(r.parent_code) ?? []), r.code])
  }
  const out: string[] = []
  const seen = new Set<string>([code])
  const walk = (at: string) => {
    for (const k of kids.get(at) ?? []) {
      if (seen.has(k)) continue
      seen.add(k)
      out.push(k)
      walk(k)
    }
  }
  walk(code)
  return out.sort()
}

import { DETAIL_ROUTES, LEDGER_NAV, activeNavPath } from './nav'

/**
 * What a tab is called.
 *
 * Derived from the ONE nav definition, never typed out: a tab that says
 * "Accounts" says it because the rail's seat for that route says it, so the
 * two cannot drift into different words for one page. Client-safe, like
 * `nav.ts` itself.
 */
export const COMPANIES_PATH = '/companies'

export function tabLabel(href: string, companyNames: Record<string, string>): string {
  const path = href.split('?')[0].split('#')[0]
  const m = /^\/ledger\/([0-9a-fA-F-]{36})(\/.*)?$/.exec(path)
  if (!m) {
    if (path === '/mail' || path.startsWith('/mail/')) return 'Mail'
    if (path.startsWith(`${COMPANIES_PATH}/new`)) return 'New company'
    if (path === COMPANIES_PATH) return 'Companies'
    // Whatever else a frame has been sent to — a download route, say. Its
    // last segment is a poor name and an honest one. `/` is deliberately not
    // special-cased: that is the desk, and N10 exists so no tab holds it.
    return path.split('/').filter(Boolean).pop() ?? path
  }
  const [, id, rest = ''] = m
  const seat = activeNavPath(id, `/ledger/${id}${rest}`)
  const item = seat === null ? undefined : LEDGER_NAV.find((i) => i.path === seat)
  const company = companyNames[id] ?? 'Company'
  // The overview's seat is the empty path, and "Company · Overview" reads
  // better on a tab than the company's name alone repeated. A path with NO
  // seat — /export, /attachments/<id> — is named after its own segment
  // rather than borrowing the Overview's label, which would put two
  // different pages under one name (critic, 2026-09-03).
  const segment = rest ? rest.split('/')[1] : ''
  const child = LEDGER_NAV.flatMap(item => item.children ?? []).find(child => rest === child.path || rest.startsWith(`${child.path}/`))
  const where = child?.label ?? item?.label ?? DETAIL_ROUTES.find((detail) => detail.segment === segment)?.label
    ?? (segment || 'Overview')
  return `${company} · ${where}`
}

/** The company a tab is sitting in, if it is sitting in one. */
export function ledgerOf(href: string): string | null {
  return /^\/ledger\/([0-9a-fA-F-]{36})\b/.exec(href.split('?')[0])?.[1] ?? null
}

/** Move the tab bar without changing any tab's identity or page. */
export function moveTab<T extends { id: string }>(tabs: T[], id: string, target: string, edge: 'before' | 'after'): T[] {
  const item = tabs.find((t) => t.id === id)
  if (!item || id === target || !tabs.some((t) => t.id === target)) return tabs
  const next = tabs.filter((t) => t.id !== id)
  const index = next.findIndex((t) => t.id === target) + (edge === 'after' ? 1 : 0)
  next.splice(index, 0, item)
  return next.every((t, i) => t === tabs[i]) ? tabs : next
}

import { moduleManifests, orderedModuleItems } from './module-manifests'
/**
 * The sidebar, as data — ONE definition of what this application is.
 *
 * Client-safe on purpose (no 'server-only'): the rail highlights the active
 * module with `usePathname`, so the client reads this list too. A second copy
 * of it anywhere — a hand-typed link block on some page — is the two-lists
 * defect, and the checks compare this list against the real route directories
 * so a new module cannot ship without a seat here.
 *
 * `path` is the suffix after `/ledger/[id]`; empty string is the overview.
 * `covers` lists route segments that belong to this item without being its
 * path — sub-functions folded under one seat (Reports covers /aging and
 * /statements).
 */
export type NavItem = {
  label: string
  path: string
  /** Display grouping only. The path and seat still decide navigation/access. */
  group: 'daily' | 'books' | 'manage'
  covers?: string[]
  /** A real grantable seat that is reached through another shell control. */
  showInRail?: boolean
  /** Hover children: shown as a flyout on the rail, each a plain link. The
   *  item itself stays a link to its own page. */
  flyout?: Array<{ label: string; path: string }>
  /** Related workspaces for labels, selection and access; no extra rail rows. */
  children?: Array<{ label: string; path: string }>
}

export const LEDGER_NAV: NavItem[] = orderedModuleItems<NavItem>([
{ order: 0, label: 'Overview', path: '', group: 'daily', covers: ['/getting-started'] },
{ order: 1, label: 'Search', path: '/search', group: 'daily', showInRail: false },
{ order: 6, label:'Automation',path:'/automation',group:'daily',flyout:[{label:'Back desk',path:'/automation/jobs'},{label:'Recurring drafts',path:'/automation/recurring'}] },
{ order: 7, label: 'Expenses', path: '/expenses', group: 'daily', children: [
    { label: 'Supplier bills', path: '/bills' },
  ], flyout: [
    { label: 'All expenses', path: '/expenses' },
    { label: 'New expense', path: '/entries/quick/expense' },
    { label: 'Supplier bills', path: '/bills' },
    { label: 'New bill', path: '/bills/new' },
  ] },
{ order: 8, label: 'Cheques', path: '/cheques', group: 'daily', flyout: [
    { label: 'All cheques', path: '/cheques' },
    { label: 'New cheque', path: '/cheques/new' },
  ] },
{ order: 9, label: 'Income', path: '/income', group: 'daily', children: [
    { label: 'Invoices', path: '/invoices' },
  ], flyout: [
    { label: 'All income', path: '/income' },
    { label: 'Invoices', path: '/invoices' },
    { label: 'New invoice', path: '/invoices/new' },
    { label: 'Invoice templates', path: '/invoices/templates' },
    { label: 'Email', path: '/income/email' },
  ] },
{ order: 10, label: 'Invoices', path: '/invoices', group: 'daily', showInRail: false, covers: ['/bills'] },
{ order: 11, label: 'Bank', path: '/bank', group: 'daily', flyout: [
    // The screen it opens is called Bank transactions, so this is too — the
    // landing that used to sit between them is gone (owner, 2026-09-10).
    { label: 'Bank transactions', path: '/bank' },
    { label: 'Reconcile', path: '/bank/reconcile' },
  ] },
{ order: 12, label: 'Journal entries', path: '/entries', group: 'books', covers: ['/fx'], flyout: [
    { label: 'Journal entries', path: '/entries' },
    { label: 'Currencies & FX', path: '/fx' },
  ] },
{ order: 13, label: 'Parties', path: '/parties', group: 'books' },
{ order: 14, label: 'Accounts', path: '/accounts', group: 'books' },
{ order: 15, label: 'Reports', path: '/reports', group: 'books', covers: ['/aging', '/statements', '/breakdown'], flyout: [
    { label: 'Financial statements', path: '/statements' },
    { label: 'Trial balance', path: '/reports/trial-balance' },
    { label: 'General ledger', path: '/reports/general-ledger' },
    { label: 'Aging', path: '/aging' },
    { label: 'GST/HST return', path: '/tax' },
    { label: 'Budgets', path: '/reports/budgets' },
  ] },
{ order: 16, label: 'Sales tax', path: '/tax', group: 'books', flyout: [
    { label: 'GST/HST return', path: '/tax' },
    { label: 'PST return', path: '/tax/pst' },
    { label: 'Registration', path: '/tax/registration' },
  ] },
{ order: 20, label: 'Periods & year-end', path: '/periods', group: 'manage' },
{ order: 21, label: 'Opening balances', path: '/opening', group: 'manage',flyout:[{label:'Opening balances',path:'/opening'},{label:'CSV migration',path:'/opening/migration'}] },
{ order: 23, label: 'Backup', path: '/backup', group: 'manage' },
{ order: 24, label: 'Assistant', path: '/assistant', group: 'daily', showInRail: false },
  ...moduleManifests.flatMap(manifest => manifest.navigation ?? []),
])

/**
 * Route families that have pages and NO seat: reached from a row, never from
 * the rail.
 *
 * The invoice list was a seat until the owner pointed out that a bill sat on
 * it while the entry it raised sat on /expenses — one company in two lists
 * (2026-09-03). The list is gone; the DOCUMENTS are still there, opened by
 * clicking the row that is about them.
 *
 * This is a list rather than an exception in a check because "a page with no
 * seat" is otherwise indistinguishable from "a module somebody forgot to put
 * in the rail", which is exactly what `N1` exists to catch. Being here is a
 * claim, and `N12` holds it to account: something must actually link there.
 */
export const DETAIL_ROUTES: Array<{
  segment: string
  /** Optional human label for a detail route that is also a shell workspace. */
  label?: string
  /** The screens whose ROWS open it, by path. Named, not described: "some
   *  file somewhere links there" is satisfied by a print page linking to
   *  itself, which proves nothing about a person being able to get there. */
  reachedFrom: string[]
  /**
   * Which seats may open it — ANY one of them is enough.
   *
   * Added 2026-09-03 (critic). Before this, a ledger path belonging to no seat
   * was simply not module-checked: `/export?what=journal` handed the whole
   * journal to anybody with any seat at all, and `/attachments/<id>` handed
   * over every receipt ever filed. The company half still refused, so it was
   * never a cross-company leak — it was every module's data to every colleague.
   *
   * The old comment claimed these paths were "already decided by the company
   * check". They were not decided; they were unaccounted for. `N18` now
   * requires every seatless ledger entrypoint in the tree to appear here, so
   * the next one fails the battery instead of quietly answering.
   */
  seats: string[]
  /**
   * When the CONTENT depends on a query parameter, the seat does too. One
   * route, six exports, four different seats' worth of data.
   */
  byQuery?: { param: string; seats: Record<string, string[]> }
  note: string
}> = [
  {
    segment: 'attachments',
    reachedFrom: [
      'src/app/ledger/[ledgerId]/entries/[entryId]/Attachments.tsx',
    ],
    // The panel is on the invoice screen too since 2026-09-07, and an
    // invoice's entry is the same entry.
    seats: ['/entries', '/invoices'],
    note: 'the receipt behind an entry, opened from that entry or from its invoice',
  },
  {
    segment: 'readings',
    label: 'AI',
    // What Read & add read — a document or a sentence — opened beside the form it
    // filled in. It moved out from under /assistant on 2026-09-07 when the
    // reader did (23-reading-a-bill.md); since 2026-09-15 it reads money coming
    // in too (38), and the seats stay the three that could reach it.
    reachedFrom: [
      'src/components/ReadBill.tsx',
      'src/components/ReadingAside.tsx',
    ],
    seats: ['/expenses', '/invoices', '/assistant'],
    note: 'the Read & add AI mode, and the bill a reading was made from — opened there or beside the review form',
  },
  {
    segment: 'export',
    // The trial-balance page left this list on 2026-09-04: its Excel comes
    // from the report's own builder now (20-reports-as-excel.md), and N12
    // holds every name here to an actual link.
    reachedFrom: [
      'src/app/ledger/[ledgerId]/entries/page.tsx',
    ],
    // The union is the fallback for a `what` nobody has named; the route
    // refuses an unknown `what` anyway, so this only decides who reaches that
    // refusal.
    seats: ['/reports'],
    byQuery: {
      param: 'what',
      seats: {
        'trial-balance': ['/reports'],
        statement: ['/reports'],
        breakdown: ['/reports'],
        journal: ['/entries'],
        account: ['/accounts'],
        'gst-hst': ['/tax'],
        pst: ['/tax'],
        pd7a: ['/payroll'],
      },
    },
    note: 'every CSV the application produces, one route, seat by `what`',
  },
]

/**
 * The seats that open a ledger path — usually one, sometimes several.
 *
 * Null means the path is not under this ledger at all. An EMPTY array means it
 * is under the ledger and belongs to no seat anybody declared, which `refuseFor`
 * treats as a refusal: a door nobody has decided about is a door that stays
 * shut. That is the opposite of what this returned before 2026-09-03.
 */
export function seatsForPath(ledgerId: string, pathAndSearch: string): string[] | null {
  const [pathname, search = ''] = pathAndSearch.split('?')
  const base = `/ledger/${ledgerId}`
  if (!pathname.startsWith(base)) return null

  // Inbox moved into the AI workspace; retain the original Automation grant.
  // Detail pages/actions still apply their existing invoice/entry checks.
  const relative = pathname.slice(base.length)
  if (relative === '/readings/inbox' || relative.startsWith('/readings/inbox/')) return ['/automation']

  const seat = activeNavPath(ledgerId, pathname)
  if (seat !== null) return [seat]

  const head = pathname.slice(base.length).split('/')[1] ?? ''
  const declared = DETAIL_ROUTES.find((d) => d.segment === head)
  if (!declared) return []

  if (declared.byQuery) {
    const asked = new URLSearchParams(search).get(declared.byQuery.param)
    // An unnamed `what` falls back to the segment's own seats rather than to
    // "everybody": the route will refuse the request, and who gets to see it
    // refuse is still an access question.
    return (asked && declared.byQuery.seats[asked]) || declared.seats
  }
  return declared.seats
}

/**
 * The Add flyout: every door that CREATES something, in one place at the top
 * of the rail (owner, 2026-09-03). Data here, not in the component — the
 * shell checks read this list, so a door cannot quietly vanish.
 */
export const ADD_MENU: Array<{ label: string; path: string }> = orderedModuleItems<{ label: string; path: string }>([
{ order: 0, label: 'Journal entry', path: '/entries/new' },
{ order: 1, label: 'Invoice', path: '/invoices/new' },
{ order: 2, label: 'Supplier bill', path: '/bills/new' },
{ order: 3, label: 'Expense', path: '/entries/quick/expense' },
{ order: 5, label: 'Cheque', path: '/cheques/new' },
  ...moduleManifests.flatMap(manifest => manifest.addMenu ?? []),
])

/** One shell entry for both ERP questions and reviewed AI-assisted additions. */
export const AI_WORKSPACE_PATH = '/readings'

/**
 * Which nav item a pathname belongs to — matched on the item's first path
 * segment, so `/bank/import` and `/bank/[accountId]` both light "Bank"
 * although the nav points at `/bank`, and `/tax/registration` lights "Sales
 * tax". A segment in
 * `covers` lights its owner: /aging and /statements light "Reports".
 */
export function activeNavPath(ledgerId: string, pathname: string): string | null {
  const base = `/ledger/${ledgerId}`
  if (!pathname.startsWith(base)) return null
  const rest = pathname.slice(base.length)
  if (rest === '' || rest === '/') return ''
  const head = '/' + (rest.split('/')[1] ?? '')
  for (const item of LEDGER_NAV) {
    if (item.path !== '' && item.path.startsWith(head)) return item.path
    if (item.covers?.includes(head)) return item.path
  }
  return null
}

/**
 * The modules a person can be given, as data — the SAME seats the rail renders.
 *
 * Not a second list. `user_module_access` stores these paths, the permission
 * screen offers them, and the gate reads them; the day a module is added to
 * `LEDGER_NAV` it appears in all three at once. A hand-kept list of module
 * names would show the new module in the rail and not on the screen that grants
 * it, which is this repository's oldest defect shape.
 *
 * `covers` matters here: /aging and /statements belong to Reports, so granting
 * Reports grants them. That mapping already exists in `activeNavPath`, and this
 * is the same answer read the same way.
 */
export const GRANTABLE_MODULES = LEDGER_NAV.map((item) => ({
  path: item.path,
  label: item.label,
}))

/** Every seat path, for a check that stored values are real seats. */
export const MODULE_PATHS = LEDGER_NAV.map((i) => i.path)

/**
 * May a person holding these seats open this ledger path? The rail's one
 * question for every door it draws (0054), answered by `seatsForPath` so a
 * declared seatless route counts through the seats that open it.
 *
 * It used to ask `activeNavPath`, which answers null for a declared route —
 * so the Add flyout's "Invoice" door, whose page belongs to no seat of its
 * own, was hidden from everyone, the owner included, from the day the rail
 * started filtering (2026-09-04) until the owner asked where invoices had
 * gone (2026-09-04). `N19` opens every door in the rail with an owner's seats.
 */
export function railMayOpen(seats: ReadonlySet<string> | string[], ledgerId: string, path: string): boolean {
  const held = seats instanceof Set ? seats : new Set(seats)
  const opens = seatsForPath(ledgerId, `/ledger/${ledgerId}${path}`)
  return opens !== null && opens.some((s) => held.has(s))
}

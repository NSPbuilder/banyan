/**
 * The shell: one sidebar list, and overlays that are the same page twice.
 *   npm run db:verify-shell   (filesystem and source only; no database)
 *
 * `src/lib/nav.ts` is THE definition of what this application is. These checks
 * hold the two ends of that claim together:
 *
 *   every module that exists has a seat in the sidebar (N1)
 *   every seat in the sidebar is a module that exists (N2)
 *   every overlay is a deep link somewhere first (N3)
 *   a dynamic intercept never swallows its static siblings (N4)
 *
 * All four are the two-lists defect in route form: the router reads
 * directories, the rail reads nav.ts, and nothing else holds them together.
 */
import { readdirSync, existsSync, readFileSync, statSync } from 'fs'
import { reporter } from './suite'
import { execFileSync } from 'node:child_process'
import { join } from 'path'
import { ADD_MENU, AI_WORKSPACE_PATH, DETAIL_ROUTES, LEDGER_NAV, activeNavPath, railMayOpen } from '../src/lib/nav'
import { DESTINATIONS, DESTINATION_KEYS, MONEY_KEYS } from '../src/lib/destinations'
// The date field itself, imported so N8 can CALL it. A component with no
// state and no hooks is an ordinary function; what it returns is what the
// browser would be handed.
import { DateInput } from '../src/components/DateInput'
import { Exports } from '../src/components/Exports'
import { AppearanceForm } from '../src/app/settings/AppearanceForm'
import { appearanceFrom, DEFAULT_APPEARANCE, THEMES, MODES } from '../src/lib/appearance'
// And the desk, which N11 renders: two tabs handed in, because a check can
// press nothing and run no effect.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Desk } from '../src/components/Desk'
import { COMPANIES_PATH, ledgerOf, tabLabel } from '../src/lib/tabs'
import { deletedEntrySentence } from '../src/lib/forms'
import { BUTTON, PAGE_HEADER, REFUSAL, REFUSAL_QUIET } from '../src/lib/ui'

const r = reporter(67)
const { check } = r

const ROOT = 'src/app/ledger/[ledgerId]'

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory()
const hasPageBeneath = (dir: string): boolean => {
  if (existsSync(join(dir, 'page.tsx'))) return true
  return readdirSync(dir).some((e) => isDir(join(dir, e)) && hasPageBeneath(join(dir, e)))
}
const hasRouteBeneath = (dir: string): boolean => {
  if (existsSync(join(dir, 'route.ts'))) return true
  return readdirSync(dir).some((e) => isDir(join(dir, e)) && hasRouteBeneath(join(dir, e)))
}

// N1 — every top-level route directory that renders a page anywhere lights a
//      nav seat, UNLESS it is a declared detail route. A module shipped
//      without a seat is reachable only by typing its URL, which is how
//      screens quietly stop existing; a detail route is reached from a row
//      and says so out loud in nav.ts, where N12 holds it to the claim.
{
  const detail = new Set(DETAIL_ROUTES.map((d) => d.segment))
  const orphans = readdirSync(ROOT)
    .filter((e) => isDir(join(ROOT, e)) && !e.startsWith('@') && !e.startsWith('('))
    .filter((e) => hasPageBeneath(join(ROOT, e)))
    .filter((e) => activeNavPath('X', `/ledger/X/${e}`) === null)
    .filter((e) => !detail.has(e))
  check(orphans.length === 0,
    'N1 every module with a page has a seat, or is a declared detail route',
    orphans.length === 0
      ? `no orphan route directories; ${detail.size} declared detail route(s)`
      : `orphans: ${orphans.join(', ')}`)
}

// N2 — and every seat points at a page that exists — `covers`, flyout items
//      and the Add menu included. A destination whose route was renamed under
//      it is a dead link the router 404s. Resolution follows the ROUTER'S OWN
//      semantics: a path segment is carried by a literal directory or by a
//      [param] directory, so /records/register/directors is honestly checked
//      against records/register/[kind]/page.tsx instead of being unverifiable.
{
  const resolvesToPage = (p: string): boolean => {
    let dirs = [ROOT]
    for (const seg of p.split('/').filter(Boolean)) {
      const next: string[] = []
      for (const d of dirs) {
        if (isDir(join(d, seg))) next.push(join(d, seg))
        for (const e of readdirSync(d)) {
          if (/^\[.+\]$/.test(e) && isDir(join(d, e))) next.push(join(d, e))
        }
      }
      dirs = next
      if (dirs.length === 0) return false
    }
    return dirs.some((d) => existsSync(join(d, 'page.tsx')) || existsSync(join(d, 'route.ts')))
  }
  const destinations = [
    ...LEDGER_NAV.flatMap((item) => [item.path, ...(item.covers ?? []),
                                     ...(item.flyout ?? []).map((f) => f.path)]),
    ...ADD_MENU.map((m) => m.path),
    AI_WORKSPACE_PATH,
  ]
  const dead = destinations.filter((p) => !resolvesToPage(p))
  check(dead.length === 0,
    'N2 every seat and cover points at a real page',
    dead.length === 0
      ? `${destinations.length} destinations, flyouts and Add included`
      : `dead: ${dead.join(', ')}`)
}

// N3 — every overlay is a full page first. The intercept only fires on client
//      navigation; a hard load of the same URL must land on a real page, or a
//      bookmarked overlay is a 404.
{
  const modal = join(ROOT, '@modal')
  const overlays: string[] = []
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (!isDir(p)) continue
      // A null catch-all clears the parallel slot on soft navigation; it is
      // not an intercepted detail route and has no full-page twin.
      if (e === '[...catchAll]') continue
      const r = rel + '/' + e.replace(/^\(\.\)/, '')
      if (existsSync(join(p, 'page.tsx'))) overlays.push(r)
      walk(p, r)
    }
  }
  walk(modal, '')
  const unbacked = overlays.filter((r) =>
    !existsSync(join(ROOT, ...r.split('/').filter(Boolean), 'page.tsx')))
  check(overlays.length > 0 && unbacked.length === 0,
    'N3 every overlay is a deep link somewhere first',
    unbacked.length === 0 ? `${overlays.length} overlays, each with its full page`
                          : `no full page for: ${unbacked.join(', ')}`)
}

// N4 — a dynamic intercept with a static sibling in the real tree must have
//      that sibling in the modal tree too, or a client navigation to the
//      static route is caught by the dynamic one with the segment as an id —
//      /invoices/new rendering as invoice "new".
{
  const modal = join(ROOT, '@modal')
  const missing: string[] = []
  const walk = (dir: string, realDir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (!isDir(p)) continue
      const real = join(realDir, e.replace(/^\(\.\)/, ''))
      if (/^\[.+\]$/.test(e) && !e.startsWith('[...')
          && existsSync(join(p, 'page.tsx')) && isDir(realDir)) {
        for (const sib of readdirSync(realDir)) {
          if (/^\[.+\]$/.test(sib) || !isDir(join(realDir, sib))) continue
          if (existsSync(join(realDir, sib, 'page.tsx')) && !existsSync(join(dir, sib, 'page.tsx'))) {
            missing.push(`${join(dir, sib)} (static ${sib} beside dynamic ${e})`)
          }
        }
      }
      walk(p, real)
    }
  }
  walk(modal, ROOT)
  check(missing.length === 0,
    'N4 no dynamic intercept swallows a static sibling',
    missing.length === 0 ? 'every static sibling is intercepted too' : missing.join('; '))
}

// N4b — an unmatched parallel slot keeps its previous modal during client
// navigation. A default.tsx fixes only hard loads. The root and catch-all
// null pages must match the next URL to dismiss the old backdrop.
{
  const modal = join(ROOT, '@modal')
  const root = join(modal, 'page.tsx')
  const rest = join(modal, '[...catchAll]', 'page.tsx')
  const clears = [root, rest].every((file) => existsSync(file)
    && /return null\b/.test(readFileSync(file, 'utf8')))
  check(clears,
    'N4b leaving an intercepted route clears the modal on soft navigation',
    clears ? 'ledger root and catch-all slot routes both render null'
           : 'a null ledger-root or catch-all modal route is missing')
}

// N5 — picking a range refines the page being READ. The first shell sent
//      every pick through a plain link, and the navigation threw the reader
//      back to the top of the page — the complaint that opened this batch.
//      Source-level, like V91: no browser here to click in.
{
  // Comments stripped first: the component's own doc comment describes this
  // exact idiom, and a scan that reads comments found the described defect
  // fixed while the code had it back — the AccountRows finding again.
  const code = readFileSync('src/components/RangePicker.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  // The SEARCH box follows the same rule with one branch more: going to
  // another page is a navigation and pushes, so Back returns to where you
  // were typing; refining the page you are reading replaces without
  // scrolling. Nothing watched that until now — N5 read the range picker and
  // only the range picker, while the design note claimed the box obeyed it
  // too (critic, 2026-09-03).
  const box = readFileSync('src/components/SearchBox.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const boxOk = /if \(elsewhere\) router\.push\(href\)/.test(box)
    && box.includes('router.replace(href, { scroll: false })')
  check(code.includes('router.replace(') && code.includes('{ scroll: false }')
        && !code.includes('router.push(') && boxOk,
    'N5 refining a page replaces in place; going elsewhere pushes',
    !boxOk ? 'the search box does not push only when it leaves the page'
      : 'the range picker replaces with scroll:false and never pushes; the box pushes only when it leaves')
}

// N6 — every report picker offers "All time". Source-level, like N5: the
//      button lives in a client component this harness cannot mount (it needs
//      the router), so the check reads the wiring — the button bound to the
//      allFrom prop, and each report page actually passing that prop. A page
//      that stops passing it silently loses the whole-history view the owner
//      asked for, with every range still working.
{
  const code = readFileSync('src/components/RangePicker.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const wired = code.includes('All time') && code.includes('go(allFrom, today)')
  const pages = [
    'src/app/ledger/[ledgerId]/reports/trial-balance/page.tsx',
    'src/app/ledger/[ledgerId]/reports/general-ledger/page.tsx',
    'src/app/ledger/[ledgerId]/statements/page.tsx',
  ]
  const missing = pages.filter((p) => !readFileSync(p, 'utf8').includes('allFrom={'))
  check(wired && missing.length === 0,
    'N6 every report range picker offers All time',
    !wired ? 'RangePicker lacks the wired button'
      : missing.length === 0 ? 'button wired to allFrom; 3 report pages pass it'
      : `not passing allFrom: ${missing.join(', ')}`)
}

// N7 — the flyout vocabulary is data the owner asked for by name
//      (2026-09-03): Corporate records carries its three registers, and Add
//      carries every ordinary creation door. AI now has its own adjacent
//      shell control rather than pretending to be another ordinary form.
//      A dropped item leaves every route
//      alive and a hover menu quietly poorer — only a pin can see it.
{
  const records = LEDGER_NAV.find((i) => i.label === 'Corporate records')
  const reports = LEDGER_NAV.find((i) => i.label === 'Reports')
  const payroll = LEDGER_NAV.find((i) => i.label === 'Payroll')
  const flyPaths = (records?.flyout ?? []).map((f) => f.path).sort()
  const reportPaths = (reports?.flyout ?? []).map((f) => f.path).sort()
  const payrollPaths = (payroll?.flyout ?? []).map((f) => f.path).sort()
  const addPaths = ADD_MENU.map((m) => m.path).sort()
  // The two creation doors are pinned as LITERAL pages, because N2 cannot
  // see them vanish: the router would carry /entries/new through [entryId]
  // with "new" as the id — a live page, wrong behavior, and no 404 anywhere
  // (critic, 2026-09-03).
  const literalDoors = [
    join(ROOT, 'entries', 'new', 'page.tsx'),
    join(ROOT, 'invoices', 'new', 'page.tsx'),
    join(ROOT, 'bills', 'new', 'page.tsx'),
    join(ROOT, 'cheques', 'new', 'page.tsx'),
    join(ROOT, 'payroll', 'new', 'page.tsx'),
    join(ROOT, 'payroll', 'people', 'new', 'page.tsx'),
  ].filter((p) => !existsSync(p))
  check(
    flyPaths.join(' ') === '/records /records/minute-book /records/register/central_securities /records/register/directors /records/register/transparency'
    && reportPaths.join(' ') === '/aging /reports/budgets /reports/general-ledger /reports/trial-balance /statements /tax'
    && addPaths.join(' ') === '/bills/new /cheques/new /entries/new /entries/quick/expense /invoices/new /payroll/new /payroll/people/new'
    && AI_WORKSPACE_PATH === '/readings'
    && payrollPaths.join(' ') === '/payroll /payroll/new /payroll/people /payroll/remittances /payroll/t4'
    && literalDoors.length === 0,
    'N7 the flyouts carry their full vocabulary',
    literalDoors.length === 0
      ? `records: ${flyPaths.length}; reports: ${reportPaths.length}; payroll: ${payrollPaths.length}; `
        + `add: ${addPaths.length} doors, literal new-pages present`
      : `literal page missing: ${literalDoors.join(', ')}`)
}

// N8 — every date on every screen is entered through the ONE date field, so
//      every date on every screen opens a calendar (owner, 2026-09-03: many
//      date boxes could only be typed into). Source-level: there is no browser
//      here to click in, and a text box that merely LOOKS like a date is
//      exactly what this refuses.
//
//      A field is a date field by its NAME, not by how it is spelled: any
//      form-field name ending in Date/On/From/To — the camelCase boundary
//      matters, or "description" and "reason" would qualify — plus `asOf`,
//      which every as-at register asks for. The tag carrying such a name must
//      be DateInput and nothing else.
{
  const dateName = (n: string) => /(Date|On|From|To)$/.test(n) || n === 'asOf'
  const tsx: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) walk(p)
      else if (e.endsWith('.tsx')) tsx.push(p)
    }
  }
  walk('src')

  const wrong: string[] = []
  for (const file of tsx) {
    const code = readFileSync(file, 'utf8')
    // `name={F.onDate}` and `name="entryDate"` alike; the tag is whatever `<`
    // opened before the attribute.
    for (const m of code.matchAll(/name=(?:\{[A-Za-z_$]+\.([A-Za-z]+)\}|"([A-Za-z]+)")/g)) {
      const field = m[1] ?? m[2]
      if (!dateName(field)) continue
      const open = code.lastIndexOf('<', m.index)
      const tag = /^<([A-Za-z][\w.]*)/.exec(code.slice(open))?.[1] ?? '?'
      if (tag !== 'DateInput') wrong.push(`${file}: ${field} in <${tag}>`)
    }
  }

  // The range picker's two boxes carry no name at all — they navigate rather
  // than post — so the scan above cannot see them. They are named here.
  const picker = readFileSync('src/components/RangePicker.tsx', 'utf8')
  const pickerOk = (picker.match(/<DateInput\b/g) ?? []).length === 2
    && !/<input\b[^>]*defaultValue=\{(?:from|to)\}/.test(picker)

  // And the component itself, EXERCISED rather than read. The first version
  // grepped its source for `type="date"` and `showPicker()` — and both
  // needles appear in this component's own doc comment, so the mutation that
  // turns the field back into a text box left the check green (critic,
  // 2026-09-03: it applied block 269 and watched N8 pass). Calling the
  // component returns the element it would render, and calling that element's
  // onClick with a stand-in field proves the calendar is actually opened.
  const el = DateInput({ name: 'probe' }) as unknown as {
    props?: { type?: string; onClick?: (e: unknown) => void }
  }
  let picked = false
  el.props?.onClick?.({ currentTarget: { showPicker() { picked = true } } })
  const fieldOk = el.props?.type === 'date' && picked

  // Each arm names ITSELF. The first version printed "does not render a
  // native date field" for a component whose type was perfectly fine and
  // whose calendar simply never opened — a diagnostic that blames the half
  // that was working.
  check(wrong.length === 0 && pickerOk && fieldOk,
    'N8 every date field is the one date field',
    wrong.length > 0 ? wrong.slice(0, 4).join('; ')
      : el.props?.type !== 'date' ? `DateInput renders type=${String(el.props?.type)}, not date`
      : !picked ? 'DateInput does not open the calendar when the field is clicked'
      : !pickerOk ? 'the range picker types its dates'
      : `${tsx.length} screens scanned; every date name reaches DateInput`)
}

// N9 — a tab is named by the ONE nav definition. A hand-typed tab label is
//      a second list of what this application's pages are called, and the
//      day a seat is renamed the two disagree with nothing to say so.
{
  const ID = '00000000-0000-4000-8000-000000000001'
  const names = { [ID]: 'Acme Ltd.' }
  const wrong = LEDGER_NAV.filter((item) => {
    const label = tabLabel(`/ledger/${ID}${item.path}`, names)
    return label !== `Acme Ltd. · ${item.label}`
  })
  check(wrong.length === 0 && tabLabel(COMPANIES_PATH, names) === 'Companies',
    'N9 a tab is named by the sidebar definition',
    wrong.length === 0
      ? `${LEDGER_NAV.length} seats, each naming its own tab`
      : wrong.map((w) => w.label).join(', '))
}

// N10 — the desk is the root and the company list has its own address, and
//       nothing inside the application links to '/'. A link to '/' inside a
//       tab loads the desk INSIDE that tab, and the tab strip appears again
//       one level down — a page framing itself, forever.
{
  const root = readFileSync('src/app/page.tsx', 'utf8')
  const list = existsSync('src/app/companies/page.tsx')
  // Signing in is how somebody ENTERS the desk, so these three send them to
  // '/' on purpose. They run outside it — proxy.ts sends anonymous traffic to
  // the sign-in page before any tab exists — and landing anywhere else after a
  // password would mean arriving at the application without its tab strip.
  // Named, so the exemption is a decision on the record rather than a hole.
  const ENTERING = ['src/app/login/page.tsx', 'src/app/first-run/page.tsx',
                    'src/app/user-actions.ts']
  const offenders: string[] = []
  // .ts AS WELL AS .tsx: `redirect('/')` and `router.push('/')` live in
  // actions and helpers, and the first version of this walk opened only
  // .tsx files while its own sentence said "the whole tree" (critic,
  // 2026-09-03). The forms are listed because a link built from a variable
  // still slips past — this catches the ones anybody actually writes.
  const toRoot = /href="\/"|redirect\('\/'\)|router\.push\('\/'\)|router\.replace\('\/'\)/
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) walk(p)
      else if ((e.endsWith('.tsx') || e.endsWith('.ts')) && p !== 'src/app/page.tsx'
               && !ENTERING.includes(p)) {
        if (toRoot.test(readFileSync(p, 'utf8'))) offenders.push(p)
      }
    }
  }
  walk('src')
  check(root.includes('<Desk') && list && offenders.length === 0,
    'N10 the desk is the root, the company list has its own page, nothing frames the desk',
    offenders.length ? offenders.join('; ')
      : `no link to / inside the app; ${ENTERING.length} sign-in files enter it on purpose`)
}

// N11 — two tabs stay MOUNTED and one is shown. A hidden tab that is
//       unmounted is a tab that forgets — the half-typed expense the reader
//       switched away from — and a `src` fed from the tab's current url
//       reloads the frame on every navigation, which is the same loss by
//       another road. Rendered with the state handed in, the NewInvoiceForm
//       precedent: a check cannot press anything.
{
  const A = '/ledger/00000000-0000-4000-8000-000000000001/accounts'
  const B = '/ledger/00000000-0000-4000-8000-000000000002/parties'
  const markup = renderToStaticMarkup(createElement(Desk, {
    companies: { '00000000-0000-4000-8000-000000000001': 'Acme Ltd.',
                 '00000000-0000-4000-8000-000000000002': 'Beta Ltd.' },
    openWith: { tabs: [{ id: 'a', href: A }, { id: 'b', href: B }], active: 'b' },
  }))
  const frames = [...markup.matchAll(/<iframe[^>]*>/g)].map((m) => m[0])
  const shown = frames.filter((f) => !f.includes('display:none'))
  const srcs = frames.map((f) => /src="([^"]*)"/.exec(f)?.[1])
  // Comments stripped BEFORE the source is scanned — this component's own
  // doc comment describes both idioms, and a scan that reads comments is
  // satisfied by the description of the thing rather than the thing (the
  // hole the critic found in N8's first version).
  const code = readFileSync('src/components/Desk.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const srcFromOpening = /src=\{t\.openedAt\}/.test(code)
  // And the tab must FOLLOW the page inside it. Next navigates in-frame
  // without reloading the document, so `load` fires once and never again;
  // the first version used it and every tab kept the label it opened with
  // while its page moved on (browser pass, 2026-09-03). Source-level because
  // there is no browser here — the browser pass is what watched it work.
  const watches = code.includes('setInterval(') && code.includes('contentWindow?.location')
  check(frames.length === 2 && shown.length === 1
        && srcs[0] === A && srcs[1] === B && srcFromOpening && watches,
    'N11 both tabs stay mounted, one is shown, and each follows its own page',
    frames.length !== 2 ? `${frames.length} frames rendered, not 2`
      : shown.length !== 1 ? `${shown.length} frames visible, not 1`
      : !srcFromOpening ? 'a frame\'s src is fed from the tab\'s current url — it would reload on every click'
      : !watches ? 'nothing watches where the frames went; the labels would freeze'
      : `${frames.length} frames, ${shown.length} visible, src from the opening url, location watched`)
}

// N12 — a detail route is a promise: no seat, because a ROW opens it. The
//       promise is kept only while the screens NAMED in the declaration
//       still build a link into it. Delete the last such link and the pages
//       are alive, reachable by typing the URL and by nothing a person can
//       click — the state N1 exists to refuse, wearing the exemption N1 just
//       granted.
//
//       Named, not "something somewhere": the first version asked whether
//       ANY file linked there, and the invoice's own print page links to
//       invoices, so it stayed green with the browse's link deleted.
{
  const broken: string[] = []
  for (const { segment, reachedFrom } of DETAIL_ROUTES) {
    const own = join(ROOT, segment)
    // A page OR a route: `/export` and `/attachments` are downloads, declared
    // here since 2026-09-03 because a path with no seat is a path with no
    // module check unless somebody says which seats open it. What they owe is
    // the same debt as a detail page — something a person can actually click.
    if (!isDir(own) || !(hasPageBeneath(own) || hasRouteBeneath(own))) {
      broken.push(`${segment}: declared, but has neither a page nor a route`)
      continue
    }
    // A link BUILT for a row: `.../invoices/${something}`, `.../export?what=`.
    const rowLink = new RegExp(`${segment}(/\\$\\{|\\?)`)
    for (const file of reachedFrom) {
      if (!existsSync(file)) broken.push(`${segment}: ${file} is gone`)
      else if (!rowLink.test(readFileSync(file, 'utf8'))) {
        broken.push(`${segment}: ${file} no longer opens one`)
      }
    }
  }
  check(broken.length === 0,
    'N12 every seatless detail route is still opened by the rows that claim it',
    broken.length === 0
      ? DETAIL_ROUTES.map((d) => `${d.segment} <- ${d.note}`).join('; ')
      : broken.join('; '))
}

// N13 — every suite that exists is in the battery. A suite nobody runs is a
//       suite that goes green forever: `db:verify-search` shipped ten checks
//       and the evidence file never mentioned them, because the battery
//       carries a hand-typed list (2026-09-03). Two lists again — package.json
//       and suites.sh — and this is the thing that holds them together.
{
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>
  }
  const suites = Object.keys(pkg.scripts).filter((n) => /^db:verify(-|$)/.test(n))
  const battery = readFileSync('scripts/suites.sh', 'utf8')
  // The list itself, not the whole file: a suite named only in a comment is
  // not a suite the battery runs.
  const listed = battery.slice(battery.indexOf('SUITES=('), battery.indexOf(')', battery.indexOf('SUITES=(')))
  const missing = suites.filter((n) => !new RegExp(`\\b${n.replace(/[-:]/g, '[-:]')}\\b`).test(listed))
  check(suites.length > 0 && missing.length === 0,
    'N13 every verify suite is in the battery',
    missing.length === 0 ? `${suites.length} suites, all in suites.sh`
                         : `not in the battery: ${missing.join(', ')}`)
}

// N14 — every SERVER ENTRYPOINT goes through the ONE gate.
//
//      RISKS §15b: a system that gates its pages and not its routes is not
//      gated. The first version of this check read page.tsx and route.ts and
//      believed that was the list. It is not (critic):
//
//        — a SERVER ACTION runs BEFORE the page it is addressed to renders, so
//          `await requireUser()` in a page body does not cover it. Next's own
//          guidance is to treat them as public API endpoints, and six of them
//          reached the ledger with no authentication in the chain at all —
//          including one that runs a bare DELETE on journal_entry.
//        — a LAYOUT runs for its whole subtree and can query the database. The
//          ledger layout did, and answered 404-or-307 to an anonymous caller,
//          which is an existence oracle for ledger ids.
//
//      So the walk collects every server entrypoint: page, route, layout,
//      default, and every exported function of a 'use server' file. Read from
//      the tree, so one added tomorrow is required tomorrow.
{
  // Reachable before anybody is anybody, named so the exemption is a decision
  // on the record. The three actions are the sign-in path itself.
  const OPEN_FILES = [
    'src/app/login/page.tsx', 'src/app/first-run/page.tsx',
    // The root shell wraps the sign-in page too, so gating it shuts the only
    // way in. It reads ONE thing since 0067 — the signed-in person's palette,
    // defaulting when nobody is signed in — which is not an oracle for
    // anything: a stranger and a person who never chose get the same answer.
    'src/app/layout.tsx',
    // Returns null, reads nothing, and sits under the ledger layout which is
    // gated — a gate here would be a second answer to a settled question.
    'src/app/ledger/[ledgerId]/@modal/default.tsx',
  ]
  const OPEN_ACTIONS = ['signInAction', 'firstRunAction', 'signOutAction']
  // Comments are not code. N16 was fixed for exactly this and N14 was not.
  const code = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) walk(p)
      else if (['page.tsx', 'route.ts', 'layout.tsx', 'default.tsx'].includes(e)) files.push(p)
    }
  }
  walk('src/app')

  const ungated = files.filter((f) => {
    if (OPEN_FILES.includes(f)) return false
    const body = code(readFileSync(f, 'utf8'))
    return f.endsWith('route.ts')
      ? !/\bawait\s+guardRoute\s*\(/.test(body)
      : !/\bawait\s+require(User|Owner|Ledger|Entity|AutomationLedger|PortalConfirmation)\s*\(/.test(body)
  })

  // Every exported function of every 'use server' file, one at a time: a
  // wrapper that reaches the gate is not evidence about the action beside it.
  const actions: string[] = []
  // EVERY file under src/app, at any depth, .ts and .tsx alike. The first
  // version read one level and only `.ts`, so a nested 'use server' file and an
  // inline 'use server' function inside a component were both invisible while
  // this check's own header said it had learned that lesson (critic,
  // 2026-09-03). `RebuildButton` is one of the inline ones.
  const serverFiles: string[] = []
  const walkAll = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) walkAll(p)
      else if (p.endsWith('.ts') || p.endsWith('.tsx')) serverFiles.push(p)
    }
  }
  walkAll('src/app')
  const gated = (fn: string) => /\bawait\s+require(User|Owner|Ledger|Entity)\s*\(/.test(fn)
  for (const f of serverFiles) {
    const src = readFileSync(f, 'utf8')
    const body = code(src)
    const wholeFile = /^['"]use server['"]/m.test(src)
    // A whole 'use server' file exports actions; a component file can still
    // declare one inline, and that one is an endpoint too.
    const pattern = wholeFile
      ? /export async function (\w+)/g
      : /async function (\w+)[^)]*\)[^{]*\{\s*['"]use server['"]/g
    for (const m of body.matchAll(pattern)) {
      const name = m[1]
      if (OPEN_ACTIONS.includes(name)) continue
      const from = m.index ?? 0
      const nextExport = body.indexOf('\nexport ', from + 1)
      const fn = body.slice(from, nextExport < 0 ? undefined : nextExport)
      // Delegation to a family helper in the same file counts, but only to a
      // helper that itself reaches the gate: twenty-five party, invoice, bank
      // and records actions read their ledger id in one shared function, and
      // putting the check in twenty-five places instead would be the version
      // somebody forgets one of.
      //
      // BOTH SPELLINGS OF THE DELEGATION. It read `return helper(...)` only,
      // which was every door until three of them had to look at the result
      // before deciding to redirect (2026-09-15) — `const r = await helper(…)`
      // is the same delegation and this said they were ungated. The teeth are
      // unchanged: whichever spelling is found, THE HELPER ITSELF must reach
      // the gate, so an action awaiting something that is not a gate is still
      // named here.
      // EVERY candidate, not the first: a door that awaits something else
      // before it delegates would otherwise be judged on the wrong call, and
      // three long-gated actions were named the moment the second spelling was
      // added. One gated family helper anywhere in the door is the rule.
      const named = new Set<string>()
      for (const d of fn.matchAll(/(?:return|=\s*await)\s+(\w+)\(/g)) named.add(d[1])
      const reaches = [...named].some((delegate) => {
        const at = body.indexOf(`async function ${delegate}(`)
        if (at === -1) return false
        return gated(body.slice(at).split('\nasync function ')[0].split('\nexport ')[0])
      })
      if (!gated(fn) && !reaches) actions.push(`${f}:${name}`)
    }
  }

  // And the sign-in path must NOT become gated, or the only way in closes.
  const shutOut = OPEN_FILES.filter((f) =>
    /\brequire(User|Owner|Ledger|Entity)\s*\(/.test(code(readFileSync(f, 'utf8'))))

  check(files.length > 50 && ungated.length === 0 && actions.length === 0
        && shutOut.length === 0,
    'N14 every page, route, layout and server action passes through the gate',
    ungated.length > 0
      ? `${ungated.length} file(s) without a gate: ${ungated.slice(0, 3).join(', ')}`
      : actions.length > 0
        ? `${actions.length} server action(s) without a gate: ${actions.slice(0, 3).join(', ')}`
        : shutOut.length > 0
          ? `the sign-in path is gated against itself: ${shutOut.join(', ')}`
          : `${files.length} files and every exported server action, `
            + `${OPEN_FILES.length + OPEN_ACTIONS.length} deliberately open`)
}

// N15 — the backup route is a POST and needs an owner. It runs pg_dump and
//       streams the whole database; as an unauthenticated GET it was a
//       one-request export of every company, every SIN and every birth date,
//       and an <img> tag could trigger it (RISKS §15b).
{
  const code = readFileSync('src/app/backup/download/route.ts', 'utf8')
  check(/export async function POST\s*\(/.test(code)
        && !/export async function GET\s*\(/.test(code)
        && /guardRoute\(\{\s*owner:\s*true\s*\}\)/.test(code),
    'N15 taking a whole-database backup is a POST, and needs an owner',
    /export async function GET/.test(code)
      ? 'it still answers GET'
      : 'POST only, behind guardRoute({ owner: true })')
}

// N16 — nothing writes the old placeholder actor any more. `WEB_ACTOR` recorded
//       the SURFACE a change came through because nothing knew a person
//       (RISKS §15). It survives as a constant so old audit rows stay readable;
//       what must not survive is anything still writing it.
{
  const tsx: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) walk(p)
      else if (e.endsWith('.ts') || e.endsWith('.tsx')) tsx.push(p)
    }
  }
  walk('src')
  // CODE, not prose. The first version matched the name wherever it appeared,
  // and `users.ts` says "Replaces `WEB_ACTOR`" in the docstring that explains
  // what took its place — so the check reported the file that documents the
  // change as the file still making the mistake. N8's first version had the
  // identical fault, matching strings that were in a component's own comments.
  const withoutComments = (code: string) =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const writers = tsx.filter((f) =>
    f !== 'src/lib/actor.ts'
    && /\bWEB_ACTOR\b/.test(withoutComments(readFileSync(f, 'utf8'))))
  check(writers.length === 0,
    'N16 the audit trail records a person, not a surface',
    writers.length === 0
      ? 'nothing outside actor.ts still writes the placeholder'
      : `still writing WEB_ACTOR: ${writers.join(', ')}`)
}

// N17 — the permission system is actually WIRED to something. `US18`-`US22`
//       prove that `refuseFor` refuses; they cannot prove that anybody asks it.
//       A library nobody calls is the same as no library, and this is the
//       version of that failure that looks completely fine on screen: the rail
//       hides the seats, so nothing appears wrong until somebody types a URL.
//
//       Three joints, because each one alone leaves a way in:
//         a. `gate.ts` asks — in BOTH of its doors. `requireUser` covers the
//            pages; `guardRoute` covers the routes that hand out a PDF or a
//            CSV, and a company's payroll PDF is the same leak as its page.
//         b. the rail draws only the seats somebody has, rather than all of
//            them. A courtesy, not the boundary, but offering a door that will
//            turn you away is its own small unkindness.
//         c. granting is behind `requireOwner`, not `requireUser`. N14 only
//            asks whether an action reaches the gate at all — and a permission
//            screen that any signed-in person may POST to is a system where
//            everybody can give themselves everything.
{
  const gate = readFileSync('src/lib/gate.ts', 'utf8')
  const layout = readFileSync('src/app/ledger/[ledgerId]/layout.tsx', 'utf8')
  const actions = readFileSync('src/app/user-actions.ts', 'utf8')

  // BOTH doors, by body. `refuseFor` appearing anywhere in gate.ts was the
  // first version of this line, and it would have been satisfied by either one
  // alone — while `guardRoute` is the half that covers the fifteen routes that
  // hand out a PDF or a CSV, which is exactly the half a page-shaped mental
  // model forgets. N14 learned the same lesson twice already.
  const bodyOf = (code: string, name: string) =>
    (code.slice(code.indexOf(`export async function ${name}`))
      .split('export async function')[1] ?? '')
  const asks = /refuseFor\(/.test(bodyOf(gate, 'requireUser'))
  const routesAsk = /refuseFor\(/.test(bodyOf(gate, 'guardRoute'))
  // The rail has FOUR link sources and the first version of this line watched
  // the layout only — so the seat list was filtered while the search box, the
  // Add flyout and every item's own flyout offered doors that refuse (critic,
  // 2026-09-03). Each one must go through the rail's `mayOpen`.
  const rail = readFileSync('src/components/NavRail.tsx', 'utf8')
  // `seatsForEntity` is the stricter form: it draws the seats held in this
  // company, not the union held somewhere. Accept the legacy helper only so a
  // deliberate compatibility rework still has to satisfy the rest of N17.
  const filters = /seatsFor(?:Entity)?\(/.test(layout) && /seats=\{/.test(layout)
    && /const mayOpen = /.test(rail)
    && /ADD_MENU\.filter\(\((?:m|item)\) => mayOpen\(/.test(rail)
    && /mayOpen\(AI_WORKSPACE_PATH\)/.test(rail)
    && /item\.flyout\.filter\(\(f\) => mayOpen\(/.test(rail)
    && /railMayOpen\(seats, ledgerId, '\/search'\)/.test(layout)
  // EVERY people action's own body, up to the next export — `requireOwner`
  // anywhere in the file would be satisfied by the action NEXT to it. Read
  // from the file, not listed here: the first version named setGrantsAction
  // alone, and the two doors added on 2026-09-04 (kind, delete) were pinned
  // by nothing (critic). The three open doors are the decision N14 records.
  const OPEN_PEOPLE_DOORS = ['signInAction', 'firstRunAction', 'signOutAction']
  const peopleDoors = [...actions.matchAll(/^export async function (\w+)/gm)].map((m) => m[1])
    .filter((n) => !OPEN_PEOPLE_DOORS.includes(n))
  const unowned = peopleDoors.filter((n) => !/await requireOwner\(\)/.test(bodyOf(actions, n)))
  const owned = peopleDoors.length >= 6 && unowned.length === 0

  // d. Both doors REFUSE when they cannot tell where the request is going. The
  //    first version admitted it, so "nobody told me" and "this is allowed"
  //    were the same answer from inside the boundary (critic).
  const closed = /if \(path === null\) redirect\(/.test(bodyOf(gate, 'requireUser'))
    && /if \(path === null\) \{/.test(bodyOf(gate, 'guardRoute'))

  // e. An owner-only page REFUSES IN WORDS. `requireOwner` threw where
  //    `requireUser` redirects, and an uncaught throw is a bare 500 with the
  //    sentence stripped in production — so a bookkeeper who opened /users met
  //    nothing at all. Found by opening it as a bookkeeper, not by a check.
  const inWords = /redirect\('\/no-access\?why=NEEDS_OWNER'\)/.test(bodyOf(gate, 'requireOwner'))

  // g. The audit trail is owner-only. It spans every company and names tables
  //    and record ids, not ledgers, so there is no company-shaped filter that
  //    could make it safe for a bookkeeper — and N14 only asks whether the
  //    page reaches a gate, not which one.
  const auditPage = readFileSync('src/app/audit/page.tsx', 'utf8')
  const auditOwner = /await requireOwner\(\)/.test(auditPage)

  // …and every code the gate can send there has a sentence waiting for it. A
  // code that falls through to "You have not been given that" is the redirect
  // done halfway: the reason `requireOwner` stopped throwing was so the person
  // would be told what happened. Codes read from BOTH files rather than typed
  // here, so a new one has to be answered rather than remembered.
  const page = readFileSync('src/app/no-access/page.tsx', 'utf8')
  const sent = [...gate.matchAll(/no-access\?why=([A-Z_]+)/g)].map((m) => m[1])
  const answered = [...page.matchAll(/^\s{4}([A-Z_]+): \{/gm)].map((m) => m[1])
  const unanswered = sent.filter((c) => !answered.includes(c))

  // f. The desk filters. It is the LANDING page and it listed every company in
  //    the system, with its ledger id, while /companies was careful (critic).
  const desk = readFileSync('src/app/page.tsx', 'utf8')
  const list = readFileSync('src/app/companies/page.tsx', 'utf8')
  const bothLists = /mayOpenEntity\(/.test(desk) && /mayOpenEntity\(/.test(list)

  const missing = [
    asks ? '' : 'requireUser never calls refuseFor, so no page is refused',
    routesAsk ? '' : 'guardRoute never calls refuseFor, so no download is refused',
    filters ? '' : 'the rail offers a door somebody would be turned away from '
      + '(the seat list, the search box, the Add flyout and the item flyouts '
      + 'must all go through mayOpen)',
    owned ? '' : `people doors not behind requireOwner: ${unowned.join(', ') || '(fewer than six found)'}`,
    closed ? '' : 'the gate admits a request with no path header instead of refusing it',
    inWords ? '' : 'requireOwner throws instead of refusing in words, which is a bare 500',
    auditOwner ? '' : 'the audit trail page is not behind requireOwner',
    unanswered.length === 0 ? ''
      : `the refusal page has no sentence for ${unanswered.join(', ')}`,
    bothLists ? '' : 'a company list is not filtered by mayOpenEntity (the desk, or /companies)',
  ].filter(Boolean)
  check(missing.length === 0,
    'N17 the gate asks the access question, the rail draws what was granted, '
    + 'and only an owner may grant',
    missing.length === 0
      ? 'refuseFor in both doors and both fail closed, all four of the rail\'s '
        + 'link sources filtered, requireOwner on every people door, the people '
        + 'screen and the audit trail, both company lists filtered, every '
        + 'why= answered'
      : missing.join('; '))
}

// N18 — two things nobody could see before this node, both of the same shape:
//       a decision that was never made, reading exactly like a decision that
//       was made and came out "allow".
//
//       a. Every ledger entrypoint belongs to a seat OR is declared in
//          DETAIL_ROUTES. `/export` and `/attachments` were in neither, so
//          `refuseFor` ran no module check on them at all: any seat at all
//          bought the whole journal as a CSV and every receipt ever filed
//          (critic, 2026-09-03). The code's comment claimed those paths were
//          "detail routes reached from a row", and DETAIL_ROUTES held exactly
//          one entry, `invoices`.
//
//       b. Every action's declared seat is the seat of the page its form lives
//          on. The server cannot know which component called it, so the seat is
//          written down — and a written-down seat goes stale the first time a
//          form moves. This RE-DERIVES it from the tree and compares.
{
  const stale: string[] = []
  const L = 'L'.repeat(36)

  // (a)
  const ledgerRoot = 'src/app/ledger/[ledgerId]'
  const entrypoints: string[] = []
  const walkLedger = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) walkLedger(p)
      else if (e === 'page.tsx' || e === 'route.ts') entrypoints.push(dir)
    }
  }
  walkLedger(ledgerRoot)
  for (const dir of [...new Set(entrypoints)]) {
    const rest = dir.slice(ledgerRoot.length)
    // A parallel route renders at its parent's URL, so it is never a path of
    // its own and the gate never sees one.
    if (rest.includes('/@')) continue
    if (activeNavPath(L, `/ledger/${L}${rest}`) !== null) continue
    const head = rest.split('/')[1] ?? ''
    if (!DETAIL_ROUTES.some((d) => d.segment === head)) {
      stale.push(`${rest || '/'} belongs to no seat and is not declared in DETAIL_ROUTES`)
    }
  }

  // (b)
  const componentFiles: string[] = []
  const walkSrc = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) walkSrc(p)
      else if (p.endsWith('.ts') || p.endsWith('.tsx')) componentFiles.push(p)
    }
  }
  walkSrc('src')
  const seatOfFile = (f: string): string[] | null => {
    if (!f.startsWith(ledgerRoot)) return null
    const dir = f.slice(ledgerRoot.length).replace(/\/[^/]+$/, '')
    if (dir.includes('/@')) return null
    const seat = activeNavPath(L, `/ledger/${L}${dir}`)
    if (seat !== null) return [seat]
    const head = dir.split('/')[1] ?? ''
    return DETAIL_ROUTES.find((d) => d.segment === head)?.seats ?? null
  }
  for (const file of ['src/app/actions.ts', 'src/app/records-actions.ts', 'src/app/ledger/[ledgerId]/sred/actions.ts', 'src/app/ledger/[ledgerId]/payroll/actions.ts']) {
    const text = readFileSync(file, 'utf8')
    // One function at a time. A regex spanning from a function name to the
    // next `requireLedger(` reads straight past the end of a function that
    // has none and blames it for the next one's seat — which it did, naming
    // `deleteInvoiceAction` for a declaration four functions away.
    const chunks = text.split(/\n(?=(?:export )?async function )/)
    const bodies = new Map<string, string>()
    for (const c of chunks) {
      const m = /^(?:export )?async function (\w+)/.exec(c)
      if (m) bodies.set(m[1], c)
    }
    const usersOf = (fn: string) => componentFiles.filter((f) =>
      !f.endsWith('actions.ts') && new RegExp('\\b' + fn + '\\b').test(readFileSync(f, 'utf8')))

    for (const [name, body] of bodies) {
      const m = /requireLedger\(\s*[^,]+,\s*(\[[^\]]*\]|'[^']*')/.exec(body)
      if (!m) continue
      const declared = m[1]
      const json = declared.replace(/'/g, '"')
      const want = new Set(JSON.parse(json.startsWith('[') ? json : `[${json}]`) as string[])

      // Who this runs for: the components that name it, plus — when it is a
      // family helper — the components that name any action delegating to it.
      const callers = usersOf(name)
      for (const [other, otherBody] of bodies) {
        if (other !== name && new RegExp('return ' + name + '\\(').test(otherBody)) {
          callers.push(...usersOf(other))
        }
      }
      const found = new Set(callers.flatMap((c) => seatOfFile(c) ?? []))
      if (found.size === 0) continue          // used from outside a ledger page
      const wrong = [...found].filter((f) => !want.has(f))
      if (wrong.length > 0) {
        stale.push(`${name} declares ${declared} but its form lives under ${wrong.map((w) => w || '(the overview)').join(', ')}`)
      }
    }
  }

  check(stale.length === 0,
    'N18 every ledger path has a seat somebody chose, and every action names '
    + 'the seat its form is actually under',
    stale.length === 0
      ? `${new Set(entrypoints).size} ledger entrypoints, ${DETAIL_ROUTES.length} declared `
        + 'seatless; every requireLedger seat matches the page its form is on'
      : stale.join('; '))
}

// N19 — every door the rail can draw OPENS for somebody who holds every seat.
//       The rail filters its doors by seat (0054), and the first filter asked
//       `activeNavPath`, which answers null for a declared seatless route — so
//       the Add flyout's "Invoice" was hidden from everyone, the owner
//       included, for a day (2026-09-04). A door nobody can open is a feature
//       that has quietly gone; this walks every one with an owner's seats.
{
  const owner = LEDGER_NAV.map((i) => i.path)
  const L = 'L'.repeat(36)
  const doors = [
    ...ADD_MENU.map((m) => `Add › ${m.label} ${m.path}`),
    ...LEDGER_NAV.flatMap((i) => (i.flyout ?? []).map((f) => `${i.label} › ${f.label} ${f.path}`)),
    'Search /search',
    `AI ${AI_WORKSPACE_PATH}`,
  ]
  const shut = doors.filter((d) => !railMayOpen(owner, L, d.slice(d.lastIndexOf(' ') + 1)))
  check(shut.length === 0,
    'N19 every door in the rail opens for an owner',
    shut.length === 0 ? `${doors.length} doors, all open` : `shut for an owner: ${shut.join('; ')}`)
}

// N21 — WHAT A BUTTON LOOKS LIKE IS SAID ONCE.
//
//        Fourteen files kept their own `const BUTTON`, eleven of them byte
//        for byte the same — so the three that differed were drift, not
//        decisions, and the owner's screens did not quite agree with each
//        other (2026-09-07: 「按钮能更明显」). One module says it now.
//
//        WHAT THIS CANNOT SEE: whether any of it LOOKS right. There is no
//        browser in these suites (RISKS §16), so this is about there being
//        one answer, not about it being a good one. The page pass is where
//        the second question is asked.
{
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) walk(p)
      else if (p.endsWith('.tsx') || p.endsWith('.ts')) files.push(p)
    }
  }
  walk('src')

  const second: string[] = []
  for (const f of files) {
    if (f === join('src', 'lib', 'ui.ts')) continue
    const text = readFileSync(f, 'utf8')
    for (const name of ['BUTTON', 'QUIET', 'FIELD']) {
      if (new RegExp(`^const ${name} =`, 'm').test(text)) second.push(`${f} keeps its own ${name}`)
    }
    // A filled button written out by hand, wherever it is passed from.
    for (const m of text.matchAll(/(?:class|buttonClass)Name="[^"]*bg-neutral-900 px-[^"]*text-white[^"]*"/g)) {
      second.push(`${f} writes a filled button by hand: ${m[0].slice(0, 40)}…`)
    }
  }

  // And the theme holds the two things the screens now lean on.
  const css = readFileSync('src/app/globals.css', 'utf8')
  const themed = /--color-clay-600:/.test(css) && /--color-neutral-300:/.test(css)
  // Every required field's name in bold, as one rule keyed on the control
  // rather than a word repeated on two hundred labels.
  const tokens = readFileSync('src/app/design-tokens.css', 'utf8')
  const requiredRule = /label:has\(:required\),[\s\S]*?\{([^}]+)\}/.exec(css)?.[1] ?? ''
  const bolded = requiredRule.includes('font-weight: var(--weight-heading);')
    && tokens.includes('--weight-heading: 600;')

  check(second.length === 0 && themed && bolded,
    'N21 one definition of a button, a warm scale, and required names bolded by one rule',
    second.length === 0
      ? `${files.length} files, none with a second spelling; clay and neutral in @theme; `
        + 'the required-label rule is there'
      : second.slice(0, 3).join('; ') + (second.length > 3 ? ` (+${second.length - 3})` : ''))
}

// N22 — A PALETTE EXISTS IN FOUR PLACES OR IT DOES NOT EXIST.
//
//        A theme is a name in `appearance.ts`, a block of CSS that defines
//        the tokens under `[data-theme="<name>"]`, a value the database will
//        accept (0067's CHECK), and — for every one but the default — nothing
//        else. Three of the four and it half-works: the settings screen
//        offers it, the door saves it, and the page does not change.
//
//        The same for the three modes, whose whole point is that `dark:`
//        follows the person rather than the machine. If the variant is not
//        redefined, choosing Dark darkens the page and nothing on it.
{
  const css = readFileSync('src/app/globals.css', 'utf8')
  const appearance = readFileSync('src/lib/appearance.ts', 'utf8')
  const migrations = readdirSync('db/migrations')
    .map((f) => readFileSync(join('db/migrations', f), 'utf8')).join('\n')

  const named = [...appearance.matchAll(/name: '([a-z]+)',\n\s*label:/g)].map((m) => m[1])
  const missing: string[] = []
  for (const t of named) {
    // The default palette IS the `@theme` block; the others override it.
    const styled = t === 'claude'
      ? /@theme\s*\{/.test(css)
      : css.includes(`:root[data-theme="${t}"]`)
    if (!styled) missing.push(`${t} has no colours`)
    if (!new RegExp(`'${t}'`).test(migrations)) missing.push(`${t} is not a value the database accepts`)
  }
  // Every palette defines the same tokens, or a screen borrows the other's.
  const blocks = [...css.matchAll(/:root\[data-theme="[a-z]+"\]\s*\{([^}]*)\}/g)]
    .map((m) => new Set([...m[1].matchAll(/(--color-[a-z]+-\d+):/g)].map((x) => x[1])))
  const base = new Set([...css.matchAll(/(--color-(?:neutral|clay)-\d+):/g)].map((x) => x[1]))
  for (const b of blocks) {
    for (const token of base) if (!b.has(token)) missing.push(`a theme leaves ${token} to another`)
  }
  // And the three modes: the variant has to key on the choice.
  const modes = /@custom-variant dark\s*\{/.test(css)
    && /data-mode="dark"/.test(css) && /data-mode="system"/.test(css)
  if (!modes) missing.push('the dark: variant still asks the machine, not the person')

  // …and the shell stamps the answer, or none of the above is reached. Read
  // from the layout, because that is the only place the two attributes are
  // put on the page and everything else keys off them.
  const shell = readFileSync('src/app/layout.tsx', 'utf8')
  if (!/data-theme=\{/.test(shell) || !/data-mode=\{/.test(shell)) {
    missing.push('the shell does not stamp the choice on <html>')
  }

  check(named.length >= 2 && missing.length === 0,
    'N22 every palette has colours, a name the database takes, and the same tokens as the rest',
    missing.length === 0
      ? `${named.length} palettes (${named.join(', ')}), ${base.size} tokens each, three modes`
      : [...new Set(missing)].slice(0, 4).join('; '))
}

// N23 — THE BATTERY DOES NOT BREAK THE TREE IT IS CHECKING.
//
//        `--from=N` skips the blocks before N. `edit`, `run`, `close` and
//        `restore` all check that and do nothing; a bare command in a block
//        does not, so it runs against the real tree on every resumed run —
//        and a run that skips EVERY block never reaches a `restore` to take
//        it back. Block 43 appended a line to `src/lib/tax-forms.ts` that way
//        for as long as it existed, and left it there on 2026-09-10, an hour
//        before a commit.
//
//        Two guards, and this is the end-to-end one: a `--from` past the last
//        block is refused rather than quietly doing nothing. The other — the
//        preflight refusing a bare command at all — is what stops the next
//        one being written.
{
  const before = readFileSync('src/lib/tax-forms.ts', 'utf8')
  let refused = ''
  try {
    execFileSync('bash', ['scripts/mutations.sh', '--from=99999'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    refused = String((e as { stderr?: string }).stderr ?? '')
  }
  const after = readFileSync('src/lib/tax-forms.ts', 'utf8')
  const guarded = /`close` and `restore` know about `--from`, so a bare command runs/.test(
    readFileSync('scripts/mutations.sh', 'utf8'))
  check(refused.includes('past the last block') && before === after && guarded,
    'N23 a resume past the last block is refused, and the tree is left alone',
    refused.includes('past the last block')
      ? `refused; tax-forms.ts ${before === after ? 'untouched' : 'CHANGED'}; `
        + `the preflight ${guarded ? 'refuses' : 'ALLOWS'} a bare command`
      : `it did not refuse: ${refused.slice(0, 60) || 'no error'}`)
}

// N24 — BANKING IS THE WAY IN, NOT A PAGE IN FRONT OF ONE.
//
//        `/bank` was a list of the accounts with rows and a link into each.
//        Bank transactions grew a card per account across its own top, so the
//        list became a worse copy of the next page's header, one click earlier
//        (owner, 2026-09-10). It sends you to an account now — and still
//        renders for the one case with nowhere to send anybody: books with no
//        bank rows at all, where "nothing here" and no way forward is how a
//        person decides the module is broken.
{
  const landing = readFileSync('src/app/ledger/[ledgerId]/bank/page.tsx', 'utf8')
  const sends = /redirect\(`\/ledger\/\$\{ledgerId\}\/bank\/\$\{land\.id\}`\)/.test(landing)
  const empty = /Read a bank file/.test(landing)
  // And nothing renders the old list here any more; the reconcile door still
  // does, and that one the owner asked to leave alone.
  const noList = !/<Standings/.test(landing)
  check(sends && empty && noList,
    'N24 Banking sends you to an account, and only renders when there is none',
    sends && empty && noList
      ? 'redirects to the account with something waiting; the empty state keeps the way in'
      : `sends ${sends}, empty state ${empty}, no list ${noList}`)
}

// N20 — AN OVERLAY IS HANDED WHAT ITS PAGE IS HANDED.
//
// Every intercepting route under `@modal` renders the same body component as
// the full page it stands in for — that is the one-renderer rule, and it
// keeps the two from drifting in what they DRAW. Nothing kept them from
// drifting in what they are GIVEN: `(.)entries/quick/[kind]` and
// `(.)invoices/new` ignored `searchParams`, so `?reading=<id>` reached the
// deep link and never the overlay, and pressing the card's button on a bill
// the assistant had read opened a blank form. The deep link was what I
// tested; the overlay is what a person gets (owner, 2026-09-07).
//
// So: if the full page reads `searchParams`, its intercept must too.
{
  const intercepts: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'page.tsx' && p.includes('/(.)')) intercepts.push(p)
    }
  }
  const modal = 'src/app/ledger/[ledgerId]/@modal'
  if (existsSync(modal)) walk(modal)

  const deaf: string[] = []
  for (const intercept of intercepts) {
    // `@modal/(.)invoices/new/page.tsx` stands in for `invoices/new/page.tsx`.
    const segment = intercept.slice(modal.length + 1).replace(/^\(\.\)/, '')
    const full = join('src/app/ledger/[ledgerId]', segment)
    if (!existsSync(full)) continue
    // What each HANDS THE BODY, not whether the word appears in the file: a
    // route that keeps the `searchParams` parameter and ignores it reads the
    // same either way, and that is precisely the shape this defect had.
    // Every prop the page passes its body must also be passed by the
    // overlay.
    const propsPassed = (file: string) => {
      const text = readFileSync(file, 'utf8')
      const tag = /<([A-Z][A-Za-z]*)\b([^>]*?)\/?>/g
      const props = new Set<string>()
      for (const [, name, attrs] of text.matchAll(tag)) {
        if (name === 'OverlayPanel') continue
        for (const [, prop] of attrs.matchAll(/(\w+)=\{/g)) props.add(`${name}.${prop}`)
      }
      return props
    }
    const onPage = propsPassed(full)
    const onOverlay = propsPassed(intercept)
    // Only the components BOTH render — the shared body. A full page also
    // carries furniture the overlay has no use for (its back link), and that
    // is not a dropped prop.
    const shared = new Set([...onPage].map((x) => x.split('.')[0])
      .filter((n) => [...onOverlay].some((y) => y.startsWith(`${n}.`))))
    const dropped = [...onPage]
      .filter((x) => shared.has(x.split('.')[0]))
      .filter((x) => !onOverlay.has(x))
    if (dropped.length > 0) {
      deaf.push(`${segment.replace('/page.tsx', '')} passes ${dropped.join(', ')} on the page and not in the overlay`)
    }
  }
  check(intercepts.length > 0 && deaf.length === 0,
    'N20 an overlay is handed what its page is handed — no intercept ignores a query its page reads',
    deaf.length === 0
      ? `${intercepts.length} intercept(s), each given what its page is given`
      : deaf.join('; '))
}

// N25 — no typed URL inside the ledger answers 404. Ten segments had pages
//       below them and none of their own (whole-project audit, 2026-09-13):
//       /entries/quick, /payroll/runs, /payroll/roe, the two records folders,
//       /attachments, a bank account's /statement (and a statement's own
//       date), a reading, a person on a run. Each now
//       redirects to the nearest screen; this walks the tree for any folder
//       without page.tsx or route.ts, and follows every redirect index to a
//       page that exists.
{
  const base = 'src/app/ledger/[ledgerId]'
  const resolves = (path: string): boolean => {
    let dirs = [base]
    for (const seg of path.split('/').filter(Boolean)) {
      const next: string[] = []
      for (const d of dirs) {
        if (isDir(join(d, seg))) next.push(join(d, seg))
        for (const e of readdirSync(d)) if (/^\[.+\]$/.test(e) && isDir(join(d, e))) next.push(join(d, e))
      }
      dirs = next
      if (dirs.length === 0) return false
    }
    return dirs.some((d) => existsSync(join(d, 'page.tsx')) || existsSync(join(d, 'route.ts')))
  }
  const missing: string[] = []
  const redirects: string[] = []
  const dead: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (!isDir(p) || e === '@modal') continue
      if (!existsSync(join(p, 'page.tsx')) && !existsSync(join(p, 'route.ts'))) missing.push(p.slice(base.length))
      else if (existsSync(join(p, 'page.tsx'))) {
        const m = /redirect\(`\/ledger\/\$\{ledgerId\}([^`]*)`\)/.exec(readFileSync(join(p, 'page.tsx'), 'utf8'))
        if (m) {
          const target = m[1].replace(/\$\{\w+\}/g, 'x')
          redirects.push(`${p.slice(base.length)} → ${target || '/'}`)
          if (target && !resolves(target)) dead.push(`${p.slice(base.length)} → ${target}`)
        }
      }
      walk(p)
    }
  }
  walk(base)
  check(missing.length === 0 && redirects.length >= 10 && dead.length === 0,
    'N25 every ledger segment answers, and every redirect index lands on a page',
    `${missing.length === 0 ? 'no folder without an index' : `no index: ${missing.join(', ')}`}; `
      + `${redirects.length} redirect indexes${dead.length ? `; dead: ${dead.join(', ')}` : ', all landing on a page'}`)
}

// N26 — ONE REFUSAL LOOK. Twenty-six alert boxes carried twenty spellings of
//       the same red box; the box now lives in ui.ts (REFUSAL, REFUSAL_QUIET)
//       and no screen spells it out. Two files keep tone SETS where red is
//       one of three siblings (a status banner, an import note) — named, not
//       forgotten. `hover:bg-red-50` is the DANGER button's hover, not a box.
{
  // The tone sets are PINNED to their current counts, not skipped wholesale:
  // a new hand-rolled box inside an allowlisted file must show (critic,
  // 2026-09-13). ui.ts uses semantic danger roles; the banner's tone table has
  // two red states; the import note has one.
  const TONE_SETS: Record<string, number> = {
    'src/lib/ui.ts': 0, 'src/app/BackupBanner.tsx': 2,
    'src/app/ledger/[ledgerId]/bank/import/ImportPreview.tsx': 1,
  }
  const offenders: string[] = []
  let users = 0
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) { walk(p); continue }
      if (!p.endsWith('.ts') && !p.endsWith('.tsx')) continue
      const src = readFileSync(p, 'utf8')
      if (/REFUSAL/.test(src)) users++
      const reds = (src.match(/(?<!hover:)bg-red-50/g) ?? []).length
      const allowed = TONE_SETS[p]
      if (allowed !== undefined ? reds !== allowed : reds > 0) offenders.push(`${p} (${reds}${allowed !== undefined ? ` of ${allowed}` : ''})`)
    }
  }
  walk('src')
  const sharedTone = [REFUSAL, REFUSAL_QUIET].every(value => value.includes('bg-danger-surface') && value.includes('text-danger-ink'))
  check(offenders.length === 0 && users >= 20 && sharedTone,
    'N26 the refusal box is spelled once, and every screen says it the same way',
    `${offenders.length === 0 ? 'no red box spelled out, tone sets at their pinned counts' : `off: ${offenders.join(', ')}`}; ${users} files use REFUSAL`)
}

// N27 — ONE FIELD LOOK. The second input style (borderless-background, px-2
//       py-1) appeared beside FIELD in a dozen screens; every one now takes
//       FIELD from ui.ts.
{
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) { walk(p); continue }
      if (!p.endsWith('.ts') && !p.endsWith('.tsx')) continue
      if (p === 'src/lib/ui.ts') continue
      if (/border-neutral-300 bg-transparent px-[23] py-[12]/.test(readFileSync(p, 'utf8'))) offenders.push(p)
    }
  }
  walk('src')
  check(offenders.length === 0,
    'N27 the input is spelled once — no screen keeps the second style',
    offenders.length === 0 ? 'no stray input style' : `still spelled out in: ${offenders.join(', ')}`)
}

// N28 — EVERY TABLE SCROLLS AT PHONE WIDTH, from one rule: forty-six screens
//       carry tables and six had wrappers, so the rule lives in globals.css
//       under a max-width media query rather than in forty wrappers.
{
  const css = readFileSync('src/app/globals.css', 'utf8')
  const m = /@media (?:screen and )?\(max-width: \d+px\) \{[^}]*main table \{([^}]*)\}/s.exec(css)
  check(m !== null && /display:\s*block/.test(m[1] ?? '') && /overflow-x:\s*auto/.test(m[1] ?? ''),
    'N28 every table scrolls sideways at phone width, from one rule',
    m ? `main table { ${m[1]!.trim().replace(/\s+/g, ' ')} }` : 'no narrow-width table rule in globals.css')
}

// N29 — A CAP SAYS ITS NUMBER, and the number is the code's. The journal page
//       reads 100 and used to cut silently; the readings page reads 10. The
//       sentence and the limit are tied so neither can drift alone.
{
  const entries = readFileSync('src/app/ledger/[ledgerId]/entries/page.tsx', 'utf8')
  const paginated = entries.includes('limit: 101, offset: (page - 1) * 100')
    && entries.includes('postedRead.slice(0, 100)')
    && entries.includes('next={postedRead.length > 100 ? pageLink(page + 1) : undefined}')
    && entries.includes('<Pagination page={page}')
  const readingsPage = readFileSync('src/app/ledger/[ledgerId]/readings/page.tsx', 'utf8')
  const readingsLib = readFileSync('src/lib/bill-reading.ts', 'utf8')
  const libCap = /readingsFor\(ledgerId: string, limit = (\d+)\)/.exec(readingsLib)?.[1]
  const saidReadings = /The newest (\d+) readings are shown/.exec(readingsPage)?.[1]
  // The readings gate too — it was the untied corner (critic, 2026-09-13).
  const readingsGate = new RegExp(`readings\\.length >= ${libCap ?? 'NEVER'}`).test(readingsPage)
  check(paginated
    && libCap !== undefined && saidReadings === libCap && readingsGate,
    'N29 journal paginates its bounded read; readings name their cap',
    `journal pagination ${paginated}; `
      + `readings: cap ${libCap}, sentence says ${saidReadings ?? 'nothing'}, gated at the cap ${readingsGate}`)
}

// N31 — A DOWNLOAD ROW DOES NOT PRINT. The breakdown page's Download row
//       printed as text (the audit named it; the first pass checked three
//       other pages and dismissed the claim — critic, 2026-09-13). Every
//       file that offers a Download link must hide it from print, by
//       print:hidden or the doc pages' no-print.
{
  const offenders: string[] = []
  const ui = readFileSync('src/lib/ui.ts', 'utf8')
  const toolHidden = /export const TOOL_BUTTON =[\s\S]*?print:hidden/.test(ui)
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) { walk(p); continue }
      if (!p.endsWith('.tsx')) continue
      const src = readFileSync(p, 'utf8')
      const sharedExit = toolHidden && /className=\{(?:TOOL_BUTTON|`\$\{TOOL_BUTTON\})/.test(src)
      if (/Download (PDF|Excel|CSV)/.test(src) && !/print:hidden|no-print/.test(src) && !sharedExit) offenders.push(p)
    }
  }
  walk('src/app'); walk('src/components')
  check(offenders.length === 0,
    'N31 every download row hides itself from print',
    offenders.length === 0 ? 'every offering page carries print:hidden or no-print' : `prints: ${offenders.join(', ')}`)
}

// N30 — THE OVERLAY HANDS FOCUS BACK. It takes focus when it opens (so Tab
//       and a screen reader enter the dialog) and returns it to the opener
//       when it closes. Read from source: a static render runs no effects.
{
  const src = readFileSync('src/components/OverlayPanel.tsx', 'utf8')
  const restored = src.includes('opener?.isConnected') && src.includes('opener.focus()')
    && src.includes('launcher?.focus()') && src.includes("getComputedStyle(element).visibility === 'visible'")
  check(src.includes('tabIndex={-1}') && src.includes('panelRef.current?.focus()')
    && restored && src.includes('element.inert = true')
    && src.includes('element.inert = prior[index]') && src.includes("e.key !== 'Tab'"),
    'N30 the overlay takes focus on open and hands it back on close',
    `panel focusable ${src.includes('tabIndex={-1}')}, focused on mount ${src.includes('panelRef.current?.focus()')}, `
      + `connected opener or visible launcher restored ${restored}, background inert ${src.includes('element.inert = true')}`)
}

// ---------------------------------------- the dead address (2026-09-15) --
//
// The owner deleted a party and the page it was deleted from became a 404 —
// and because the desk keeps each tab's current url in localStorage and
// re-opens it on every reload, that 404 came back forever. They got out by
// clearing the browser's storage. Two faults, and these are both of them.

// N32 — A DOOR THAT DESTROYS THE PAGE IT SITS ON MUST LEAVE IT.
//       Source, not behaviour: calling a server action needs a request, and
//       `redirect` works by throwing. What can be read is that each of these
//       doors reaches for it — and that every one of them is a door pressed
//       from the record's OWN page, which is the property that makes it
//       necessary.
//
//       THE LIST IS DERIVED, NOT TYPED. The owner asked the right question
//       the moment three doors were fixed — "其他东西如果我删掉了，也会触发
//       这个问题吗" — and a hand-written list of three was the shape of the
//       bug itself. So the doors are found: a destructive action, rendered by
//       a screen that lives under a route segment carrying the id of the very
//       thing it destroys. Add such a door tomorrow and this names it.
{
  /**
   * EVERY DESTRUCTIVE DOOR IS CLASSIFIED, and the classification is checked.
   *
   * A door was first derived from its name — deleteParty -> partyId in the
   * route — and it found three of five: a DRAFT is an entry (`entryId`), and
   * the SR&ED project's segment is `[projectId]`, not `[sredProjectId]`. A
   * heuristic that quietly misses two is worse than none, because it reads
   * like coverage.
   *
   * So the two lists, the way N1 and N2 do it: the router's destructive doors
   * on one side, a verdict for each on the other. A door added tomorrow is in
   * neither list and this fails until somebody says which it is — which is the
   * point. The verdict is a JUDGEMENT about where the door is pressed, and it
   * cannot be derived, so it is written down instead of guessed.
   */
  const src = readFileSync('src/app/actions.ts', 'utf8')
    + readFileSync('src/app/records-actions.ts', 'utf8')
    + readFileSync('src/app/user-actions.ts', 'utf8')
    + readFileSync('src/app/ledger/[ledgerId]/sred/actions.ts', 'utf8')
    + readFileSync('src/app/ledger/[ledgerId]/payroll/actions.ts', 'utf8')

  // Pressed from the record's OWN page: the url dies with the record, so the
  // door must leave before the page it is standing on becomes a 404.
  const OWN_PAGE = [
    'deletePartyAction',      // parties/[partyId]
    'deleteEntryAction',      // entries/[entryId]
    'deleteInvoiceAction',    // invoices/[invoiceId]
    'discardDraftAction',     // entries/[entryId] — a draft IS an entry
    'deleteSredProjectAction',// sred/[projectId]
    'deleteAccountAction',    // accounts/[accountId]
    'deleteEmployeeAction',   // payroll/people/[employeeId]/edit
  ]
  // Pressed from a list, or from a page that outlives what was removed. The
  // url survives, so there is nothing to leave.
  const SURVIVES: Record<string, string> = {
    deleteSredTimeAction:     'sred/[projectId] — the project outlives the time entry',
    deleteSredEvidenceAction: 'sred/[projectId] — the project outlives the evidence',
    deleteSredRateAction:     'sred — a list',
    deletePaymentAction:      'invoices/[invoiceId] — the invoice outlives the application',
    deleteStatementAction:    'bank/[accountId]/reconcile — the bank account outlives the statement',
    deleteAttachmentAction:   'entries/[entryId] — the entry outlives the receipt',
    removeStatementFileAction: 'bank/[accountId]/reconcile — the statement outlives the file link',
    deleteCompanyAction:      '/companies — a list. It kills OTHER tabs, which nothing can navigate',
    archiveCompanyAction:     '/companies — and archiving hides nothing: the books stay readable',
    deleteUserAction:         '/users — a list',
    discardReadingAction:     'readings — a list',
    removeEditionAction:      'payroll — the list of CRA editions',
    deleteRecordRowAction:    'records and the register pages — lists; the row goes, the page stays',
    deleteShareClassAction:   'records and the securities register page — a list',
    deleteTaxRegistrationAction: 'tax/registration — a list of registrations',
    deleteSredClaimAction:    'sred/[projectId] — the project outlives the year\'s claim',
    deleteBankRowAction:      'bank/[accountId] — the account outlives the row',
    deleteRoleAction:         'parties/[partyId] — the party outlives the role',
    deleteAddressAction:      'parties/[partyId] — the party outlives the address',
    deleteFiscalYearAction:   'periods — a list of years',
  }

  const doors = [...src.matchAll(/export async function ((?:delete|discard|remove|archive)\w*Action)/g)]
    .map((m) => m[1])
  const unclassified = doors.filter((d) => !OWN_PAGE.includes(d) && !(d in SURVIVES))
  const standingStill = OWN_PAGE.filter((door) => {
    const at = src.indexOf(`export async function ${door}`)
    if (at === -1) return true
    const next = src.indexOf('\nexport ', at + 1)
    return !src.slice(at, next === -1 ? undefined : next).includes('redirect(')
  })
  const vanished = [...OWN_PAGE, ...Object.keys(SURVIVES)].filter((d) => !doors.includes(d))

  check(doors.length > 10 && unclassified.length === 0 && standingStill.length === 0 && vanished.length === 0,
    'N32 deleting a record leaves the page that was showing it',
    unclassified.length > 0
      ? `${unclassified.join(', ')}: destructive and unclassified — does its own page survive it?`
      : standingStill.length > 0
        ? `${standingStill.join(', ')}: stays on the page it just destroyed`
        : vanished.length > 0 ? `classified but gone: ${vanished.join(', ')}`
        : `${doors.length} destructive doors; the ${OWN_PAGE.length} that destroy their own page all redirect`)
}

// N33 — AND THERE IS SOMEWHERE TO LAND. Without a not-found boundary Next
//       renders its own 404, which carries no rail, no link and no sentence —
//       a dead end inside a desk tab. ONE boundary, at the root, deliberately:
//       a second under /ledger/[ledgerId] was tried and renders WITHOUT the
//       company shell, because that segment carries the @modal parallel slot
//       (page pass, 2026-09-15). A file appearing there again would be that
//       mistake coming back, so this check refuses it by name.
{
  const root = 'src/app/not-found.tsx'
  const hasRoot = existsSync(root)
  const src = hasRoot ? readFileSync(root, 'utf8') : ''
  const strays: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) walk(p)
      else if (e === 'not-found.tsx' && p !== root) strays.push(p)
    }
  }
  walk('src/app')
  // `WayOut` takes no props — `not-found.tsx` is given none — so the company
  // it links back to comes from the url, through the same parse the desk's tab
  // labels use. THE ADDRESS THAT BROKE is the one worth asserting on: a
  // deleted party's page must still name the company it was in.
  const broke = '/ledger/b88dfbbd-07ba-4731-8e1f-19677bb4dd0d/parties/78803258-7e09-4a2d-af88-fa7386cb80a3'
  const named = ledgerOf(broke) === 'b88dfbbd-07ba-4731-8e1f-19677bb4dd0d' && ledgerOf('/companies') === null
  check(hasRoot && src.includes('WayOut') && strays.length === 0 && named,
    'N33 a dead address lands on a page with a way out, and there is one boundary',
    !hasRoot ? 'no src/app/not-found.tsx — Next\u2019s own 404 has no link out'
      : strays.length > 0 ? `a second boundary under a parallel slot: ${strays.join(', ')}`
      : !named ? 'the url parse does not find the company a dead party page was in'
      : 'root boundary; a dead party url still names its company, /companies names none')
}

// N34 — WHAT THE DELETE SAID SURVIVES THE MOVE. An entry's delete now lands
//       on the journal, and the consequences have to arrive with it: a
//       released application means a debt is owed again, a released match
//       means a reconciliation must be done over. Counts travel in the
//       address and this words them, so nothing a person could put in a link
//       becomes a sentence on the page.
{
  const plain = deletedEntrySentence('JE-0007')
  const loud = deletedEntrySentence('JE-0007', 3, 2)
  check(plain.startsWith('JE-0007 deleted.') && !plain.includes('owed again')
    && loud.includes('3 application(s) released') && loud.includes('2 bank match(es) released')
    && loud.includes('reconcile again'),
    'N34 a deleted entry carries its consequences to the page it lands on',
    `quiet: "${plain.slice(0, 40)}…" / loud names both releases`)
}

// N35 — TEACHING MARKERS ARE GONE; THE SCREENS ALWAYS SHOW THEIR DATA.
{
  const marked: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (isDir(p)) { walk(p); continue }
      if (!p.endsWith('.tsx')) continue
      if (/className="[^"\n]*\bnote\b|\$\{NOTE(?:_LEAD)?\}/.test(readFileSync(p, 'utf8'))) marked.push(p)
    }
  }
  walk('src/app'); walk('src/components')
  const ui = readFileSync('src/lib/ui.ts', 'utf8')
  check(marked.length === 0 && !/export const NOTE\b/.test(ui),
    'N35 teaching markers are removed from every module, rather than hidden by preference',
    marked.length ? marked.join(', ') : 'no note-marked UI or NOTE token')
}

// N36 — EVERY DESTINATION IS A DOOR THAT EXISTS (2026-09-16).
//
//       The model now picks where a read document belongs from
//       src/lib/destinations.ts, and the prompt is generated from that list —
//       which is the point: 「我希望 ai 理解整个 app 自己选择正确的处理方式」.
//       A catalogue that can name a route the router does not have would be
//       worse than the four hardcoded answers it replaced: the model would
//       choose correctly and the person would land on a 404.
{
  /**
   * Does the router have this path? Resolved the way Next does, one segment at
   * a time: a literal directory, or a `[param]` one standing in for it.
   *
   * Written because the first version of this check compared the path against
   * directories literally and called `/entries/quick/expense` missing — it is
   * `/entries/quick/[kind]`, and `expense` is the kind. A check that cannot
   * read a dynamic segment would have forced the catalogue to describe routes
   * that do not exist rather than the ones that do.
   */
  const routed = (path: string): boolean => {
    let at = ROOT
    for (const seg of path.split('/').filter(Boolean)) {
      if (isDir(join(at, seg))) { at = join(at, seg); continue }
      const dynamic = readdirSync(at).find((e) => /^\[[^.]+\]$/.test(e) && isDir(join(at, e)))
      if (!dynamic) return false
      at = join(at, dynamic)
    }
    return existsSync(join(at, 'page.tsx'))
  }

  const missing: string[] = []
  const unseated: string[] = []
  for (const d of DESTINATIONS) {
    if (!routed(d.path)) missing.push(`${d.key} -> ${d.path}`)
    // And it must be somewhere the rail can reach, or it is a door nobody
    // could have found on their own — which N1/N2 already require of modules.
    if (activeNavPath('x', `/ledger/x${d.path}`) === null) unseated.push(`${d.key} -> ${d.path}`)
  }
  const keys = DESTINATIONS.map((d) => d.key)
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
  // The four that existed before the catalogue must keep their exact spelling,
  // or every proposal stored before 2026-09-16 reads as `other`.
  const kept = MONEY_KEYS.every((k) => keys.includes(k))

  check(missing.length === 0 && unseated.length === 0 && dupes.length === 0 && kept
        && !DESTINATION_KEYS.includes(''),
    'N36 every destination the model may choose is a screen that exists',
    missing.length > 0 ? `no page.tsx: ${missing.join(', ')}`
      : unseated.length > 0 ? `no seat on the rail: ${unseated.join(', ')}`
      : dupes.length > 0 ? `duplicate key: ${dupes.join(', ')}`
      : !kept ? 'a money key was renamed — every proposal stored before the catalogue would read as other'
      : `${DESTINATIONS.length} destinations, all routed and seated, plus "other"`)
}

// N37 — THE PRIMARY CONTROL RESERVES ITS BORDER. FIELD, QUIET and DANGER
//       already carry one; without the transparent border BUTTON is two
//       pixels shorter and a mixed action row does not share a baseline.
{
  const bordered = BUTTON.split(' ').includes('border') && BUTTON.split(' ').includes('border-transparent')
  check(bordered,
    'N37 the primary button reserves the same border box as the other controls',
    bordered
      ? 'BUTTON carries a transparent border'
      : 'BUTTON has no transparent border placeholder')
}

// N38 — A STATE CHANGE CHANGES COLOUR, NOT GEOMETRY. Both range presets and
//       SR&ED years take their height, border and padding from one shared base;
//       selected and unselected branches supply colours only.
{
  const range = readFileSync('src/components/RangePicker.tsx', 'utf8')
  const sred = readFileSync('src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx', 'utf8')
  const rangeSharedField = range.includes('aria-label="Period preset" value={selected} className={FIELD}')
  const yearBox = /const YEAR_BUTTON = '([^']+)'/.exec(sred)?.[1] ?? ''
  const shared = (box: string) => box.includes('h-[34px]') && /(?:^| )border(?: |$)/.test(box)
    && box.includes('items-center') && box.includes('px-')
  const duplicateYearBorder = sred.includes("'border border-neutral-300 text-neutral-600")
  check(rangeSharedField && shared(yearBox) && !duplicateYearBorder,
    'N38 range selection uses a shared field; SR&ED year states keep one box model',
    `range shared field ${rangeSharedField}; year base ${shared(yearBox)}, duplicate inactive border ${duplicateYearBorder}`)
}

// N39 — OVERFLOW STOPS AT THE CONTENT PANE. The routed overlay keeps two
//       24px gutters, and a wide business form scrolls beside the rail rather
//       than widening the document and dragging the rail with it.
{
  const overlay = readFileSync('src/components/OverlayPanel.tsx', 'utf8')
  const layout = readFileSync('src/app/ledger/[ledgerId]/layout.tsx', 'utf8')
  const safe = overlay.includes('right-6 w-[calc(100%_-_3rem)]') && overlay.includes('overflow-auto') && overlay.includes("size === 'wide' ? 'max-w-6xl' : 'max-w-4xl'")
  const frame = readFileSync('src/components/ApplicationFrame.tsx', 'utf8')
  const contained = layout.includes('<ApplicationFrame')
    && frame.includes('ledger-canvas-wrap min-w-0 overflow-x-auto')
  check(safe && contained,
    'N39 overlays keep 24px gutters and wide ledger content scrolls inside the shell',
    `safe overlay width ${safe}, content owns horizontal overflow ${contained}`)
}

// N40 — THE ADD-TAB DOOR CANNOT SCROLL AWAY. Tabs have their own scroll
//       region; each tab and close door resists shrinking; the + sits after
//       that content-sized region and resists shrinking too. It follows the
//       last tab when there is room, and remains reachable when tabs overflow.
{
  const desk = readFileSync('src/components/Desk.tsx', 'utf8')
  const scrollAt = desk.indexOf('desk-tab-list flex min-w-0 items-center gap-1.5 overflow-x-auto')
  const scrollEnd = desk.indexOf('</div>', scrollAt)
  const addAt = desk.indexOf('aria-label="New tab"')
  const tabFixed = /max-w-\d+ shrink-0 items-center/.test(desk)
  const closeFixed = /aria-label=\{`Close \$\{tabLabel\(t.href, companies\)\}`\}[\s\S]{0,180}className="shrink-0/.test(desk)
  const addFixed = /aria-label="New tab"[\s\S]{0,180}className="[^"]*shrink-0/.test(desk)
  const contentSized = !/desk-tab-list[^"\n]*flex-1/.test(desk)
  check(scrollAt >= 0 && scrollEnd > scrollAt && addAt > scrollEnd && tabFixed && closeFixed && addFixed && contentSized,
    'N40 Desk tabs scroll separately while tabs, close doors, and + stay usable',
    `scroll region ${scrollAt >= 0}, + outside ${addAt > scrollEnd}, content sized ${contentSized}, tab fixed ${tabFixed}, close fixed ${closeFixed}, + fixed ${addFixed}`)
}

// N41 — PAGE HEADERS HAVE ONE WRAPPING SHAPE. These are the high-traffic
//       list screens whose title/action pairs used to be rigid one-line rows.
{
  const paths = [
    'src/app/companies/page.tsx',
    'src/app/ledger/[ledgerId]/entries/page.tsx',
    'src/app/ledger/[ledgerId]/invoices/InvoiceListPage.tsx',
    'src/app/ledger/[ledgerId]/parties/page.tsx',
    'src/app/ledger/[ledgerId]/payroll/page.tsx',
    'src/app/ledger/[ledgerId]/PartyLedgerPage.tsx',
  ]
  const header = PAGE_HEADER.split(' ')
  const shared = ['ui-page-header', 'flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-3'].every((token) => header.includes(token))
  const missing = paths.filter((p) => {
    const source = readFileSync(p, 'utf8')
    return (source.match(/PAGE_HEADER/g) ?? []).length < 2 && !source.includes('<PageHeader')
  })
  check(shared && missing.length === 0,
    'N41 list-page title and action rows share the wrapping PAGE_HEADER',
    !shared ? 'PAGE_HEADER does not encode wrap, gap and vertical alignment'
      : missing.length > 0 ? `not using PAGE_HEADER: ${missing.join(', ')}`
      : `${paths.length} page headers use the shared wrapping shape`)
}

// N42 — FILTER AND DOWNLOAD ROWS MAY MAKE A SECOND LINE. These rows carry
//       variable-length labels and optional exits, so a fixed line is an
//       overflow bug at the 768px acceptance width.
{
  const expectations: Array<[string, RegExp]> = [
    ['src/components/DocHeader.tsx', /no-print mb-4 flex flex-wrap items-center justify-end gap-2/],
    ['src/components/Exports.tsx', /mt-4 flex flex-wrap justify-end gap-2/],
    ['src/app/ledger/[ledgerId]/aging/page.tsx', /mt-6 flex flex-wrap items-end gap-2/],
    ['src/app/ledger/[ledgerId]/reports/general-ledger/page.tsx', /<FilterBar>/],
    ['src/app/ledger/[ledgerId]/reports/trial-balance/page.tsx', /<FilterBar>/],
    ['src/app/ledger/[ledgerId]/parties/PartiesScreen.tsx', /mt-3 flex flex-wrap items-end gap-3/],
  ]
  const missing = expectations.filter(([p, re]) => !re.test(readFileSync(p, 'utf8'))).map(([p]) => p)
  check(missing.length === 0,
    'N42 document exits, report filters, and Party filters wrap with explicit gaps',
    missing.length === 0 ? `${expectations.length} variable action rows wrap with a gap` : `rigid or gapless: ${missing.join(', ')}`)
}

// N43 — SEGMENTED NAVIGATION SCROLLS; ITS LABELS DO NOT FOLD. The bank feed
//       and SR&ED tabs keep their single-line labels and put excess width on
//       the tab strip rather than on the document.
{
  const feed = readFileSync('src/app/ledger/[ledgerId]/bank/[accountId]/FeedScreen.tsx', 'utf8')
  const sred = readFileSync('src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx', 'utf8')
  const scrolls = (src: string) => /<nav className="[^"]*overflow-x-auto[^"]*"/.test(src)
    && src.includes('shrink-0 whitespace-nowrap border-b-2')
  const tabs = readFileSync('src/components/ModuleTabs.tsx', 'utf8')
  const feedScrolls = feed.includes('<ModuleTabs label="feed tabs"') && tabs.includes('overflow-x-auto') && tabs.includes('shrink-0 whitespace-nowrap border-b-2')
  check(feedScrolls && scrolls(sred),
    'N43 Bank Feed and SR&ED tabs scroll horizontally without folding labels',
    `Bank Feed ${feedScrolls}, SR&ED ${scrolls(sred)}`)
}

// N44 — A BANK ROW PRESENTS TWO RESOLUTIONS, NOT A CHOICE AND AN UNRELATED
//       ACTION COLUMN. The suggested match owns its Match button; the category
//       owns Post new; both sit under one Resolve heading.
{
  const feed = readFileSync('src/app/ledger/[ledgerId]/bank/[accountId]/FeedScreen.tsx', 'utf8')
  const grouped = feed.includes('data-resolution="match"')
    && feed.includes('data-resolution="post"')
    && feed.includes('data-resolve={row.id}')
  const sameRow = feed.includes('bank-resolve grid gap-1.5')
    && feed.includes('h-[34px] grid-cols-[minmax(0,1fr)_auto]')
    && (feed.includes('data-table-scroll') || feed.includes('<TableViewport label="Bank transactions"'))
  const flatPaths = feed.includes('data-suggestion')
    && !feed.includes('Post a new entry') && !feed.includes('New entry')
    && feed.includes('className={`h-[34px] w-full ${FIELD}`}')
  const oneHeading = feed.includes('<th className="bank-resolve-cell py-2 font-medium" colSpan={2}>Resolve</th>')
    && !feed.includes('Match/Categorize')
  const namedActions = feed.includes('submit="Match"') && feed.includes("'Post new'")
  check(grouped && sameRow && flatPaths && oneHeading && namedActions,
    'N44 Bank keeps both inline resolution paths and compact controls inside a local scroller',
    `grouped paths ${grouped}, compact controls ${sameRow}, flat paths ${flatPaths}, one heading ${oneHeading}, named actions ${namedActions}`)
}

// N45 — RETIRING BRIEF PRESERVES THE PERSON'S EXISTING COLOUR CHOICES.
{
  const settings = readFileSync('src/app/settings/AppearanceForm.tsx', 'utf8')
  const root = readFileSync('src/app/layout.tsx', 'utf8')
  const css = readFileSync('src/app/globals.css', 'utf8')
  const users = readFileSync('src/lib/users.ts', 'utf8')
  const start = users.indexOf('export async function saveAppearance(')
  const save = users.slice(start, users.indexOf('export async function', start + 1))
  const retired = !settings.includes('name="detail"') && !settings.includes('DETAILS')
    && !root.includes('data-detail=') && !css.includes('data-detail=')
  const preserves = root.includes('theme: me.theme') && root.includes('mode: me.appearance_mode')
    && root.includes('liquidTint: me.liquid_tint') && !save.includes('detail =')
    && save.includes('WHERE id = ${userId}::uuid')
  check(retired && preserves,
    'N45 Brief is retired without resetting themes, tint or the legacy database field',
    `retired ${retired}; saved appearance remains scoped to its owner ${preserves}`)
}

// N46 — ONE NUMBER STAYS NEAR ITS LABEL; MANY COLUMNS KEEP THE WIDTH. A
//       single-column statement is capped and centred. Comparative, period and
//       equity tables remain wide inside their own horizontal scroller.
{
  const statements = readFileSync('src/app/ledger/[ledgerId]/statements/page.tsx', 'utf8')
  const derived = readFileSync('src/app/ledger/[ledgerId]/statements/Derived.tsx', 'utf8')
  const adaptive = statements.includes("data-report-layout={wide ? 'wide' : 'single'}")
    && statements.includes("wide ? 'w-full min-w-[48rem]' : 'mx-auto w-full max-w-2xl'")
    && statements.includes("wide ? 'mt-8 overflow-x-auto' : 'mt-8'")
  const derivedAdaptive = derived.includes('data-report-layout="single" className="mx-auto mt-8 w-full max-w-2xl')
    && derived.includes('data-report-layout="wide" className="mt-8 w-full min-w-[48rem]')
  check(adaptive && derivedAdaptive,
    'N46 statement width follows its data: compact for one figure, wide for many columns',
    `template statements ${adaptive}, derived statements ${derivedAdaptive}`)
}

// N47 — BRIEF REMOVES TEACHING, NEVER THE CONSEQUENCE OF A LIVE STATE OR
//       ACTION. These blocks are status/safety boundaries: live document and
//       filing states, destructive lifecycle actions, and one-way constraints.
//       Their explanatory copy must remain beside the state-changing action in
//       both detail modes.
{
  const block = (src: string, from: string, to?: string) => {
    const start = src.indexOf(from)
    if (start < 0) return ''
    const end = to ? src.indexOf(to, start + from.length) : -1
    return src.slice(start, end < 0 ? undefined : end)
  }
  const paragraph = (src: string, marker: string) => {
    const markerAt = src.indexOf(marker)
    if (markerAt < 0) return ''
    const start = src.lastIndexOf('<p', markerAt)
    const end = src.indexOf('</p>', markerAt)
    return start < 0 || end < 0 ? '' : src.slice(start, end + 4)
  }
  const invoice = readFileSync('src/app/ledger/[ledgerId]/invoices/[invoiceId]/InvoiceDetail.tsx', 'utf8')
  const periods = readFileSync('src/app/ledger/[ledgerId]/periods/PeriodActions.tsx', 'utf8')
  const parties = readFileSync('src/app/ledger/[ledgerId]/parties/[partyId]/PartyManage.tsx', 'utf8')
  const sred = readFileSync('src/app/ledger/[ledgerId]/sred/[projectId]/ProjectBody.tsx', 'utf8')
  const companies = readFileSync('src/app/companies/page.tsx', 'utf8')
  const taxReturn = readFileSync('src/app/ledger/[ledgerId]/tax/ReturnScreen.tsx', 'utf8')
  const reconcile = readFileSync('src/app/ledger/[ledgerId]/bank/reconcile/page.tsx', 'utf8')
  const newAccount = readFileSync('src/app/ledger/[ledgerId]/accounts/new/NewAccountBody.tsx', 'utf8')
  const assistant = readFileSync('src/app/ledger/[ledgerId]/assistant/page.tsx', 'utf8')
  const readBill = readFileSync('src/components/ReadBill.tsx', 'utf8')
  const cheque = readFileSync('src/app/ledger/[ledgerId]/cheques/[chequeId]/page.tsx', 'utf8')
  const newCheque = readFileSync('src/app/ledger/[ledgerId]/cheques/new/page.tsx', 'utf8')
  const boundaries = [
    ['voided invoice', paragraph(invoice, "{status === 'void'")],
    ['reopen year', block(periods, 'export function ReopenYearControls')],
    ['party off-list actions', block(parties, 'Off the list', '</section>')],
    ['SR&ED filing actions', block(sred, 'export function Filing', '\nfunction Paper')],
    ['company archive and removal', paragraph(companies, 'Archived companies keep history')],
    ['return book figures and separate overrides', paragraph(taxReturn, 'Book figures can change')],
    ['finished reconciliation freeze', paragraph(reconcile, 'When the difference is zero')],
    ['used-account type lock', paragraph(newAccount, 'Its type and normal balance are fixed')],
    ['Ask FigTree data-sharing disclosure', paragraph(assistant, 'Every question sends')],
    ['Read & add data-sharing and review disclosure', paragraph(readBill, 'Your service receives')],
    ['manual cheque edit consequence', paragraph(cheque, 'Changing the bank, expense account, amount or date')],
    ['source expense edit consequence', paragraph(cheque, 'The bank account can be corrected here')],
    ['source payment and payroll edit consequence', paragraph(cheque, 'The bank account and amount belong to the')],
    ['cheque void consequence', paragraph(cheque, 'Voiding this cheque')],
    ['manual cheque posting consequence', paragraph(newCheque, 'A manual cheque posts an expense')],
    ['cheque number reservation', paragraph(newCheque, 'The next cheque number is reserved')],
    ['cheque printing prerequisites', paragraph(cheque, 'Print at 100% / Actual size')],
  ] as const
  const unsafe = boundaries.filter(([, src]) => !src
    || /className=(?:"[^"]*\bnote\b|\{`[^`]*\$\{NOTE(?:_LEAD)?\})/.test(src))
  check(unsafe.length === 0,
    'N47 live status and destructive-action consequences stay visible after copy simplification',
    unsafe.length > 0 ? `unsafe boundary: ${unsafe[0]![0]}` : `${boundaries.length} safety boundaries remain outside .note`)
}

// N48 — PORTABLE RESTORE IS THE SUPERADMIN'S DOOR; THE CROSS-COMPANY AUDIT
// EXPORT IS AN OWNER DOOR. The ordinary backup download remains available to
// an authorised company user; only the trigger-bypass restore and the
// system-wide trail are elevated. The restore had drifted to any owner while
// this check's own name, the screen and RISKS §1 said superadmin (2026-10-20).
{
  const actions = readFileSync('src/app/actions.ts', 'utf8')
  const restoreAt = actions.indexOf('export async function restoreBackupAction')
  const restoreBody = actions.slice(restoreAt, actions.indexOf('\nexport async function', restoreAt + 1))
  const backupPage = readFileSync('src/app/ledger/[ledgerId]/backup/page.tsx', 'utf8')
  const auditPage = readFileSync('src/app/audit/page.tsx', 'utf8')
  const auditRoute = readFileSync('src/app/audit/export/route.ts', 'utf8')
  const superadminRestore = restoreBody.includes("if (me.kind !== 'superadmin') return")
    && restoreBody.indexOf("me.kind !== 'superadmin'") < restoreBody.indexOf('await restoreCompany(')
    && !restoreBody.includes('ALLOW_PRIVILEGED_WEB_RESTORE')
    && backupPage.includes("restoreAvailable={user.kind === 'superadmin'}")
  const ownerCsv = auditPage.includes('href={exportHref}')
    && auditPage.includes('Export CSV')
    && auditRoute.includes('guardRoute({ owner: true })')
    && auditRoute.includes("'Cache-Control': 'no-store'")
    && auditRoute.includes("'X-FigTree-Truncated'")
    && auditRoute.includes('auditFilterFrom(values)')
  check(superadminRestore && ownerCsv,
    'N48 superadmin can restore in the app and export the filtered audit trail without widening either door',
    `superadmin-only web restore ${superadminRestore}; owner filtered CSV ${ownerCsv}`)
}

// N49 — A NARROW PAGE MAY BE NARROW WITHOUT FLOATING AWAY FROM THE RAIL.
// Ask FigTree, Backup, SR&ED and several focused forms keep useful max-widths,
// but the shared ledger pane owns their left edge and horizontal gutter. Only
// an explicitly marked paper preview remains centred on screen.
{
  const layout = readFileSync('src/app/ledger/[ledgerId]/layout.tsx', 'utf8')
  const css = readFileSync('src/app/globals.css', 'utf8')
  const bankPaper = readFileSync('src/app/ledger/[ledgerId]/bank/[accountId]/statement/[date]/print/page.tsx', 'utf8')
  const invoicePaper = readFileSync('src/app/ledger/[ledgerId]/invoices/[invoiceId]/print/route.ts', 'utf8')
  const partyPaper = readFileSync('src/app/ledger/[ledgerId]/parties/[partyId]/statement/page.tsx', 'utf8')
  const frame = readFileSync('src/components/ApplicationFrame.tsx', 'utf8')
  const sharedPane = layout.includes('<ApplicationFrame')
    && frame.includes('ledger-canvas-wrap min-w-0 overflow-x-auto')
    && frame.includes('data-ledger-content className="ledger-canvas min-h-full min-w-0 flex-1"')
  const leftRule = css.includes('[data-ledger-content] > .ledger-canvas-wrap > main:not([data-centered-paper])')
    && css.includes('margin-inline: 0;') && css.includes('padding-inline: var(--space-32);')
    && readFileSync('src/app/design-tokens.css', 'utf8').includes('--space-32: 2rem;')
  const papers = (bankPaper.match(/<main data-centered-paper/g) ?? []).length === 1
    && invoicePaper.includes('status: 307')
    && invoicePaper.includes('Location: `/ledger/${encodeURIComponent(ledgerId)}/invoices/${encodeURIComponent(invoiceId)}/pdf`')
    && !invoicePaper.includes('<InvoiceDocView')
    && (partyPaper.match(/<main data-centered-paper/g) ?? []).length === 1
  check(sharedPane && leftRule && papers,
    'N49 every ledger screen shares one left edge while explicit paper previews stay centred',
    `shared pane ${sharedPane}, left rule ${leftRule}, paper exceptions ${papers}`)
}

// N50 — LIQUID GLASS IS A THEME, NOT A SCREEN-SPECIFIC EFFECT. Its palette
// still satisfies N22; this pins the material layer that makes it distinct:
// a glass tool shell, solid working surfaces, both WebKit and standard
// blur on navigation, and an opaque answer when transparency is reduced.
{
  const appearance = readFileSync('src/lib/appearance.ts', 'utf8')
  const css = readFileSync('src/app/globals.css', 'utf8')
  const migration = readFileSync('db/migrations/0089_liquid_glass_is_a_theme.sql', 'utf8')
  const offered = appearance.includes("name: 'liquid'")
    && appearance.includes("label: 'Liquid Glass'")
  const stored = /CHECK \(theme IN \('claude', 'figtree', 'liquid'\)\)/.test(migration)
  const material = css.includes(':root[data-theme="liquid"] body')
    && css.includes('background-image: var(--liquid-canvas)')
    && css.includes('--material-work: #f7faff')
    && css.includes('.ui-card') && css.includes('.ui-field')
    && css.includes('-webkit-backdrop-filter: blur(20px) saturate(130%)')
    && css.includes('backdrop-filter: blur(20px) saturate(130%)')
    && !css.includes(':where(section, article, aside, dialog, div)[class~="bg-white"]')
  const fallback = css.includes('prefers-reduced-transparency: reduce')
    && css.includes('@supports not ((-webkit-backdrop-filter: blur(1px))')
    && css.includes('backdrop-filter: none')
  check(offered && stored && material && fallback,
    'N50 Liquid Glass is one selectable, mode-aware material with an opaque fallback',
    `offered ${offered}, stored ${stored}, shared material ${material}, fallback ${fallback}`)
}

// N51 — ADD AND ITS MENU HAVE ONE CONTINUOUS POINTER BOUNDARY. Opening still
// belongs only to the Add trigger, so hovering AI does not summon Add; closing
// belongs to the full two-button row and its descendant menu, so crossing AI
// on the way to the right-side menu cannot make that menu disappear.
{
  const rail = readFileSync('src/components/NavRail.tsx', 'utf8')
  const css = readFileSync('src/app/globals.css', 'utf8')
  const continuous = rail.includes('data-add-flyout-boundary')
    && rail.includes("flyoutBoundaryProps('add')")
    && rail.includes("data-add-trigger {...flyoutTriggerProps('add')}")
    && rail.includes('data-add-menu')
    && rail.includes('className={`${panelClass} left-full top-0`}')
    && !rail.includes('left-[calc(200%+1rem)]')
  const glassRail = rail.includes("'nav-flyout absolute z-50")
    && css.includes('background-color: var(--material-tool)')
    && css.includes('.nav-flyout')
    && css.includes('backdrop-filter: blur(20px) saturate(130%)')
    && css.includes('--liquid-nav-flyout:')
  check(continuous && glassRail,
    'N51 Add reaches its right-side menu continuously and the liquid rail is visibly glass',
    `continuous boundary ${continuous}, glass rail and flyout ${glassRail}`)
}

// N52 — A GLASS FLYOUT STILL SITS ABOVE THE PAGE. Backdrop-filter makes the
// rail a stacking context, so the parent itself must rise above ordinary page
// controls; its child z-50 cannot escape an auto-level parent. The rail stays
// below the routed overlay's z-40, with a subtle boundary at the work area.
{
  const rail = readFileSync('src/components/NavRail.tsx', 'utf8')
  const overlay = readFileSync('src/components/OverlayPanel.tsx', 'utf8')
  const css = readFileSync('src/app/globals.css', 'utf8')
  const navigationFrame = readFileSync('src/components/NavigationFrame.tsx', 'utf8')
  const stack = rail.includes('<NavigationFrame') && navigationFrame.includes('nav-rail relative z-30')
    && rail.includes('nav-flyout absolute z-50')
    && overlay.includes('fixed inset-0 z-40')
  const legible = css.includes('--liquid-nav-text: #e5f0fa')
    && css.includes('[class~="text-neutral-300"]')
    && css.includes('.nav-rail input[type="search"]::placeholder')
  const bounded = css.includes('border-right-color: var(--liquid-line)')
    && css.includes('.nav-flyout {')
    && css.includes('border-color: transparent')
  check(stack && legible && bounded,
    'N52 liquid navigation is legible and bounded, above pages but below overlays',
    `stack 30/40/50 ${stack}, bright labels ${legible}, subtle rail boundary ${bounded}`)
}

// N53 — ICON TOOLS KEEP THEIR NAMES AND THEIR FILTERED DOWNLOAD ADDRESSES.
{
  const href = '/ledger/example/tax/pdf?from=2026-01-01&to=2026-03-31&tax=pst'
  const csv = '/ledger/example/export?what=pst&from=2026-01-01&to=2026-03-31'
  const html = renderToStaticMarkup(createElement(Exports, { href, csv }))
  const esc = (value: string) => value.replace(/&/g, '&amp;')
  const names = ['Download PDF', 'Download Excel', 'Download CSV', 'Print'].every((name) => html.includes(`class="sr-only">${name}</span>`))
  const exits = [href, `${href}&format=xlsx`, csv].every((url) => html.includes(`href="${esc(url)}"`))
  const icons = (html.match(/aria-hidden="true" focusable="false" viewBox="0 0 24 24"/g) ?? []).length === 4
  check(names && exits && icons, 'N53 icon tools retain accessible names, filtered URLs and decorative SVGs',
    `names ${names}; original URLs ${exits}; four valid icon viewBoxes ${icons}`)
}

// N54 — A SAVED PALETTE IS STILL SELECTED AFTER RETIRING BRIEF.
{
  const failures: string[] = []
  for (const theme of THEMES) for (const mode of MODES) {
    const look = appearanceFrom(theme.name, mode.name, 'brief', '#AE9BEC')
    const html = renderToStaticMarkup(createElement(AppearanceForm, { current: look, action: async () => ({}) }))
    if (look.theme !== theme.name || look.mode !== mode.name || look.liquidTint !== '#ae9bec'
      || !html.includes(`name="theme" checked="" value="${theme.name}"`)
      || !html.includes(`name="mode" checked="" value="${mode.name}"`)
      || html.includes('name="detail"') || html.includes('How much it explains')) failures.push(`${theme.name}/${mode.name}`)
  }
  const safe = appearanceFrom('unknown', 'unknown', 'brief', 'javascript:bad')
  check(failures.length === 0 && JSON.stringify(safe) === JSON.stringify(DEFAULT_APPEARANCE),
    'N54 saved appearances survive legacy Brief; invalid appearance inputs use defaults',
    failures.length ? failures.join(', ') : `${THEMES.length} themes × ${MODES.length} modes; saved tint retained; no Brief control`)
}

// The document workspaces moved visually, while existing document grants stay valid.
{
  const income = LEDGER_NAV.find(item => item.path === '/income')
  const expense = LEDGER_NAV.find(item => item.path === '/expenses')
  const documents = LEDGER_NAV.find(item => item.path === '/invoices')
  const children = LEDGER_NAV.flatMap(item => item.children ?? [])
  check(Boolean(income?.children?.some(child => child.path === '/invoices')
    && expense?.children?.some(child => child.path === '/bills') && documents?.showInRail === false
    && !readFileSync('src/components/NavRail.tsx', 'utf8').includes('className="nav-children"')
    && !ADD_MENU.some(item => item.path === '/entries/quick/income')
    && !income?.flyout?.some(item => item.path === '/entries/quick/income')),
    'N55 documents have parent workspaces without extra rail rows or duplicate income creation', 'Sales under Income; bills under Expenses; new income starts with an invoice')
  const documentDoors = ['/invoices', '/invoices/new', '/bills', '/bills/new', '/bills/example/edit']
  check(documentDoors.every(path => railMayOpen(['/invoices'], 'X', path))
    && documentDoors.every(path => !railMayOpen(['/income', '/expenses'], 'X', path))
    && children.every(child => railMayOpen(LEDGER_NAV.map(item => item.path), 'X', child.path)),
    'N56 document workspaces preserve existing grants without borrowing parent grants', 'Every child has a seat; document seat covers both directions')
}

console.log(r.summary())
process.exit(r.failures === 0 ? 0 : 1)

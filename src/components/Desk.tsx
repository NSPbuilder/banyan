'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Image from 'next/image'
import { Icon } from './Icon'
import { COMPANIES_PATH, ledgerOf, tabLabel, moveTab } from '@/lib/tabs'
import { useNavigationCollapsed } from '@/lib/navigation-display'

/**
 * The desk: several pages open at once, each keeping its own state.
 *
 * The owner wanted Accounts and Parties open together, and two companies open
 * together (2026-09-03). One Next router holds one route tree, so tabs here
 * are IFRAMES: each tab is a full app view with its own rail, its own history
 * and its own company, and switching tabs touches neither.
 *
 * Two rules do all the work:
 *
 *   1. A tab's `src` is set when the tab is created and never again. Feeding
 *      the tab's current URL back into `src` would reload it on every click,
 *      which is precisely what tabs exist to avoid.
 *   2. A hidden tab stays MOUNTED. Unmounting it is what loses the half-typed
 *      expense the reader came back for.
 *
 * The list survives a reload through localStorage; each tab's stored href is
 * its CURRENT url, polled from the frame — see the note on that effect for
 * why polling and not the frame's `load` event.
 */

export type DeskTab = { id: string; href: string }
type MountedDeskTab = DeskTab & { openedAt: string }
type DeskStart = { tabs: MountedDeskTab[]; active: string }

const KEY = 'erp.desk.v1'
const COMPANIES_TAB: DeskTab = { id: 't0', href: COMPANIES_PATH }
const hydrationSubscribe = () => () => {}
const hydratedSnapshot = () => true
const serverSnapshot = () => false

function mountedStart(tabs: DeskTab[], active: string): DeskStart {
  const source = tabs.length > 0 ? tabs : [COMPANIES_TAB]
  return {
    tabs: source.map((t) => ({ ...t, openedAt: t.href })),
    active: active && source.some((t) => t.id === active) ? active : source[0].id,
  }
}

/** Read browser persistence once, as the client's initial state. The server
 *  uses the fallback, but both server and first client render show the same
 *  hydration shell; `useSyncExternalStore` opens the desk after hydration. */
function initialDesk(openWith?: { tabs: DeskTab[]; active: string }): DeskStart {
  if (openWith) return mountedStart(openWith.tabs, openWith.active)
  if (typeof window === 'undefined') return mountedStart([COMPANIES_TAB], COMPANIES_TAB.id)
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : null
    const tabsIn = Array.isArray(parsed?.tabs) ? parsed.tabs : []
    const tabs = tabsIn.filter((t: unknown): t is DeskTab => {
      const candidate = t as DeskTab | null
      return !!candidate && typeof candidate.id === 'string' && /^t\d+$/.test(candidate.id)
        && typeof candidate.href === 'string' && candidate.href.startsWith('/')
    })
    if (tabs.length > 0) {
      return mountedStart(tabs, typeof parsed.active === 'string' ? parsed.active : tabs[0].id)
    }
  } catch { /* a corrupt entry is no reason to have no desk */ }
  return mountedStart([COMPANIES_TAB], COMPANIES_TAB.id)
}

function idAfter(tabs: DeskTab[]): number {
  return 1 + Math.max(0, ...tabs.map((t) => Number(t.id.slice(1)) || 0))
}

export function Desk({ companies, homes = {}, openWith }: {
  /** id -> name, for the tab labels. */
  companies: Record<string, string>
  /** id -> first route this user may open in that company. */
  homes?: Record<string, string>
  /** Handed in by checks, which cannot run effects or press anything. */
  openWith?: { tabs: DeskTab[]; active: string }
}) {
  const [start] = useState(() => initialDesk(openWith))
  const [tabs, setTabs] = useState<MountedDeskTab[]>(start.tabs)
  const [active, setActive] = useState(start.active)
  const dragging = useRef<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; edge: 'before' | 'after' } | null>(null)
  const hydrated = useSyncExternalStore(hydrationSubscribe, hydratedSnapshot, serverSnapshot)
  const ready = !!openWith || hydrated
  const collapsed = useNavigationCollapsed()
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({})
  // One past the HIGHEST id ever used, not one past the count: close two tabs
  // out of four and a count-based id walks onto a living frame.
  const nextId = useRef(idAfter(start.tabs))

  useEffect(() => {
    if (!ready || openWith) return
    const stored = tabs.map(({ id, href }) => ({ id, href }))
    try { localStorage.setItem(KEY, JSON.stringify({ tabs: stored, active })) } catch { /* private window */ }
  }, [tabs, active, ready, openWith])

  const open = (href: string) => {
    const id = `t${nextId.current++}`
    setTabs((ts) => [...ts, { id, href, openedAt: href }])
    setActive(id)
  }

  const close = (id: string) => {
    // Computed out here, not inside a state updater: an updater can be called
    // twice, and a second `setActive` from inside one is a side effect that
    // runs twice with it.
    const left = tabs.filter((t) => t.id !== id)
    delete frames.current[id]
    if (left.length === 0) {
      const fresh = { id: `t${nextId.current++}`, href: COMPANIES_PATH, openedAt: COMPANIES_PATH }
      setTabs([fresh])
      setActive(fresh.id)
      return
    }
    setTabs(left)
    if (id === active) setActive(left[left.length - 1].id)
  }

  /** A new tab opens in the same company at this person's allowed home. */
  const openNext = () => {
    const here = tabs.find((t) => t.id === active)
    const ledger = here ? ledgerOf(here.href) : null
    open(ledger ? (homes[ledger] ?? `/ledger/${ledger}`) : COMPANIES_PATH)
  }

  // Where each frame actually IS, read on a timer rather than on `load`.
  //
  // Next navigates inside the frame without reloading the document, so the
  // frame's `load` event fires once and never again: the first version used
  // it, and every tab kept the label it opened with while the page inside it
  // moved on (browser pass, 2026-09-03). Reading the location is same-origin
  // and costs nothing; a frame showing a PDF refuses, and that tab keeps the
  // label it had.
  useEffect(() => {
    if (!ready) return
    const read = () => {
      // The frames are read HERE, not inside the updater. An updater that
      // reaches for a ref is impure, and React may call it twice — harmless
      // for a location read, and a trap for whatever gets added next to it.
      const where: Record<string, string> = {}
      for (const [id, frame] of Object.entries(frames.current)) {
        try {
          const loc = frame?.contentWindow?.location
          if (loc) where[id] = loc.pathname + loc.search
        } catch { /* a PDF frame refuses; that tab keeps the label it had */ }
      }
      // Appearance is stored on each framed document's <html>. Saving it in
      // Settings reloads that frame, but not the desk around it. Match the
      // active frame so the tab bar and rail remain one continuous surface.
      try {
        const source = frames.current[active]?.contentDocument?.documentElement
        if (source?.dataset.theme) {
          const target = document.documentElement
          for (const key of ['theme', 'mode'] as const) {
            const value = source.dataset[key]
            if (value && target.dataset[key] !== value) target.dataset[key] = value
          }
          const tint = source.style.getPropertyValue('--liquid-tint')
          if (tint && target.style.getPropertyValue('--liquid-tint') !== tint) {
            target.style.setProperty('--liquid-tint', tint)
          }
        }
      } catch { /* A PDF has no readable document; keep the last appearance. */ }
      setTabs((ts) => {
        const moved = ts.some((t) => where[t.id] && where[t.id] !== t.href)
        // The SAME array when nothing moved: a new array every half second
        // would re-render the desk forever.
        return moved ? ts.map((t) => (where[t.id] ? { ...t, href: where[t.id] } : t)) : ts
      })
    }
    read()
    const timer = setInterval(read, 500)
    return () => clearInterval(timer)
  }, [active, ready])

  // Nothing to press until the restore has run: a `+` clicked in that first
  // tick created a tab the restore then threw away, and took the id counter
  // with it (critic, 2026-09-03).
  if (!ready) {
    return (
      <div className="flex h-screen flex-col bg-neutral-900">
        <div className="h-11 bg-neutral-900" />
      </div>
    )
  }

  return (
    <div className="desk-shell flex h-screen flex-col" data-collapsed={collapsed}>
      <div className="desk-bar flex min-w-0 items-center gap-2 bg-neutral-900 px-3 text-sm">
        <div className="desk-brand flex shrink-0 items-center gap-2 text-white" aria-label="Banyan">
          <Image src="/banyan-icon.png" width={25} height={25} alt="" className="rounded-control" priority />
          <span>Banyan</span>
        </div>
        <div className="desk-tab-list flex min-w-0 items-center gap-1.5 overflow-x-auto" role="tablist" aria-label="Open pages">
          {tabs.map((t) => (
            <span key={t.id} draggable
                  data-drop={dropAt?.id === t.id ? dropAt.edge : undefined}
                  onDragStart={(e) => {
                    dragging.current = t.id
                    e.dataTransfer.setData('text/plain', t.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragOver={(e) => {
                    if (!dragging.current) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    const box = e.currentTarget.getBoundingClientRect()
                    const edge = e.clientX < box.left + box.width / 2 ? 'before' : 'after'
                    setDropAt((old) => old?.id === t.id && old.edge === edge ? old : { id: t.id, edge })
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const id = dragging.current
                    const box = e.currentTarget.getBoundingClientRect()
                    const edge = e.clientX < box.left + box.width / 2 ? 'before' : 'after'
                    if (id) setTabs((ts) => moveTab(ts, id, t.id, edge))
                    dragging.current = null
                    setDropAt(null)
                  }}
                  onDragEnd={() => { dragging.current = null; setDropAt(null) }}
                  className={`desk-tab flex max-w-80 shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 ${
                    t.id === active ? 'desk-tab-active' : 'desk-tab-inactive'}`}>
              <button type="button" onClick={() => setActive(t.id)}
                      onKeyDown={(e) => {
                        if (!e.altKey || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return
                        const target = tabs[tabs.findIndex((x) => x.id === t.id) + (e.key === 'ArrowLeft' ? -1 : 1)]
                        if (!target) return
                        e.preventDefault()
                        setTabs((ts) => moveTab(ts, t.id, target.id, e.key === 'ArrowLeft' ? 'before' : 'after'))
                      }}
                      className="min-w-0 truncate" data-tab={t.id}
                      role="tab" aria-selected={t.id === active} title={tabLabel(t.href, companies)}>
                {tabLabel(t.href, companies)}
              </button>
              <button type="button" aria-label={`Close ${tabLabel(t.href, companies)}`} onClick={() => close(t.id)}
                      title={`Close ${tabLabel(t.href, companies)}`} className="shrink-0 desk-tab-close rounded-md px-1 text-neutral-400 hover:text-neutral-900 dark:hover:text-white">
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
        <button type="button" onClick={openNext} aria-label="New tab" title="New tab"
                className="shrink-0 desk-new-tab rounded-lg px-2.5 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-white">
          <Icon name="plus" />
        </button>
      </div>

      <div className="relative min-h-0 grow">
        {/* Keep frames in creation order: moving an iframe DOM node reloads it. */}
        {[...tabs].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).map((t) => (
          <iframe key={t.id} src={t.openedAt}
                  title={tabLabel(t.href, companies)}
                  ref={(el) => { frames.current[t.id] = el }}
                  data-frame={t.id}
                  className="absolute inset-0 h-full w-full border-0"
                  style={{ display: t.id === active ? 'block' : 'none' }} />
        ))}
      </div>
    </div>
  )
}

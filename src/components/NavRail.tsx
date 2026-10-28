'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Icon } from './Icon'
import { NavigationFrame, useNavigationPanel } from './NavigationFrame'
import { usePathname } from 'next/navigation'
import { ADD_MENU, AI_WORKSPACE_PATH, LEDGER_NAV, activeNavPath, railMayOpen } from '@/lib/nav'
import { setNavigationCollapsed, useNavigationCollapsed } from '@/lib/navigation-display'

function NavIcon({ label }: { label: string }) { return <Icon name={label} className="nav-icon" /> }

/**
 * The left rail: labels can collapse to icons, active one lit. It renders the
 * ONE nav definition and nothing of its own — a link that exists only here
 * does not exist. The Add flyout and the per-item flyouts come from the same
 * file (ADD_MENU, NavItem.flyout), so the shell checks see every door.
 *
 * Flyouts are STATE, not CSS hover: a pure hover panel stayed open after a
 * click because the pointer was still over it (owner, 2026-09-03). Open on
 * mouse-enter or focus, close on leave, blur past the panel — and on CLICK,
 * because a chosen destination is a finished conversation.
 *
 * Hidden in print: the pages that print are paper, and paper has no sidebar.
 */
export function NavRail({ ledgerId, entityName, seats }: {
  ledgerId: string
  entityName: string
  /**
   * The seat paths this person may open (0054). A COURTESY: the gate refuses
   * the URL either way, and hiding a seat whose address still answers is the
   * defect RISKS §15b was written about. This exists so nobody is offered a
   * door they will be turned away from.
   */
  seats: string[]
}) {
  const pathname = usePathname()
  const allowed = new Set(seats)
  /**
   * The rail has FOUR link sources, and the first version filtered one.
   *
   * The seat list above was filtered; the search box, the Add flyout and every
   * item's own flyout were not (critic, 2026-09-03) — so a person without the
   * Payroll seat was still offered "Pay run", and the Reports flyout offered
   * the GST/HST return, which lives in the separate Sales-tax seat. Nothing
   * leaked: the gate refuses each of those URLs. What it cost was the one thing
   * the rail is for, which is telling somebody what they may do.
   *
   * Every door goes through this, so a door added later is filtered by being
   * added rather than by somebody remembering.
   */
  const mayOpen = (path: string) => railMayOpen(allowed, ledgerId, path)
  const nav = LEDGER_NAV.filter((item) => item.showInRail !== false
    && (allowed.has(item.path) || item.children?.some(child => mayOpen(child.path))))
  const isCurrent = (path: string) => pathname === `/ledger/${ledgerId}${path}`
    || pathname.startsWith(`/ledger/${ledgerId}${path}/`)
  const activeSeat = activeNavPath(ledgerId, pathname)
  const active = nav.find(item => item.children?.some(child => isCurrent(child.path)))?.path ?? activeSeat
  const [open, setOpen] = useState<string | null>(null)
  const panel = useNavigationPanel()
  const { setMobileOpen } = panel
  const collapsed = useNavigationCollapsed()
  const toggleCollapsed = () => {
    setNavigationCollapsed(!collapsed)
    setOpen(null)
  }
  const [manageOpen, setManageOpen] = useState(false)
  const groups = [
    { id: 'daily', label: 'Daily work' },
    { id: 'books', label: 'Books & reports' },
    { id: 'manage', label: 'Manage' },
  ] as const
  const activeGroup = nav.find((item) => item.path === active)?.group
  const addItems = ADD_MENU.filter((item) => mayOpen(item.path))
  const showAi = mayOpen(AI_WORKSPACE_PATH)||mayOpen('/automation/inbox')
  const aiActive = pathname.includes('/assistant') || pathname.includes('/readings')

  const panelClass =
    'nav-flyout absolute z-50 min-w-52 rounded-panel border border-line-subtle ' +
    'bg-surface-elevated p-1'
  const itemClass =
    'block rounded-control px-3 py-1 text-body'

  const flyoutTriggerProps = (key: string) => ({
    onMouseEnter: () => setOpen(key),
    onFocus: () => setOpen(key),
    onClick: () => setOpen(key),
  })

  const flyoutBoundaryProps = (key: string) => ({
    onMouseLeave: () => setOpen((o) => (o === key ? null : o)),
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setOpen((o) => (o === key ? null : o))
      }
    },
  })

  return (
    <NavigationFrame panel={panel} label={entityName} id="ledger-navigation" collapsed={collapsed} onEscape={() => setOpen(null)}>
      <div className="nav-company px-3 pt-3 pb-3">
        {/* The company list, not `/`. `/` is the desk, and a tab that opened
            the desk would show a tab strip inside a tab, and another inside
            that one. N10 refuses a link to `/` anywhere in the app. */}
        <Link href="/companies" onClick={() => setMobileOpen(false)} className="nav-company-link flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-1 text-label font-semibold"
              aria-label={`Change company: ${entityName}`}
              title={`Change company · ${entityName}`}>
          <span className="nav-company-icon"><NavIcon label="Corporate records" /></span>
          <span className="nav-company-name min-w-0 flex-1 truncate">{entityName}</span><Icon name="chevron-down" className="nav-company-chevron" />
        </Link>
        <button type="button" className="nav-collapse-toggle" onClick={toggleCollapsed}
                aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
                aria-expanded={!collapsed} title={collapsed ? 'Expand navigation' : 'Collapse navigation'}>
          <Icon name={collapsed ? 'sidebar-expand' : 'sidebar-collapse'} />
        </button>
      </div>

      {/* The two ways to begin work: ordinary forms and one shared AI space. */}
      {(addItems.length > 0 || showAi) && (
        <div className="nav-actions relative px-4 pb-3" data-add-flyout-boundary
             {...(addItems.length > 0 ? flyoutBoundaryProps('add') : {})}>
          <div className={`grid gap-2 ${addItems.length > 0 && showAi ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {addItems.length > 0 && (
              <button type="button" aria-label="Add" aria-haspopup="menu" aria-expanded={open === 'add'}
                      title="Add"
                      data-add-trigger {...flyoutTriggerProps('add')}
                      className="nav-action flex min-h-control w-full items-center gap-2 rounded-control px-2 text-label font-medium">
                <Icon name="plus" /><span className="nav-action-label"> Add</span>
              </button>
            )}
            {showAi && (
              <Link href={`/ledger/${ledgerId}${mayOpen(AI_WORKSPACE_PATH)?AI_WORKSPACE_PATH:'/readings/inbox'}`}
                    aria-current={aiActive ? 'page' : undefined}
                    aria-label="AI workspace"
                    title="AI workspace"
                    onClick={() => setMobileOpen(false)}
                    className={`nav-action flex min-h-control items-center gap-2 rounded-control px-2 text-label font-medium ${aiActive ? 'nav-action-active' : ''}`}>
                <Icon name="sparkles" /><span className="nav-action-label"> AI</span>
              </Link>
            )}
          </div>
          {open === 'add' && (
            <div role="menu" data-add-menu className={`${panelClass} left-full top-0`}>
              {addItems.map((item) => (
                <Link key={item.path} role="menuitem" href={`/ledger/${ledgerId}${item.path}`}
                      onClick={() => { setOpen(null); setMobileOpen(false) }} className={itemClass}>
                  {item.label}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {groups.map((group) => {
        const items = nav.filter((item) => item.group === group.id)
        if (items.length === 0) return null
        const expanded = group.id !== 'manage' || manageOpen || activeGroup === 'manage'
        return <div key={group.id} className="nav-group">
          {group.id === 'manage' ? (
            <button type="button" className="nav-section-label nav-group-toggle" aria-expanded={expanded}
                    aria-label="Manage" title="Manage"
                    aria-controls="nav-manage-items" onClick={() => setManageOpen((value) => !value)}>
              <span className="nav-group-icon"><NavIcon label="Manage" /></span>
              <span className="nav-group-name">{group.label}</span><Icon name={expanded ? 'chevron-down' : 'chevron-right'} className="nav-group-chevron" />
            </button>
          ) : <div className="nav-section-label px-6 pt-3 pb-1 text-metadata font-medium">{group.label}</div>}
          <ul id={group.id === 'manage' ? 'nav-manage-items' : undefined}
              className="nav-list px-3 text-sm" hidden={!expanded}>
        {items.map((item) => (
          <li key={item.path}
              className={item.flyout ? 'relative' : undefined}
              {...(item.flyout ? flyoutBoundaryProps(item.path) : {})}>
            <div className="nav-item-row flex items-center">
            {allowed.has(item.path) ? <Link
              href={`/ledger/${ledgerId}${item.path}`}
              aria-current={active === item.path ? 'page' : undefined}
              onMouseEnter={item.flyout ? () => setOpen(item.path) : undefined}
              onFocus={item.flyout ? () => setOpen(item.path) : undefined}
              onClick={() => { setOpen(null); setMobileOpen(false) }}
              className={
                active === item.path
                  ? 'nav-item nav-item-active flex min-w-0 flex-1 items-center gap-2 rounded-control px-3 py-1 font-medium'
                  : 'nav-item flex min-w-0 flex-1 items-center gap-2 rounded-control px-3 py-1'
              }
              title={item.label}
              aria-label={item.label}
            >
              <NavIcon label={item.label} />
              <span className="nav-item-label min-w-0 flex-1 truncate">{item.label}</span>
            </Link> : <span className={`nav-item flex min-w-0 flex-1 items-center gap-2 rounded-control px-3 py-1 ${active === item.path ? 'nav-item-active font-medium' : ''}`} title={item.label}
              aria-current={active === item.path ? 'page' : undefined}>
              <NavIcon label={item.label} /><span className="nav-item-label min-w-0 flex-1 truncate">{item.label}</span>
            </span>}
            {item.flyout && <button type="button" className="nav-flyout-toggle" aria-label={`${item.label} options`}
                                    aria-haspopup="menu" aria-expanded={open === item.path}
                                    title={`${item.label} options`} onClick={() => setOpen((value) => value === item.path ? null : item.path)}><Icon name="chevron-right" /></button>}
            </div>
            {item.flyout && open === item.path && (
              <div role="menu" className={`${panelClass} left-full top-0`}>
                {item.flyout.filter((f) => mayOpen(f.path)).map((f) => (
                  <Link key={f.path} role="menuitem" href={`/ledger/${ledgerId}${f.path}`}
                        onClick={() => { setOpen(null); setMobileOpen(false) }} className={itemClass}>
                    {f.label}
                  </Link>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
        </div>
      })}

      {/* Settings is the person's, not the company's — so it is under the
          seats rather than among them, and no seat gates it. Everybody may
          decide how their own screen looks (0067). */}
      <div className="nav-settings mt-5 border-t border-neutral-800 px-3 py-3">
        <Link href={`/settings?ledger=${ledgerId}`} onClick={() => setMobileOpen(false)}
              aria-label="Settings" title="Settings"
              aria-current={pathname === '/settings' ? 'page' : undefined}
              className={pathname === '/settings'
                ? 'nav-item nav-item-active flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium'
                : 'nav-item flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-neutral-400'}>
          <NavIcon label="Settings" /><span className="nav-item-label">Settings</span>
        </Link>
      </div>
    </NavigationFrame>
  )
}

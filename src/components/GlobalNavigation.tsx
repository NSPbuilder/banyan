'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { setNavigationCollapsed, useNavigationCollapsed } from '@/lib/navigation-display'
import { Icon } from './Icon'
import { NavigationFrame, useNavigationPanel } from './NavigationFrame'

/** Global pages use the same shell, with workspace rather than company seats. */
export function GlobalNavigation({ owner }: { owner: boolean }) {
  const pathname = usePathname(), panel = useNavigationPanel()
  const collapsed = useNavigationCollapsed()
  const items = [
    { path: '/companies', label: 'Companies', icon: 'companies' },
    ...(owner ? [{ path: '/users', label: 'People', icon: 'Parties' }, { path: '/audit', label: 'Audit trail', icon: 'audit' }] : []),
    { path: '/settings', label: 'Settings', icon: 'Settings' },
  ]
  return <NavigationFrame panel={panel} label="Workspace" id="workspace-navigation" collapsed={collapsed}>
    <div className="nav-company px-3 py-3">
      <span className="nav-company-name min-w-0 flex-1 px-2 text-label font-semibold text-ink">Workspace</span>
      <button type="button" className="nav-collapse-toggle" onClick={() => setNavigationCollapsed(!collapsed)}
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!collapsed}
              title={collapsed ? 'Expand navigation' : 'Collapse navigation'}><Icon name={collapsed ? 'sidebar-expand' : 'sidebar-collapse'} /></button>
    </div>
    <ul className="nav-list px-3 text-body">
      {items.map(item => <li key={item.path}>
        <Link href={item.path} onClick={() => panel.setMobileOpen(false)} aria-current={pathname.startsWith(item.path) ? 'page' : undefined}
              aria-label={item.label} title={item.label}
              className={`nav-item flex items-center gap-2 rounded-control px-3 py-1 ${pathname.startsWith(item.path) ? 'nav-item-active font-medium' : ''}`}>
          <Icon name={item.icon} className="nav-icon" /><span className="nav-item-label">{item.label}</span>
        </Link>
      </li>)}
    </ul>
  </NavigationFrame>
}

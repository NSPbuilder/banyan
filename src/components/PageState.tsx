import type { ReactNode } from 'react'
import { Icon } from './Icon'

export function PageState({ title, children, action, icon, role }: {
  title: string
  children?: ReactNode
  action?: ReactNode
  icon?: string
  role?: 'alert' | 'status'
}) {
  return <section className="max-w-xl space-y-3 py-6" role={role}>
    <div className="flex items-center gap-2">
      {icon && <Icon name={icon} />}
      <h2 className="text-section-title font-semibold text-ink">{title}</h2>
    </div>
    {children && <div className="text-body text-ink-secondary">{children}</div>}
    {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
  </section>
}

export function PageLoading() {
  return <main className="w-full px-8 py-6" aria-busy="true" role="status">
    <p className="mb-6 text-body text-ink-muted">Loading…</p>
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-8 border-b border-line-subtle"><div className="h-4 w-1/3 rounded-control bg-surface-secondary" /></div>)}
    </div>
  </main>
}

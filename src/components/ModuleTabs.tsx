import Link from 'next/link'
import type { ReactNode } from 'react'

export function ModuleTabs({ label, items, className = '' }: {
  label: string; items: Array<{ href: string; label: ReactNode; selected: boolean }>; className?: string
}) {
  return <nav aria-label={label} className={`ui-module-tabs flex gap-1 overflow-x-auto border-b border-line-subtle text-label print:hidden ${className}`}>
    {items.map((item) => <Link key={item.href} href={item.href} aria-current={item.selected ? 'page' : undefined}
      className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 ${item.selected ? 'border-action font-medium text-ink' : 'border-transparent text-ink-secondary hover:bg-surface-hover hover:text-ink'}`}>{item.label}</Link>)}
  </nav>
}

'use client'

import { usePathname } from 'next/navigation'
import { ModuleTabs } from './ModuleTabs'

export function WorkspaceTabs({ label, items, className }: {
  label: string; items: Array<{href: string; label: string}>; className?: string
}) {
  const path = usePathname()
  const selected = items.filter(item => path === item.href || path.startsWith(item.href + '/'))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href
  return <ModuleTabs label={label} className={className} items={items.map(item => ({...item,
    selected: item.href === selected,
  }))} />
}

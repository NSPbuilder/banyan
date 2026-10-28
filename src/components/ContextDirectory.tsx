'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { FIELD, GHOST } from '@/lib/ui'
import { formatNumber } from '@/lib/numbers'
import { Icon } from './Icon'

/** A local context selector, never a second permanent navigation rail. */
export function ContextDirectory({ label, items, selected, total, href }: {
  label: string; items: Array<{ id: string; name: string; count: number }>
  selected: string; total: number; href: (id: string) => string
}) {
  const id = useId(), ref = useRef<HTMLDetailsElement>(null)
  const [query, setQuery] = useState('')
  const current = items.find(item => item.id === selected)
  const shown = items.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()))
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute('open')
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])
  const item = (key: string, name: string, count: number) => <Link key={key} href={href(key)} scroll={false}
    aria-current={selected === key ? 'page' : undefined} onClick={() => ref.current?.removeAttribute('open')}
    className={`flex items-center justify-between gap-3 rounded-control px-3 py-2 text-label hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus ${selected === key ? 'bg-surface-selected font-medium' : ''}`}>
    <span className="min-w-0 break-words">{name}</span><span className="text-metadata text-ink-muted tabular-nums">{formatNumber(count)}</span>
  </Link>
  return <details ref={ref} className="ui-context-directory group relative" onKeyDown={event => {
    if (event.key === 'Escape' && ref.current?.open) {
      event.preventDefault(); ref.current.open = false; ref.current.querySelector('summary')?.focus()
    }
  }}>
    <summary className={`${GHOST} cursor-pointer list-none max-w-full`} aria-controls={id}>
      <span className="text-metadata text-ink-muted">{label}</span>
      <span className="truncate">{current?.name ?? `All ${label.toLowerCase()}`}</span>
      <span className="text-metadata text-ink-muted tabular-nums">{formatNumber(current?.count ?? total)}</span>
      <Icon name="chevron-down" className="shrink-0 group-open:rotate-180" />
    </summary>
    <div id={id} className="absolute left-0 top-full z-20 mt-1 w-field-wide max-w-[calc(100vw-4rem)] rounded-panel border border-line bg-surface-elevated p-2 shadow-(--shadow-popover)">
      <label className="block"><span className="sr-only">Find {label.toLowerCase()}</span>
        <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={`Find ${label.toLowerCase()}…`} className={`w-full ${FIELD}`} />
      </label>
      <nav className="mt-2 max-h-80 overflow-y-auto" aria-label={`${label} list`}>
        {item('', `All ${label.toLowerCase()}`, total)}{shown.map(p => item(p.id, p.name, p.count))}
        {!shown.length && <p className="px-3 py-2 text-metadata text-ink-muted">{query ? 'No matches.' : `No ${label.toLowerCase()} yet.`}</p>}
      </nav>
    </div>
  </details>
}

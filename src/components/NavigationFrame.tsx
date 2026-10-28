'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'
import { QUIET_COMPACT } from '@/lib/ui'

/** Shared mobile navigation focus guard. Desktop flyouts remain unobstructed. */
export function useNavigationPanel() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const rail = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!mobileOpen) return
    const media = window.matchMedia('(max-width: 880px)')
    if (!media.matches) return
    const opener = document.activeElement as HTMLElement | null
    const background = document.querySelector<HTMLElement>('[data-ledger-content]')
    const prior = background?.inert ?? false
    if (background) background.inert = true
    if (trigger.current) trigger.current.inert = true
    const controls = () => [...rail.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled])') ?? []]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    controls()[0]?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Tab') return
      const items = controls(), first = items[0], last = items[items.length - 1]
      if (!rail.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    const onResize = () => { if (!media.matches) setMobileOpen(false) }
    document.addEventListener('keydown', onKey)
    media.addEventListener('change', onResize)
    const button = trigger.current
    return () => {
      document.removeEventListener('keydown', onKey)
      media.removeEventListener('change', onResize)
      if (background) background.inert = prior
      if (button) button.inert = false
      if (media.matches) button?.focus({ preventScroll: true })
      else opener?.focus()
    }
  }, [mobileOpen])
  return { mobileOpen, setMobileOpen, rail, trigger }
}

export function NavigationFrame({ panel, label, id, collapsed, onEscape, children }: {
  panel: ReturnType<typeof useNavigationPanel>
  label: string
  id: string
  collapsed: boolean
  onEscape?: () => void
  children: ReactNode
}) {
  const { mobileOpen, setMobileOpen, rail, trigger } = panel
  return <>
    <button ref={trigger} type="button" className="nav-mobile-trigger" aria-controls={id}
            aria-expanded={mobileOpen} onClick={() => setMobileOpen(value => !value)} title="Open navigation">
      <Icon name="menu" /><span className="truncate">{label}</span><span className="sr-only"> navigation</span>
    </button>
    {mobileOpen && <button type="button" className="nav-mobile-backdrop" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <nav ref={rail} id={id} aria-label={`${label} navigation`} aria-modal={mobileOpen || undefined} role={mobileOpen ? 'dialog' : undefined}
         onKeyDown={event => { if (event.key === 'Escape') { onEscape?.(); setMobileOpen(false) } }} data-collapsed={collapsed}
         className={`nav-rail relative z-30 shrink-0 ${mobileOpen ? 'nav-rail-open' : ''}`}>
      {mobileOpen && <button type="button" className={`nav-mobile-close m-3 ${QUIET_COMPACT}`} onClick={() => setMobileOpen(false)}>Close navigation</button>}
      {children}
    </nav>
  </>
}

'use client'

import { useCallback, useEffect, useId, useRef } from 'react'
import { DialogHeader } from './DialogHeader'
import { DialogHeadingProvider } from './DialogHeading'
import { useRouter } from 'next/navigation'
import { useOverlayOrigin } from './WorkspaceNavigation'
import { useConfirmExit, useUnsavedChanges } from './UnsavedChanges'

/**
 * The floating frame a sub-page lives in while its module stays open behind
 * it. Exits return to the launch surface in this iframe; a route may supply
 * a stable fallback when there is no recorded launch surface.
 * Escape and the backdrop use the same exit as the close button.
 *
 * The frame decides nothing about content; the intercepted route renders the
 * SAME body component the full page renders, so the overlay and the deep link
 * cannot drift apart.
 */
export function OverlayPanel({ children, returnTo, size = 'regular' }: { children: React.ReactNode; returnTo?: string; size?: 'regular' | 'wide' }) {
  const router = useRouter()
  const titleId = useId()
  const origin = useOverlayOrigin(returnTo)
  const close = useCallback(() => {
    if (origin) router.replace(origin, { scroll: false })
    else router.back()
  }, [router, origin])
  const panelRef = useRef<HTMLDivElement>(null)
  const { isDirty } = useUnsavedChanges(panelRef)
  const { requestClose, requestExit, prompt } = useConfirmExit(isDirty, close, panelRef)

  // The overlay takes focus when it opens and hands it back when it closes:
  // without this, Tab kept walking the page underneath and a screen reader
  // never entered the dialog (whole-project audit, 2026-09-13).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const background = [...document.querySelectorAll<HTMLElement>('.ledger-workspace > :not(.overlay-panel)')]
    const prior = background.map((element) => element.inert)
    background.forEach((element) => { element.inert = true })
    panelRef.current?.focus()
    return () => {
      background.forEach((element, index) => { element.inert = prior[index] })
      if (opener?.isConnected && opener !== document.body && !opener.closest('[inert]')) opener.focus()
      else {
        // A flyout item is removed when its menu closes. Return to a stable
        // visible launcher, including the navigation button on narrow screens.
        const launcher = [...document.querySelectorAll<HTMLElement>('.nav-mobile-trigger, [data-add-trigger]')]
          .find((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible')
        launcher?.focus()
      }
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('dialog[open]')) return
      if (e.key === 'Escape') { e.preventDefault(); requestClose() }
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0)
      if (focusable.length === 0) { e.preventDefault(); panelRef.current.focus(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panelRef.current)) {
        e.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [requestClose])

  return (
    <div className="overlay-panel fixed inset-0 z-40" role="dialog" aria-labelledby={titleId} aria-modal="true"
         onClickCapture={(event) => {
           const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
           if (!link || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !isDirty()) return
           const target = new URL(link.href, window.location.href)
           if (target.origin !== window.location.origin || target.href === window.location.href) return
           event.preventDefault()
           requestExit(() => router.push(target.pathname + target.search + target.hash))
         }}>
      <div className="absolute inset-0 bg-black/40" onClick={requestClose} aria-hidden />
      <div ref={panelRef} tabIndex={-1} className={`overlay-surface absolute inset-y-6 right-6 w-[calc(100%_-_3rem)] ${size === 'wide' ? 'max-w-6xl' : 'max-w-4xl'} overflow-auto rounded-lg bg-white outline-none dark:bg-neutral-900`}>
        <DialogHeadingProvider header={heading => <DialogHeader titleId={titleId} title={heading?.title ?? 'Details'} context={heading?.context} onClose={requestClose} />}>
        {/* Fields reflow within the panel; complex detail tables own their scroll area. */}
        <div className="overlay-content pb-6">
          {children}
        </div>
        </DialogHeadingProvider>
        {prompt}
      </div>
    </div>
  )
}

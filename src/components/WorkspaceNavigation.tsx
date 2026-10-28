'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

const Origins = createContext<((target: string) => string | undefined) | null>(null)

/** Each Desk iframe owns its launch surfaces; browser back shares history
 * across frames, so an overlay must not use it to choose another tab's page. */
export function WorkspaceNavigation({ children }: { children: React.ReactNode }) {
  const origins = useRef(new Map<string, string>())
  const lookup = useCallback((target: string) => origins.current.get(target), [])
  return (
    <Origins.Provider value={lookup}>
      <div className="contents" onClickCapture={(event) => {
        const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
        if (!link || link.target || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        const target = new URL(link.href, window.location.href)
        if (target.origin !== window.location.origin) return
        const from = window.location.pathname + window.location.search + window.location.hash
        const to = target.pathname + (target.searchParams.size ? '?' + target.searchParams.toString() : '')
        if (target.href === window.location.href) return
        origins.current.set(to, from)
        if (origins.current.size > 100) origins.current.delete(origins.current.keys().next().value!)
      }}>
        {children}
      </div>
    </Origins.Provider>
  )
}

export function useOverlayOrigin(fallback?: string) {
  const lookup = useContext(Origins)
  const pathname = usePathname()
  const query = useSearchParams().toString()
  // Next can render the new route before committing it to window.location.
  const [origin] = useState(() => lookup?.(pathname + (query ? '?' + query : '')) ?? fallback)
  return origin
}

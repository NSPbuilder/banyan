'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

type Heading = { title: ReactNode; context?: ReactNode }
const DialogHeadingContext = createContext<((heading: Heading) => void) | null>(null)

/** The body and deep link share PageHeader; the routed frame owns its modal title. */
export function DialogHeadingProvider({ children, header }: {
  children: ReactNode; header: (heading: Heading | null) => ReactNode
}) {
  const [heading, setHeading] = useState<Heading | null>(null)
  const register = useCallback((next: Heading) => setHeading(previous =>
    previous?.title === next.title && previous?.context === next.context ? previous : next), [])
  return <DialogHeadingContext.Provider value={register}>{header(heading)}{children}</DialogHeadingContext.Provider>
}

export function PageHeading({ title, context, className = '' }: Heading & {className?: string}) {
  const register = useContext(DialogHeadingContext)
  useEffect(() => { register?.({ title, context }) }, [register, title, context])
  if (register) return null
  return <div className={`min-w-0 ${className}`}><h1 className="text-page-title font-semibold">{title}</h1>
    {context && <div className="mt-1 text-metadata text-ink-muted">{context}</div>}
  </div>
}

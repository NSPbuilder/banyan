import type { ReactNode } from 'react'
import { GHOST } from '@/lib/ui'
import { Icon } from './Icon'

/** Fields stay in their GET form and retain values even when collapsed. */
export function MoreFilters({ children, active = 0 }: { children: ReactNode; active?: number }) {
  return <details className="ui-more-filters group basis-full" open={active > 0 || undefined}>
    <summary className={`${GHOST} cursor-pointer list-none w-fit`}>More filters{active > 0 && <span className="text-metadata">({active} active)</span>}<Icon name="chevron-down" className="group-open:rotate-180" /></summary>
    <div className="mt-2 flex flex-wrap items-end gap-3">{children}</div>
  </details>
}

import { IconButton } from './IconButton'
import type { ReactNode } from 'react'

export function DialogHeader({ title, context, titleId, onClose }: { title?: ReactNode; context?: ReactNode; titleId?: string; onClose: () => void }) {
  return <div className="overlay-header sticky top-0 z-10 flex items-center justify-between gap-3">
    {title ? <div className="min-w-0"><h2 id={titleId} className="text-page-title font-semibold">{title}</h2>
      {context && <div className="mt-1 text-metadata text-ink-muted">{context}</div>}
    </div> : <span />}
    <IconButton label="Close" icon="close" onClick={onClose} className="overlay-close shrink-0" />
  </div>
}

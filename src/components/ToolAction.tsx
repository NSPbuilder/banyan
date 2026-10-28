import type { ReactNode } from 'react'
import { Icon } from './Icon'

export type ToolKind = 'back' | 'pdf' | 'csv' | 'xlsx' | 'print' | 'download'

/** Content for a tool link/button; its parent keeps the original navigation/action. */
export function ToolAction({ kind, children, showLabel = false }: { kind: ToolKind; children: ReactNode; showLabel?: boolean }) {
  return <>
    <Icon name={kind === 'back' || kind === 'print' || kind === 'download' ? kind : 'file'} />
    {!showLabel && ['pdf', 'csv', 'xlsx'].includes(kind) &&
      <span aria-hidden="true" className="text-caption font-medium leading-none">{kind.toUpperCase()}</span>}
    <span className={showLabel ? 'text-metadata' : 'sr-only'}>{children}</span>
  </>
}

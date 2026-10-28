import type { ReactNode } from 'react'
import Link from 'next/link'
import { PAGE_HEADER, TOOL_BUTTON } from '@/lib/ui'
import { ToolAction } from './ToolAction'
import { PageHeading } from './DialogHeading'

export function PageHeader({ title, context, backTo, backLabel = 'Back', children }: {
  title: ReactNode
  context?: ReactNode
  backTo?: string
  backLabel?: string
  children?: ReactNode
}) {
  return <header className={PAGE_HEADER}>
    <div className="flex min-w-0 items-center gap-3">
      {backTo && <Link href={backTo} className={TOOL_BUTTON} title={backLabel}><ToolAction kind="back">{backLabel}</ToolAction></Link>}
      <PageHeading title={title} context={context} />
    </div>
    {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
  </header>
}

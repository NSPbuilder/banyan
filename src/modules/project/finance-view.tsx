import { Fragment } from 'react'
import Link from 'next/link'
import type { FinanceViewContext, FinanceView } from '@/lib/module-extensions'
import { refuseForLedger } from '@/lib/access'
import { managedEntryOrigins, managedProjectOrigin } from '@/lib/project-finance'
import { projectInvoiceOrigin } from '@/lib/project-invoices'

export async function financeView(context: FinanceViewContext): Promise<FinanceView | null> {
  const { type, id, ledgerId, entityId, user } = context
  const mayOpen = !(await refuseForLedger(user, ledgerId, '/projects'))
  if (type === 'entry') {
    const origins = await managedEntryOrigins(id)
    if (!origins.length) return null
    return { order: 10, managed: true, panel: <p key="project" className="mt-3 text-metadata text-ink-muted">Managed by Project{mayOpen&&origins.map(p=><Link key={p.project_id} href={`/ledger/${ledgerId}/projects/${p.project_id}`} className="ml-2 underline">{p.code}</Link>)}. Edit or cancel at the source.</p> }
  }
  const managed = await managedProjectOrigin(id)
  const href = managed ? `/ledger/${ledgerId}/projects/${managed.project_id}` : undefined
  const origin = mayOpen ? await projectInvoiceOrigin(entityId, id) : null
  return {
    managed: !!managed,
    editTarget: managed ? { seat: '/projects', href: href!, label: 'Project', accessible: mayOpen } : undefined,
    panel: <Fragment key="project">
      {origin && <p className="mt-2 text-metadata text-ink-muted">
        Project {origin.deleted ? origin.code : <Link href={`/ledger/${ledgerId}/projects/${origin.project_id}#record-${origin.record_id}`} className="underline">{origin.code}</Link>}
        {' · '}{origin.state==='void'?'Revenue cancelled':origin.deleted?'Project deleted':origin.version!==origin.source_version?'Revenue changed after invoice creation':'Revenue invoice'}
        {' · '}Project receipts are separate.
      </p>}
      {managed&&<p className="mt-2 text-metadata text-ink-muted">{mayOpen?<>Project <Link href={href!} className="underline">{managed.code}</Link></>:'Managed by Project'} · Payments linked</p>}
    </Fragment>,
  }
}

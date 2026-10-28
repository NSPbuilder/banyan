import { notFound, redirect } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { projectCompany, ProjectError } from '@/lib/project'
import { projectInvoiceReview } from '@/lib/project-invoices'
import { invoiceTemplateChoices } from '@/lib/invoice-templates'
import { PageHeader } from '@/components/PageHeader'
import { REFUSAL } from '@/lib/ui'
import { ProjectInvoiceForm } from '../../../ProjectInvoiceForm'
import { generateProjectInvoiceAction } from '../../../actions'

export const dynamic = 'force-dynamic'
export default async function ProjectInvoicePage({ params }: {
  params: Promise<{ ledgerId: string; projectId: string; recordId: string }>
}) {
  const { ledgerId, projectId, recordId } = await params
  await requireLedger(ledgerId, '/projects')
  await requireLedger(ledgerId, '/invoices')
  const company = await projectCompany(ledgerId)
  const review = await projectInvoiceReview(company.id, projectId, recordId).catch(error => {
    if (error instanceof ProjectError) notFound()
    throw error
  })
  if (review.link) redirect(`/ledger/${review.link.ledger_id}/invoices/${review.link.invoice_id}`)
  const { templates } = await invoiceTemplateChoices(company.id)
  const archived = company.archived_at || review.head.status === 'archived'
  return <main className="min-w-0 space-y-4 p-6">
    <PageHeader title="Generate invoice" context={`${review.head.code} · ${review.head.name}`}
      backTo={`/ledger/${ledgerId}/projects/${projectId}`} backLabel="Back to project"/>
    {archived ? <p role="status" className={REFUSAL}>Restore this company or project before generating an invoice.</p>
      : <ProjectInvoiceForm ledgerId={ledgerId} review={review} templates={templates} action={generateProjectInvoiceAction}/>}
  </main>
}

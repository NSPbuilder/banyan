import { guardRoute } from '@/lib/gate'
import { allInvoiceTemplates } from '@/lib/invoice-templates'
import { invoiceTemplateSample } from '@/lib/invoice-template-sample'
import { companyBlock } from '@/lib/customer-docs'
import { localToday } from '@/lib/today'
import { invoicePaperPdf, pdfResponse } from '@/lib/pdf-reports'

export const dynamic = 'force-dynamic'
export async function GET(_req: Request, { params }: { params: Promise<{ templateId: string }> }) {
  const me = await guardRoute()
  if (me instanceof Response) return me
  if (me.kind !== 'superadmin') return new Response('Only the superadmin can preview global templates.', { status: 403 })
  const { templateId } = await params, template = (await allInvoiceTemplates(me)).find(t => t.id === templateId)
  if (!template) return new Response('Template not found.', { status: 404 })
  const today = localToday(), doc = invoiceTemplateSample(template.owner_name, today, { templateId, name: template.name, version: template.current_version, settings: template.settings })
  doc.company = await companyBlock(template.entity_id, today)
  return pdfResponse(await invoicePaperPdf(doc))
}

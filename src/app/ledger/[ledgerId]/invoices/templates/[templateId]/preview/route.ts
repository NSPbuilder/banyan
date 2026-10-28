import { guardRoute } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { invoiceTemplateChoices } from '@/lib/invoice-templates'
import { invoiceTemplateSample } from '@/lib/invoice-template-sample'
import { companyBlock } from '@/lib/customer-docs'
import { localToday } from '@/lib/today'
import { invoicePaperPdf, pdfResponse } from '@/lib/pdf-reports'

export const dynamic = 'force-dynamic'
export async function GET(_req: Request, { params }: { params: Promise<{ ledgerId: string; templateId: string }> }) {
  const me = await guardRoute()
  if (me instanceof Response) return me
  const { ledgerId, templateId } = await params, head = await ledgerHead(ledgerId)
  if (!head) return new Response('Company not found.', { status: 404 })
  const template = (await invoiceTemplateChoices(head.entity_id)).templates.find(t => t.id === templateId)
  if (!template) return new Response('Template not found.', { status: 404 })
  const today = localToday(), doc = invoiceTemplateSample(head.entity, today, { templateId, name: template.name, version: template.current_version, settings: template.settings })
  doc.company = await companyBlock(head.entity_id, today)
  return pdfResponse(await invoicePaperPdf(doc))
}

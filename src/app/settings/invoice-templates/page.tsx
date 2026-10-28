import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/gate'
import { ApplicationFrame } from '@/components/ApplicationFrame'
import { GlobalNavigation } from '@/components/GlobalNavigation'
import { allInvoiceTemplates, templateCompanies, templateAccess } from '@/lib/invoice-templates'
import { localToday } from '@/lib/today'
import { createTemplateAction, reviseTemplateAction, templateAccessAction } from '../invoice-template-actions'
import { InvoiceTemplatesScreen } from './InvoiceTemplatesScreen'

export const dynamic = 'force-dynamic'
export default async function Page() {
  const me = await requireUser()
  if (me.kind !== 'superadmin') notFound()
  const [templates, companies] = await Promise.all([allInvoiceTemplates(me), templateCompanies(me)])
  const rows = await Promise.all(templates.map(async t => ({ ...t, access: await templateAccess(me, t.id) })))
  return <ApplicationFrame navigation={<GlobalNavigation owner={me.is_owner} />} context={{ name: 'Workspace' }}>
    <main className="w-full px-8 py-6 font-sans"><InvoiceTemplatesScreen rows={rows} companies={companies} today={localToday()} actions={{ create: createTemplateAction, revise: reviseTemplateAction, access: templateAccessAction }} /></main>
  </ApplicationFrame>
}

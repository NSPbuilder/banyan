import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { refuseForLedger } from '@/lib/access'
import { CrmError, crmWorkspace, financeInvoiceChoices } from '@/lib/crm'
import { CrmScreen } from './CrmScreen'
import {
  completeTaskAction, convertLeadAction, createCrmAccountAction, createActivityAction,
  createContactAction, createLeadAction, createOpportunityAction, createTaskAction,
  linkHandoffInvoiceAction, moveOpportunityAction, reviewHandoffAction,
} from './actions'

export const dynamic = 'force-dynamic'

const TABS = new Set(['overview', 'leads', 'accounts', 'pipeline', 'tasks', 'activity', 'finance'])

export default async function CrmPage({
  params, searchParams,
}: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ tab?: string; copy?: string }>
}) {
  const { ledgerId } = await params
  const me = await requireLedger(ledgerId, '/crm')
  let data
  try {
    data = await crmWorkspace(ledgerId)
  } catch (error) {
    if (error instanceof CrmError && error.code === 'NO_COMPANY') notFound()
    throw error
  }
  const { tab: asked = 'overview', copy } = await searchParams
  const tab = TABS.has(asked) ? asked : 'overview'
  const mayReviewFinance = (await refuseForLedger(me, ledgerId, '/invoices')) === null
  const invoiceChoices = mayReviewFinance ? await financeInvoiceChoices(ledgerId) : []

  return <CrmScreen ledgerId={ledgerId} tab={tab} data={data} copyRef={copy}
    mayReviewFinance={mayReviewFinance} invoiceChoices={invoiceChoices}
    actions={{
      lead: createLeadAction, account: createCrmAccountAction, convert: convertLeadAction,
      contact: createContactAction, opportunity: createOpportunityAction,
      move: moveOpportunityAction, activity: createActivityAction, task: createTaskAction,
      completeTask: completeTaskAction, reviewHandoff: reviewHandoffAction,
      linkHandoffInvoice: linkHandoffInvoiceAction,
    }} />
}

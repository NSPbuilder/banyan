import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { invoiceTemplateChoices } from '@/lib/invoice-templates'
import { partyChoices } from '@/lib/parties'
import { localToday } from '@/lib/today'
import { templateAssignmentAction, reviseTemplateAction } from '@/app/settings/invoice-template-actions'
import { CompanyTemplatesScreen } from './CompanyTemplatesScreen'

export async function CompanyTemplatesBody({ ledgerId }: { ledgerId: string }) {
  const me = await requireLedger(ledgerId, '/invoices')
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()
  const today = localToday(), [data, parties] = await Promise.all([invoiceTemplateChoices(head.entity_id), partyChoices(head.entity_id, today)])
  return <CompanyTemplatesScreen ledgerId={ledgerId} company={head.entity} today={today} data={data} customers={parties.customers} superadmin={me.kind === 'superadmin'} assign={templateAssignmentAction} revise={reviseTemplateAction} />
}

'use client'

import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { Floating } from '@/components/Floating'
import { InvoiceTemplateEditor } from '@/components/InvoiceTemplateEditor'
import { PageHeader } from '@/components/PageHeader'
import { Picker } from '@/components/Picker'
import { ToolAction } from '@/components/ToolAction'
import { DataTable, TableViewport } from '@/components/Table'
import { BUTTON, FIELD, GHOST, LABEL, QUIET, QUIET_COMPACT, TOOL_BUTTON } from '@/lib/ui'
import type { Choice } from '@/lib/forms'
import type { AvailableInvoiceTemplate, InvoiceTemplateAssignment } from '@/lib/invoice-template-types'

type Data = { templates: AvailableInvoiceTemplate[]; assignments: InvoiceTemplateAssignment[] }
export function CompanyTemplatesScreen({ ledgerId, company, today, data, customers, superadmin, assign, revise }: {
  ledgerId: string; company: string; today: string; data: Data; customers: Choice[]; superadmin: boolean; assign: FormAction; revise: FormAction
}) {
  const current = data.assignments.find(a => a.party_id === null), customerRules = data.assignments.filter(a => a.party_id !== null)
  return <>
    <PageHeader title="Invoice templates" context={company} backTo={`/ledger/${ledgerId}/invoices`} backLabel="Back to Invoices">
      {superadmin && <Link href="/settings/invoice-templates" className={GHOST}>Manage templates</Link>}
      <Floating label="Add customer rule" title="Customer invoice template" buttonClassName={BUTTON}><AssignmentForm ledgerId={ledgerId} templates={data.templates} customers={customers} action={assign} /></Floating>
    </PageHeader>
    <section className="mt-4"><h2 className="text-section-title font-semibold">Company default</h2>
      <AssignmentForm key={current?.template_id ?? 'system'} ledgerId={ledgerId} templates={data.templates} action={assign} companyDefault selected={current?.template_id} />
    </section>
    <section className="mt-6 border-t border-line-subtle pt-4"><h2 className="mb-3 text-section-title font-semibold">Available templates</h2>
      <TableViewport label="Available invoice templates"><DataTable className="ui-table-spaced min-w-lg"><thead><tr><th className="text-left">Template</th><th className="w-28 text-left">Layout</th><th className="w-20 text-left">Version</th><th className="w-32 text-left">Access</th><th className="relative w-32 text-right"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{data.templates.map(t => <tr key={t.id}><td><span className="inline-flex min-h-control items-center font-medium">{t.name}</span></td><td><span className="inline-flex min-h-control items-center">{t.settings.layout === 'compact' ? 'Compact' : 'Standard'}</span></td><td><span className="inline-flex min-h-control items-center tabular-nums">v{t.current_version}</span></td><td><span className="inline-flex min-h-control items-center text-ink-secondary">{t.can_edit ? 'Use and edit' : 'Use only'}</span></td><td><div className="flex items-center justify-end gap-2"><a href={`/ledger/${ledgerId}/invoices/templates/${t.id}/preview`} target="_blank" rel="noopener noreferrer" title={`Preview ${t.name} PDF`} className={TOOL_BUTTON}><ToolAction kind="pdf">Preview {t.name} PDF</ToolAction></a>
          {t.can_edit && <Floating label="Edit" title={`Edit ${t.name}`} buttonClassName={QUIET_COMPACT} wide><InvoiceTemplateEditor key={t.current_version} template={t} today={today} ledgerId={ledgerId} action={revise} previewHref={`/ledger/${ledgerId}/invoices/templates/${t.id}/preview`} /></Floating>}
        </div></td></tr>)}</tbody>
      </DataTable></TableViewport>
      {!data.templates.length && <p role="status" className="py-4 text-label text-ink-muted">System standard is available. Ask the superadmin to grant a custom template.</p>}
    </section>
    <section className="mt-6 border-t border-line-subtle pt-4"><h2 className="mb-3 text-section-title font-semibold">Customer templates</h2>
      <TableViewport label="Customer invoice templates"><DataTable className="ui-table-spaced min-w-lg"><thead><tr><th className="text-left">Customer</th><th className="text-left">Template</th><th className="relative w-32 text-right"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{customerRules.map(a => <tr key={a.party_id}><td><span className="inline-flex min-h-control items-center">{a.party_name}</span></td><td><span className="inline-flex min-h-control items-center">{a.template_name}</span></td><td className="text-right"><Floating label="Edit" title="Customer invoice template" buttonClassName={QUIET_COMPACT}><AssignmentForm key={a.template_id} ledgerId={ledgerId} templates={data.templates} customers={customers} partyId={a.party_id!} partyName={a.party_name ?? undefined} selected={a.template_id} action={assign} /></Floating></td></tr>)}</tbody>
      </DataTable></TableViewport>
      {!customerRules.length && <p className="py-4 text-label text-ink-muted">All customers use the company default.</p>}
    </section>
  </>
}
function AssignmentForm({ ledgerId, templates, customers, partyId, partyName, selected, action, companyDefault = false }: {
  ledgerId: string; templates: AvailableInvoiceTemplate[]; customers?: Choice[]; partyId?: string; partyName?: string; selected?: string; action: FormAction; companyDefault?: boolean
}) {
  return <ActionForm action={action} submit={companyDefault ? 'Save default' : 'Save rule'} working="Saving…" buttonClassName={QUIET} className={companyDefault ? 'mt-3 max-w-sm' : ''}>
    <input type="hidden" name="ledgerId" value={ledgerId} />
    {!companyDefault && <div className={`${LABEL} mb-3`}><span>Customer</span><>{partyId ? <><p className="mt-1 text-body font-normal text-ink">{partyName ?? customers?.find(c => c.id === partyId)?.label ?? 'Customer'}</p><input type="hidden" name="partyId" value={partyId} /></> : <Picker name="partyId" ariaLabel="Customer" required options={customers ?? []} className="mt-1" />}</>
    </div>}
    <label className={LABEL}><span>Template</span><select name="templateId" aria-label="Template" defaultValue={selected ?? ''} className={`mt-1 w-full ${FIELD}`}>
      <option value="">{companyDefault ? 'System standard' : 'Use company default'}</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select></label>
  </ActionForm>
}

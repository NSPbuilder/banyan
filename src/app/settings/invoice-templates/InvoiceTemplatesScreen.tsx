'use client'

import { useState } from 'react'
import { useActionForm, FormError, type FormAction } from '@/components/ActionForm'
import { PageHeader } from '@/components/PageHeader'
import { FilterBar } from '@/components/FormLayout'
import { Floating } from '@/components/Floating'
import { DataTable, TableViewport } from '@/components/Table'
import { InvoiceTemplateEditor } from '@/components/InvoiceTemplateEditor'
import { Picker } from '@/components/Picker'
import { BUTTON, FIELD, GHOST, QUIET_COMPACT, LABEL, TABLE_ACTION } from '@/lib/ui'
import { formatNumber } from '@/lib/numbers'
import type { InvoiceTemplate, TemplateCompanyAccess } from '@/lib/invoice-template-types'

type Row = InvoiceTemplate & { access: TemplateCompanyAccess[] }
type Actions = { create: FormAction; revise: FormAction; access: FormAction }
export function InvoiceTemplatesScreen({ rows, companies, today, actions }: { rows: Row[]; companies: { id: string; name: string }[]; today: string; actions: Actions }) {
  const [q, setQ] = useState(''), [company, setCompany] = useState('')
  const visible = rows.filter(t => (!company || t.entity_id === company) && (!q.trim() || [t.name, t.owner_name].some(v => v.toLowerCase().includes(q.trim().toLowerCase()))))
  return <>
    <PageHeader title="Invoice templates" backTo="/settings" backLabel="Back to Settings">
      <Floating label="New template" title="New invoice template" buttonClassName={BUTTON} wide><InvoiceTemplateEditor companies={companies} today={today} action={actions.create} /></Floating>
    </PageHeader>
    <FilterBar><label className="min-w-48 flex-1"><span className="sr-only">Search templates</span><input aria-label="Search templates" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search templates or companies" className={`w-full ${FIELD}`} /></label>
      <select aria-label="Owned by company" value={company} onChange={e => setCompany(e.target.value)} className={`${FIELD} max-w-full`}><option value="">All companies</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
    </FilterBar>
    <TableViewport label="Invoice templates"><DataTable className="ui-table-spaced min-w-2xl table-fixed">
      <thead><tr><th className="text-left">Template</th><th className="text-left">Owned by</th><th className="w-28 text-left">Layout</th><th className="w-20 text-left">Version</th><th className="w-24 text-right">Companies</th><th className="w-28 text-left">Status</th></tr></thead>
      <tbody>{visible.map(t => <tr key={t.id}><td><Floating label={t.name} title={t.name} ariaLabel={`Manage ${t.name}`} buttonClassName={`${TABLE_ACTION} max-w-full break-words`} wide>
        <InvoiceTemplateEditor key={t.current_version} admin template={t} today={today} action={actions.revise} previewHref={`/settings/invoice-templates/${t.id}/preview`} />
        <CompanyAccess template={t} companies={companies} action={actions.access} />
      </Floating></td><td className="text-ink-secondary"><span className="inline-flex min-h-control items-center">{t.owner_name}</span></td><td><span className="inline-flex min-h-control items-center">{t.settings.layout === 'compact' ? 'Compact' : 'Standard'}</span></td><td><span className="inline-flex min-h-control items-center tabular-nums">v{formatNumber(t.current_version)}</span></td><td data-numeric><span className="inline-flex min-h-control items-center">{formatNumber(t.access.filter(a => a.can_use).length)}</span></td><td><span className="inline-flex min-h-control items-center text-ink-secondary">{t.is_active ? 'Available' : 'Inactive'}</span></td></tr>)}</tbody>
    </DataTable></TableViewport>
    {!visible.length && <p role="status" className="py-8 text-center text-body text-ink-muted">{rows.length ? 'No templates match these filters.' : 'No custom templates yet. Create a template to assign company access.'}</p>}
  </>
}

function CompanyAccess({ template, companies, action }: { template: Row; companies: { id: string; name: string }[]; action: FormAction }) {
  const add = useActionForm(action), available = companies.filter(c => !template.access.some(a => a.entity_id === c.id))
  return <section className="mt-6 border-t border-line-subtle pt-4">
    <h2 className="mb-3 text-section-title font-semibold">Company access</h2>
    <TableViewport label="Template company access"><DataTable className="ui-table-spaced min-w-lg">
      <thead><tr><th className="text-left">Company</th><th className="w-24 text-left">Can use</th><th className="w-24 text-left">Can edit</th><th className="relative w-40 text-right"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{template.access.map(a => <AccessRow key={`${a.entity_id}:${a.can_use}:${a.can_edit}`} templateId={template.id} access={a} action={action} />)}</tbody>
    </DataTable></TableViewport>
    {!template.access.length && <p className="py-3 text-metadata text-ink-muted">No companies have access.</p>}
    {available.length > 0 && <form {...add.formProps} className="mt-3 flex flex-wrap items-end gap-3" aria-label="Add company access">
      <input type="hidden" name="templateId" value={template.id} />
      <div className={`${LABEL} min-w-48 flex-1`}><span>Company</span><Picker name="entityId" required ariaLabel="Company" className="mt-1" options={available.map(c => ({ id: c.id, label: c.name }))} /></div>
      <input type="hidden" name="canUse" value="on" /><label className="flex min-h-control items-center gap-2 text-label"><input name="canEdit" type="checkbox" />Can edit</label>
      <button type="submit" disabled={add.pending} className={QUIET_COMPACT}>{add.pending ? 'Adding…' : 'Add company'}</button>
      <div className="w-full"><FormError state={add.state} />{add.state.ok && <p role="status" className="text-metadata text-ink-secondary">{add.state.ok}</p>}</div>
    </form>}
  </section>
}
function AccessRow({ templateId, access, action }: { templateId: string; access: TemplateCompanyAccess; action: FormAction }) {
  const bind = useActionForm(action), [canUse, setCanUse] = useState(access.can_use), [canEdit, setCanEdit] = useState(access.can_edit)
  const formId = `template-access-${templateId}-${access.entity_id}`
  return <tr><td><span className="inline-flex min-h-control items-center">{access.name}</span><FormError state={bind.state} />{bind.state.ok && <p role="status" className="text-metadata text-ink-muted">{bind.state.ok}</p>}</td>
    <td><label className="inline-flex min-h-control items-center"><input type="checkbox" aria-label={`Can use for ${access.name}`} name="canUse" form={formId} checked={canUse} onChange={e => { setCanUse(e.target.checked); if (!e.target.checked) setCanEdit(false) }} /></label></td>
    <td><label className="inline-flex min-h-control items-center"><input type="checkbox" aria-label={`Can edit for ${access.name}`} name="canEdit" form={formId} disabled={!canUse} checked={canEdit} onChange={e => setCanEdit(e.target.checked)} /></label></td>
    <td><form {...bind.formProps} id={formId} className="flex items-center justify-end gap-2" aria-label={`Access for ${access.name}`}><input type="hidden" name="templateId" value={templateId} /><input type="hidden" name="entityId" value={access.entity_id} />
      <button type="submit" disabled={bind.pending} className={QUIET_COMPACT}>Save</button><button type="submit" name="operation" value="revoke" disabled={bind.pending} className={GHOST}>Revoke</button>
    </form></td></tr>
}

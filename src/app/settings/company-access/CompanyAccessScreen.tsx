'use client'

import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '@/components/PageHeader'
import { Picker } from '@/components/Picker'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { DataTable, TableViewport } from '@/components/Table'
import { BUTTON, GHOST, LABEL } from '@/lib/ui'
import { GRANTABLE_MODULES, LEDGER_NAV, MODULE_PATHS } from '@/lib/nav'

type Company = { id: string; code: string; name: string; archived: boolean }
export function CompanyAccessScreen({ companies, policies, action }: {
  companies: Company[]; policies: Record<string, string[]>; action: FormAction
}) {
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '')
  const company = companies.find(c => c.id === companyId), enabled = policies[companyId] ?? MODULE_PATHS
  return <>
    <PageHeader title="Company access" backTo="/settings" backLabel="Back to Settings"><Link href="/settings/invoice-templates" className={GHOST}>Invoice templates</Link><Link href="/users" className={GHOST}>User access</Link></PageHeader>
    {companies.length ? <>
      <div className="mt-4 max-w-md"><div className={LABEL}><span>Company</span><Picker ariaLabel="Company" value={companyId} onChange={setCompanyId} options={companies.map(c => ({ id: c.id, label: `${c.code} · ${c.name}${c.archived ? ' (archived)' : ''}` }))} className="mt-1" /></div></div>
      <p className="mt-3 text-metadata text-ink-muted">Users can access only modules enabled here and allowed by their user permissions.</p>
      {company && <ModuleForm key={`${companyId}:${enabled.join('|')}`} company={company} enabled={enabled} action={action} />}
    </> : <p role="status" className="mt-4 text-body text-ink-muted">Add a company before assigning modules.</p>}
  </>
}
function ModuleForm({ company, enabled, action }: { company: Company; enabled: string[]; action: FormAction }) {
  const [selected, setSelected] = useState(new Set(enabled))
  return <ActionForm action={action} submit="Save access" working="Saving…" buttonClassName={BUTTON} stickyActions className="mt-4 max-w-3xl">
    <input type="hidden" name="entityId" value={company.id} /><input type="hidden" name="expectedModules" value={JSON.stringify(enabled)} />
    <div className="mb-2 flex items-center justify-between gap-3"><h2 className="text-section-title font-semibold">Modules <span className="ml-2 text-metadata font-normal tabular-nums text-ink-muted">{selected.size} of {GRANTABLE_MODULES.length}</span></h2><div className="flex gap-2"><button type="button" className={GHOST} onClick={() => setSelected(new Set(MODULE_PATHS))}>All</button><button type="button" className={GHOST} onClick={() => setSelected(new Set())}>None</button></div></div>
    <TableViewport label="Company modules"><DataTable className="ui-table-spaced min-w-sm"><thead><tr><th className="text-left">Module</th><th className="w-28 text-left">Group</th><th className="w-24 text-center">Enabled</th></tr></thead>
      <tbody>{GRANTABLE_MODULES.map(m => <tr key={m.path}><td><label htmlFor={`company-module-${m.path || 'overview'}`} className="inline-flex min-h-control items-center">{m.label}</label></td><td className="text-ink-muted">{LEDGER_NAV.find(n => n.path === m.path)?.group === 'daily' ? 'Daily work' : LEDGER_NAV.find(n => n.path === m.path)?.group === 'books' ? 'Books' : 'Manage'}</td><td className="text-center"><input id={`company-module-${m.path || 'overview'}`} aria-label={`Enable ${m.label}`} type="checkbox" name="module" value={m.path} checked={selected.has(m.path)} onChange={e => setSelected(old => { const next = new Set(old); if (e.target.checked) next.add(m.path); else next.delete(m.path); return next })} /></td></tr>)}</tbody>
    </DataTable></TableViewport>
  </ActionForm>
}

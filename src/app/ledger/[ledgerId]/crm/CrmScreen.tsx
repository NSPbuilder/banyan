
import { TimestampText } from '@/components/AccountingData'

import { DataTable } from '@/components/Table'

import { formatNumber } from '@/lib/numbers'
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import type { CrmWorkspace } from '@/lib/crm'
import { formatMoney, moneyInput } from '@/lib/money'
import { PageHeader } from '@/components/PageHeader'
import { ModuleTabs } from '@/components/ModuleTabs'
import { BUTTON, SECTION, FIELD, LABEL, PAGE_HEADER, QUIET } from '@/lib/ui'

export type CrmActions = {
  lead: FormAction; account: FormAction; convert: FormAction; contact: FormAction
  opportunity: FormAction; move: FormAction; activity: FormAction
  task: FormAction; completeTask: FormAction; reviewHandoff: FormAction
  linkHandoffInvoice: FormAction
}

const TABS = [
  ['overview', 'Overview'], ['leads', 'Leads'], ['accounts', 'Accounts'],
  ['pipeline', 'Pipeline'], ['tasks', 'Tasks'], ['activity', 'Activities'],
  ['finance', 'Finance handoff'],
] as const

const input = `mt-1 h-[34px] w-full ${FIELD}`
const area = `mt-1 w-full ${FIELD}`
const money = (value: string | null) => value === null ? '—' : formatMoney(BigInt(value))
const day = (value: string | null) => value ? value.slice(0, 10) : '—'
const copyHref = (base: string, tab: string, kind: string, id: string) =>
  `${base}?tab=${tab}&copy=${encodeURIComponent(`${kind}|${id}`)}#copy-form-${kind}`

function Hidden({ ledgerId }: { ledgerId: string }) {
  return <input type="hidden" name="ledgerId" value={ledgerId} />
}

function PersonSelect({ users, name = 'ownerUserId', initial }: {
  users: CrmWorkspace['users']; name?: string; initial?: string | null
}) {
  return (
    <select name={name} className={input} defaultValue={initial ?? ''}>
      <option value="">Unassigned</option>
      {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
    </select>
  )
}

function TargetSelect({ data, initial }: { data: CrmWorkspace; initial?: string | null }) {
  return (
    <>
      <label className={LABEL}>Record</label>
      <div className="mt-1">
        <Picker name="targetRef" required defaultValue={initial ?? ''} ariaLabel="Record"
          options={[
            ...data.accounts.map((a) => ({ id: `account|${a.id}`, label: a.name, group: 'Accounts' })),
            ...data.leads.filter((l) => !['converted', 'disqualified'].includes(l.status) || initial === `lead|${l.id}`).map((l) => ({
              id: `lead|${l.id}`, label: l.organisation_name ?? l.person_name ?? 'Unnamed lead', group: 'Leads',
            })),
            ...data.opportunities.map((o) => ({ id: `opportunity|${o.id}`, label: o.name, group: 'Opportunities' })),
          ]} />
      </div>
    </>
  )
}

export function CrmScreen({
  ledgerId, tab, data, actions, mayReviewFinance, invoiceChoices, copyRef,
}: {
  ledgerId: string; tab: string; data: CrmWorkspace; actions: CrmActions
  mayReviewFinance: boolean; invoiceChoices: Array<{ id: string; label: string }>
  copyRef?: string
}) {
  const base = `/ledger/${ledgerId}/crm`
  return (
    <main className="mx-auto w-full max-w-none px-8 py-8 font-sans">
      <PageHeader title="CRM">
        <a href={`${base}/export?what=accounts`} className={TOOL_BUTTON} title="Accounts CSV"><ToolAction kind="csv">Accounts CSV</ToolAction></a>
        <a href={`${base}/export?what=opportunities`} className={TOOL_BUTTON} title="Pipeline CSV"><ToolAction kind="csv">Pipeline CSV</ToolAction></a>
      </PageHeader>

      {data.entity.archived && (
        <p role="status" className="mt-5 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {data.entity.name} is archived. CRM history remains available, but it is read-only.
        </p>
      )}

      <ModuleTabs label="CRM sections" className="mt-4" items={TABS.map(([path, label]) => ({
        href: `${base}?tab=${path}`, label, selected: tab === path,
      }))} />

      {tab === 'overview' && <Overview data={data} base={base} />}
      {tab === 'leads' && <Leads ledgerId={ledgerId} data={data} actions={actions} readOnly={data.entity.archived} copyRef={copyRef} />}
      {tab === 'accounts' && <Accounts ledgerId={ledgerId} data={data} actions={actions} readOnly={data.entity.archived} copyRef={copyRef} />}
      {tab === 'pipeline' && <Pipeline ledgerId={ledgerId} data={data} actions={actions} readOnly={data.entity.archived} copyRef={copyRef} />}
      {tab === 'tasks' && <Tasks ledgerId={ledgerId} data={data} actions={actions} readOnly={data.entity.archived} copyRef={copyRef} />}
      {tab === 'activity' && <Activities ledgerId={ledgerId} data={data} actions={actions} readOnly={data.entity.archived} copyRef={copyRef} />}
      {tab === 'finance' && <Finance ledgerId={ledgerId} data={data} actions={actions}
        mayReview={mayReviewFinance} invoiceChoices={invoiceChoices} readOnly={data.entity.archived} />}
    </main>
  )
}

function Overview({ data, base }: { data: CrmWorkspace; base: string }) {
  const openStages = data.stages.filter((stage) => stage.kind === 'open')
  return (
    <>
      <section className="mt-4 grid grid-cols-4 gap-3 border-b border-line-subtle pb-4 max-[1000px]:grid-cols-2">
        {[
          ['Open pipeline', formatMoney(BigInt(data.stats.pipeline))],
          ['Weighted', formatMoney(BigInt(data.stats.weighted))],
          ['Open opportunities', formatNumber(data.stats.open_opportunities)],
          ['Overdue tasks', formatNumber(data.stats.overdue_tasks)],
        ].map(([label, value]) => (
          <div key={label} className={SECTION}>
            <p className="text-metadata text-ink-muted">{label}</p>
            <p className="mt-1 text-page-title font-semibold tabular-nums">{value}</p>
          </div>
        ))}
      </section>
      <div className="mt-4 grid items-start grid-cols-[minmax(0,2fr)_minmax(17rem,0.8fr)] gap-4 max-[1100px]:grid-cols-1">
        <section className={SECTION}>
          <div className={PAGE_HEADER}><h2 className="text-section-title font-semibold">Pipeline</h2><Link href={`${base}?tab=pipeline`} className="text-xs text-clay-700 hover:underline">All opportunities →</Link></div>
          <div className="mt-4 overflow-x-auto pb-1">
            <div className="grid min-w-[42rem] grid-cols-4 gap-2">
              {openStages.map((stage) => (
                <div key={stage.id} className="min-w-40 rounded-md bg-neutral-50 p-2 dark:bg-neutral-950">
                <p className="flex justify-between text-xs font-semibold"><span>{stage.name}</span><span>{formatNumber(data.opportunities.filter((o) => o.stage_id === stage.id).length)}</span></p>
                {data.opportunities.filter((o) => o.stage_id === stage.id).slice(0, 3).map((o) => (
                  <div key={o.id} className="mt-2 rounded border border-neutral-200 bg-white p-2 text-xs dark:border-neutral-800 dark:bg-neutral-900">
                    <strong className="block truncate">{o.name}</strong><span className="text-neutral-500">{o.account_name}</span>
                    <span className="mt-1 block tabular-nums text-clay-700">{money(o.expected_amount)} · {day(o.expected_close_on)}</span>
                  </div>
                ))}
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className={SECTION}>
          <div className={PAGE_HEADER}><h2 className="text-section-title font-semibold">Next tasks</h2><Link href={`${base}?tab=tasks`} className="text-xs text-clay-700 hover:underline">All tasks →</Link></div>
          <div className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
            {data.tasks.filter((task) => task.status === 'open').slice(0, 6).map((task) => (
              <div key={task.id} className="grid grid-cols-[1fr_auto] gap-3 py-2 text-sm">
                <span>{task.title}<small className="block text-neutral-500">{task.subject}</small></span>
                <span className="text-xs text-neutral-500">{day(task.due_at)}</span>
              </div>
            ))}
            {!data.tasks.some((task) => task.status === 'open') && <p className="py-4 text-sm text-neutral-500">Nothing waiting.</p>}
          </div>
        </section>
      </div>
    </>
  )
}

function Leads({ ledgerId, data, actions, readOnly, copyRef }: {
  ledgerId: string; data: CrmWorkspace; actions: CrmActions; readOnly: boolean; copyRef?: string
}) {
  const initial = data.leads.find((lead) => copyRef === `lead|${lead.id}`)
  const base = `/ledger/${ledgerId}/crm`
  return (
    <div className="mt-5 grid items-start grid-cols-[minmax(0,1.8fr)_minmax(18rem,0.8fr)] gap-5 max-[1100px]:grid-cols-1">
      <section className={SECTION}>
        <div className={PAGE_HEADER}><h2 className="text-section-title font-semibold">Leads</h2><a href={`/ledger/${ledgerId}/crm/export?what=leads`} className={TOOL_BUTTON} title="Export CSV"><ToolAction kind="csv">CSV</ToolAction></a></div>
        <div className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
          {data.leads.map((lead) => (
            <div key={lead.id} className="grid grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_8rem_auto] items-center gap-3 py-3 text-sm max-[900px]:grid-cols-1 max-[900px]:gap-1">
              <span><strong className="block">{lead.organisation_name ?? lead.person_name}</strong><small className="text-neutral-500">{lead.person_name ?? lead.source ?? ''}</small></span>
              <span className="truncate text-neutral-500">{lead.email ?? lead.phone ?? 'No contact details'}</span>
              <span className="capitalize">{lead.status}</span>
              <span className="flex items-center gap-2">{!readOnly && <Link href={copyHref(base, 'leads', 'lead', lead.id)} className={QUIET}>Copy</Link>}
              {!readOnly && !['converted', 'disqualified'].includes(lead.status) ? (
                <ActionForm action={actions.convert} submit="Convert" working="…" buttonClassName={QUIET}>
                  <Hidden ledgerId={ledgerId} /><input type="hidden" name="leadId" value={lead.id} />
                  <input type="hidden" name="version" value={lead.version} />
                </ActionForm>
              ) : null}</span>
            </div>
          ))}
          {data.leads.length === 0 && <p className="py-5 text-sm text-neutral-500">No leads yet.</p>}
        </div>
      </section>
      {!readOnly && <section id="copy-form-lead" className={SECTION}>
        <h2 className="text-section-title font-semibold">{initial ? 'Copy lead' : 'New lead'}</h2>
        <ActionForm key={initial?.id ?? 'new'} action={actions.lead} submit="Add lead" working="Adding…" className="mt-4 space-y-3" buttonClassName={BUTTON}>
          <Hidden ledgerId={ledgerId} />
          <label className={LABEL}>Organisation<input name="organisationName" defaultValue={initial?.organisation_name ?? ''} className={input} /></label>
          <label className={LABEL}>Person<input name="personName" defaultValue={initial?.person_name ?? ''} className={input} /></label>
          <label className={LABEL}>Email<input name="email" type="email" defaultValue={initial?.email ?? ''} className={input} /></label>
          <label className={LABEL}>Phone<input name="phone" defaultValue={initial?.phone ?? ''} className={input} /></label>
          <label className={LABEL}>Source<input name="source" defaultValue={initial?.source ?? ''} className={input} /></label>
          <label className={LABEL}>Owner<PersonSelect users={data.users} initial={initial?.owner_user_id} /></label>
        </ActionForm>
      </section>}
    </div>
  )
}

function Accounts({ ledgerId, data, actions, readOnly, copyRef }: {
  ledgerId: string; data: CrmWorkspace; actions: CrmActions; readOnly: boolean; copyRef?: string
}) {
  const accountInitial = data.accounts.find((account) => copyRef === `account|${account.id}`)
  const contactInitial = data.contacts.find((contact) => copyRef === `contact|${contact.id}`)
  const base = `/ledger/${ledgerId}/crm`
  return (
    <>
      <div className="mt-5 grid items-start grid-cols-[minmax(0,1.8fr)_minmax(18rem,0.8fr)] gap-5 max-[1100px]:grid-cols-1">
        <section className={SECTION}>
          <h2 className="text-section-title font-semibold">Accounts</h2>
          <DataTable density="reading" className="mt-3 w-full text-sm"><thead><tr className="border-b border-neutral-300 text-left text-metadata text-ink-muted dark:border-neutral-700">
            <th className="py-2">Account</th><th>Lifecycle</th><th>Segment</th><th className="text-right">Opportunities</th><th>Last touch</th>
          </tr></thead><tbody>{data.accounts.map((account) => (
            <tr key={account.id} className="border-b border-neutral-200 dark:border-neutral-800">
              <td className="py-2 pr-3"><strong>{account.name}</strong>{account.trading_name && <small className="block text-neutral-500">{account.trading_name}</small>}{!readOnly && <Link href={copyHref(base, 'accounts', 'account', account.id)} className="text-xs text-neutral-500 underline">Copy</Link>}</td>
              <td className="capitalize">{account.lifecycle}</td><td>{account.segment ?? '—'}</td>
              <td className="text-right tabular-nums">{account.opportunity_count}</td><td>{day(account.last_touch)}</td>
            </tr>
          ))}</tbody></DataTable>
        </section>
        {!readOnly && data.partyChoices.length > 0 && <section id="copy-form-account" className={SECTION}>
          <h2 className="text-section-title font-semibold">{accountInitial ? 'Copy CRM account' : 'Add existing Party'}</h2>
          <ActionForm key={accountInitial?.id ?? 'new'} action={actions.account} submit="Add account" working="Adding…" className="mt-4 space-y-3" buttonClassName={BUTTON}>
            <Hidden ledgerId={ledgerId} />
            <label className={LABEL}>Party<Picker name="partyId" required className="mt-1" ariaLabel="Party" options={data.partyChoices.map((p) => ({ id: p.id, label: p.name }))} /></label>
            <label className={LABEL}>Owner<PersonSelect users={data.users} initial={accountInitial?.owner_user_id} /></label>
            <label className={LABEL}>Source<input name="source" defaultValue={accountInitial?.source ?? ''} className={input} /></label>
            <label className={LABEL}>Segment<input name="segment" defaultValue={accountInitial?.segment ?? ''} className={input} /></label>
          </ActionForm>
        </section>}
        {!readOnly && accountInitial && data.partyChoices.length === 0 && (
          <section id="copy-form-account" className={SECTION}>
            <h2 className="text-section-title font-semibold">Copy CRM account</h2>
            <p className="mt-3 text-sm text-neutral-500">Each CRM account needs its own Party. Add another Party before creating this copy.</p>
            <Link href={`/ledger/${ledgerId}/parties/new`} className="mt-3 inline-block text-sm underline">Add Party</Link>
          </section>
        )}
      </div>
      <div className="mt-5 grid items-start grid-cols-[minmax(0,1.8fr)_minmax(18rem,0.8fr)] gap-5 max-[1100px]:grid-cols-1">
        <section className={SECTION}><h2 className="text-section-title font-semibold">Contacts</h2>
          <div className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">{data.contacts.map((contact) => (
            <div key={contact.id} className="grid grid-cols-[1fr_1fr_1fr] gap-3 py-2 text-sm">
              <span><strong>{contact.name}</strong>{contact.is_primary && <small className="ml-2 text-clay-700">primary</small>}<small className="block text-neutral-500">{contact.account_name}</small>{!readOnly && <Link href={copyHref(base, 'accounts', 'contact', contact.id)} className="text-xs text-neutral-500 underline">Copy</Link>}</span>
              <span>{contact.job_title ?? contact.decision_role ?? '—'}</span><span>{contact.work_email ?? contact.work_phone}</span>
            </div>
          ))}</div>
        </section>
        {!readOnly && data.accounts.length > 0 && <section id="copy-form-contact" className={SECTION}><h2 className="text-section-title font-semibold">{contactInitial ? 'Copy contact' : 'New contact'}</h2>
          <ActionForm key={contactInitial?.id ?? 'new'} action={actions.contact} submit="Add contact" working="Adding…" className="mt-4 space-y-3" buttonClassName={BUTTON}>
            <Hidden ledgerId={ledgerId} />
            <label className={LABEL}>Account<Picker name="accountId" required defaultValue={contactInitial?.account_id ?? ''} className="mt-1" ariaLabel="Account" options={data.accounts.map((a) => ({ id: a.id, label: a.name }))} /></label>
            <label className={LABEL}>Name<input name="name" required defaultValue={contactInitial?.name ?? ''} className={input} /></label>
            <label className={LABEL}>Title<input name="jobTitle" defaultValue={contactInitial?.job_title ?? ''} className={input} /></label>
            <label className={LABEL}>Email<input name="email" type="email" defaultValue={contactInitial?.work_email ?? ''} className={input} /></label>
            <label className={LABEL}>Phone<input name="phone" defaultValue={contactInitial?.work_phone ?? ''} className={input} /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isPrimary" defaultChecked={contactInitial?.is_primary ?? false} /> Primary contact</label>
          </ActionForm>
        </section>}
      </div>
    </>
  )
}

function Pipeline({ ledgerId, data, actions, readOnly, copyRef }: {
  ledgerId: string; data: CrmWorkspace; actions: CrmActions; readOnly: boolean; copyRef?: string
}) {
  const initial = data.opportunities.find((opportunity) => copyRef === `opportunity|${opportunity.id}`)
  const base = `/ledger/${ledgerId}/crm`
  return (
    <>
      <div className="mt-5 grid items-start grid-cols-[minmax(0,1.8fr)_minmax(18rem,0.8fr)] gap-5 max-[1100px]:grid-cols-1">
        <section className={SECTION}><h2 className="text-section-title font-semibold">Pipeline</h2>
          <div className="mt-4 overflow-x-auto pb-2">
            <div className="grid min-w-[52rem] grid-cols-4 gap-3">
              {data.stages.filter((s) => s.kind === 'open').map((stage) => (
                <div key={stage.id} className="min-w-52 rounded-md bg-neutral-50 p-3 dark:bg-neutral-950">
                <p className="flex justify-between text-sm font-semibold"><span>{stage.name}</span><span>{formatNumber(data.opportunities.filter((o) => o.stage_id === stage.id).length)}</span></p>
                {data.opportunities.filter((o) => o.stage_id === stage.id).map((opportunity) => (
                  <div key={opportunity.id} className="mt-2 rounded border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
                    <strong className="block">{opportunity.name}</strong><small className="text-neutral-500">{opportunity.account_name}</small>
                    <p className="mt-1 tabular-nums text-clay-700">{money(opportunity.expected_amount)} · {day(opportunity.expected_close_on)}</p>
                    {!readOnly && <Link href={copyHref(base, 'pipeline', 'opportunity', opportunity.id)} className="text-xs text-neutral-500 underline">Copy</Link>}
                    {!readOnly && <ActionForm action={actions.move} submit="Move" working="…" className="mt-2 flex items-center gap-1" buttonClassName={QUIET}>
                      <Hidden ledgerId={ledgerId} /><input type="hidden" name="opportunityId" value={opportunity.id} /><input type="hidden" name="version" value={opportunity.version} />
                      <select name="stageId" className={`min-w-0 flex-1 ${FIELD}`} defaultValue={opportunity.stage_id}>{data.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                      <input name="reason" aria-label="Reason when closing or reopening" className={`min-w-0 w-24 ${FIELD}`} />
                    </ActionForm>}
                  </div>
                ))}
                </div>
              ))}
            </div>
          </div>
        </section>
        {!readOnly && data.accounts.length > 0 && <section id="copy-form-opportunity" className={SECTION}><h2 className="text-section-title font-semibold">{initial ? 'Copy opportunity' : 'New opportunity'}</h2>
          <ActionForm key={initial?.id ?? 'new'} action={actions.opportunity} submit="Add opportunity" working="Adding…" className="mt-4 space-y-3" buttonClassName={BUTTON}>
            <Hidden ledgerId={ledgerId} />
            <label className={LABEL}>Account<Picker name="accountId" required defaultValue={initial?.account_id ?? ''} className="mt-1" ariaLabel="Account" options={data.accounts.map((a) => ({ id: a.id, label: a.name }))} /></label>
            <label className={LABEL}>Name<input name="name" required defaultValue={initial?.name ?? ''} className={input} /></label>
            <div className="grid grid-cols-2 gap-2"><label className={LABEL}>Amount<input name="expectedAmount" inputMode="decimal" defaultValue={initial?.expected_amount ? moneyInput(BigInt(initial.expected_amount)) : ''} className={input} /></label><label className={LABEL}>Currency<input name="currency" defaultValue={initial?.currency ?? 'CAD'} maxLength={3} className={input} /></label></div>
            <label className={LABEL}>Expected close<DateInput name="expectedCloseOn" defaultValue={initial?.expected_close_on ?? ''} className={input} /></label>
            <label className={LABEL}>Probability %<input name="probability" type="number" min="0" max="100" defaultValue={initial?.probability_bp != null ? initial.probability_bp / 100 : ''} className={input} /></label>
            <label className={LABEL}>Owner<PersonSelect users={data.users} initial={initial?.owner_user_id} /></label>
          </ActionForm>
        </section>}
      </div>
      <section className={`mt-5 ${SECTION}`}><h2 className="text-section-title font-semibold">Closed opportunities</h2>
        <div className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">{data.opportunities.filter((o) => o.stage_kind !== 'open').map((o) => <div key={o.id} className="grid grid-cols-[1fr_1fr_8rem_8rem_auto] gap-3 py-2 text-sm max-[900px]:grid-cols-1 max-[900px]:gap-1"><strong>{o.name}</strong><span>{o.account_name}</span><span>{o.stage_name}</span><span className="text-right tabular-nums max-[900px]:text-left">{money(o.expected_amount)}</span>{!readOnly && <Link href={copyHref(base, 'pipeline', 'opportunity', o.id)} className="text-xs text-neutral-500 underline">Copy</Link>}</div>)}</div>
      </section>
    </>
  )
}

function Tasks({ ledgerId, data, actions, readOnly, copyRef }: {
  ledgerId: string; data: CrmWorkspace; actions: CrmActions; readOnly: boolean; copyRef?: string
}) {
  const initial = data.tasks.find((task) => copyRef === `task|${task.id}`)
  const base = `/ledger/${ledgerId}/crm`
  return <div className="mt-5 grid items-start grid-cols-[minmax(0,1.8fr)_minmax(18rem,0.8fr)] gap-5 max-[1100px]:grid-cols-1">
    <section className={SECTION}><h2 className="text-section-title font-semibold">Tasks</h2><div className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">{data.tasks.map((task) => <div key={task.id} className="grid grid-cols-[1fr_1fr_8rem_7rem_auto] items-center gap-3 py-2 text-sm max-[900px]:grid-cols-1 max-[900px]:items-start max-[900px]:gap-1"><span><strong>{task.title}</strong><small className="block text-neutral-500">{task.assigned_name ?? 'Unassigned'}</small></span><span>{task.subject}</span><span>{day(task.due_at)}</span><span className="capitalize">{task.status}</span><span className="flex gap-2">{!readOnly && <Link href={copyHref(base, 'tasks', 'task', task.id)} className={QUIET}>Copy</Link>}{!readOnly && task.status === 'open' ? <ActionForm action={actions.completeTask} submit="Done" working="…" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} /><input type="hidden" name="taskId" value={task.id} /><input type="hidden" name="version" value={task.version} /></ActionForm> : null}</span></div>)}</div></section>
    {!readOnly && <section id="copy-form-task" className={SECTION}><h2 className="text-section-title font-semibold">{initial ? 'Copy task' : 'New task'}</h2><ActionForm key={initial?.id ?? 'new'} action={actions.task} submit="Add task" working="Adding…" className="mt-4 space-y-3" buttonClassName={BUTTON}><Hidden ledgerId={ledgerId} /><TargetSelect data={data} initial={initial?.target_ref} /><label className={LABEL}>Task<input name="title" required defaultValue={initial?.title ?? ''} className={input} /></label><label className={LABEL}>Due<input name="dueAt" type="datetime-local" defaultValue={initial?.due_at?.slice(0, 16).replace(' ', 'T') ?? ''} className={input} /></label><label className={LABEL}>Priority<select name="priority" defaultValue={initial?.priority ?? 'normal'} className={input}><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label><label className={LABEL}>Assigned to<PersonSelect users={data.users} name="assignedUserId" initial={initial?.assigned_user_id} /></label></ActionForm></section>}
  </div>
}

function Activities({ ledgerId, data, actions, readOnly, copyRef }: {
  ledgerId: string; data: CrmWorkspace; actions: CrmActions; readOnly: boolean; copyRef?: string
}) {
  const initial = data.activities.find((activity) => copyRef === `activity|${activity.id}`)
  const base = `/ledger/${ledgerId}/crm`
  return <div className="mt-5 grid items-start grid-cols-[minmax(0,1.8fr)_minmax(18rem,0.8fr)] gap-5 max-[1100px]:grid-cols-1"><section className={SECTION}><h2 className="text-section-title font-semibold">Activity timeline</h2><div className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">{data.activities.map((activity) => <article key={activity.id} className="py-3 text-sm"><div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{activity.subject}</strong><span className="text-xs text-neutral-500">{activity.kind} · <TimestampText value={activity.occurred_at}/></span></div><p className="text-neutral-500">{activity.related_to}{activity.actor_name ? ` · ${activity.actor_name}` : ''}</p>{activity.body && <p className="mt-1 whitespace-pre-wrap">{activity.body}</p>}{!readOnly && <Link href={copyHref(base, 'activity', 'activity', activity.id)} className="text-xs text-neutral-500 underline">Copy</Link>}</article>)}</div></section>{!readOnly && <section id="copy-form-activity" className={SECTION}><h2 className="text-section-title font-semibold">{initial ? 'Copy activity' : 'Record activity'}</h2><ActionForm key={initial?.id ?? 'new'} action={actions.activity} submit="Record activity" working="Saving…" className="mt-4 space-y-3" buttonClassName={BUTTON}><Hidden ledgerId={ledgerId} /><TargetSelect data={data} initial={initial?.target_ref} /><label className={LABEL}>Kind<select name="kind" defaultValue={initial?.kind ?? 'note'} className={input}><option value="note">Note</option><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option></select></label><label className={LABEL}>Direction<select name="direction" defaultValue={initial?.direction ?? ''} className={input}><option value="">Not applicable</option><option value="outbound">Outbound</option><option value="inbound">Inbound</option></select></label><label className={LABEL}>Subject<input name="subject" required defaultValue={initial?.subject ?? ''} className={input} /></label><label className={LABEL}>Notes<textarea name="body" rows={5} defaultValue={initial?.body ?? ''} className={area} /></label></ActionForm></section>}</div>
}

function Finance({ ledgerId, data, actions, mayReview, invoiceChoices, readOnly }: {
  ledgerId: string; data: CrmWorkspace; actions: CrmActions; mayReview: boolean
  invoiceChoices: Array<{ id: string; label: string }>; readOnly: boolean
}) {
  return <section className={`mt-6 ${SECTION}`}><div className={PAGE_HEADER}><div><h2 className="text-section-title font-semibold">Finance handoff</h2></div>{mayReview && <Link href={`/ledger/${ledgerId}/invoices/new`} className={BUTTON}>New draft invoice</Link>}</div><div className="mt-4 divide-y divide-neutral-200 dark:divide-neutral-800">{data.handoffs.map((handoff) => <div key={handoff.id} className="grid grid-cols-[minmax(12rem,1fr)_10rem_minmax(18rem,1.4fr)] items-center gap-4 py-3 text-sm max-[1100px]:grid-cols-1 max-[1100px]:items-start max-[1100px]:gap-2"><span><strong className="block">{handoff.opportunity_name}</strong><small className="text-neutral-500">{handoff.account_name}</small></span><span className="capitalize">{handoff.status}{handoff.customer_role_ready ? ' · customer' : ''}{handoff.invoice_created ? ' · invoice linked' : ''}</span>{mayReview && !readOnly && handoff.status === 'pending' ? <ActionForm action={actions.reviewHandoff} submit="Review" working="…" className="grid grid-cols-[8rem_minmax(9rem,1fr)_minmax(8rem,1fr)_auto] items-center gap-2 max-[900px]:grid-cols-1 max-[900px]:items-stretch" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} /><input type="hidden" name="handoffId" value={handoff.id} /><input type="hidden" name="version" value={handoff.version} /><select name="decision" className={FIELD}><option value="accepted">Accept</option><option value="rejected">Reject</option></select><select name="invoiceId" className={FIELD} defaultValue=""><option value="">No invoice linked yet</option>{invoiceChoices.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select><input name="reason" aria-label="Reason for finance review" className={FIELD} /></ActionForm> : mayReview && !readOnly && handoff.status === 'accepted' && !handoff.invoice_created ? <ActionForm action={actions.linkHandoffInvoice} submit="Link" working="…" className="flex flex-wrap items-center gap-2" buttonClassName={QUIET}><Hidden ledgerId={ledgerId} /><input type="hidden" name="handoffId" value={handoff.id} /><input type="hidden" name="version" value={handoff.version} /><select name="invoiceId" required className={`min-w-64 flex-1 ${FIELD}`} defaultValue=""><option value="" disabled>Choose a draft sales invoice…</option>{invoiceChoices.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select></ActionForm> : <span className="text-neutral-500">{handoff.review_reason ?? (mayReview ? 'Reviewed' : 'Finance review only')}</span>}</div>)}</div>{data.handoffs.length === 0 && <p className="mt-4 text-sm text-neutral-500">No opportunities are waiting for finance.</p>}</section>
}

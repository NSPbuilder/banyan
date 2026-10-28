import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { Picker } from '@/components/Picker'
import { DateInput } from '@/components/DateInput'
import { DataTable, TableViewport } from '@/components/Table'
import { BUTTON, FIELD, LABEL, QUIET, REFUSAL } from '@/lib/ui'
import { formatMoney } from '@/lib/money'
import type { ProjectInvoiceReview } from '@/lib/project-invoices'
import type { AvailableInvoiceTemplate } from '@/lib/invoice-template-types'
import { projectTaxErrors } from '@/lib/project-tax'

export function ProjectInvoiceForm({ ledgerId, review, templates, action }: {
  ledgerId: string; review: ProjectInvoiceReview; templates: AvailableInvoiceTemplate[]; action: FormAction
}) {
  const { head, source, lines, accounts } = review
  const total = (key: 'base' | 'gst' | 'pst') => lines.reduce((s, l) => s + BigInt(l[key]), 0n)
  const gst = total('gst'), pst = total('pst'), gross = total('base') + gst + pst
  const missing = !accounts.receivable.length
  const taxErrors=projectTaxErrors(review.taxAccounts,'revenue',lines)
  const here = `/ledger/${ledgerId}/projects/${head.id}`
  const field = `mt-1 w-full ${FIELD}`
  return <>
    <p className="text-metadata text-ink-muted">Creates a draft in Invoices. Review and post when ready.</p>
    {missing && <p role="status" className={REFUSAL}>Add the missing receivables account in <Link href={`/ledger/${ledgerId}/accounts`} className="underline">Accounts</Link> before creating this invoice.</p>}
    {taxErrors.map(message=><p key={message} role="alert" className={REFUSAL}>{message}</p>)}
    {!review.customerAtSourceDate && <p role="status" className={REFUSAL}>The customer role does not cover the revenue date. Choose an invoice date covered by that role, or update the role in <Link href={`/ledger/${ledgerId}/parties`} className="underline">Parties</Link>.</p>}
    <ActionForm action={action} submit="Create draft invoice" working="Creating…" buttonClassName={BUTTON}
      className="space-y-4" stickyActions secondaryActions={<Link href={here} className={QUIET}>Cancel</Link>}
      requestError="Could not confirm invoice creation. Return to this revenue record and check its invoice link before trying again.">
      <input type="hidden" name="ledgerId" value={ledgerId}/>
      <input type="hidden" name="projectId" value={head.id}/>
      <input type="hidden" name="recordId" value={source.id}/>
      <input type="hidden" name="version" value={source.version}/>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div><div className={LABEL}>Customer</div><p className="mt-1 text-body">{head.customer}</p></div>
        <div><div className={LABEL}>Invoice number</div><p className="mt-1 text-body tabular-nums">{review.number}</p><p className="mt-1 text-caption text-ink-muted">Assigned on creation from the project code.</p></div>
        <label className={LABEL}>Receivables<Picker name="controlAccountId" ariaLabel="Receivables" required className="mt-1"
          options={accounts.receivable} defaultValue={accounts.receivable.length === 1 ? accounts.receivable[0].id : ''}/></label>
        <label className={LABEL}>Invoice date<DateInput name="issuedOn" required defaultValue={source.record_date} className={field}/></label>
        <label className={LABEL}>Due date<DateInput name="dueOn" required defaultValue={source.due_date || source.record_date} className={field}/></label>
        <label className={LABEL}>Template<select name="template" defaultValue="auto" className={field}>
          <option value="auto">Automatic · customer / company default</option><option value="system">Original standard</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select></label>
      </div>
      <section className="space-y-2">
        <h2 className="text-section-title font-semibold">{source.description}</h2>
        {source.reference && <p className="text-metadata text-ink-muted">Reference: {source.reference}</p>}
        <TableViewport label="Invoice source lines"><DataTable className="ui-table-spaced">
          <thead><tr><th scope="col" className="text-left">Description</th><th scope="col" className="text-right">Net</th><th scope="col" className="text-right">GST</th><th scope="col" className="text-right">PST</th><th scope="col" className="text-left">Revenue account</th></tr></thead>
          <tbody>{lines.map((line, i) => <tr key={i}>
            <td className="min-w-40">{line.description || source.description}</td>
            {(['base','gst','pst'] as const).map(k => <td key={k} className="text-right tabular-nums whitespace-nowrap">{formatMoney(BigInt(line[k]))}</td>)}
            <td className="min-w-56 text-metadata text-ink-secondary">{accounts.revenue[0]?.label||'Assigned on creation'}</td>
          </tr>)}</tbody><tfoot><tr><th scope="row" className="text-left">Total · {head.currency}</th>
            {(['base','gst','pst'] as const).map(k => <td key={k} className="text-right tabular-nums whitespace-nowrap">{formatMoney(total(k))}</td>)}
            <td className="text-right tabular-nums whitespace-nowrap font-semibold"><span className="mr-2 text-metadata font-normal text-ink-muted">Invoice total</span>{formatMoney(gross)}</td>
          </tr></tfoot>
        </DataTable></TableViewport>
      </section>
      <p className="text-metadata text-ink-muted">Project receipts remain separate from invoice payments.</p>
    </ActionForm>
  </>
}

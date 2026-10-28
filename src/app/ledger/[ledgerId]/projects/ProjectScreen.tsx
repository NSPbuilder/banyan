import type { ProjectFinanceOptions, ProjectFinanceLink } from '@/lib/project-finance'
import type { CSSProperties } from 'react'
import type { ProjectPaymentAttachment } from '@/lib/project-attachments'
import { FilterBar } from '@/components/FormLayout'
import { MoreFilters } from '@/components/MoreFilters'
import { PageHeader } from '@/components/PageHeader'
import { Pagination } from '@/components/Pagination'
import { Money as ExactMoney } from '@/components/AccountingData'
import { DataTable, ColumnTable, TableSummaryRow } from '@/components/Table'

import { formatNumber } from '@/lib/numbers'
import { ToolAction } from '@/components/ToolAction'
import { projectReceiptNumber } from '@/lib/receipt-number'
import { TOOL_BUTTON, PAGE_HEADER, QUIET, REFUSAL, FIELD_COMPACT, LABEL_COMPACT, QUIET_COMPACT } from '@/lib/ui'
import Link from 'next/link'
import { randomUUID } from 'node:crypto'
import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import { formatMoney } from '@/lib/money'
import { localToday } from '@/lib/today'
import { projectProfit, type ProjectCompany, type ProjectFilters, type ProjectSummary, type ProjectRecordRow, type ProjectPaymentRow, type ProjectAllocationRow } from '@/lib/project'
import { PROJECT_CATEGORIES, projectRecordType, projectAccountingGroups, projectAccountingTotal, projectAccountingProfit, projectProfitBasis, type ProjectAccountingRow } from '@/lib/project-accounting'
import { ActionForm } from '@/components/ActionForm'
import { Floating } from '@/components/Floating'
import { NewProject, EditProject, ProjectDeleteForm, RecordForm, PaymentForm, EditPaymentForm, AllocateForm, VoidForm, AttachmentForm, PaymentAttachments, type PartyChoice, type ProjectActions } from './ProjectForms'
import * as actions from './actions'
import type { ProjectInvoiceLink } from '@/lib/project-invoices'

export const projectActions:ProjectActions={party:actions.createProjectPartyAction,create:actions.createProjectAction,update:actions.updateProjectAction,delete:actions.deleteProjectAction,restore:actions.restoreProjectAction,record:actions.saveProjectRecordAction,payment:actions.createProjectPaymentAction,editPayment:actions.editProjectPaymentAction,allocate:actions.allocateProjectPaymentAction,void:actions.voidProjectItemAction,attach:actions.attachProjectFileAction,detach:actions.detachProjectFileAction}
const cell='px-2 py-2 align-top'
const amount=cell+' text-right whitespace-nowrap tabular-nums'
const table='w-full text-[13px]'
// All three registers share Date, money and document-number column positions.
const detailColumnWidths=[10,12,10,8,5,5,8,8,8,9,17] as const
const detailColumns=detailColumnWidths.map((width,i)=>({width:`${width}%`,className:i===10?'print:hidden':undefined}))
const detailTable=table+' tabular-nums min-w-(--table-min-width) print:min-w-0'
const surface='table-scroll border-y border-line-subtle'
const divider='divide-y divide-neutral-200 dark:divide-neutral-800'
const filterField='mt-1 block h-8 w-full '+FIELD_COMPACT
const filterLabel=LABEL_COMPACT
function Money({value}:{value:string|bigint}) {return <ExactMoney cents={value}/>}

function RevenueInvoiceAction({record,links}:{record:ProjectRecordRow;links:ProjectInvoiceLink[]}) {
  const link=links.find(l=>l.record_id===record.id)
  if(link)return <Link href={`/ledger/${link.ledger_id}/invoices/${link.invoice_id}`} data-project-document
    title={`Invoice ${link.number || 'Draft'}${link.source_version!==record.version?' · Source changed; the invoice is not updated automatically.':''}`}
    className="block max-w-full truncate text-metadata underline">{link.number || 'Draft'}</Link>
  return null
}

export function ProjectFilter({base,filters,parties}:{base:string;filters:ProjectFilters;parties:PartyChoice[]}) {
  return <form action={base} className="print:hidden">
    {filters.deleted&&<input type="hidden" name="deleted" value="yes"/>}
    <FilterBar><label className={filterLabel+' w-32'}>Project<input name="q" defaultValue={filters.q} className={filterField}/></label>
    <label className={filterLabel+' w-32'}>From<DateInput name="from" defaultValue={filters.from} className={filterField}/></label>
    <label className={filterLabel+' w-32'}>Through<DateInput name="to" defaultValue={filters.to} className={filterField}/></label>
    <label className={filterLabel+' w-28'}>Status<select name="status" defaultValue={filters.status||''} className={filterField}><option value="">All statuses</option>{['planned','active','completed','archived'].map(s=><option key={s}>{s}</option>)}</select></label>
    <button className={QUIET_COMPACT+' h-8'}>Apply</button>
    <Link className="flex h-8 items-center text-xs underline" href={filters.deleted?base+'?deleted=yes':base}>Clear</Link>
    <MoreFilters active={[filters.supplier,filters.customer].filter(Boolean).length}>
    <label className={filterLabel+' w-32'}>Supplier<Picker name="supplier" defaultValue={filters.supplier||''} placeholder="All suppliers" ariaLabel="Supplier" options={parties.map(p=>({id:p.id,label:p.name}))} /></label>
    <label className={filterLabel+' w-32'}>Customer<Picker name="customer" defaultValue={filters.customer||''} placeholder="All customers" ariaLabel="Customer" options={parties.map(p=>({id:p.id,label:p.name}))} /></label>
    </MoreFilters></FilterBar>
  </form>
}
export function ProjectExports({base,filters,projectId}:{base:string;filters:ProjectFilters;projectId?:string}) {
  const qs=new URLSearchParams(Object.entries(filters).filter(([,v])=>!!v) as [string,string][])
  if(projectId)qs.set('project',projectId)
  const href=(what:string,format='csv')=>{const p=new URLSearchParams(qs);p.set('what',what);p.set('format',format);return base+'/export?'+p}
  return <details className="print:hidden text-sm"><summary className="cursor-pointer font-medium">Export</summary><div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{['summary','accounting','records','lines','payments','parties','balances','allocations','taxes'].map(k=><a key={k} className={TOOL_BUTTON} href={href(k)} title="Export CSV"><ToolAction kind="csv" showLabel>{k==='accounting'?'Summary by Party':k==='summary'?'Project totals':k} CSV</ToolAction></a>)}<a className={TOOL_BUTTON} href={href('summary','xlsx')} title="Complete workbook"><ToolAction kind="xlsx" showLabel>Complete workbook</ToolAction></a></div></details>
}
function ReviewedMoney({value}:{value:bigint|null}) {return value===null?<span className="text-xs font-medium text-red-700 dark:text-red-300">Pending PST review</span>:<Money value={value}/>}
const accountingKeys=['gst','pst','gross','settled','outstanding'] as const
function AccountingValues({row,kind}:{row:ReturnType<typeof projectAccountingTotal>;kind:'revenue'|'cost'}) {
  return <><td className={amount}><Money value={row.base}/></td><td className={amount}><ReviewedMoney value={projectProfitBasis(row,kind)}/></td>{accountingKeys.map(k=><td key={k} className={amount}><Money value={row[k]}/></td>)}</>
}
export function ProjectTotals({project:p,accounting,href}:{project:ProjectSummary;accounting:ProjectAccountingRow[];href:string}) {
  const profit=projectAccountingProfit(accounting)
  return <section className="space-y-3">
    <header className={PAGE_HEADER}><h2 className="text-section-title font-semibold">Summary</h2><div className="flex items-center gap-4 text-xs text-neutral-500"><span>All dates · {p.currency}</span><a href={href} className={TOOL_BUTTON} title="Export CSV"><ToolAction kind="csv">Export CSV</ToolAction></a></div></header>
    <div className={surface}><DataTable density="reading" className={table}><thead><tr className="text-left text-xs text-neutral-500">
      <th className={cell}>Type</th><th className={cell}>Party</th><th className={amount}>Net</th>
      <th className={amount} title="Revenue: Net. Costs: Net + confirmed non-recoverable PST.">Net + cost PST</th>
      {['GST','PST','Total','Paid / received','Outstanding'].map(h=><th key={h} className={amount}>{h}</th>)}
    </tr></thead>{(['revenue','cost'] as const).map(kind=><tbody key={kind} className={divider} aria-label={kind==='revenue'?'Revenue summary':'Cost summary'}>
      {accounting.filter(r=>r.kind===kind).map((r,i)=><tr key={i}><td className={cell+' whitespace-nowrap'}>{r.type}</td><td className={cell+' min-w-32'}>{r.party}</td><AccountingValues row={r} kind={kind}/></tr>)}
      <TableSummaryRow><th scope="row" colSpan={2} className={cell+' text-left'}>{kind==='revenue'?'Revenue total':'Cost total'}</th><AccountingValues row={projectAccountingTotal(accounting,kind)} kind={kind}/></TableSummaryRow>
    </tbody>)}<tfoot>
      <TableSummaryRow><th scope="row" colSpan={2} className={cell+' text-left font-medium'}>Profit before tax</th><td className={amount}><Money value={profit.beforeTax}/></td><td colSpan={6}/></TableSummaryRow>
      <TableSummaryRow><th scope="row" colSpan={3} className={cell+' text-left'}>Profit before GST</th><td className={amount}><ReviewedMoney value={profit.beforeGST}/></td><td colSpan={5}/></TableSummaryRow>
      {(profit.cost.nonrecoverGST>0n||profit.cost.pendingGST>0n)&&<TableSummaryRow><th scope="row" colSpan={3} className={cell+' text-left'}>After non-recoverable GST</th><td className={amount}>{profit.adjusted===null?<span className="text-xs text-red-700 dark:text-red-300">Pending tax review</span>:<Money value={profit.adjusted}/>}</td><td colSpan={5}/></TableSummaryRow>}
    </tfoot></DataTable></div>
    {profit.cost.pendingGST+profit.cost.pendingPST>0n&&<p role="status" className={REFUSAL}>Tax recovery pending: <Money value={profit.cost.pendingGST+profit.cost.pendingPST}/>.</p>}
  </section>
}
export function ProjectList({ledgerId,company,projects,filters,parties,actions}:{ledgerId:string;company:ProjectCompany;projects:ProjectSummary[];filters:ProjectFilters;parties:PartyChoice[];actions:ProjectActions}) {
  const base='/ledger/'+ledgerId+'/projects',deleted=filters.deleted==='yes'
  return <main className="w-full min-w-0 px-8 py-8 font-sans space-y-4"><PageHeader title={deleted?'Deleted projects':'Project'} context={`${company.name} · ${company.currency}`}>
      <Link className="text-label underline" href={deleted?base:base+'?deleted=yes'}>{deleted?'Projects':'Deleted projects'}</Link>{!company.archived_at&&!deleted&&<NewProject ledgerId={ledgerId} parties={parties} action={actions.create} newParty={actions.party} today={localToday()}/>}
    </PageHeader>
    <ProjectFilter base={base} filters={filters} parties={parties}/>
    {(filters.from||filters.to)&&<p className="text-xs text-neutral-500">Record / payment dates: {filters.from||'Start'} — {filters.to||'All dates'} · Balances as of {filters.to||'all dates'}</p>}
    <div className={surface}><DataTable density="reading" className={table}><thead><tr className="text-left text-xs text-neutral-500"><th className={cell+' min-w-56'}>Project / customer</th><th className={cell}>Status</th>{['Revenue (net)','Costs (net)','Gross profit (excl. tax)','Adjusted profit','Receivable','Payable'].map(h=><th key={h} className={amount}>{h}</th>)}<th className={cell+' print:hidden'}>Actions</th></tr></thead><tbody className={divider}>{projects.map(p=>{const profit=projectProfit(p);return <tr key={p.id}><td className={cell}>{deleted?<span className="font-medium">{p.code} · {p.name}</span>:<Link href={base+'/'+p.id} className="font-medium underline">{p.code} · {p.name}</Link>}<div className="mt-1 text-xs text-neutral-500">{p.customer} · {p.currency}</div></td><td className={cell+' capitalize'}>{p.status}</td>{[p.revenue,profit.cost,profit.before,profit.adjusted,p.receivable,p.payable].map((v,i)=><td key={i} className={amount}>{v===null?<span className="text-xs">Pending tax review</span>:<Money value={v}/>}</td>)}<td className={cell+' print:hidden'}>{!company.archived_at&&<ProjectDeleteForm ledgerId={ledgerId} project={p} action={deleted?actions.restore:actions.delete} restore={deleted}/>}</td></tr>})}</tbody></DataTable>{!projects.length&&<p className="p-5 text-sm text-neutral-500">{deleted?'No deleted projects.':Object.values(filters).some(Boolean)?'No matching projects.':'No projects yet.'}</p>}</div>
    {!deleted&&<ProjectExports base={base} filters={filters}/>}
  </main>
}
export type ProjectAttachmentView={id:string;uploaded_filename:string;mime:string;byte_size:string;record_id:string|null;payment_id:string|null;note:string|null}
export function ProjectDetail({ledgerId,company,project:p,parties,records,payments,allocations,attachments,storageReady,today,actions,paymentAttachments={},paymentAttachmentErrors={},page=1,mayGenerateInvoice=false,invoiceLinks=[],finance,financeLinks=[]}:{ledgerId:string;company:ProjectCompany;project:ProjectSummary;parties:PartyChoice[];records:ProjectRecordRow[];payments:ProjectPaymentRow[];allocations:ProjectAllocationRow[];attachments:ProjectAttachmentView[];paymentAttachments?:Record<string,ProjectPaymentAttachment[]>;paymentAttachmentErrors?:Record<string,string>;storageReady:boolean;today:string;actions:ProjectActions;page?:number;mayGenerateInvoice?:boolean;invoiceLinks?:ProjectInvoiceLink[];finance?:ProjectFinanceOptions;financeLinks?:ProjectFinanceLink[]}) {
  const base='/ledger/'+ledgerId+'/projects',here=base+'/'+p.id,editable=!company.archived_at&&p.status!=='archived'
  const categoryOrder=(r:ProjectRecordRow)=>PROJECT_CATEGORIES.findIndex(k=>r.lines.some(l=>l.kind===k))
  const ordered=[...records].sort((a,b)=>categoryOrder(a)-categoryOrder(b)||projectRecordType(a).localeCompare(projectRecordType(b))||a.record_date.localeCompare(b.record_date)||a.description.localeCompare(b.description)||a.id.localeCompare(b.id))
  const visible=ordered.slice((page-1)*25,page*25),accounting=projectAccountingGroups(records)
  const financialRecords=records.filter(r=>financeLinks.some(l=>l.record_id===r.id&&l.invoice_id&&l.ledger_id===ledgerId))
  const totals=(['revenue','cost'] as const).map(kind=>projectAccountingTotal(accounting,kind))
  const numericValues=[
    [...records.map(r=>r.base),...totals.map(t=>t.base)],
    [...records.map(r=>r.gst),...totals.map(t=>t.gst)],
    [...records.map(r=>r.pst),...totals.map(t=>t.pst)],
    [...records.map(r=>r.gross),...totals.map(t=>t.gross),...payments.map(p=>p.amount)],
    [...records.map(r=>r.settled),...totals.map(t=>t.settled),...payments.map(p=>p.allocated)],
    [...records.map(r=>r.outstanding),...totals.map(t=>t.outstanding),...payments.map(p=>p.unallocated)],
  ]
  // Reserve readable space for the actual formatted figures; large values widen all three tables together.
  const numericMinimums=numericValues.map((values,i)=>{
    const units=Math.max(1,...values.map(v=>[...formatMoney(BigInt(v))].reduce((n,c)=>n+(c==='.'||c===','?0.5:1),0)))+0.5
    const scale=100/detailColumnWidths[i+3]
    return `calc(${units*scale}ch + ${scale}rem)`
  })
  const gridStyle={'--table-min-width':`max(72rem, ${numericMinimums.join(', ')})`} as CSSProperties
  return <main className="w-full min-w-0 px-8 py-8 font-sans space-y-5"><Link href={base} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Projects</ToolAction></Link>
    <PageHeader title={`${p.code} · ${p.name}`} context={<>{company.name} · {p.customer} · {p.currency} · <span className="capitalize">{p.status}</span>{p.site&&<span className="block">{p.site}</span>}</>}>
      {!company.archived_at&&<><EditProject ledgerId={ledgerId} project={p} action={actions.update}/><ProjectDeleteForm ledgerId={ledgerId} project={p} action={actions.delete}/></>}
    </PageHeader>
    {!editable&&<p role="status" className={REFUSAL}>{company.archived_at?'Company':'Project'} archived · Read-only</p>}
    <ProjectTotals project={p} accounting={accounting} href={base+'/export?project='+p.id+'&what=accounting'}/>
    {(['revenue','cost'] as const).map(kind=>{const total=projectAccountingTotal(accounting,kind),kindRecords=records.filter(r=>r.kind===kind);return <section key={kind} className="space-y-3"><header className={PAGE_HEADER}><h2 className="text-section-title font-semibold">{kind==='revenue'?'Revenue':'Costs'} <span className="text-xs font-normal text-neutral-500">{formatNumber(kindRecords.length)}</span></h2>{editable&&<div className="print:hidden"><RecordForm ledgerId={ledgerId} project={p} parties={parties} action={actions.record} newParty={actions.party} kind={kind} today={today} submissionKey={randomUUID()} finance={finance&&(kind==='revenue'?finance.invoices:finance.invoices||finance.expenses)?finance:undefined}/></div>}</header>
      <div className={surface}><ColumnTable columns={detailColumns} className={detailTable} style={gridStyle}><thead><tr className="text-left text-xs text-neutral-500">{['Type','Party / record','Date','Net','GST','PST','Total',kind==='revenue'?'Received':'Paid','Outstanding','Document no.','Actions'].map((h,i)=><th key={h} className={(i>=3&&i<=8?amount:cell)+(i===10?' print:hidden':'')}>{h}</th>)}</tr></thead><tbody className={divider}>{visible.filter(r=>r.kind===kind).map(r=><tr key={r.id} id={'record-'+r.id}>
        <td className={cell+' whitespace-nowrap'}>{projectRecordType(r).replace(/^Cost · /,'')}</td><td className={cell}><p className="truncate font-medium" title={r.party}>{r.party}</p>{r.description&&<p className="mt-1 break-words text-xs text-neutral-500">{r.description}</p>}{BigInt(r.pending_tax)>0n&&<p className="mt-1 text-xs font-medium text-red-700 dark:text-red-300">Tax recovery pending</p>}</td><td className={cell+' whitespace-nowrap'}><time dateTime={r.record_date}>{r.record_date}</time></td>
        {[r.base,r.gst,r.pst,r.gross].map((v,i)=><td key={i} className={amount}><Money value={v}/></td>)}<td className={amount}><Money value={r.settled}/></td><td className={amount}><Money value={r.outstanding}/></td>
        <td className={cell+' whitespace-nowrap'}>{financeLinks.filter(l=>l.record_id===r.id).map(l=><div key={l.id}><Link data-project-document href={`/ledger/${l.ledger_id}/${l.invoice_id?(r.kind==='revenue'?'invoices/':'bills/')+l.invoice_id:'entries/'+l.expense_entry_id}`} title={`${l.invoice_id?(r.kind==='revenue'?'Invoice':'Bill'):'Expense'} ${l.number||'draft'}`} className="block max-w-36 truncate text-metadata underline">{l.number||'Draft'}</Link></div>)}{r.kind==='revenue'&&mayGenerateInvoice&&!financeLinks.some(l=>l.record_id===r.id)&&<RevenueInvoiceAction record={r} links={invoiceLinks}/>}</td>
        <td className={cell+' print:hidden'}>{editable&&!financeLinks.some(l=>l.record_id===r.id&&(l.expense_entry_id?!finance?.expenses:!finance?.invoices))&&<div data-project-row-actions className="flex flex-nowrap items-center gap-1 whitespace-nowrap [&>*]:shrink-0"><RecordForm ledgerId={financeLinks.find(l=>l.record_id===r.id)?.ledger_id||ledgerId} project={p} parties={parties} action={actions.record} newParty={actions.party} kind={r.kind as 'revenue'|'cost'} today={today} submissionKey={randomUUID()} record={r} finance={financeLinks.some(l=>l.record_id===r.id)?finance:undefined} link={financeLinks.find(l=>l.record_id===r.id)}/>{BigInt(r.outstanding)>0n&&<PaymentForm ledgerId={financeLinks.find(l=>l.record_id===r.id)?.ledger_id||ledgerId} project={p} parties={parties} records={records} action={actions.payment} newParty={actions.party} today={today} direction={r.kind==='revenue'?'received':'paid'} submissionKey={randomUUID()} initialRecord={r} finance={financeLinks.some(l=>l.record_id===r.id)?finance:undefined}/>}<VoidForm ledgerId={financeLinks.find(l=>l.record_id===r.id)?.ledger_id||ledgerId} projectId={p.id} kind="record" id={r.id} version={r.version} description={r.description||r.kind+' on '+r.record_date} action={actions.void}/></div>}</td>
      </tr>)}</tbody><tfoot><TableSummaryRow><th scope="row" colSpan={3} className={cell+' text-left'}>{kind==='revenue'?'Revenue total':'Cost total'}{records.length>25?' · All records':''}</th>{[total.base,total.gst,total.pst,total.gross,total.settled,total.outstanding].map((v,i)=><td key={i} className={amount}><Money value={v}/></td>)}<td/><td className="print:hidden"/></TableSummaryRow></tfoot></ColumnTable>{!visible.some(r=>r.kind===kind)&&<p className="p-5 text-sm text-neutral-500">{kindRecords.length?'No '+(kind==='revenue'?'revenue':'costs')+' on this page.':kind==='revenue'?'No revenue yet.':'No costs yet.'}</p>}</div>
    </section>})}
      {records.length>25&&<Pagination page={page} pageSize={25} total={records.length} count={visible.length}
        previous={page>1?here+'?page='+(page-1):undefined} next={page*25<records.length?here+'?page='+(page+1):undefined} label="Record pages"/>}
    <section className="space-y-3"><header className={PAGE_HEADER}><h2 className="text-section-title font-semibold">Payment records <span className="text-xs font-normal text-neutral-500">{formatNumber(payments.length)}</span></h2>{editable&&<div className="flex flex-wrap gap-2 print:hidden">{(['received','paid'] as const).map(direction=><PaymentForm key={direction} ledgerId={ledgerId} project={p} parties={parties} records={finance?.payments?financialRecords:records} action={actions.payment} newParty={actions.party} today={today} direction={direction} submissionKey={randomUUID()} finance={finance?.payments?finance:undefined}/>)}</div>}</header>
      <div className={surface}><ColumnTable columns={detailColumns} className={detailTable} style={gridStyle}><thead><tr className="text-left text-xs text-neutral-500">{['Type','Party','Date','Attachments','Amount','Allocated','Advance','Document no.','Actions'].map((h,i)=><th key={h||'spacing'} colSpan={i===3?3:undefined} className={(i>=4&&i<=6?amount:cell)+(i===8?' print:hidden':'')}>{h}</th>)}</tr></thead><tbody className={divider}>{[...payments].sort((a,b)=>a.payment_date.localeCompare(b.payment_date)||a.id.localeCompare(b.id)).map(pay=>{const paidCost=pay.edit?.source==='quick_expense'?records.find(r=>financeLinks.some(l=>l.record_id===r.id&&l.expense_entry_id===pay.accounting_entry_id)):undefined;return <tr key={pay.id} id={'payment-'+pay.id}><td className={cell+' capitalize'}>{pay.direction}</td><td className={cell}><p className="truncate" title={pay.party}>{pay.party}</p></td><td className={cell+' whitespace-nowrap'}><time dateTime={pay.payment_date}>{pay.payment_date}</time></td><td colSpan={3} className={cell}><div className="print:hidden"><PaymentAttachments ledgerId={pay.accounting_ledger_id||ledgerId} projectId={p.id} paymentId={pay.id} files={paymentAttachments[pay.id]||[]} action={actions.attach} detach={actions.detach} allowUpload={editable&&(storageReady||!!pay.accounting_entry_id)&&!paymentAttachmentErrors[pay.id]} allowDelete={editable&&!paymentAttachmentErrors[pay.id]} error={paymentAttachmentErrors[pay.id]}/></div></td>{[pay.amount,pay.allocated,pay.unallocated].map((v,i)=><td key={i} className={amount}><Money value={v}/></td>)}<td className={cell}><Link href={`/ledger/${pay.accounting_ledger_id||ledgerId}/projects/${p.id}/payments/${pay.id}/receipt/preview`} data-project-receipt-link title={projectReceiptNumber(pay.id,pay.accounting_entry_no)} aria-label={`Receipt ${projectReceiptNumber(pay.id,pay.accounting_entry_no)}`} className="block max-w-full truncate text-metadata underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">{projectReceiptNumber(pay.id,pay.accounting_entry_no)}</Link></td><td className={cell+' print:hidden'}>{editable&&<div data-project-row-actions className="flex flex-nowrap items-center gap-1 whitespace-nowrap [&>*]:shrink-0">{pay.edit&&(!pay.edit.source||(pay.edit.source==='quick_expense'?finance?.expenses:finance?.payments))&&<EditPaymentForm ledgerId={pay.accounting_ledger_id||ledgerId} project={p} payment={pay} action={actions.editPayment} finance={finance} supporting={{files:paymentAttachments[pay.id]||[],action:actions.attach,detach:actions.detach,allowUpload:editable&&(storageReady||!!pay.accounting_entry_id)&&!paymentAttachmentErrors[pay.id],allowDelete:editable&&!paymentAttachmentErrors[pay.id],error:paymentAttachmentErrors[pay.id]}}/>} {BigInt(pay.unallocated)>0n&&<AllocateForm ledgerId={pay.accounting_ledger_id||ledgerId} project={p} payment={pay} records={pay.accounting_entry_id?records.filter(r=>financeLinks.some(l=>l.record_id===r.id&&l.invoice_id&&l.ledger_id===pay.accounting_ledger_id)):records} action={actions.allocate} submissionKey={randomUUID()}/>}<VoidForm ledgerId={pay.accounting_ledger_id||ledgerId} projectId={p.id} id={paidCost?.id||pay.id} version={paidCost?.version||pay.version} kind={paidCost?'record':'payment'} description={paidCost?paidCost.description||'paid cost on '+paidCost.record_date:pay.direction+' '+pay.party} action={actions.void} label={paidCost?'Cancel cost':'Cancel'}/></div>}</td></tr>})}</tbody></ColumnTable>{!payments.length&&<p className="p-5 text-sm text-neutral-500">No payments.</p>}</div>
      <details><summary className="text-xs font-medium cursor-pointer">Allocations ({formatNumber(allocations.length)})</summary><ul className={'mt-2 '+divider}>{allocations.map(a=><li key={a.id} className="py-2 flex flex-wrap justify-between gap-2 text-xs"><div>{a.effective_date} · {a.party} · {a.description} · <Money value={a.amount}/></div>{editable&&<VoidForm ledgerId={ledgerId} projectId={p.id} kind="allocation" id={a.id} version={a.version} description={'allocation to '+a.description} action={actions.void}/>}</li>)}</ul></details>
    </section>
    <section className="space-y-3"><header className={PAGE_HEADER}><h2 className="text-section-title font-semibold">Attachments <span className="text-xs font-normal text-neutral-500">{formatNumber(attachments.length)}</span></h2>{editable&&storageReady&&<div className="print:hidden"><AttachmentForm ledgerId={ledgerId} project={p} records={records} payments={payments} action={actions.attach}/></div>}</header>
      {!storageReady&&<p role="status" className={REFUSAL}>Project file storage unavailable.</p>}
      <ul className={divider}>{attachments.map(a=><li key={a.id} className="py-2 flex flex-wrap items-center justify-between gap-3 text-sm"><div><a href={base+'/attachments/'+a.id} className="font-medium underline">{a.uploaded_filename}</a><p className="mt-1 text-xs text-neutral-500">{formatNumber(a.byte_size)} bytes{a.record_id&&' · '+(records.find(r=>r.id===a.record_id)?.description||a.record_id)}{a.payment_id&&' · Payment'}{a.note&&' · '+a.note}</p></div>{editable&&<Floating label="Unlink" title="Unlink document" buttonClassName={QUIET}><ActionForm action={actions.detach} submit="Unlink document" working="Unlinking…" className="mt-5 space-y-4" buttonClassName={QUIET}><input type="hidden" name="ledgerId" value={ledgerId}/><input type="hidden" name="projectId" value={p.id}/><input type="hidden" name="attachmentId" value={a.id}/><p>{a.uploaded_filename}</p></ActionForm></Floating>}</li>)}{!attachments.length&&<li className="text-sm text-neutral-500">No attachments.</li>}</ul>
    </section>
    {p.note&&<section className="border-t border-line-subtle pt-4"><h2 className="text-sm font-semibold">Notes</h2><p className="mt-2 text-sm whitespace-pre-wrap">{p.note}</p></section>}
    <ProjectExports base={base} filters={{}} projectId={p.id}/>
  </main>
}

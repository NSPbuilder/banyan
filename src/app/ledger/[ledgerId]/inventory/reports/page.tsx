import Link from 'next/link'
import {requireLedger} from '@/lib/gate'
import {ledgerHead} from '@/lib/ledger-head'
import {productionReport} from '@/lib/production-report'
import {operationsReconciliation} from '@/lib/operations-reconciliation'
import {financeSetting} from '@/lib/operations-finance'
import {operationDate} from '@/lib/operations-scope'
import {localToday} from '@/lib/today'
import {formatMoney} from '@/lib/money'
import {formatQuantity} from '@/lib/quantity'
import {PRODUCTION_EVENT_LABELS} from '@/lib/production-types'
import {PageHeader} from '@/components/PageHeader'
import {DateInput} from '@/components/DateInput'
import {FormFields} from '@/components/FormLayout'
import {DataTable,TableViewport} from '@/components/Table'
import {JournalLink,ReconciliationTable} from '@/components/OperationsFinance'
import {FIELD,LABEL,QUIET} from '@/lib/ui'
export const dynamic='force-dynamic'
export default async function ReportsPage({params,searchParams}:{params:Promise<{ledgerId:string}>;searchParams:Promise<{from?:string;to?:string}>}) {
 const {ledgerId}=await params;await requireLedger(ledgerId,'/inventory');const q=await searchParams;let to=localToday(),from=to.slice(0,7)+'-01',refusal=''
 try{if(q.to)to=operationDate(q.to);if(q.from)from=operationDate(q.from);if(from>to)throw new Error('Report start must be on or before its end.')}catch(e){refusal=e instanceof Error?e.message:'Choose valid dates.'}
 const [head,cfg,rows,events]=await Promise.all([ledgerHead(ledgerId),financeSetting(ledgerId,'/inventory'),operationsReconciliation(ledgerId,'/inventory',to),refusal?Promise.resolve([]):productionReport(ledgerId,from,to)])
 if(!head)return null
 return <div className="space-y-6" data-operations-screen="production-report"><PageHeader title="Production report" context={head.entity}><a className={QUIET} href={`/ledger/${ledgerId}/inventory/reports/export?from=${from}&to=${to}`}>Export production CSV</a></PageHeader>
  <form method="get" className="space-y-3"><FormFields><label className={LABEL}>From<DateInput name="from" required defaultValue={from} className={`${FIELD} mt-1 block`}/></label><label className={LABEL}>Through<DateInput name="to" required defaultValue={to} className={`${FIELD} mt-1 block`}/></label><button className={`${QUIET} self-end`}>Review dates</button></FormFields></form>
  {refusal&&<p role="alert" className="text-body text-error">{refusal}</p>}
  <section className="space-y-3"><h2 className="text-section-title font-semibold">Inventory and balance sheet · {to}</h2><p className="text-metadata text-ink-muted">{cfg?.connected_on&&to>=cfg.connected_on?'Recorded movement costs and production WIP are compared to the same-day general ledger cutoff.':`Financial comparison starts after Finance connection${cfg?.connected_on?` on ${cfg.connected_on}`:''}. Historical records remain available.`}</p><ReconciliationTable rows={rows} currency={head.currency}/></section>
  <section className="space-y-3"><h2 className="text-section-title font-semibold">Production records · {from} to {to}</h2><p className="text-metadata text-ink-muted">{events.length} records. Export includes every record in the selected range, source IDs, quantities, WIP changes and journal references.</p><TableViewport label="Daily production records"><DataTable className="ui-table-spaced min-w-272"><thead><tr><th>Date / order</th><th>Action / item</th><th className="text-right">Quantity</th><th className="text-right">WIP change ({head.currency})</th><th>Payroll time</th><th>Journal</th><th>Review note</th></tr></thead><tbody>{events.map(e=><tr key={e.id}><td>{e.event_date}<p><Link className="underline" href={`/ledger/${ledgerId}/inventory/production/${e.order_id}`}>{e.order_no}</Link></p><p className="text-metadata text-ink-muted">{e.output_name} · {e.warehouse}</p></td><td>{PRODUCTION_EVENT_LABELS[e.kind]}<p className="text-metadata text-ink-muted">{e.sku??'—'}</p></td><td className="text-right tabular-nums">{BigInt(e.quantity)?formatQuantity(e.quantity):'—'} {e.unit??''}</td><td className="text-right tabular-nums">{formatMoney(BigInt(e.wip_change))}</td><td>{e.employee_name??'—'}{e.estimated_labour!==null&&<p className="text-metadata text-ink-muted tabular-nums">Estimated {formatMoney(BigInt(e.estimated_labour))}{e.actual_labour!==null?` · actual ${formatMoney(BigInt(e.actual_labour))}`:''}</p>}{e.hours&&<p className="text-metadata text-ink-muted">{Number(e.hours)/100} h · worked {e.work_date}{e.pay_date?` · paid ${e.pay_date}`:' · estimated'}</p>}</td><td><JournalLink ledgerId={ledgerId} id={e.entry_id} number={e.entry_no} reason={e.no_entry_reason}/></td><td className="max-w-64 whitespace-pre-wrap break-words">{e.note||'—'}</td></tr>)}{!events.length&&<tr><td colSpan={7} className="py-8 text-center text-ink-muted">No production records in this date range.</td></tr>}</tbody></DataTable></TableViewport></section>
 </div>
}

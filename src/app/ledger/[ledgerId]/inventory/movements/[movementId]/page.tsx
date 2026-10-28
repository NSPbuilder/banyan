import Link from 'next/link'
import {operationsJournalEvents} from '@/lib/operations-reconciliation'
import {JournalLink} from '@/components/OperationsFinance'
import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { movementDetail } from '@/lib/inventory'
import { MOVEMENT_LABELS } from '@/lib/inventory-types'
import { formatMoney } from '@/lib/money'
import { formatQuantity } from '@/lib/quantity'
import { QUIET } from '@/lib/ui'
import { PageHeader } from '@/components/PageHeader'
import { DataTable,TableViewport } from '@/components/Table'
export const dynamic='force-dynamic'
export default async function MovementPage({params}:{params:Promise<{ledgerId:string;movementId:string}>}) {
  const {ledgerId,movementId}=await params;await requireLedger(ledgerId,'/inventory')
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(movementId))notFound()
  const [head,detail,journals]=await Promise.all([ledgerHead(ledgerId),movementDetail(ledgerId,movementId),operationsJournalEvents(ledgerId,'/inventory','0001-01-01','9999-12-31')]);if(!head||!detail)notFound()
  const {movement:m,stock,allocations}=detail
  const journal=journals.find(j=>j.source_id===movementId)??journals.find(j=>j.movement_id===movementId)
  const fields=[['Date',m.movement_date],['Type',MOVEMENT_LABELS[m.kind]],['Cost method',m.cost_method==='moving_average'?'Moving average':'FIFO'],['Quantity',`${formatQuantity(m.quantity)} ${m.unit}`],[`Cost (${head.currency})`,formatMoney(BigInt(m.cost))],['Reference',m.reference||'—'],['Recorded by',m.created_by],...(m.from_name?[['From',m.from_name]]:[]),...(m.to_name?[['To',m.to_name]]:[])]
  return <div className="space-y-6"><PageHeader title={`STK-${m.sequence.padStart(6,'0')}`} context={`${m.sku} · ${m.item_name}`} backTo={`/ledger/${ledgerId}/inventory/movements`} backLabel="Stock movements"><Link href={`/ledger/${ledgerId}/inventory/${m.item_id}`} className={QUIET}>Open item</Link></PageHeader>
    <dl className="grid grid-cols-1 gap-x-8 gap-y-4 border-y border-line-subtle py-5 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([text,value])=><div key={text}><dt className="text-metadata text-ink-muted">{text}</dt><dd className="mt-1 break-words text-body font-medium tabular-nums">{value}</dd></div>)}</dl>
    <p className="text-body">Journal: <JournalLink ledgerId={ledgerId} id={journal?.entry_id??null} number={journal?.entry_no??null} reason={journal?.no_entry_reason}/></p>{m.note&&<section><h2 className="text-section-title font-semibold">Notes / reason</h2><p className="mt-2 whitespace-pre-wrap break-words text-body">{m.note}</p></section>}
    <section className="space-y-3"><h2 className="text-section-title font-semibold">Physical stock moved</h2><TableViewport label="Movement physical stock"><DataTable className="ui-table-spaced min-w-128"><thead><tr><th>Location</th><th>Batch</th><th>Serial number</th><th className="text-right">Quantity ({m.unit})</th></tr></thead><tbody>{stock.map((s,i)=><tr key={i}><td>{s.warehouse_name}</td><td>{s.batch||'—'}</td><td>{s.serial||'—'}</td><td className="text-right tabular-nums">{formatQuantity(s.quantity)}</td></tr>)}</tbody></DataTable></TableViewport></section>
    {!!allocations.length&&<section className="space-y-3"><h2 className="text-section-title font-semibold">Cost consumed</h2><TableViewport label="Movement cost allocations"><DataTable className="ui-table-spaced min-w-128"><thead><tr><th>Original receipt date</th><th>Receipt order</th><th className="text-right">Quantity</th><th className="text-right">Cost ({head.currency})</th></tr></thead><tbody>{allocations.map((a,i)=><tr key={i}><td>{a.acquired_on}</td><td>STK-{a.fifo_order.padStart(6,'0')}</td><td className="text-right tabular-nums">{formatQuantity(a.quantity)}</td><td className="text-right tabular-nums">{formatMoney(BigInt(a.cost))}</td></tr>)}</tbody></DataTable></TableViewport></section>}
    <p className="text-metadata text-ink-muted">This movement is retained as recorded. To correct a quantity, open the item and record an adjustment with a reason.</p>
  </div>
}

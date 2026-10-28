import { randomUUID } from 'node:crypto'
import Link from 'next/link'
import {financeSetting,financialAccountOptions} from '@/lib/operations-finance'
import {QUIET} from '@/lib/ui'
import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { inventoryItemDetail,inventorySettings,inventoryWarehouses } from '@/lib/inventory'
import { formatMoney } from '@/lib/money'
import { formatQuantity } from '@/lib/quantity'
import { localToday } from '@/lib/today'
import { PageHeader } from '@/components/PageHeader'
import { DataTable,TableViewport } from '@/components/Table'
import { ItemForm,StockMovementForm } from '../InventoryForms'
import { MovementTable } from '../InventoryScreen'
import { saveItemAction,stockMovementAction } from '../actions'
export const dynamic='force-dynamic'
export default async function ItemPage({params}:{params:Promise<{ledgerId:string;itemId:string}>}) {
  const {ledgerId,itemId}=await params;await requireLedger(ledgerId,'/inventory')
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(itemId))notFound()
  const [head,detail,settings,warehouses,finance,accounts]=await Promise.all([ledgerHead(ledgerId),inventoryItemDetail(ledgerId,itemId),inventorySettings(ledgerId),inventoryWarehouses(ledgerId),financeSetting(ledgerId,'/inventory'),financialAccountOptions(ledgerId)]);if(!head||!detail)notFound()
  const {item,stock,layers,movements}=detail
  return <div className="space-y-6"><PageHeader title={item.name} context={`${item.sku} · ${item.kind==='finished_goods'?'Finished goods':item.kind==='work_in_progress'?'Work in progress':'Raw material'}${item.is_active?'':' · Archived'}`} backTo={`/ledger/${ledgerId}/inventory`} backLabel="Inventory">
    <ItemForm key={item.version} ledgerId={ledgerId} item={item} action={saveItemAction}/>{item.is_active&&(finance?.connected_on?<StockMovementForm ledgerId={ledgerId} item={item} settings={settings} warehouses={warehouses} currency={head.currency} today={localToday()} requestKey={randomUUID()} action={stockMovementAction} finance={finance} accounts={accounts}/>:<Link className={QUIET} href={`/ledger/${ledgerId}/inventory/finance`}>Connect Finance to record stock</Link>)}</PageHeader>
    <div className="flex flex-wrap gap-x-10 gap-y-4 border-y border-line-subtle py-4"><div><p className="text-metadata text-ink-muted">On hand · {item.unit}</p><p className="text-page-title font-semibold tabular-nums">{formatQuantity(item.on_hand)}</p></div><div><p className="text-metadata text-ink-muted">Stock value · {head.currency}</p><p className="text-page-title font-semibold tabular-nums">{formatMoney(BigInt(item.fifo_cost))}</p></div><div><p className="text-metadata text-ink-muted">Reorder level · {item.unit}</p><p className="text-page-title font-semibold tabular-nums">{formatQuantity(item.reorder_level)}</p></div><div><p className="text-metadata text-ink-muted">Tracking</p><p className="mt-1 text-body font-medium">{[item.track_batches?'Batch':'',item.track_serials?'Serial number':''].filter(Boolean).join(' + ')||'None'}</p></div></div>
    {item.notes&&<p className="whitespace-pre-wrap break-words text-body">{item.notes}</p>}
    <section className="space-y-3"><h2 className="text-section-title font-semibold">Stock on hand</h2><TableViewport label="Stock on hand"><DataTable className="ui-table-spaced min-w-128"><thead><tr>{settings.warehouses_enabled&&<th>Warehouse</th>}{item.track_batches&&<th>Batch</th>}{item.track_serials&&<th>Serial number</th>}<th className="text-right">Quantity ({item.unit})</th></tr></thead><tbody>{stock.map(s=><tr key={s.id}>{settings.warehouses_enabled&&<td>{s.warehouse_name}</td>}{item.track_batches&&<td>{s.batch}</td>}{item.track_serials&&<td>{s.serial}</td>}<td className="text-right tabular-nums">{formatQuantity(s.quantity)}</td></tr>)}{!stock.length&&<tr><td colSpan={1+Number(settings.warehouses_enabled)+Number(item.track_batches)+Number(item.track_serials)} className="py-8 text-center text-ink-muted">No stock on hand.</td></tr>}</tbody></DataTable></TableViewport></section>
    <section className="space-y-3"><h2 className="text-section-title font-semibold">Receipt cost balances</h2><TableViewport label="Receipt cost balances"><DataTable className="ui-table-spaced min-w-160"><thead><tr><th>Original receipt date</th><th>Receipt order</th>{settings.warehouses_enabled&&<th>Warehouse</th>}<th className="text-right">Remaining quantity</th><th className="text-right">Remaining cost ({head.currency})</th></tr></thead><tbody>{layers.map(l=><tr key={l.id}><td>{l.acquired_on}</td><td>STK-{l.fifo_order.padStart(6,'0')}</td>{settings.warehouses_enabled&&<td>{l.warehouse_name}</td>}<td className="text-right tabular-nums">{formatQuantity(l.remaining_quantity)}</td><td className="text-right tabular-nums">{formatMoney(BigInt(l.remaining_cost))}</td></tr>)}{!layers.length&&<tr><td colSpan={settings.warehouses_enabled?5:4} className="py-8 text-center text-ink-muted">No remaining receipt cost.</td></tr>}</tbody></DataTable></TableViewport></section>
    <section className="space-y-3"><h2 className="text-section-title font-semibold">Movement history</h2><MovementTable ledgerId={ledgerId} movements={movements} currency={head.currency} warehousesEnabled={settings.warehouses_enabled}/>{movements.length===250&&<p className="text-metadata text-ink-muted">The latest 250 movements for this item are shown.</p>}</section>
  </div>
}

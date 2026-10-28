import {requireLedger} from '@/lib/gate'
import {notFound} from 'next/navigation'
import {ledgerHead} from '@/lib/ledger-head'
import {inventoryItems} from '@/lib/inventory'
import {productionBoms} from '@/lib/production'
import {PageHeader} from '@/components/PageHeader'
import {TableViewport,DataTable} from '@/components/Table'
import {formatQuantity} from '@/lib/quantity'
import {BomForm} from '../ProductionForms'
import {bomAction} from '../actions'
export const dynamic='force-dynamic'
export default async function BomsPage({params}:{params:Promise<{ledgerId:string}>}){const {ledgerId}=await params;await requireLedger(ledgerId,'/inventory');const [head,items,boms]=await Promise.all([ledgerHead(ledgerId),inventoryItems(ledgerId),productionBoms(ledgerId)]);if(!head)notFound()
  return <div className="space-y-6"><PageHeader title="Bills of materials" context={head.entity}><BomForm ledgerId={ledgerId} items={items} action={bomAction}/></PageHeader><p className="text-body text-ink-secondary max-w-prose">Save recipes for WIP and finished goods. New orders reuse the current recipe; existing orders retain their component quantities.</p><TableViewport label="Bills of materials"><DataTable className="ui-table-spaced min-w-192"><thead><tr><th>Recipe</th><th>Output</th><th>Components</th><th>Status</th><th>Actions</th></tr></thead><tbody>{boms.map(b=><tr key={b.id}><td>{b.name}<p className="text-metadata text-ink-muted">{b.code} · Version {b.version}</p></td><td>{b.output_sku}<p className="text-metadata text-ink-muted">{formatQuantity(b.output_quantity)} {b.output_unit}</p></td><td>{b.components.map(c=><p key={c.item_id}>{c.sku} · {formatQuantity(c.quantity)} {c.unit}</p>)}</td><td>{b.is_active?'Active':'Archived'}</td><td><BomForm key={b.version} ledgerId={ledgerId} items={items} bom={b} action={bomAction}/></td></tr>)}{!boms.length&&<tr><td colSpan={5} className="py-10 text-center text-ink-muted">Add raw materials and an output item, then save your first recipe.</td></tr>}</tbody></DataTable></TableViewport></div>
}

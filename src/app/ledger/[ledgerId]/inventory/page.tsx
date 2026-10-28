import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { inventoryItems, inventorySettings } from '@/lib/inventory'
import {financeSetting} from '@/lib/operations-finance'
import {productionOrders} from '@/lib/production'
import { InventoryScreen } from './InventoryScreen'
import { saveItemAction,inventorySettingsAction } from './actions'
export const dynamic='force-dynamic'
export default async function InventoryPage({params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params;await requireLedger(ledgerId,'/inventory')
  const [head,items,settings,orders,finance]=await Promise.all([ledgerHead(ledgerId),inventoryItems(ledgerId),inventorySettings(ledgerId),productionOrders(ledgerId),financeSetting(ledgerId,'/inventory')]);if(!head)notFound()
  return <InventoryScreen ledgerId={ledgerId} entity={head.entity} currency={head.currency} items={items} openOrders={orders.filter(o=>o.status==='in_progress').length} orderWip={orders.filter(o=>o.status==='in_progress').reduce((n,o)=>n+BigInt(o.wip_cost),0n).toString()} finance={finance} settings={settings} itemAction={saveItemAction} settingsAction={inventorySettingsAction}/>
}

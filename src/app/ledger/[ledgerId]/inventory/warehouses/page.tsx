import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { inventoryWarehouses,inventorySettings } from '@/lib/inventory'
import { WarehousesScreen } from '../InventoryScreen'
import { inventorySettingsAction,warehouseAction } from '../actions'
export const dynamic='force-dynamic'
export default async function WarehousesPage({params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params;await requireLedger(ledgerId,'/inventory')
  const [head,warehouses,settings]=await Promise.all([ledgerHead(ledgerId),inventoryWarehouses(ledgerId),inventorySettings(ledgerId)]);if(!head)notFound()
  return <WarehousesScreen ledgerId={ledgerId} entity={head.entity} warehouses={warehouses} settings={settings} settingsAction={inventorySettingsAction} warehouseAction={warehouseAction}/>
}

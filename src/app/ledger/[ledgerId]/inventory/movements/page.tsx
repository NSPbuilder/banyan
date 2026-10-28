import { notFound } from 'next/navigation'
import { requireLedger } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { inventoryMovements,inventorySettings } from '@/lib/inventory'
import { MovementsScreen } from '../InventoryScreen'
export const dynamic='force-dynamic'
export default async function MovementsPage({params}:{params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params;await requireLedger(ledgerId,'/inventory')
  const [head,movements,settings]=await Promise.all([ledgerHead(ledgerId),inventoryMovements(ledgerId,undefined,1000),inventorySettings(ledgerId)]);if(!head)notFound()
  return <MovementsScreen ledgerId={ledgerId} entity={head.entity} currency={head.currency} movements={movements} warehousesEnabled={settings.warehouses_enabled}/>
}

import { requireLedger } from '@/lib/gate'
import {OperationsWorkspace,OperationsTabs} from '@/components/OperationsWorkspace'
export default async function InventoryLayout({children,params}:{children:React.ReactNode;params:Promise<{ledgerId:string}>}) {
  const {ledgerId}=await params;await requireLedger(ledgerId,'/inventory')
  return <OperationsWorkspace><OperationsTabs ledgerId={ledgerId} module="inventory"/>{children}</OperationsWorkspace>
}

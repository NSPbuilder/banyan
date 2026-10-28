import {requireLedger} from '@/lib/gate'
import {OperationsWorkspace,OperationsTabs} from '@/components/OperationsWorkspace'
export default async function AssetsLayout({children,params}:{children:React.ReactNode;params:Promise<{ledgerId:string}>}){const {ledgerId}=await params;await requireLedger(ledgerId,'/assets');return <OperationsWorkspace><OperationsTabs ledgerId={ledgerId} module="assets"/>{children}</OperationsWorkspace>}

import LegacyInbox from '../../automation/inbox/page'
import {requireLedger} from '@/lib/gate'
export const dynamic='force-dynamic'
export default async function Inbox(props:{params:Promise<{ledgerId:string}>}){const {ledgerId}=await props.params;await requireLedger(ledgerId,'/automation');return <LegacyInbox {...props}/>}

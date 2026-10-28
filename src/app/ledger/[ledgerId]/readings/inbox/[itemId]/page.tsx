import LegacyInbox from '../../../automation/inbox/[itemId]/page'
import {requireAutomationLedger} from '@/lib/automation-gate'
export const dynamic='force-dynamic'
export default async function Inbox(props:{params:Promise<{ledgerId:string;itemId:string}>}){const {ledgerId}=await props.params;await requireAutomationLedger(ledgerId,['/invoices','/entries']);return <LegacyInbox {...props}/>}

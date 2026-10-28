import LegacyEmail from '../../automation/mail/page'
import {requireAutomationLedger} from '@/lib/automation-gate'
export const dynamic='force-dynamic'
export default async function Email(props:{params:Promise<{ledgerId:string}>}){const {ledgerId}=await props.params;await requireAutomationLedger(ledgerId,['/invoices']);return <LegacyEmail {...props}/>}

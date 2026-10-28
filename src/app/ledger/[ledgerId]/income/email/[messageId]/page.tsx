import LegacyEmail from '../../../automation/mail/[messageId]/page'
import {requireAutomationLedger} from '@/lib/automation-gate'
export const dynamic='force-dynamic'
export default async function Email(props:{params:Promise<{ledgerId:string;messageId:string}>}){const {ledgerId}=await props.params;await requireAutomationLedger(ledgerId,['/invoices']);return <LegacyEmail {...props}/>}

import LegacyEmail from '../../../automation/mail/new/page'
import {requireAutomationLedger} from '@/lib/automation-gate'
export const dynamic='force-dynamic'
export default async function Email(props:{params:Promise<{ledgerId:string}>;searchParams:Promise<{invoice?:string;party?:string;parent?:string}>}){const {ledgerId}=await props.params;await requireAutomationLedger(ledgerId,['/invoices']);return <LegacyEmail {...props}/>}

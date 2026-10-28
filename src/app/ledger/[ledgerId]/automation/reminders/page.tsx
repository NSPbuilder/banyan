import {redirect} from 'next/navigation'
import {requireAutomationLedger} from '@/lib/automation-gate'
import {serviceSettingsPath} from '@/lib/workflow-links'
export const dynamic='force-dynamic'
export default async function ReminderSettings({params}:{params:Promise<{ledgerId:string}>}){const {ledgerId}=await params;await requireAutomationLedger(ledgerId,['/invoices']);redirect(serviceSettingsPath(ledgerId,'reminders'))}

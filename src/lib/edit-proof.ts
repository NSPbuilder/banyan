export const EDIT_RESOURCES = {
  invoice:{table:'invoice',leaseKey:'invoice_id',seat:'/invoices',path:'invoices'},
  entry:{table:'journal_entry',leaseKey:'journal_entry_id',seat:'/entries',path:'entries'},
  inbox:{table:'inbox_item',leaseKey:'inbox_item_id',seat:'/automation',path:'automation/inbox'},
  recurring:{table:'recurring_template',leaseKey:'recurring_template_id',seat:'/automation',path:'automation/recurring'},
  reminder:{table:'reminder_rule',leaseKey:'reminder_rule_id',seat:'/automation',path:'automation/reminders'},
  migration:{table:'migration_run',leaseKey:'migration_run_id',seat:'/opening',path:'opening/migration'},
  payment:{table:'payment_connection',leaseKey:'payment_connection_id',seat:'/automation',path:'automation/payments'},
  inbound:{table:'inbound_connection',leaseKey:'inbound_connection_id',seat:'/automation',path:'automation/inbound'},
  budget:{table:'budget',leaseKey:'budget_id',seat:'/reports',path:'reports/budgets'},
  account:{table:'account',leaseKey:'account_id',seat:'/accounts',path:'accounts'},
  party:{table:'party',leaseKey:'party_id',seat:'/parties',path:'parties'},
} as const
export type EditResource = { ledgerId: string; type: keyof typeof EDIT_RESOURCES; id: string }
export type EditProof = { version: string; tabId?: string; token?: string; generation?: string }
export type EditContext = { sessionToken: string; proof: EditProof; leaseRequired: boolean }
/** Public build-time timings; no credential or private configuration exposed. */
export function leaseClientTiming() {
  const heartbeat=Number(process.env.NEXT_PUBLIC_EDIT_HEARTBEAT_SECONDS ?? 30)
  const idle=Number(process.env.NEXT_PUBLIC_EDIT_IDLE_MINUTES ?? 15)
  if(!Number.isSafeInteger(heartbeat) || heartbeat<5 || heartbeat>30 || !Number.isSafeInteger(idle) || idle<1 || idle>60)
    throw Error('Edit heartbeat must be 5–30 seconds; idle timeout 1–60 minutes.')
  return {heartbeatMs:heartbeat*1000,idleMs:idle*60_000}
}
export function proofFrom(form: FormData): EditProof {
  const get = (key: string) => String(form.get(key) ?? '')
  return { version: get('expectedVersion'), tabId: get('editTab'), token: get('editToken'), generation: get('editGeneration') }
}

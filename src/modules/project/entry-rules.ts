import { sql } from 'drizzle-orm'
import type { Tx } from '@/lib/acting'
import type { EditResource } from '@/lib/edit-proof'
import type { FinanceResource } from '@/lib/module-extensions'
import { EditConflict } from '@/lib/edit-leases'

export async function assertEditable(tx: Tx, r: EditResource) {
  if (r.type === 'invoice') {
    const linked = await tx.execute(sql`SELECT 1 FROM project_accounting_link WHERE invoice_id=${r.id}::uuid`)
    if (linked.length) throw new EditConflict(403, 'Edit this document in Project.')
  }
}

export async function beforeFinanceDelete(tx: Tx, resource: FinanceResource) {
  if (resource.type !== 'payment') return
  const entryId = resource.id
    await tx.execute(sql`SELECT set_config('erp.project_write','on',true)`)
    await tx.execute(sql`UPDATE project_payment_allocation SET state='void',version=version+1 WHERE payment_id IN (SELECT payment_id FROM project_accounting_payment WHERE entry_id=${entryId}::uuid) AND state='active'`)
    await tx.execute(sql`UPDATE project_payment SET state='void',version=version+1 WHERE id IN (SELECT payment_id FROM project_accounting_payment WHERE entry_id=${entryId}::uuid) AND state='active'`)
}

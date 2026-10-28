import type { Tx } from '@/lib/acting'
import type { ModuleRestoreContext } from '@/lib/module-extensions'
import { sql } from 'drizzle-orm'

export const backupParties = (entityId: string) => [
  sql`SELECT party_id FROM crm_account WHERE entity_id=${entityId}::uuid`,
  sql`SELECT converted_party_id FROM crm_lead WHERE entity_id=${entityId}::uuid AND converted_party_id IS NOT NULL`,
]

export async function afterRestore(tx: Tx, { rows, entityId }: ModuleRestoreContext) {
  if ((rows.crm_pipeline?.length ?? 0) === 0) await tx.execute(sql`SELECT seed_crm_pipeline_for_entity(${entityId}::uuid)`)
}

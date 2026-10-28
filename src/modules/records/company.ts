import { sql } from 'drizzle-orm'
import { OPEN_THE_REGISTER } from '@/lib/records'
import type { Tx } from '@/lib/acting'

export async function beforeCompanyDelete(tx: Tx) { await tx.execute(OPEN_THE_REGISTER) }
export async function deleteCompanyRows(tx: Tx, table: string, selector: string, entityId: string) {
  if (selector !== 'shareClass') return false
  await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE share_class_id IN (SELECT id FROM share_class WHERE entity_id=${entityId}::uuid)`)
  return true
}

import { sql, type SQL } from 'drizzle-orm'

export const backupScopes: Record<string, (t: string, id: string) => SQL> = {
payRun: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE pay_run_id IN (
      SELECT p.id FROM pay_run p JOIN ledger l ON l.id = p.ledger_id WHERE l.entity_id = ${id}::uuid)`,
}

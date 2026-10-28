import { sql, type SQL } from 'drizzle-orm'

export const backupScopes: Record<string, (t: string, id: string) => SQL> = {
sredProject: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE project_id IN (
      SELECT p.id FROM sred_project p WHERE p.entity_id = ${id}::uuid)`,
sredClaim: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE claim_id IN (
      SELECT c.id FROM sred_claim c JOIN sred_project p ON p.id = c.project_id
       WHERE p.entity_id = ${id}::uuid)`,
}

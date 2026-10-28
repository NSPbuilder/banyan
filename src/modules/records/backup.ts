import { sql, type SQL } from 'drizzle-orm'

export const backupScopes: Record<string, (t: string, id: string) => SQL> = {
shareClass: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE share_class_id IN (
      SELECT s.id FROM share_class s WHERE s.entity_id = ${id}::uuid)`,
minuteBook: (t, id) => sql`
    SELECT * FROM ${sql.raw(t)} WHERE minute_book_entry_id IN (
      SELECT m.id FROM minute_book_entry m WHERE m.entity_id = ${id}::uuid)`,
}

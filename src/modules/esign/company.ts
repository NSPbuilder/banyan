import { sql, type SQL } from 'drizzle-orm'

export const companyActivity = (entity: SQL) => sql`(SELECT count(*) FROM esign_document x WHERE x.entity_id=${entity})`

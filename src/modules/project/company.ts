import { sql, type SQL } from 'drizzle-orm'

export const companyActivity = (entity: SQL) => sql`(SELECT count(*) FROM project x WHERE x.entity_id=${entity})`

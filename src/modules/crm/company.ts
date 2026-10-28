import { sql, type SQL } from 'drizzle-orm'

export const companyActivity = (entity: SQL) => sql`(SELECT count(*) FROM crm_account x WHERE x.entity_id=${entity}) + (SELECT count(*) FROM crm_lead x WHERE x.entity_id=${entity}) + (SELECT count(*) FROM crm_opportunity x WHERE x.entity_id=${entity}) + (SELECT count(*) FROM crm_activity x WHERE x.entity_id=${entity}) + (SELECT count(*) FROM crm_task x WHERE x.entity_id=${entity})`

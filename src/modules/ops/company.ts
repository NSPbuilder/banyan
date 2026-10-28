import { sql, type SQL } from 'drizzle-orm'

export const companyActivity = (entity: SQL) => sql`(SELECT count(*) FROM asset_cca_pool x JOIN ledger l ON l.id=x.ledger_id WHERE l.entity_id=${entity}) + (SELECT count(*) FROM fixed_asset x JOIN ledger l ON l.id=x.ledger_id WHERE l.entity_id=${entity}) + (SELECT count(*) FROM inventory_item x JOIN ledger l ON l.id=x.ledger_id WHERE l.entity_id=${entity}) + (SELECT count(*) FROM inventory_warehouse x JOIN ledger l ON l.id=x.ledger_id WHERE l.entity_id=${entity} AND NOT x.is_default)`

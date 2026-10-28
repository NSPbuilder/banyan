import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting } from './acting'
import { auditRow } from './audit-row'
import { AccessError } from './access'
import { MODULE_PATHS } from './nav'
import type { UserRecord } from './users'
import { initializeModuleCompany } from './module-extensions'
import { effectiveCompanyModules } from './company-module-defaults'

/** Project needs explicit company activation; other missing switches stay enabled. */
export async function companyModulePolicies() {
  const rows = await db.execute<{ entity_id: string; module: string | null; enabled: boolean | null }>(sql`
    SELECT e.id::text AS entity_id, c.module, c.enabled FROM entity e
    LEFT JOIN company_module_access c ON c.entity_id=e.id`)
  const grouped: Record<string, { module: string; enabled: boolean }[]> = {}
  for (const row of rows) {
    grouped[row.entity_id] ??= []
    if (row.module !== null && row.enabled !== null) grouped[row.entity_id].push({ module: row.module, enabled: row.enabled })
  }
  return Object.fromEntries(Object.entries(grouped).map(([id, switches]) => [id, effectiveCompanyModules(switches)]))
}

export async function setCompanyModules(me: UserRecord, input: {
  entityId: string; modules: string[]; expectedModules?: string[]
}) {
  if (me.kind !== 'superadmin') throw new AccessError('SUPERADMIN_ONLY', 'Only the superadmin can manage company modules.')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.entityId)) throw new AccessError('BAD_ID', 'Choose a valid company.')
  const modules = [...new Set(input.modules)]
  if (modules.some(m => !MODULE_PATHS.includes(m))) throw new AccessError('NO_SUCH_MODULE', 'Choose modules from the list.')
  await db.transaction(async tx => {
    await acting(tx, me.email)
    const [company] = await tx.execute<{ id: string; name: string }>(sql`SELECT id::text, name FROM entity WHERE id = ${input.entityId}::uuid FOR UPDATE`)
    if (!company) throw new AccessError('NO_COMPANY', 'That company does not exist.')
    const old = await tx.execute<{ module: string; enabled: boolean }>(sql`SELECT module, enabled FROM company_module_access WHERE entity_id = ${company.id}::uuid`)
    const before = effectiveCompanyModules(old)
    if (input.expectedModules && JSON.stringify([...input.expectedModules].sort()) !== JSON.stringify([...before].sort())) throw new AccessError('CONFLICT', 'Company access changed. Reload this page before saving.')
    if (JSON.stringify([...before].sort()) === JSON.stringify([...modules].sort())) {
      await initializeModuleCompany(tx, company.id, me.email, modules)
      return
    }
    for (const seat of MODULE_PATHS) await tx.execute(sql`
      INSERT INTO company_module_access(entity_id, module, enabled, updated_by)
      VALUES (${company.id}::uuid, ${seat}, ${modules.includes(seat)}, ${me.email})
      ON CONFLICT(entity_id, module) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`)
    await initializeModuleCompany(tx, company.id, me.email, modules)
    // A disabled folder must not revive an existing WebDAV credential later.
    if (!modules.some(m => ['/entries', '/invoices', '/records'].includes(m))) await tx.execute(sql`
      UPDATE webdav_credential SET revoked_at = now() WHERE entity_id = ${company.id}::uuid AND revoked_at IS NULL`)
    await auditRow(tx, { actor: me.email, action: 'set_modules', table: 'company_module_access', recordId: company.id,
      before: { modules: before }, after: { modules }, entityId: company.id, scope: 'company', targetLabel: company.name })
  })
}

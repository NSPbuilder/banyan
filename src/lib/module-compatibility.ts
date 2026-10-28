import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { excludedModules } from '@/assembly/excluded'
import type { ModuleExclusion } from './module-contract'

export class ModuleCompatibilityError extends Error {
  readonly code = 'MODULE_DATA_PRESENT'
}

/** Read-only: omitted module data is retained and must never become invisible to writes. */
export async function assertModuleCompatibility(exclusions: readonly ModuleExclusion[]) {
  const candidates = exclusions.flatMap(module => module.tables.map(table => ({ id: module.id, table })))
  if (!candidates.length) return
  const present = new Set((await db.execute<{ name: string }>(sql`
    SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public'`)).map(row => row.name))
  const queries = candidates.filter(candidate => present.has(candidate.table)).map(candidate => sql`
    SELECT ${candidate.id}::text AS module, ${candidate.table}::text AS table_name
    WHERE EXISTS (SELECT 1 FROM ${sql.identifier(candidate.table)} LIMIT 1)`)
  if (!queries.length) return
  const [occupied] = await db.execute<{ module: string; table_name: string }>(sql`${sql.join(queries, sql` UNION ALL `)} LIMIT 1`)
  if (occupied) throw new ModuleCompatibilityError(
    `This database contains ${occupied.module} data (${occupied.table_name}). Include that module in the assembly before opening it. No data was changed.`)
}

let compatible: Promise<void> | undefined
export function assertDeploymentModules() {
  return compatible ??= assertModuleCompatibility(excludedModules)
}

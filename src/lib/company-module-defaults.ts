import { defaultDisabledSeats } from './module-manifests'
import { MODULE_PATHS } from './nav'

/** Project is an opt-in workflow; ordinary accounting modules retain their defaults. */
export const DEFAULT_COMPANY_MODULES = MODULE_PATHS.filter(m => !defaultDisabledSeats.has(m))

export function effectiveCompanyModules(rows: { module: string; enabled: boolean }[]) {
  const enabled = new Set(DEFAULT_COMPANY_MODULES)
  for (const row of rows) {
    if (!MODULE_PATHS.includes(row.module)) continue
    if (row.enabled) enabled.add(row.module)
    else enabled.delete(row.module)
  }
  return MODULE_PATHS.filter(m => enabled.has(m))
}

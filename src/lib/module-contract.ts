import type { NavItem } from './nav'
import type { AssistantSkill } from './assistant-skills'
import type { Destination } from './destinations'
import type { Entry as ReportDefinition, ReportKey } from './report-catalogue'

/** The source and release ownership vocabulary. Safe in browser bundles. */
export type ModuleId =
  | 'FW' | 'GL' | 'ARAP' | 'BANK' | 'TAX' | 'FX'
  | 'AI' | 'MCP' | 'AUTO' | 'IMPORT' | 'BUDGET' | 'PORTAL'
  | 'PAYROLL' | 'RECORDS' | 'CRM' | 'ESIGN' | 'PROJECT' | 'OPS' | 'SRED'

/** Owner's release boundary, 2026-10-22. These always ship together. */
export const BASE_MODULES: readonly ModuleId[] = [
  'FW', 'GL', 'ARAP', 'BANK', 'TAX', 'FX', 'AI', 'MCP', 'AUTO', 'IMPORT', 'BUDGET', 'PORTAL',
]
export const ADDON_MODULES = ['PAYROLL', 'RECORDS', 'CRM', 'ESIGN', 'PROJECT', 'OPS', 'SRED'] as const
export type AddonId = typeof ADDON_MODULES[number]

/** Source locations are consumed by the assembler, never imported by the core. */
export type ModuleManifest = {
  id: AddonId
  name: string
  requires: readonly AddonId[]
  seats: readonly string[]
  routes?: readonly string[]
  /** Exact regular expressions for independently authenticated callback routes. */
  publicRoutes?: readonly string[]
  /** Migration-seeded reference rows may remain without the module. */
  referenceTables?: readonly string[]
  defaultDisabledSeats?: readonly string[]
  server?: string
  settings?: string
  readings?: string
  navigation?: ReadonlyArray<NavItem & { order: number }>
  addMenu?: ReadonlyArray<{ label: string; path: string; order: number }>
  skills?: ReadonlyArray<AssistantSkill & { order: number }>
  destinations?: ReadonlyArray<Destination & { order: number }>
  reports?: Readonly<Partial<Record<ReportKey, ReportDefinition>>>
  journalPrefixes?: Readonly<Record<string, string>>
  company?: {
    first?: ReadonlyArray<{ table: string; by: string; order: number }>
    byEntity?: ReadonlyArray<{ table: string; order: number }>
    retained?: ReadonlyArray<{ table: string; order: number }>
  }
  backup?: {
    companyData?: ReadonlyArray<{ table: string; by: string; order: number }>
    excluded?: Readonly<Record<string, string>>
    notCarried?: Readonly<Record<string, string[]>>
    unique?: Readonly<Record<string, string>>
    blobReferences?: ReadonlyArray<{ table: string; column?: string; notNull?: boolean; order: number }>
    storage?: ReadonlyArray<{ domain: string; table: string; rowOwner: string; fileOwner: string; minFormat: number; mapKey: string }>
    restoredIds?: ReadonlyArray<{ key: string; table: string }>
  }
}

export type ModuleExclusion = { id: AddonId; paths: readonly string[]; tables: readonly string[] }

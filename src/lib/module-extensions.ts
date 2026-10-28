import 'server-only'
import type { Tx } from './acting'
import type { AddonId } from './module-contract'
import { serverExtensions } from '@/assembly/server'
import type { Query } from './query'
import type { Hit } from './search'
import type { ReactNode } from 'react'
import type { UserRecord } from './users'
import type { Tool } from './inquiry-tool-runtime'
import { sql, type SQL } from 'drizzle-orm'
import type { FigtreeFile } from './backup'
import type { EditResource } from './edit-proof'

export type FinanceResource = { type: 'invoice' | 'payment'; id: string }
export type ModuleDataExport = { csv: string; rows: Array<Array<string | number>>; entity: string }
export type FinanceViewContext = {
  type: 'entry' | 'invoice'; id: string; ledgerId: string; entityId: string; user: UserRecord; sourceType?: string
}
export type FinanceView = {
  order?: number; managed?: boolean; blocksCopy?: boolean; panel?: ReactNode
  editTarget?: { seat: string; href: string; label: string; accessible: boolean }
}
export type SkillCommandInput = { ledgerId: string; inquiryId: string; stepN: number; user: UserRecord }
export type ModulePaper = {
  id: string; entity: string; sha256: string; uploaded: string; filename: string; mime: string
  byte_size: string; created_at: string; destination: string; folderLabel: string; seat: string
}
export type BackupRows = Record<string, Array<Record<string, unknown>>>
export type ModuleRestoreContext = { rows: BackupRows; map: Map<string, string>; entityId: string }
export type ModuleFileRestoreContext = { entityId: string; maps: Record<string, Record<string, string>> }
export type ModuleExtension = {
  id: AddonId
  lockFinance?: (tx: Tx, resource: FinanceResource) => Promise<void>
  initializeCompany?: (tx: Tx, entityId: string, actor: string, seats: readonly string[]) => Promise<void>
  inputError?: (error: unknown) => boolean
  dataExports?: Record<string, (ledgerId: string, args: Readonly<Record<string, string>>) => Promise<ModuleDataExport | null>>
  owns?: (kind: string, id: string, ledgerId: string) => Promise<boolean | undefined>
  searches?: Array<{ order: number; run: (ledgerId: string, query: Query, limit: number) => Promise<Hit[]> }>
  financeView?: (context: FinanceViewContext) => Promise<FinanceView | null>
  inquiryTools?: readonly Tool[]
  skillCommands?: Record<string, (input: SkillCommandInput) => Promise<string>>
  paperFiles?: (entityId: string) => Promise<ModulePaper[]>
  companyActivity?: (entity: SQL) => SQL
  beforeCompanyDelete?: (tx: Tx, entityId: string, actor: string) => Promise<void>
  deleteCompanyRows?: (tx: Tx, table: string, selector: string, entityId: string) => Promise<boolean>
  backupScopes?: Record<string, (table: string, entityId: string) => SQL>
  backupParties?: (entityId: string) => SQL[]
  backupFiles?: (rows: BackupRows, entityId: string) => Promise<FigtreeFile['files']>
  restoreRow?: (table: string, row: Record<string, unknown>, map: Map<string, string>) => Record<string, unknown>
  restoreOrder?: number
  afterRestore?: (tx: Tx, context: ModuleRestoreContext) => Promise<void>
  restoreFile?: (file: FigtreeFile['files'][number], context?: ModuleFileRestoreContext) => Promise<boolean>
  assertEditable?: (tx: Tx, resource: EditResource) => Promise<void>
  beforeFinanceDelete?: (tx: Tx, resource: FinanceResource) => Promise<void>
  entryChange?: (tx: Tx, entry: { id: string; sourceType: string; operation: 'amend' | 'reverse' }) => Promise<void>
}

/** Load only at a call boundary, after the caller's database modules initialized. */
let loadedExtensions: Promise<ModuleExtension[]> | undefined
export async function moduleExtensions(): Promise<ModuleExtension[]> {
  return loadedExtensions ??= Promise.all(serverExtensions.map(load => load()))
}

/** Keep source locks inside the caller's transaction and before document locks. */
export async function lockFinanceResource(tx: Tx, type: FinanceResource['type'], id: string) {
  for (const extension of await moduleExtensions()) await extension.lockFinance?.(tx, { type, id })
}

export async function initializeModuleCompany(tx: Tx, entityId: string, actor: string, seats: readonly string[]) {
  for (const extension of await moduleExtensions()) await extension.initializeCompany?.(tx, entityId, actor, seats)
}

export async function moduleInputError(error: unknown) {
  return (await moduleExtensions()).some(extension => extension.inputError?.(error))
}

export async function moduleDataExport(kind: string, ledgerId: string, args: Readonly<Record<string, string>>) {
  const providers = (await moduleExtensions()).filter(extension => extension.dataExports?.[kind])
  if (providers.length > 1) throw new Error(`More than one module owns export ${kind}.`)
  return providers[0]?.dataExports?.[kind](ledgerId, args) ?? null
}

export async function moduleOwns(kind: string, id: string, ledgerId: string) {
  for (const extension of await moduleExtensions()) {
    const owned = await extension.owns?.(kind, id, ledgerId)
    if (owned !== undefined) return owned
  }
  return false
}

export async function moduleSearchGroups(ledgerId: string, query: Query, limit: number) {
  const readers = (await moduleExtensions()).flatMap(extension => extension.searches ?? [])
  return Promise.all(readers.map(async reader => ({ order: reader.order, hits: await reader.run(ledgerId, query, limit) })))
}

export async function moduleFinanceView(context: FinanceViewContext) {
  const results = await Promise.all((await moduleExtensions()).map(extension => extension.financeView?.(context)))
  const views = results.filter((view): view is FinanceView => view != null).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const targets = views.flatMap(view => view.editTarget ? [view.editTarget] : [])
  if (targets.length > 1) throw new Error('More than one module controls this document.')
  return {
    managed: views.some(view => view.managed), blocksCopy: views.some(view => view.blocksCopy),
    panels: views.map(view => view.panel), editTarget: targets[0],
  }
}

export async function moduleInquiryTools() {
  return (await moduleExtensions()).flatMap(extension => extension.inquiryTools ?? [])
}

export async function moduleSkillCommand(skill: string, input: SkillCommandInput) {
  const commands = (await moduleExtensions()).flatMap(extension => extension.skillCommands?.[skill] ? [extension.skillCommands[skill]] : [])
  if (commands.length > 1) throw new Error(`More than one module owns confirmed commands for ${skill}.`)
  return commands[0]?.(input) ?? null
}

export async function modulePapers(entityId: string, seats?: readonly string[]) {
  const papers = (await Promise.all((await moduleExtensions()).map(extension => extension.paperFiles?.(entityId) ?? []))).flat()
  return seats ? papers.filter(paper => seats.includes(paper.seat)) : papers
}

export async function moduleCompanyActivity(entity: SQL) {
  const counts = (await moduleExtensions()).flatMap(extension => extension.companyActivity ? [extension.companyActivity(entity)] : [])
  return counts.length ? sql.join(counts.map(count => sql`(${count})`), sql` + `) : sql`0`
}

export async function beforeModuleCompanyDelete(tx: Tx, entityId: string, actor: string) {
  for (const extension of await moduleExtensions()) await extension.beforeCompanyDelete?.(tx, entityId, actor)
}

export async function deleteModuleCompanyRows(tx: Tx, table: string, selector: string, entityId: string) {
  for (const extension of await moduleExtensions()) {
    if (await extension.deleteCompanyRows?.(tx, table, selector, entityId)) return
  }
  throw new Error(`No installed module owns company selector ${selector}.`)
}

export async function moduleBackupScope(selector: string, table: string, entityId: string) {
  const readers = (await moduleExtensions()).flatMap(extension => extension.backupScopes?.[selector] ? [extension.backupScopes[selector]] : [])
  if (readers.length !== 1) throw new Error(`Expected one module to own backup selector ${selector}.`)
  return readers[0](table, entityId)
}

export async function moduleBackupParties(entityId: string) {
  return (await moduleExtensions()).flatMap(extension => extension.backupParties?.(entityId) ?? [])
}

export async function moduleBackupFiles(rows: BackupRows, entityId: string) {
  return (await Promise.all((await moduleExtensions()).map(extension => extension.backupFiles?.(rows, entityId) ?? []))).flat()
}

export async function moduleRestoredRow(table: string, row: Record<string, unknown>, map: Map<string, string>) {
  for (const extension of await moduleExtensions()) row = extension.restoreRow?.(table, row, map) ?? row
  return row
}

export async function afterModuleRestore(tx: Tx, context: ModuleRestoreContext) {
  const extensions = [...await moduleExtensions()].sort((a, b) => (a.restoreOrder ?? 0) - (b.restoreOrder ?? 0))
  for (const extension of extensions) await extension.afterRestore?.(tx, context)
}

export async function restoreModuleFile(file: FigtreeFile['files'][number], context?: ModuleFileRestoreContext) {
  for (const extension of await moduleExtensions()) if (await extension.restoreFile?.(file, context)) return true
  return false
}

export async function assertModuleEditable(tx: Tx, resource: EditResource) {
  for (const extension of await moduleExtensions()) await extension.assertEditable?.(tx, resource)
}

export async function beforeModuleFinanceDelete(tx: Tx, resource: FinanceResource) {
  for (const extension of await moduleExtensions()) await extension.beforeFinanceDelete?.(tx, resource)
}

export async function moduleEntryChange(tx: Tx, entry: { id: string; sourceType: string; operation: 'amend' | 'reverse' }) {
  for (const extension of await moduleExtensions()) await extension.entryChange?.(tx, entry)
}

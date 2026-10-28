import { structuredReadingExtensions } from '@/assembly/readings'

export type ReadRows = Partial<Record<string, Array<Record<string, string>>>>
export type ReadingTableWords = { title: string; one: string; many: string; list: string }
export type StructuredReadingExtension = {
  tableWords: Readonly<Record<string, ReadingTableWords>>
  rowsFrom: (raw: unknown) => ReadRows
  rowsMenu: () => string
}

export const STRUCTURED_TABLE_WORDS: Readonly<Record<string, ReadingTableWords>> =
  Object.assign({}, ...structuredReadingExtensions.map(extension => extension.tableWords))

export function structuredRowsFrom(raw: unknown): ReadRows {
  return Object.assign({}, ...structuredReadingExtensions.map(extension => extension.rowsFrom(raw)))
}
export const structuredRowsMenu = () => structuredReadingExtensions.map(extension => extension.rowsMenu()).join(' ')
export const structuredRowCounts = (rows: ReadRows): Array<[string, number]> =>
  Object.keys(STRUCTURED_TABLE_WORDS).flatMap(table => rows[table]?.length ? [[table, rows[table]!.length] as [string, number]] : [])

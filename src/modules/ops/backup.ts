import { sql } from 'drizzle-orm'
import type { Tx } from '@/lib/acting'
import type { ModuleRestoreContext } from '@/lib/module-extensions'

function remapOperationsLocators(value:unknown,map:Map<string,string>):unknown {
 const keys=new Set(['id','assetId','asset_id','ledger_id','sourceId','source_id','entryId','entry_id','movement_id','orderId','order_id','item_id','timeId','payStubId','employeeId','employee_id','originalEntryId','expenseAccountId','accountId','account_id','openingAccountId','counterpartAccountId','taxAccountId','partyId','periodId','period_id','accrualId','settlementId','reverseOf','reversalId','layer_id'])
 if(Array.isArray(value))return value.map(v=>remapOperationsLocators(v,map))
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,keys.has(k)&&typeof v==='string'?map.get(v)??v:remapOperationsLocators(v,map)]))
 return value
}

export function restoreRow(table: string, value: Record<string, unknown>, map: Map<string, string>) {
  if (table==='operations_finance_setting') return {...value,opening_snapshot:remapOperationsLocators(value.opening_snapshot,map)}
  if (table==='operations_journal_event') return {...value,lines:remapOperationsLocators(value.lines,map),snapshot:remapOperationsLocators(value.snapshot,map)}
  if (['production_payroll_allocation','production_labour_period','production_labour_settlement'].includes(table)) return {...value,snapshot:remapOperationsLocators(value.snapshot,map)}
  return value
}
export async function afterRestore(tx: Tx, { rows, map }: ModuleRestoreContext) {
  for (const row of rows.ledger ?? []) await tx.execute(sql`SELECT operations_validate_ledger(${map.get(String(row.id))!}::uuid)`)
}

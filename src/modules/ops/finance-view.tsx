import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { refuseForLedger } from '@/lib/access'
import type { FinanceViewContext, FinanceView } from '@/lib/module-extensions'

export async function financeView(context: FinanceViewContext): Promise<FinanceView | null> {
  const { type, id: entryId, ledgerId, sourceType, user } = context
  if (type !== 'entry' || !['fixed_asset','asset_depreciation','asset_deferred_tax','inventory','production','operations_opening'].includes(sourceType ?? '')) return null
  const [operation]=await db.execute<{seat:'/assets'|'/inventory';source_kind:string;source_id:string;movement_id:string|null;asset_id:string|null;order_id:string|null}>(sql`SELECT o.seat,o.source_kind,o.source_id::text,o.movement_id::text,(SELECT asset_id::text FROM asset_depreciation_entry WHERE id=o.source_id) asset_id,(SELECT order_id::text FROM production_event WHERE id=o.source_id) order_id FROM operations_journal_event o WHERE o.ledger_id=${ledgerId}::uuid AND o.entry_id=${entryId}::uuid`)
  const mayOpen=operation&&!(await refuseForLedger(user,ledgerId,operation.seat))
  const href=operation?`/ledger/${ledgerId}`+(operation.order_id?`/inventory/production/${operation.order_id}`:operation.asset_id?`/assets/${operation.asset_id}`:['asset_acquisition','asset_disposal'].includes(operation.source_kind)?`/assets/${operation.source_id}`:operation.movement_id?`/inventory/movements/${operation.movement_id}`:`${operation.seat}/${operation.source_kind==='deferred_tax'?'deferred-tax':'finance'}`):''
  return { order: 0, managed: true, blocksCopy: true, panel: <p key="ops" className="mt-3 text-metadata text-ink-muted">Managed by {operation?.seat==='/inventory'?'Inventory':'Fixed assets'}. Review or correct the business at its source. {mayOpen&&<Link className="underline" href={href}>Open source record</Link>}</p> }
}

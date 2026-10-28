import 'server-only'
import {createHash} from 'node:crypto'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import type {Tx} from './acting'
import {operationDate,operationId} from './operations-scope'
import type {OperationsSeat,ReconciliationRow,OperationsJournalRow} from './operations-finance-types'

export async function operationsReconciliation(ledgerId:string,seat:OperationsSeat,date:string,on:Pick<Tx,'execute'>=db):Promise<ReconciliationRow[]> {
 operationId(ledgerId);operationDate(date)
 return on.execute<ReconciliationRow>(sql`SELECT s.*,m.account_id::text,a.code||' — '||a.name account_label,
   t.amount::text register_amount,coalesce(g.amount,0)::text gl_amount,(t.amount-coalesce(g.amount,0))::text difference
  FROM ledger l CROSS JOIN operations_account_specs(${seat}) s
  JOIN operations_financial_targets(${ledgerId}::uuid,${seat},${date}::date) t ON t.key=s.key
  LEFT JOIN operations_account m ON m.entity_id=l.entity_id AND m.seat=${seat} AND m.key=s.key
  LEFT JOIN account a ON a.id=m.account_id
  LEFT JOIN LATERAL(SELECT sum(jl.amount) amount FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
   WHERE jl.account_id=m.account_id AND je.ledger_id=l.id AND je.status IN ('posted','reversed') AND je.entry_date<=${date}::date) g ON true
  WHERE l.id=${ledgerId}::uuid ORDER BY s.code`)
}
export async function operationsLatestDate(ledgerId:string,seat:OperationsSeat,on:Pick<Tx,'execute'>=db) {
 const [r]=await on.execute<{date:string|null}>(sql`SELECT max(d)::text date FROM (
  SELECT acquired_on d FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND ${seat}='/assets'
  UNION ALL SELECT disposed_on FROM fixed_asset WHERE ledger_id=${ledgerId}::uuid AND ${seat}='/assets'
  UNION ALL SELECT entry_date FROM asset_depreciation_entry WHERE ledger_id=${ledgerId}::uuid AND ${seat}='/assets'
  UNION ALL SELECT reporting_date FROM asset_deferred_tax_review WHERE ledger_id=${ledgerId}::uuid AND ${seat}='/assets'
  UNION ALL SELECT movement_date FROM inventory_movement WHERE ledger_id=${ledgerId}::uuid AND ${seat}='/inventory'
  UNION ALL SELECT event_date FROM production_event WHERE ledger_id=${ledgerId}::uuid AND ${seat}='/inventory') x`)
 return r.date
}
export function reconciliationHash(rows:ReconciliationRow[],date:string,latest:string|null) {
 return createHash('sha256').update(JSON.stringify({rows:rows.map(r=>[r.key,r.account_id,r.register_amount,r.gl_amount]),date,latest})).digest('hex')
}
export function operationsJournalEvents(ledgerId:string,seat:OperationsSeat,from:string,to:string,on:Pick<Tx,'execute'>=db) {
 operationId(ledgerId);operationDate(from);operationDate(to)
 return on.execute<OperationsJournalRow>(sql`SELECT e.id::text,e.source_kind,e.source_id::text,e.movement_id::text,e.event_date::text,e.entry_id::text,j.entry_no,e.no_entry_reason
  FROM operations_journal_event e LEFT JOIN journal_entry j ON j.id=e.entry_id WHERE e.ledger_id=${ledgerId}::uuid AND e.seat=${seat} AND e.event_date BETWEEN ${from}::date AND ${to}::date ORDER BY e.event_date DESC,e.created_at DESC`)
}

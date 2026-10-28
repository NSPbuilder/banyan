import 'server-only'
import {sql} from 'drizzle-orm'
import {db} from '@/db/client'
import {operationDate,operationId,OperationsError} from './operations-scope'
import type {ProductionEventRow} from './production-types'
export type ProductionReportRow={id:string;event_date:string;kind:ProductionEventRow['kind'];order_id:string;order_no:string;output_name:string;warehouse:string;sku:string|null;unit:string|null;quantity:string;cost:string;wip_change:string;movement_id:string|null;entry_id:string|null;entry_no:string|null;no_entry_reason:string|null;note:string;created_by:string;employee_name:string|null;work_date:string|null;hours:string|null;pay_date:string|null;pay_run_id:string|null;payroll_entry_id:string|null;pay_stub_id:string|null;time_id:string|null;estimated_labour:string|null;actual_labour:string|null;labour_period_id:string|null;settlement_id:string|null}
export async function productionReport(ledgerId:string,from:string,to:string,orderId?:string) {
 operationId(ledgerId);operationDate(from);operationDate(to);if(orderId)operationId(orderId)
 if(from>to)throw new OperationsError('DATE','Report start must be on or before its end.')
 return db.execute<ProductionReportRow>(sql`SELECT e.id::text,e.event_date::text,e.kind,e.order_id::text,'PRD-'||lpad(o.sequence::text,6,'0') order_no,out.name output_name,w.name warehouse,i.sku,i.unit,e.quantity::text,e.cost::text,
  (CASE WHEN e.kind IN ('material_issue','conversion_cost','labour_accrual','labour_adjustment') THEN e.cost ELSE -e.cost END)::text wip_change,e.movement_id::text,j.entry_id::text,je.entry_no,j.no_entry_reason,e.note,e.created_by,
  p.name employee_name,t.work_date::text,(CASE WHEN e.kind IN ('labour_return','labour_accrual_return') THEN -coalesce(a.hours,t.hours) ELSE coalesce(a.hours,t.hours) END)::text hours,pr.pay_date::text,pr.id::text pay_run_id,pr.entry_id::text payroll_entry_id,ps.id::text pay_stub_id,t.id::text time_id,CASE WHEN e.kind='labour_accrual' THEN e.cost::text WHEN e.kind='labour_accrual_return' THEN (-e.cost)::text WHEN e.kind='labour_settlement' THEN st.estimated_cost::text ELSE NULL END estimated_labour,CASE WHEN e.kind='labour_settlement' THEN st.actual_cost::text ELSE NULL END actual_labour,coalesce(ac.period_id,st.period_id)::text labour_period_id,st.id::text settlement_id
  FROM production_event e JOIN production_order o ON o.id=e.order_id JOIN inventory_item out ON out.id=o.output_item_id JOIN inventory_warehouse w ON w.id=o.warehouse_id
  LEFT JOIN inventory_item i ON i.id=e.item_id LEFT JOIN production_labour_cost_adjustment lc ON lc.event_id=e.id LEFT JOIN production_labour_settlement st ON st.event_id=e.id OR st.id=lc.settlement_id
  LEFT JOIN production_labour_accrual_reversal av ON av.event_id=e.id LEFT JOIN production_labour_accrual ac ON ac.event_id=e.id OR ac.id=av.accrual_id
  LEFT JOIN production_labour_period lp ON lp.id=coalesce(ac.period_id,st.period_id)
  LEFT JOIN operations_journal_event j ON j.ledger_id=e.ledger_id AND j.source_kind='production' AND j.source_id=coalesce(st.event_id,e.id) LEFT JOIN journal_entry je ON je.id=j.entry_id
  LEFT JOIN production_payroll_reversal v ON v.event_id=e.id LEFT JOIN production_payroll_allocation a ON a.event_id=e.id OR a.id=v.allocation_id
  LEFT JOIN production_time t ON t.id=coalesce(a.time_id,ac.time_id) LEFT JOIN payroll_employee pe ON pe.id=coalesce(t.employee_id,lp.employee_id) LEFT JOIN party p ON p.id=pe.party_id LEFT JOIN pay_stub ps ON ps.id=coalesce(a.pay_stub_id,st.pay_stub_id) LEFT JOIN pay_run pr ON pr.id=ps.pay_run_id
  WHERE e.ledger_id=${ledgerId}::uuid AND e.event_date BETWEEN ${from}::date AND ${to}::date AND (${orderId??null}::uuid IS NULL OR e.order_id=${orderId??null}::uuid) ORDER BY e.event_date DESC,o.sequence,e.created_at,e.id`)
}

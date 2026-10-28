import { sql } from 'drizzle-orm'
import { PostingError } from '@/lib/posting'
import type { Tx } from '@/lib/acting'

export async function entryChange(tx: Tx, original: { id: string; sourceType: string; operation: 'amend' | 'reverse' }) {
  if (original.operation !== 'reverse') return
  const entryId = original.id
  if(['fixed_asset','asset_depreciation','asset_deferred_tax','inventory','production','operations_opening'].includes(original.sourceType))throw new PostingError('OPERATIONS_SOURCE','Correct this business through Fixed assets or Inventory; its source and journal must stay together.')
  if(original.sourceType==='payroll'&&(await tx.execute(sql`SELECT 1 FROM production_labour_settlement st JOIN pay_stub s ON s.id=st.pay_stub_id JOIN pay_run r ON r.id=s.pay_run_id WHERE r.entry_id=${entryId}::uuid AND st.reverse_of IS NULL AND NOT EXISTS(SELECT 1 FROM production_labour_settlement v WHERE v.reverse_of=st.id) UNION ALL SELECT 1 FROM production_payroll_allocation a JOIN pay_stub s ON s.id=a.pay_stub_id JOIN pay_run r ON r.id=s.pay_run_id WHERE r.entry_id=${entryId}::uuid AND NOT EXISTS(SELECT 1 FROM production_payroll_reversal v WHERE v.allocation_id=a.id)`)).length)throw new PostingError('PAYROLL_ALLOCATED','Reverse the active production labour allocations before reversing this payroll journal.')
}

import { PostingError } from '@/lib/posting'
import type { Tx } from '@/lib/acting'

export async function entryChange(_tx: Tx, original: { id: string; sourceType: string; operation: 'amend' | 'reverse' }) {
  if (original.operation !== 'amend') return
    // A payroll entry is the pay run's paper: its stubs are frozen once posted
    // (0051) and the PD7A and T4 read them, not the entry. Amending the entry
    // alone would leave a run pointing at a reversed entry — gone from the
    // remittance worksheet while its money stays in the liability (critic,
    // 2026-09-04). The run's own rule already says how to correct it.
    if (original.sourceType === 'payroll') {
      throw new PostingError('PAYROLL_ENTRY',
        'That entry is a pay run. Reverse the run and run it again — its stubs and the '
        + 'remittance figures follow the run, not the entry.')
    }

}

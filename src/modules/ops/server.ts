import { entryChange } from './entry-rules'
import { restoreRow, afterRestore } from './backup'
import { companyActivity } from './company'
import 'server-only'
import type { ModuleExtension } from '@/lib/module-extensions'
import { ensureOperationsAccountsCore } from '@/lib/operations-finance'

export const extension: ModuleExtension = {
  id: 'OPS', entryChange, restoreRow, afterRestore, restoreOrder: 10,
  companyActivity,
  financeView: async context => (await import('./finance-view')).financeView(context),
  async initializeCompany(tx, entityId, actor, seats) {
    for (const seat of ['/assets', '/inventory'] as const) {
      if (seats.includes(seat)) await ensureOperationsAccountsCore(tx, entityId, seat, actor)
    }
  },
}

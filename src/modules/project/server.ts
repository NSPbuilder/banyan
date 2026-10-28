import { assertEditable, beforeFinanceDelete } from './entry-rules'
import { afterRestore, restoreFile } from './backup'
import { backupParties, backupFiles } from './backup'
import { companyActivity } from './company'
import 'server-only'
import type { ModuleExtension } from '@/lib/module-extensions'
import { lockInvoiceProject, lockPaymentProjects } from '@/lib/project-finance-locks'
import { ensureProjectAccountsCore, ProjectAccountsError } from '@/lib/project-accounts'

export const extension: ModuleExtension = {
  id: 'PROJECT', assertEditable, beforeFinanceDelete, afterRestore, restoreFile, restoreOrder: 20, backupParties, backupFiles,
  companyActivity,
  financeView: async context => (await import('./finance-view')).financeView(context),
  inputError: error => error instanceof ProjectAccountsError,
  async initializeCompany(tx, entityId, actor, seats) {
    if (seats.includes('/projects')) await ensureProjectAccountsCore(tx, entityId, actor)
  },
  async lockFinance(tx, resource) {
    if (resource.type === 'invoice') await lockInvoiceProject(tx, resource.id)
    else await lockPaymentProjects(tx, resource.id)
  },
}

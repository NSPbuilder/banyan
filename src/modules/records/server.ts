import { backupScopes } from './backup'
import { beforeCompanyDelete, deleteCompanyRows } from './company'
import 'server-only'
import type { ModuleExtension } from '@/lib/module-extensions'
import { owns } from './ownership'
import { matchingShares, matchingMinutes } from './search'
import { inquiryTools } from './inquiry-tools'
import { paperFiles } from './attachments'

export const extension: ModuleExtension = {
  id: 'RECORDS', backupScopes, beforeCompanyDelete, deleteCompanyRows, owns, inquiryTools, paperFiles,
  searches: [{ order: 50, run: matchingShares }, { order: 60, run: matchingMinutes }],
}

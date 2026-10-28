import { entryChange } from './entry-rules'
import { backupScopes } from './backup'
import 'server-only'
import type { ModuleExtension } from '@/lib/module-extensions'
import { pd7aCsv } from './reports'
import { owns } from './ownership'
import { matchingEmployees, matchingPayRuns } from './search'
import { inquiryTools } from './inquiry-tools'

export const extension: ModuleExtension = {
  id: 'PAYROLL', entryChange, backupScopes,
  owns,
  inquiryTools,
  searches: [{ order: 80, run: matchingEmployees }, { order: 90, run: matchingPayRuns }],
  dataExports: { pd7a: (ledgerId, args) => pd7aCsv(ledgerId, Number(args.year)) },
}

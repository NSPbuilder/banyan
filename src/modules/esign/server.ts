import { restoreRow } from './backup'
import 'server-only'
import type { ModuleExtension } from '@/lib/module-extensions'
import { companyActivity } from './company'

export const extension: ModuleExtension = { id: 'ESIGN', restoreRow, companyActivity }

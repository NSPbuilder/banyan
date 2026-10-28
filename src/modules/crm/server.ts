import { afterRestore } from './backup'
import { backupParties } from './backup'
import { companyActivity } from './company'
import 'server-only'
import type { ModuleExtension } from '@/lib/module-extensions'
import { owns } from './ownership'
import { inquiryTools } from './inquiry-tools'
import { confirmCrmCommand } from './assistant-command'

export const extension: ModuleExtension = { id: 'CRM', afterRestore, restoreOrder: 30, backupParties, companyActivity, owns, inquiryTools, skillCommands: { crm: confirmCrmCommand } }

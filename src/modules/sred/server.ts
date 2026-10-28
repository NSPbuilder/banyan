import { backupScopes } from './backup'
import 'server-only'
import type { ModuleExtension } from '@/lib/module-extensions'
import { owns } from './ownership'
import { matchingSred } from './search'

export const extension: ModuleExtension = { id: 'SRED', backupScopes, owns, searches: [{ order: 100, run: matchingSred }] }

import 'server-only'
import type { ReactNode } from 'react'
import type { UserRecord } from './users'
import { settingsExtensions } from '@/assembly/settings'

export type SettingsExtensionContext = {
  section: string
  user: UserRecord
  ledger: { id: string; entity_id: string; entity: string; archived_at: string | null } | null
}
export type SettingsExtension = (context: SettingsExtensionContext) => ReactNode

export async function moduleSettingsPanels(context: SettingsExtensionContext) {
  return Promise.all(settingsExtensions.map(async load => (await load())(context)))
}

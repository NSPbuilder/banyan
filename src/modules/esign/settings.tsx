import type { SettingsExtension } from '@/lib/settings-extensions'
import { DocumensoSettings } from '@/app/settings/DocumensoSettings'

export const renderSettings: SettingsExtension = ({ section, user, ledger }) =>
  section === 'documents' && user.is_owner && ledger
    ? <DocumensoSettings ledgerId={ledger.id} company={{ id: ledger.entity_id, name: ledger.entity, archived_at: ledger.archived_at }} />
    : null

import { requireUser } from '@/lib/gate'
import { SecurityForm } from './SecurityForm'
import { SettingsFrame } from '@/components/SettingsFrame'
import {settingsContext} from '@/lib/settings-context'
import {passkeysEnabled,passkeysFor,passkeyConfig} from '@/lib/passkeys'
import {PasskeySettings} from './PasskeySettings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Account security' }

export default async function AccountSecurity({searchParams}:PageProps<'/settings/security'>) {
  const user = await requireUser(true)
  const view=await settingsContext(user,(await searchParams).ledger)
  const passkeys=passkeysEnabled()?{keys:await passkeysFor(user.id),rpID:passkeyConfig().rpID}:null
  return <SettingsFrame view={view} active="security">
      <h2 className="text-section-title font-semibold">Account security</h2>
      <p className="mt-2 text-sm">Authenticator {user.mfa_enabled ? 'enabled' : 'not enabled'}</p>
      <SecurityForm />
      {passkeys&&<PasskeySettings {...passkeys}/>}
    </SettingsFrame>
}

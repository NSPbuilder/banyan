'use client'
import { useActionForm } from '@/components/ActionForm'
import { securityAction, type SecurityState } from './actions'
import { BUTTON, QUIET, FIELD, REFUSAL } from '@/lib/ui'

export function SecurityForm() {
  const { state, pending, formProps } = useActionForm<SecurityState>(securityAction)
  return <form {...formProps} className="mt-6 max-w-xl space-y-4">
    {state.error && <p role="alert" className={REFUSAL}>{state.error}</p>}
    {state.ok && <p role="status" className="text-sm">{state.ok}</p>}
    <label className="block text-sm">Current password <input name="password" type="password" autoComplete="current-password" className={`mt-1 w-full ${FIELD}`} /></label>
    <label className="block text-sm">Authenticator or recovery code <input name="code" autoComplete="one-time-code" maxLength={64} className={`mt-1 w-full ${FIELD}`} /></label>
    <div className="flex flex-wrap gap-3">
      <button disabled={pending} name="operation" value="reauth" className={BUTTON}>Verify identity</button>
      <button disabled={pending} name="operation" value="begin" className={QUIET}>Set up authenticator</button>
      <button disabled={pending} name="operation" value="confirm" className={QUIET}>Confirm setup code</button>
      <button disabled={pending} name="operation" value="disable" className={QUIET}>Disable authenticator</button>
    </div>
    {state.setupKey && <p className="break-all text-sm">Enter this key in your authenticator (TOTP, SHA1, 6 digits, 30 seconds): <code>{state.setupKey}</code></p>}
    {state.recoveryCodes && <pre className="select-all whitespace-pre-wrap rounded border p-3 text-sm">{state.recoveryCodes.join('\n')}</pre>}
    <p className="text-xs text-ink-muted">Verify your identity before changing an authenticator. Each recovery code works once. Keep the codes offline.</p>
  </form>
}

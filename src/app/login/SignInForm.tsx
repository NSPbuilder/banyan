'use client'

import { useActionForm } from '@/components/ActionForm'
import { signInAction } from '@/app/user-actions'
import { USER_FIELDS as F } from '@/lib/forms'
import { BUTTON_WIDE, FIELD, REFUSAL } from '@/lib/ui'

const input =
  `mt-1 w-full ${FIELD}`
const label = 'block text-xs font-medium uppercase tracking-wide text-neutral-500'

export function SignInForm({ next }: { next: string }) {
  const { state, pending, formProps } = useActionForm(signInAction)

  return (
    <form {...formProps} className="mt-8 space-y-4">
      <input type="hidden" name={F.next} value={next} />
      {state.error && (
        <p role="alert" className={REFUSAL}>
          {state.error}
        </p>
      )}
      <div>
        <label htmlFor="si-email" className={label}>Email</label>
        <input id="si-email" name={F.email} type="email" required autoFocus
               autoComplete="username" className={input} />
      </div>
      <div>
        <label htmlFor="si-pw" className={label}>Password</label>
        <input id="si-pw" name={F.password} type="password" required
               autoComplete="current-password" className={input} />
      </div>
      <div>
        <label htmlFor="si-factor" className={label}>Authenticator or recovery code (if enabled)</label>
        <input id="si-factor" name="factor" type="text" autoComplete="one-time-code" maxLength={64} className={input} />
      </div>
      <button type="submit" disabled={pending}
              className={`w-full ${BUTTON_WIDE}`}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

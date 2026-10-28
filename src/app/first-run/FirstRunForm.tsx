'use client'

import { useActionForm } from '@/components/ActionForm'
import { firstRunAction } from '@/app/user-actions'
import { USER_FIELDS as F } from '@/lib/forms'
import { BUTTON_WIDE, FIELD, REFUSAL } from '@/lib/ui'

const input =
  `mt-1 w-full ${FIELD}`
const label = 'block text-xs font-medium uppercase tracking-wide text-neutral-500'

export function FirstRunForm() {
  const { state, pending, formProps } = useActionForm(firstRunAction)

  return (
    <form {...formProps} className="mt-8 space-y-4">
      {state.error && (
        <p role="alert" className={REFUSAL}>
          {state.error}
        </p>
      )}
      <div className="flex gap-3">
        <div className="flex-1">
          <label htmlFor="fr-first" className={label}>First name</label>
          <input id="fr-first" name={F.firstName} type="text" required autoFocus
                 className={input} />
        </div>
        <div className="flex-1">
          <label htmlFor="fr-last" className={label}>Last name</label>
          <input id="fr-last" name={F.lastName} type="text" className={input} />
        </div>
      </div>
      <div>
        <label htmlFor="fr-email" className={label}>Email</label>
        <input id="fr-email" name={F.email} type="email" required
               autoComplete="username" className={input} />

      </div>
      <div>
        <label htmlFor="fr-pw" className={label}>Password</label>
        <input id="fr-pw" name={F.password} type="password" required minLength={12}
               autoComplete="new-password" className={input} />

      </div>
      <button type="submit" disabled={pending}
              className={`w-full ${BUTTON_WIDE}`}>
        {pending ? 'Creating…' : 'Create account and sign in'}
      </button>
    </form>
  )
}

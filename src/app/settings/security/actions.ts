'use server'
import { cookies, headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { requireUser, SESSION_COOKIE } from '@/lib/gate'
import { authAttempt, manageMfa, reauthenticate } from '@/lib/auth-security'
import { trustedClientIp } from '@/lib/auth-client'
import { UserError } from '@/lib/users'

export type SecurityState = { ok?: string; error?: string; setupKey?: string; recoveryCodes?: string[] }
export async function securityAction(_previous: SecurityState, form: FormData): Promise<SecurityState> {
  const user = await requireUser(true)
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? ''
  const ip = trustedClientIp(await headers())
  const operation = String(form.get('operation') ?? '')
  try {
    if (operation === 'reauth') {
      await reauthenticate(token, String(form.get('password') ?? ''), String(form.get('code') ?? ''), ip)
      return { ok: 'Identity verified for five minutes.' }
    }
    if (!['begin', 'confirm', 'disable'].includes(operation)) return { error: 'Choose a security operation.' }
    await authAttempt('totp', user.email, ip)
    const result = await manageMfa(token, operation as 'begin' | 'confirm' | 'disable', String(form.get('code') ?? ''))
    if (operation !== 'begin') revalidatePath('/settings/security')
    return { ...result, ok: operation === 'confirm' ? 'Authenticator enabled. Store these recovery codes now; they are shown once.'
      : operation === 'disable' ? 'Authenticator disabled. Other sessions have been signed out.' : 'Setup expires in ten minutes. Verify a code to enable it.' }
  } catch (error) {
    return { error: error instanceof UserError ? error.message : 'Security operation unavailable. Check the server configuration.' }
  }
}

'use server'

import { cookies, headers } from 'next/headers'
import { trustedClientIp } from '@/lib/auth-client'
import { authAttempt } from '@/lib/auth-security'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { SESSION_COOKIE, requireOwner } from '@/lib/gate'
import { signOut } from '@/lib/users'
import {startSession} from '@/lib/session-cookie'
import {
  createUserFromForm, deleteUserFromForm, firstRunFromForm, setGrantsFromForm, setIdentityFromForm,
  setKindFromForm, setPasswordFromForm, setStatusFromForm, signInFromForm,
} from '@/lib/user-forms'
import type { UserFormResult } from '@/lib/forms'

/**
 * The doors that make somebody somebody.
 *
 * Kept apart from `app/actions.ts` because these are the only actions that run
 * for a caller who is NOT yet signed in, and that difference should be visible
 * in the file list rather than buried in a function.
 */

export async function signInAction(_prev: UserFormResult, formData: FormData): Promise<UserFormResult> {
  // Whatever this browser was carrying is about to be replaced, so it is ended
  // rather than left live and unreferenced (critic).
  const carried = (await cookies()).get(SESSION_COOKIE)?.value
  const result = await signInFromForm(formData, carried, trustedClientIp(await headers()))
  if (!result.token) return result
  await startSession(result.token)
  redirect(result.next ?? '/')            // throws; nothing below runs
}

export async function firstRunAction(_prev: UserFormResult, formData: FormData): Promise<UserFormResult> {
  const result = await firstRunFromForm(formData)
  if (!result.token) return result
  await startSession(result.token)
  redirect('/')
}

export async function signOutAction() {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) await signOut(token)
  jar.delete(SESSION_COOKIE)
  redirect('/login')
}

/**
 * The people doors. `requireOwner` is the threshold (superadmin or owner);
 * WHO on the far side of it may be changed is the ladder's question, asked in
 * the form layer with the acting person in hand.
 */
export async function createUserAction(_prev: UserFormResult, formData: FormData): Promise<UserFormResult> {
  const result = await createUserFromForm(formData, await requireOwner())
  if (result.ok) revalidatePath('/users')
  return result
}

export async function setPasswordAction(_prev: UserFormResult, formData: FormData): Promise<UserFormResult> {
  const actor = await requireOwner()
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? ''
  try {
    await authAttempt('reset', actor.email, trustedClientIp(await headers()))
  } catch { return { error: 'Verify your identity in Account security before resetting a password.' } }
  const result = await setPasswordFromForm(formData, actor, token)
  if (result.ok) revalidatePath('/users')
  return result
}

/** A name and email put right (0084). */
export async function setIdentityAction(_prev: UserFormResult, formData: FormData): Promise<UserFormResult> {
  const result = await setIdentityFromForm(formData, await requireOwner())
  if (result.ok) revalidatePath('/users')
  return result
}

export async function setStatusAction(_prev: UserFormResult, formData: FormData): Promise<UserFormResult> {
  const result = await setStatusFromForm(formData, await requireOwner())
  if (result.ok) revalidatePath('/users')
  return result
}

export async function setKindAction(_prev: UserFormResult, formData: FormData): Promise<UserFormResult> {
  const result = await setKindFromForm(formData, await requireOwner())
  if (result.ok) revalidatePath('/users')
  return result
}

export async function deleteUserAction(_prev: UserFormResult, formData: FormData): Promise<UserFormResult> {
  const result = await deleteUserFromForm(formData, await requireOwner())
  if (result.ok) revalidatePath('/users')
  return result
}

export async function setGrantsAction(_prev: UserFormResult, formData: FormData): Promise<UserFormResult> {
  const result = await setGrantsFromForm(formData, await requireOwner())
  if (result.ok) {
    revalidatePath('/users')
    revalidatePath('/settings')
  }
  return result
}

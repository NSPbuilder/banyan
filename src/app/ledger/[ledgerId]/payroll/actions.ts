'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireLedger, currentActor } from '@/lib/gate'
import { PAYROLL_FIELDS } from '@/lib/forms'
import { deleteEmployeeFromForm, runPayrollFromForm, saveEmployeeFromForm } from '@/lib/payroll/forms'
import type { FormState } from '@/app/actions'

/**
 * Payroll: one action per door. Both revalidate the whole module rather than
 * the page they were called from — a pay run changes the employee's year to
 * date, the run list, the journal and the overview at once, and a screen
 * showing last week's figure beside this week's is the sort of thing nobody
 * notices until the remittance is wrong.
 */
export async function saveEmployeeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(PAYROLL_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/payroll')
  const result = await saveEmployeeFromForm(formData, await currentActor())
  if (result.ok) revalidatePath(`/ledger/${ledgerId}/payroll`, 'layout')
  return result
}

/** A payroll record entered by mistake, deleted; its edit page goes with it, so the list is where this lands (0084). */
export async function deleteEmployeeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(PAYROLL_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/payroll')
  const result = await deleteEmployeeFromForm(formData, await currentActor())
  if (result.error) return result
  revalidatePath(`/ledger/${ledgerId}/payroll`, 'layout')
  redirect(`/ledger/${ledgerId}/payroll/people`)
}

/**
 * A CRA T4127 edition added in the app, or one removed (0082). Behind the
 * payroll seat: the tables decide every payday of every company.
 */
export async function addEditionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(PAYROLL_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/payroll')
  const { addEditionFromForm } = await import('@/lib/payroll/edition-forms')
  const result = await addEditionFromForm(formData, await currentActor())
  if (result.ok) revalidatePath(`/ledger/${ledgerId}/payroll`, 'layout')
  return result
}

export async function removeEditionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(PAYROLL_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/payroll')
  const { removeEditionFromForm } = await import('@/lib/payroll/edition-forms')
  const result = await removeEditionFromForm(formData, await currentActor())
  if (result.ok) revalidatePath(`/ledger/${ledgerId}/payroll`, 'layout')
  return result
}

export async function runPayrollAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const ledgerId = String(formData.get(PAYROLL_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/payroll')
  const result = await runPayrollFromForm(formData, await currentActor())
  if (result.ok) {
    revalidatePath(`/ledger/${ledgerId}/payroll`, 'layout')
    revalidatePath(`/ledger/${ledgerId}/entries`)
    revalidatePath(`/ledger/${ledgerId}`)
  }
  return result
}


'use server'

import { revalidatePath } from 'next/cache'
import { currentActor, requireLedger } from '@/lib/gate'
import type { FormState } from '@/app/actions'
import {
  attachMinuteBookFromForm, ceaseDirectorFromForm, ceaseSiFromForm, correctRowFromForm, detachMinuteBookFromForm,
  enterRowsFromForm, removeClassFromForm, removeRowFromForm, renameClassFromForm, saveProfileFromForm,
  type FormResult,
} from '@/lib/record-forms'
import { RECORD_FIELDS } from '@/lib/record-forms'
import { REGISTER_KINDS } from '@/lib/registers'
import { setShareholderAddressFromForm } from '@/lib/shareholder-address'

/**
 * Server actions for the corporate-records screen. In their own file rather
 * than `app/actions.ts` only because they arrived as a batch; the shape is the
 * same — parse in `record-forms.ts`, revalidate on success.
 */

async function recordsAction(
  formData: FormData, run: () => Promise<FormResult>,
): Promise<FormState> {
  const ledgerId = String(formData.get(RECORD_FIELDS.ledgerId) ?? '')
  await requireLedger(ledgerId, '/records')
  const result = await run()
  if (result.ok && ledgerId) {
    // The register pages carry their own management forms now, so a change
    // must refresh them too — the register above the form would otherwise
    // show the world before the click.
    revalidatePath(`/ledger/${ledgerId}/records`)
    revalidatePath(`/ledger/${ledgerId}/records/minute-book`)
    // And the readings: a card says which tables its rows went into.
    revalidatePath(`/ledger/${ledgerId}/readings`)
    for (const kind of REGISTER_KINDS) {
      revalidatePath(`/ledger/${ledgerId}/records/register/${kind}`)
    }
  }
  return result
}

export async function saveProfileAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => saveProfileFromForm(f, await currentActor()))
}
/**
 * Every add form's rows — offices, the minute book and the three registers
 * (docs/design/41). One door, because it is one shape: a table named by the
 * form, rows read by index, entered together or not at all.
 */
export async function enterRowsAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => enterRowsFromForm(f, await currentActor()))
}
/** A document filed against a minute-book record, and unfiled (0081). */
export async function attachMinuteBookAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => attachMinuteBookFromForm(f, await currentActor()))
}
export async function detachMinuteBookAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => detachMinuteBookFromForm(f, await currentActor()))
}
export async function ceaseDirectorAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => ceaseDirectorFromForm(f, await currentActor()))
}
export async function ceaseSiAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => ceaseSiFromForm(f, await currentActor()))
}
/**
 * A row on any of the five tables put right, or taken out — from the boxes its
 * Edit opens on the row itself (0083). Ceasing stays its own door: it is a date
 * for something that happened, and these are for what was entered wrong.
 */
export async function correctRowAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => correctRowFromForm(f, await currentActor()))
}
export async function deleteRecordRowAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => removeRowFromForm(f, await currentActor()))
}
/** A share class renamed, or removed while nothing on the register is in it. */
export async function renameShareClassAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => renameClassFromForm(f, await currentActor()))
}
export async function deleteShareClassAction(_p: FormState, f: FormData): Promise<FormState> {
  return recordsAction(f, async () => removeClassFromForm(f, await currentActor()))
}

export async function setShareholderAddressAction(_p: FormState, f: FormData): Promise<FormState> {
  const result = await recordsAction(f, async () => setShareholderAddressFromForm(f, await currentActor()))
  if (result.ok) {
    // The party is shared. Refresh its consumers in every open company too.
    revalidatePath('/ledger', 'layout')
  }
  return result
}

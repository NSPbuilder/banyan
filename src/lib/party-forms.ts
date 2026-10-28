import 'server-only'
import { g, PARTY_FIELDS as F } from './forms'
import {
  PartyError, correctRole, createParty, deactivateParty, deleteAddress, deleteParty, deleteRole, endRole, grantRole,
  reactivateParty, setAddress, updateParty, type PartyKind, type PartyRole,
} from './parties'
import { refuseUnlessOurs } from './ours'
import {db} from '@/db/client'
import type {Runner} from './acting'

/**
 * Reading the customers-and-suppliers form.
 *
 * Separate from `app/actions.ts` for the reason `opening-forms.ts` is: a check
 * can call this, and cannot call a server action. When the two are the same
 * file, what gets checked is a function the shipped page never runs — which is
 * how the opening balance screen came to show a uuid where a name belonged,
 * with every check green.
 */

export type FormResult = {
  ok?: string
  error?: string
  /**
   * What was just made, for a caller that has to go on using it. The picker
   * creates a party from inside a form it must not leave and then has to
   * choose the one it made (2026-09-07); only the creating door sets these.
   */
  madeId?: string
  madeLabel?: string
}

/** Every message in the chain, because the driver wraps what Postgres said. */
function causesOf(e: unknown): string {
  const parts: string[] = []
  let cur: unknown = e
  for (let i = 0; cur && i < 5; i++) {
    const err = cur as { message?: string; constraint_name?: string; cause?: unknown }
    if (err.message) parts.push(err.message)
    if (err.constraint_name) parts.push(err.constraint_name)
    cur = err.cause
  }
  return parts.join(' | ')
}


/** Both paths end the same way, so both report failure the same way. */
async function attempt(
  run: () => Promise<unknown>, ok: string,
  /** What was made, read off whatever `run` returned — the picker needs it. */
  made?: (result: unknown) => { madeId: string; madeLabel: string } | undefined,
): Promise<FormResult> {
  try {
    const result = await run()
    return { ok, ...(made?.(result) ?? {}) }
  } catch (e) {
    if (e instanceof PartyError) return { error: e.message }

    // A duplicate or an overlap that got past the library is still refused by
    // the database. Those refusals are correct and unreadable, so they are
    // turned back into sentences here rather than shown as constraint names.
    //
    // The whole cause chain, not `e.message`. The driver wraps the Postgres
    // error, so the constraint name is two levels down and reading only the
    // top level finds nothing — which is not a wrong message but a crash, the
    // page falling over instead of saying what happened.
    const text = causesOf(e)
    if (text.includes('party_one_active_name')) {
      return { error: 'Someone with that name is already on the list.' }
    }
    if (text.includes('party_role_one_current') || text.includes('party_role_no_overlap')) {
      return { error: 'That role is already recorded here. End it before adding it again.' }
    }
    throw e
  }
}

export async function createPartyFromForm(f: FormData, actor: string): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['entity', g(f, F.entityId)]], g(f, F.ledgerId))
  if (nope) return nope
  const address = {
    line1: g(f, F.line1).trim(), line2: g(f, F.line2).trim(), city: g(f, F.city).trim(),
    region: g(f, F.region).trim(), postalCode: g(f, F.postalCode).trim(), country: g(f, F.country).trim() || 'CA',
  }
  const hasAddress = !!(address.line1 || address.line2 || address.city || address.region || address.postalCode || address.country !== 'CA')
  return attempt(() => createParty({
    kind: (g(f, F.kind) || 'organisation') as PartyKind,
    name: g(f, F.name),
    taxNumber: g(f, F.taxNumber) || undefined,
    tradingName: g(f, F.tradingName) || undefined,
    notes: g(f, F.notes) || undefined,
    primaryContact: { name: g(f, F.contactName), email: g(f, F.email), phone: g(f, F.phone) },
    mailingAddress: hasAddress ? address : undefined,
    roles: [{
      entityId: g(f, F.entityId),
      role: (g(f, F.role) || 'customer') as PartyRole,
    }],
    actor,
  }), 'Added.',
  // The picker creates a party from inside a form it must not leave, and
  // then has to choose the one it made (2026-09-07).
  (r) => {
    const party = r as { id?: string; name?: string }
    return party?.id ? { madeId: party.id, madeLabel: party.name ?? '' } : undefined
  })
}

export async function grantRoleFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['entity', g(f, F.entityId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => grantRole({
    partyId: g(f, F.partyId),
    entityId: g(f, F.entityId),
    role: (g(f, F.role) || 'customer') as PartyRole,
    actor,
  }, on), 'Added.')
}

export async function updatePartyFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['party', g(f, F.partyId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => updateParty({
    partyId: g(f, F.partyId),
    name: g(f, F.name),
    tradingName: g(f, F.tradingName) || undefined,
    taxNumber: g(f, F.taxNumber) || undefined,
    notes: g(f, F.notes) || undefined,
    // An unchecked box sends nothing, so its absence is the answer — and this
    // form always renders the box, which is what makes absence readable as
    // "not at arm's length" rather than "the form did not ask".
    armsLength: f.get(F.armsLength) !== null,
    actor,
  }, on), 'Saved.')
}

export async function setAddressFromForm(f: FormData, _actor?: string, on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['party', g(f, F.partyId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => setAddress({
    partyId: g(f, F.partyId),
    purpose: g(f, F.purpose),
    line1: g(f, F.line1),
    line2: g(f, F.line2) || undefined,
    city: g(f, F.city) || undefined,
    region: g(f, F.region) || undefined,
    postalCode: g(f, F.postalCode) || undefined,
    country: g(f, F.country) || undefined,
  }, on), 'Address saved — everywhere this party appears.')
}

export async function endRoleFromForm(f: FormData, actor = 'system', on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['party_role', g(f, F.roleId)]], g(f, F.ledgerId))
  if (nope) return nope
  const heldTo = g(f, F.heldTo)
  if (!heldTo) return { error: 'Say the last day the role was held.' }
  return attempt(() => endRole(g(f, F.roleId), heldTo, actor, on), 'Role ended.')
}

/** An empty last day means the role is still held. Legacy start dates stay on file. */
export async function correctRoleFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['party_role', g(f, F.roleId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => correctRole(g(f, F.roleId), undefined, g(f, F.heldTo) || null, actor, on), 'Role saved.')
}

/** A role given by mistake, taken out — refused while anything posted rests on it (0084). */
export async function deleteRoleFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['party_role', g(f, F.roleId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => deleteRole(g(f, F.roleId), actor, on), 'Role deleted.')
}

export async function deleteAddressFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['party', g(f, F.partyId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => deleteAddress(g(f, F.partyId), g(f, F.purpose), actor, on), 'Address removed — everywhere this party appears.')
}

export async function deactivatePartyFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['party', g(f, F.partyId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => deactivateParty(g(f, F.partyId), actor, on),
    'Taken off the lists. History keeps its explanation.')
}

export async function reactivatePartyFromForm(f: FormData, actor: string, on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['party', g(f, F.partyId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => reactivateParty(g(f, F.partyId), actor, on), 'Back on the lists.')
}

export async function deletePartyFromForm(f: FormData, actor = 'system', on: Runner = db): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['party', g(f, F.partyId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => deleteParty(g(f, F.partyId), actor, on), 'Deleted.')
}

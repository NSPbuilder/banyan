'use client'

import { useState } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { PARTY_FIELDS as F } from '@/lib/forms'
import { DateInput } from '@/components/DateInput'
import { BUTTON, FIELD, QUIET } from '@/lib/ui'
import {MasterEdit,MasterProof} from '@/components/MasterEdit'

type Role = {
  id: string; role: string; entity_name: string
  held_from: string | null; held_to: string | null
}
type Address = {
  id: string; purpose: string; purpose_label: string
  line1: string; line2: string | null; city: string | null; region: string | null
  postal_code: string | null; country: string | null
}
type Purpose = { code: string; label: string }

const LABEL = 'text-xs text-neutral-500'

/**
 * Managing one party: who they say they are, the roles they hold, their
 * addresses, and the three exits — deactivate, reactivate, true delete.
 * Every submit goes through ActionForm; every refusal arrives as a sentence.
 */
export function PartyManage({
  ledgerId, entityId, party, roles, roleOptions, addresses, today, actions,version,primaryEmail,
}: {
  ledgerId: string
  version:string
  primaryEmail:string|null
  entityId: string
  party: {
    id: string; kind: string; name: string; trading_name: string | null
    tax_number: string | null; is_active: boolean; notes: string | null
    arms_length: boolean
  }
  roles: Role[]
  roleOptions: Purpose[]
  addresses: Address[]
  /** Server-decided local day (R47): default for the end-role date. */
  today: string
  actions: {
    update: FormAction; setAddress: FormAction; endRole: FormAction
    saveEmail:FormAction
    grantRole: FormAction
    /** A role's dates put right, a role given by mistake deleted, an address removed (0084). */
    correctRole: FormAction; deleteRole: FormAction; deleteAddress: FormAction
    deactivate: FormAction; reactivate: FormAction; delete: FormAction
  }
}) {
  const byPurpose = new Map(addresses.map((a) => [a.purpose, a]))
  const [fixing, setFixing] = useState<string | null>(null)

  return (
    <MasterEdit resource={{ledgerId,type:'party',id:party.id}} version={version}>
      <section id="contact-email" className="mt-6 border-t border-line pt-4"><h2 className="text-section-title font-semibold">Primary contact email</h2><ActionForm action={actions.saveEmail} submit="Save email" working="Saving…" className="mt-3 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
        <input type="hidden" name={F.ledgerId} value={ledgerId}/><input type="hidden" name={F.partyId} value={party.id}/><MasterProof/>
        <label className="min-w-56 flex-1 text-label">Email<input type="email" name="email" defaultValue={primaryEmail??''} className={`${FIELD} mt-1 w-full`} maxLength={254}/></label>
      </ActionForm><p className="mt-2 text-metadata text-ink-muted">Used for invoice email and reminders. This contact belongs to the shared Party record across companies.</p></section>
      <section className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Who they are</h2>
        <ActionForm action={actions.update} submit="Save" working="Saving…"
                    className="mt-3 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
          <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
          <input type="hidden" name={F.partyId} value={party.id} />
          <label className={LABEL}>
            <span className="block">Name</span>
            <input name={F.name} required defaultValue={party.name} className={`mt-1 w-56 ${FIELD}`} />
          </label>
          <label className={LABEL}>
            <span className="block">Trading as</span>
            <input name={F.tradingName} defaultValue={party.trading_name ?? ''} className={`mt-1 w-44 ${FIELD}`} />
          </label>
          <label className={LABEL}>
            <span className="block">Tax number</span>
            <input name={F.taxNumber} defaultValue={party.tax_number ?? ''} className={`mt-1 w-44 ${FIELD}`} />
          </label>
          <label className={LABEL}>
            <span className="block">Notes</span>
            <input name={F.notes} defaultValue={party.notes ?? ''} className={`mt-1 w-64 ${FIELD}`} />
          </label>
          <label className="flex max-w-64 items-start gap-2 pb-1 text-sm">
            <input type="checkbox" name={F.armsLength} defaultChecked={party.arms_length ?? true}
                   className="mt-1" />
            <span>
              At arm&rsquo;s length

            </span>
          </label>
        </ActionForm>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Roles</h2>

        <ul className="mt-3 space-y-2">
          {roles.map((r) => (
            <li key={r.id} className="flex flex-wrap items-end gap-3 border-b border-neutral-100 pb-2 text-sm last:border-0 dark:border-neutral-900">
              <span className="min-w-32 capitalize">{r.role}</span>
              <span className="text-xs text-neutral-500">
                at {r.entity_name}{r.held_to ? ` · ended ${r.held_to}` : ''}
              </span>
              {!r.held_to && fixing !== r.id && (
                <ActionForm action={actions.endRole} submit="End role" working="…"
                            className="ml-auto flex items-end gap-2" buttonClassName={QUIET}>
                  <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
                  <input type="hidden" name={F.roleId} value={r.id} />
                  <label className={LABEL}>
                    <span className="block">Last day</span>
                    <DateInput name={F.heldTo} defaultValue={today} className={`mt-1 ${FIELD}`} />
                  </label>
                </ActionForm>
              )}
              {fixing !== r.id ? (
                <button type="button" onClick={() => setFixing(r.id)} className={`${r.held_to ? 'ml-auto ' : ''}${QUIET}`}
                        aria-label={`Edit the ${r.role} role`}>
                  Edit
                </button>
              ) : (
                <span className="ml-auto flex flex-wrap items-end gap-3" data-role-editing={r.id}>
                  <ActionForm action={actions.correctRole} submit="Save" working="…" onSucceeded={() => setFixing(null)}
                              className="flex flex-wrap items-end gap-2" buttonClassName={QUIET}>
                    <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
                    <input type="hidden" name={F.roleId} value={r.id} />
                    <label className={LABEL}>
                      <span className="block">To (empty: still held)</span>
                      <DateInput name={F.heldTo} defaultValue={r.held_to ?? ''} className={`mt-1 ${FIELD}`} />
                    </label>
                  </ActionForm>
                  <ActionForm action={actions.deleteRole} submit="Delete" working="…" onSucceeded={() => setFixing(null)}
                              className="inline" buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
                    <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
                    <input type="hidden" name={F.roleId} value={r.id} />
                  </ActionForm>
                  <button type="button" onClick={() => setFixing(null)} className="text-xs text-neutral-500 hover:underline">
                    Cancel
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {/* Adding a capacity happens HERE, where the person is being looked
            at — the owner could not find it on the list page (2026-09-03). */}
        <ActionForm action={actions.grantRole} submit="Add role" working="…"
                    className="mt-3 flex flex-wrap items-end gap-2" buttonClassName={BUTTON}>
          <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
          <input type="hidden" name={F.entityId} value={entityId} />
          <input type="hidden" name={F.partyId} value={party.id} />
          <label className={LABEL}>
            <span className="block">New role</span>
            <select name={F.role} defaultValue="customer" className={`mt-1 ${FIELD}`}>
              {roleOptions.map((r) => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </select>
          </label>
        </ActionForm>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Address</h2>
        <p className="mt-2 text-xs text-neutral-500">
          Address changes apply to every company using this party.
        </p>

        {(() => {
          const a = byPurpose.get('mailing')
          return (
            <ActionForm action={actions.setAddress} submit={a ? 'Save address' : 'Set address'}
                        working="Saving…" className="mt-3 max-w-xl space-y-2" buttonClassName={BUTTON}>
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
              <input type="hidden" name={F.partyId} value={party.id} />
              <input type="hidden" name={F.purpose} value="mailing" />
              <label className={`${LABEL} block`}>
                <span className="block">Street address</span>
                <input name={F.line1} required defaultValue={a?.line1 ?? ''} className={`mt-1 w-full ${FIELD}`} />
              </label>
              <label className={`${LABEL} block`}>
                <span className="block">Line 2</span>
                <input name={F.line2} defaultValue={a?.line2 ?? ''} className={`mt-1 w-full ${FIELD}`} />
              </label>
              <div className="grid grid-cols-[1fr_5rem_8rem_5rem] gap-2">
                <label className={LABEL}>
                  <span className="block">City</span>
                  <input name={F.city} defaultValue={a?.city ?? ''} className={`mt-1 w-full ${FIELD}`} />
                </label>
                <label className={LABEL}>
                  <span className="block">Prov.</span>
                  <input name={F.region} defaultValue={a?.region ?? ''} className={`mt-1 w-full ${FIELD}`} />
                </label>
                <label className={LABEL}>
                  <span className="block">Postal</span>
                  <input name={F.postalCode} defaultValue={a?.postal_code ?? ''} className={`mt-1 w-full ${FIELD}`} />
                </label>
                <label className={LABEL}>
                  <span className="block">Country</span>
                  <input name={F.country} defaultValue={a?.country ?? 'CA'} className={`mt-1 w-full ${FIELD}`} />
                </label>
              </div>
            </ActionForm>
          )
        })()}
        {byPurpose.has('mailing') && (
          <ActionForm action={actions.deleteAddress} submit="Remove this address" working="…"
                      className="mt-2" buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
            <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
            <input type="hidden" name={F.partyId} value={party.id} />
            <input type="hidden" name={F.purpose} value="mailing" />
          </ActionForm>
        )}
      </section>

      <section className="mt-10 rounded border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Off the list
        </h2>
        <div className="mt-3 flex flex-wrap gap-6">
          {party.is_active ? (
            <ActionForm action={actions.deactivate} submit="Deactivate" working="…"
                        buttonClassName={QUIET}>
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
              <input type="hidden" name={F.partyId} value={party.id} />
            </ActionForm>
          ) : (
            <ActionForm action={actions.reactivate} submit="Reactivate" working="…"
                        buttonClassName={QUIET}>
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
              <input type="hidden" name={F.partyId} value={party.id} />
            </ActionForm>
          )}
          <ActionForm action={actions.delete} submit="Delete forever" working="…"
                      buttonClassName="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50">
            <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <MasterProof/>
            <input type="hidden" name={F.partyId} value={party.id} />
          </ActionForm>
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          Deactivating hides them from every list and keeps history whole. Deleting only works
          while nothing in the books refers to them — otherwise it is refused with the reason.
        </p>
      </section>
    </MasterEdit>
  )
}

'use client'

import { useState, type FocusEvent } from 'react'
import { ActionForm, type FormAction } from './ActionForm'
import { PARTY_FIELDS as F } from '@/lib/forms'
import { BUTTON, FIELD, GHOST, LABEL } from '@/lib/ui'

export type PartyCreateInitial = {
  name?: string; kind?: string; role?: string; tradingName?: string; taxNumber?: string; notes?: string
  contactName?: string; email?: string; phone?: string
  line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string
}

/** Native focus can regard a field under a sticky footer as visible. Reveal
 * only the covered portion, using the actual footer and its token spacing. */
function revealFocusedField(event: FocusEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement
  const form = event.currentTarget.closest('form')
  if (!target.matches('input, select, textarea')) return
  requestAnimationFrame(() => {
    if (!target.isConnected || document.activeElement !== target) return
    const footer = form?.querySelector<HTMLElement>('.form-actions')
    if (!footer) return
    const field = target.getBoundingClientRect(), actions = footer.getBoundingClientRect()
    if (field.bottom <= actions.top || field.top >= actions.bottom) return
    const gap = parseFloat(getComputedStyle(footer).paddingTop) || 0
    const top = field.bottom - actions.top + gap
    const dialog = target.closest('dialog')
    if (dialog) dialog.scrollBy({ top, behavior: 'instant' })
    else window.scrollBy({ top, behavior: 'instant' })
  })
}

/** The same Party form in its own page or over the document being completed. */
export function PartyCreateForm({ ledgerId, entityId, roles, action, initial, fixedKind, onCreated, onCancel }: {
  ledgerId: string
  entityId?: string
  roles: Array<{ code: string; label: string }>
  action: FormAction
  initial?: PartyCreateInitial
  fixedKind?: string
  onCreated?: (made: { id: string; label: string }) => void
  onCancel?: () => void
}) {
  const initialKind = fixedKind ?? initial?.kind ?? 'organisation'
  const [kind, setKind] = useState(initialKind)
  return <ActionForm action={action} submit="Add" working="Adding…"
    className="mt-6 max-w-3xl space-y-6" buttonClassName={BUTTON} stickyActions
    requestError="The response was lost. Check Parties before trying to add this party again."
    secondaryActions={onCancel ? <button type="button" className={GHOST} onClick={onCancel}>Cancel</button> : undefined}
    onSucceeded={state => { setKind(initialKind); if (state.madeId) onCreated?.({ id: state.madeId, label: state.madeLabel ?? '' }) }}>
    <input type="hidden" name={F.ledgerId} value={ledgerId}/>
    {entityId && <input type="hidden" name={F.entityId} value={entityId}/>}
    <div className="space-y-6" onFocusCapture={revealFocusedField}>
    <fieldset className="min-w-0 space-y-4">
      <legend className="text-section-title font-semibold text-ink">Party details</legend>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <label className={`${LABEL} sm:col-span-2`}><span className="block">Name</span>
          <input name={F.name} required autoComplete={kind === 'person' ? 'name' : 'organization'} defaultValue={initial?.name ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
        <label className={LABEL}><span className="block">Party type</span>
          {fixedKind ? <><input type="hidden" name={F.kind} value={fixedKind}/><span className="mt-1 block py-2">{fixedKind === 'person' ? 'A person' : 'An organisation'}</span></>
            : <select name={F.kind} value={kind} onChange={event => setKind(event.target.value)} className={`mt-1 w-full ${FIELD}`}>
              <option value="organisation">An organisation</option><option value="person">A person</option>
            </select>}
        </label>
        <label className={LABEL}><span className="block">Role</span>
          <select name={F.role} defaultValue={initial?.role ?? roles[0]?.code} className={`mt-1 w-full ${FIELD}`}>
            {roles.map(role => <option key={role.code} value={role.code}>{role.label}</option>)}
          </select>
        </label>
        <label className={LABEL}><span className="block">Trading name</span>
          <input name={F.tradingName} defaultValue={initial?.tradingName ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
        <label className={LABEL}><span className="block">Tax number</span>
          <input name={F.taxNumber} defaultValue={initial?.taxNumber ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
      </div>
    </fieldset>
    <fieldset className="min-w-0 border-t border-line-subtle pt-5">
      <legend className="flex items-baseline gap-3 pr-3 text-section-title font-semibold text-ink">Contact
        <span className="text-metadata font-normal text-ink-muted">Optional</span>
      </legend>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <label className={`${LABEL} sm:col-span-2`}><span className="block">Contact name</span>
          <input name={F.contactName} autoComplete="name" defaultValue={initial?.contactName ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
        <label className={LABEL}><span className="block">Email</span>
          <input type="email" name={F.email} autoComplete="email" maxLength={254} defaultValue={initial?.email ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
        <label className={LABEL}><span className="block">Phone</span>
          <input type="tel" name={F.phone} autoComplete="tel" defaultValue={initial?.phone ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
      </div>
    </fieldset>
    <fieldset className="min-w-0 border-t border-line-subtle pt-5">
      <legend className="flex items-baseline gap-3 pr-3 text-section-title font-semibold text-ink">Mailing address
        <span className="text-metadata font-normal text-ink-muted">Optional</span>
      </legend>
      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <label className={`${LABEL} sm:col-span-2`}><span className="block">Street address</span>
          <input name={F.line1} autoComplete="address-line1" defaultValue={initial?.line1 ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
        <label className={`${LABEL} sm:col-span-2`}><span className="block">Apartment, suite or unit</span>
          <input name={F.line2} autoComplete="address-line2" defaultValue={initial?.line2 ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
        <label className={LABEL}><span className="block">City</span>
          <input name={F.city} autoComplete="address-level2" defaultValue={initial?.city ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
        <label className={LABEL}><span className="block">Province or state</span>
          <input name={F.region} autoComplete="address-level1" defaultValue={initial?.region ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
        <label className={LABEL}><span className="block">Postal code</span>
          <input name={F.postalCode} autoComplete="postal-code" defaultValue={initial?.postalCode ?? ''} className={`mt-1 w-full ${FIELD}`}/>
        </label>
        <label className={LABEL}><span className="block">Country</span>
          <input name={F.country} autoComplete="country" defaultValue={initial?.country ?? 'CA'} className={`mt-1 w-full ${FIELD}`}/>
        </label>
      </div>
    </fieldset>
    <label className={LABEL}><span className="block">Notes</span>
      <textarea name={F.notes} rows={2} defaultValue={initial?.notes ?? ''} className={`mt-1 w-full resize-y ${FIELD}`}/>
    </label>
    </div>
  </ActionForm>
}

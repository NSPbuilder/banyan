'use client'

import { useRef } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { Floating } from '@/components/Floating'
import { PARTY_FIELDS as F } from '@/lib/forms'
import { BUTTON, FIELD, LABEL, QUIET } from '@/lib/ui'
import type { ShareholderAddress as Address } from '@/lib/shareholder-address'

export function ShareholderAddress({ ledgerId, partyId, holder, address, action }: {
  ledgerId: string; partyId: string; holder: string; address?: Address; action: FormAction
}) {
  const panel = useRef<HTMLDivElement>(null)
  const label = address ? 'Edit address' : 'Add address'
  return (
    <Floating label={label} ariaLabel={`${label} for ${holder}`} title={`Last known address · ${holder}`}
              buttonClassName={`${QUIET} whitespace-nowrap`}>
      <div ref={panel}>
        <p className="mt-2 text-xs text-neutral-500">Updates every company using this party.</p>
        <ActionForm action={action} submit="Save" working="Saving…" buttonClassName={BUTTON}
                    className="mt-5 max-w-xl space-y-4"
                    onSucceeded={() => panel.current?.closest('dialog')?.close()}>
          <input type="hidden" name={F.ledgerId} value={ledgerId} />
          <input type="hidden" name={F.partyId} value={partyId} />
          <input type="hidden" name={F.purpose} value={address?.purpose ?? 'mailing'} />
          <label className={`${LABEL} block`}>Street address
            <input name={F.line1} required defaultValue={address?.line1 ?? ''} className={`mt-1 w-full ${FIELD}`} />
          </label>
          <label className={`${LABEL} block`}>Line 2
            <input name={F.line2} defaultValue={address?.line2 ?? ''} className={`mt-1 w-full ${FIELD}`} />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className={LABEL}>City
              <input name={F.city} defaultValue={address?.city ?? ''} className={`mt-1 w-full ${FIELD}`} />
            </label>
            <label className={LABEL}>Province / State
              <input name={F.region} defaultValue={address?.region ?? ''} className={`mt-1 w-full ${FIELD}`} />
            </label>
            <label className={LABEL}>Postal code
              <input name={F.postalCode} defaultValue={address?.postal_code ?? ''} className={`mt-1 w-full ${FIELD}`} />
            </label>
            <label className={LABEL}>Country
              <input name={F.country} defaultValue={address?.country ?? 'CA'} className={`mt-1 w-full ${FIELD}`} />
            </label>
          </div>
        </ActionForm>
      </div>
    </Floating>
  )
}

import { TAX_FIELDS as F } from '@/lib/forms'
import { type ProposedRow } from './AccountRow'
import { AccountRows } from './AccountRows'
import { DateInput } from '@/components/DateInput'
import { FIELD } from '@/lib/ui'

/**
 * Every input either sales tax form submits.
 *
 * Pure, importing nothing from the server, so a check renders these and reads
 * back exactly what they post. They are handed to `ActionForm` as children by the
 * page — which has the data — so no client component ever holds a field value
 * long enough to corrupt it.
 */

const input = FIELD
const label = 'block text-xs font-medium uppercase tracking-wide text-neutral-500'

/**
 * Takes the whole proposal — which tax it is for and the rows it proposes —
 * rather than a tax and a separately-sourced list, which the page could pair
 * wrongly. It did: rendering one tax's proposal inside another tax's form
 * produced an account coded and named for GST tagged as PST. `registerTax` now
 * refuses a row whose role belongs to another form, and this removes the way to
 * build the mismatch in the first place.
 */
export function RegisterInputs({
  ledgerId, entityId, proposal, today, initial,
}: {
  ledgerId: string
  entityId: string
  proposal: { tax: string; label: string; rows: ProposedRow[] }
  today: string
  initial?: { number: string; registeredOn: string }
}) {
  const { tax, label: taxLabel, rows: proposed } = proposal
  return (
    <>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <input type="hidden" name={F.entityId} value={entityId} />
      <input type="hidden" name={F.tax} value={tax} />

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={`number-${tax}`} className={label}>{taxLabel} number</label>
          <input id={`number-${tax}`} name={F.number} required
                 defaultValue={initial?.number ?? ''}
                 className={`mt-1 w-52 font-mono ${input}`} />
        </div>
        <div>
          <label htmlFor={`on-${tax}`} className={label}>Registered from</label>
          <DateInput id={`on-${tax}`} name={F.registeredOn} required defaultValue={initial?.registeredOn ?? today}
                 className={`mt-1 ${input}`} />
        </div>
      </div>

      <p className="mt-6 text-xs font-semibold uppercase tracking-widest text-neutral-500">
        {proposed.length === 1 ? 'The account this needs' : 'The accounts this needs'}
      </p>

      <AccountRows proposed={proposed} tax={tax} />
    </>
  )
}

/**
 * `end` — no end date yet.
 * `change` — an end date in the future: the registration is still live.
 * `correct` — an end date already past.
 */
export type CeaseMode = 'end' | 'change' | 'correct'

/**
 * Takes the WHOLE row `registrationView` decided, not its parts.
 *
 * Passed piece by piece, the page could hand this a different value than the
 * one that was checked — and did: `defaultDate={today}` at the call site
 * survived a round of review, silently rewriting a recorded end date whenever
 * the owner pressed a button labelled "Save the corrected date". Nothing
 * rendered the page, so nothing saw it.
 *
 * There is no separate prop to substitute now. Corrupting this means building a
 * different row, which is a visible act rather than a plausible typo.
 */
export function CeaseInputs({
  ledgerId, row,
}: {
  ledgerId: string
  row: { registration: { id: string }; mode: CeaseMode; defaultDate: string }
}) {
  const prompt = row.mode === 'correct' ? 'Correct the date it ended'
               : row.mode === 'change' ? 'Change the date it ends'
               : 'Stopped being registered on'
  const id = row.registration.id

  return (
    <>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <input type="hidden" name={F.registrationId} value={id} />
      <div>
        <label htmlFor={`ceased-${id}`} className={label}>{prompt}</label>
        <DateInput id={`ceased-${id}`} name={F.ceasedOn} required
               defaultValue={row.defaultDate} className={`mt-1 ${input}`} />
      </div>
    </>
  )
}

/**
 * Putting a registration right (0084): the number, the day it began, and the
 * day it ended — left empty, it is still registered. Takes the registration
 * whole, for the same reason `CeaseInputs` takes its row whole.
 */
export function CorrectInputs({
  ledgerId, registration: r,
}: {
  ledgerId: string
  registration: { id: string; number: string; registeredOn: string; ceasedOn: string | null }
}) {
  return (
    <>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <input type="hidden" name={F.registrationId} value={r.id} />
      <div>
        <label htmlFor={`fix-number-${r.id}`} className={label}>Number</label>
        <input id={`fix-number-${r.id}`} name={F.number} required defaultValue={r.number}
               className={`mt-1 w-52 font-mono ${input}`} />
      </div>
      <div>
        <label htmlFor={`fix-from-${r.id}`} className={label}>Registered from</label>
        <DateInput id={`fix-from-${r.id}`} name={F.registeredOn} required defaultValue={r.registeredOn}
                   className={`mt-1 ${input}`} />
      </div>
      <div>
        <label htmlFor={`fix-to-${r.id}`} className={label}>Ended on (empty: still registered)</label>
        <DateInput id={`fix-to-${r.id}`} name={F.ceasedOn} defaultValue={r.ceasedOn ?? ''}
                   className={`mt-1 ${input}`} />
      </div>
    </>
  )
}

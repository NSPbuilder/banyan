import type { RegistrationView } from '@/lib/registrations'
import { type ProposedRow } from './AccountRow'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { CeaseInputs, CorrectInputs, RegisterInputs } from './TaxFormFields'
import { Floating } from '@/components/Floating'
import { BUTTON, BUTTON_WIDE, QUIET } from '@/lib/ui'
import { TAX_FIELDS as F } from '@/lib/forms'

/**
 * Everything on the registration page below the heading: the registrations on
 * file with their end-date forms, and a registration form for each tax still
 * open.
 *
 * Pure, and taking the actions as props, so a check can render the whole thing
 * and read back every field every form would submit. That is the point.
 *
 * Six rounds of review found the same defect at six hops, each one further out
 * than the last, and the seventh was the one no source-pattern check could
 * reach: substituting a whole value of the same type. `row={view.rows[0]}` —
 * one identifier — makes every cease form end the FIRST registration whatever
 * card it sits under, and `proposal={proposals[0]}` makes the PST form register
 * GST. Nothing is rebuilt, nothing is unpacked, and the types agree, so no
 * pattern over the source can tell it from the correct code.
 *
 * The only thing that can is looking at what the forms actually say.
 *
 * Every form here floats since 2026-09-16 (owner: every add is a form in a
 * floating page, not boxes sitting on the screen), in `Floating`'s native
 * dialog — which keeps its contents IN THE MARKUP, so what this component is
 * rendered to read still carries every field every form would submit.
 */

const TAX_LABEL: Record<string, string> = { GST_HST: 'GST/HST', QST: 'QST', PST: 'PST' }

export type OpenProposal = {
  tax: string
  label: string
  note?: string
  rows: ProposedRow[]
}

export function RegistrationSections({
  ledgerId, entityId, view, proposals, today, registerAction, ceaseAction, correctAction, deleteAction,
}: {
  ledgerId: string
  entityId: string
  view: RegistrationView
  proposals: OpenProposal[]
  today: string
  registerAction: FormAction
  ceaseAction: FormAction
  /** A registration entered wrong, put right or deleted (0084). */
  correctAction: FormAction
  deleteAction: FormAction
}) {
  return (
    <>
      {view.rows.length > 0 && (
        <>
          <h2 className="mt-10 mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Registered
          </h2>
          <div className="space-y-6">
            {view.rows.map((row) => (
              <div key={row.registration.id}
                   className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-medium">{TAX_LABEL[row.registration.tax]}</span>
                  <span className="font-mono text-sm">{row.registration.number}</span>
                  <span className="text-sm text-neutral-500">
                    from {row.registration.registeredOn}
                    {row.registration.ceasedOn ? ` to ${row.registration.ceasedOn}` : ''}
                  </span>
                  {row.badge && (
                    <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      {row.badge}
                    </span>
                  )}
                </div>
                {/* Shown for a registration that has already ended too: a
                    mistyped end date is the ordinary reason to come back here,
                    and it stops being active the moment the mistake is saved. */}
                <div className="mt-2">
                  {proposals.some((proposal) => proposal.tax === row.registration.tax) && (
                    <Floating label="Copy registration" title={`Copy ${TAX_LABEL[row.registration.tax]} registration`}
                              buttonClassName={QUIET}>
                      <p className="mt-1 text-xs text-neutral-500">Review the registration date and account codes before saving.</p>
                      <ActionForm action={registerAction} submit="Register the copy" working="Registering…"
                                  className="mt-4" buttonClassName={BUTTON}>
                        <RegisterInputs ledgerId={ledgerId} entityId={entityId}
                                        proposal={proposals.find((proposal) => proposal.tax === row.registration.tax)!}
                                        today={today}
                                        initial={{ number: row.registration.number,
                                          registeredOn: row.registration.registeredOn }} />
                      </ActionForm>
                    </Floating>
                  )}
                  <Floating label={row.registration.ceasedOn ? 'Correct the end date' : 'End this registration'}
                            title={`${TAX_LABEL[row.registration.tax]} ${row.registration.number}`}
                            buttonClassName={QUIET}>
                    <ActionForm action={ceaseAction}
                             submit={row.mode === 'correct' ? 'Save the corrected date'
                                     : row.mode === 'change' ? 'Save the new date'
                                     : `End the ${TAX_LABEL[row.registration.tax]} registration`}
                             working="Saving…"
                             className="mt-4 flex flex-wrap items-end gap-3"
                             buttonClassName="rounded border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
                      <CeaseInputs ledgerId={ledgerId} row={row} />
                    </ActionForm>
                  </Floating>
                  {/* For a registration ENTERED wrong: the number, the day it
                      began, the day it ended — or none (owner, 2026-09-16:
                      「所有的紀錄儘量都可以編輯刪除」). */}
                  <Floating label="Edit or delete…"
                            title={`Edit ${TAX_LABEL[row.registration.tax]} ${row.registration.number}`}
                            buttonClassName={`ml-4 ${QUIET}`}>
                    <ActionForm action={correctAction} submit="Save" working="Saving…"
                                className="mt-4 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
                      <CorrectInputs ledgerId={ledgerId} registration={row.registration} />
                    </ActionForm>
                    <ActionForm action={deleteAction} submit="Delete this registration" working="Deleting…"
                                className="mt-6 flex flex-wrap items-center gap-3"
                                buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
                      <input type="hidden" name={F.ledgerId} value={ledgerId} />
                      <input type="hidden" name={F.registrationId} value={row.registration.id} />
                      <span className="text-xs text-neutral-500">For one entered by mistake. Its accounts stay.</span>
                    </ActionForm>
                  </Floating>
                </div>
              </div>
            ))}
          </div>

        </>
      )}

      {proposals.length > 0 ? (
        <>
          <h2 className="mt-10 mb-1 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Not registered
          </h2>
          {proposals.map((proposal) => (
            <div key={proposal.tax}
                 className="mt-6 rounded border border-dashed border-neutral-300 p-6 dark:border-neutral-700">
              <h2 className="text-sm font-medium">Register for {proposal.label}</h2>
              {proposal.note && <p className="mt-1 text-sm text-neutral-500">{proposal.note}</p>}
              <div className="mt-4">
                <Floating label={`Register for ${proposal.label}`} title={`Register for ${proposal.label}`}
                          buttonClassName={BUTTON}>
                  {proposal.note && <p className="mt-1 text-sm text-neutral-500">{proposal.note}</p>}
                  <ActionForm action={registerAction}
                           submit={`Register and create ${proposal.rows.length === 1 ? 'the account' : 'the accounts'}`}
                           working="Registering…"
                           className="mt-4"
                           buttonClassName={`mt-5 ${BUTTON_WIDE}`}>
                    <RegisterInputs ledgerId={ledgerId} entityId={entityId}
                                    proposal={proposal} today={today} />
                  </ActionForm>
                </Floating>
              </div>
            </div>
          ))}
        </>
      ) : (
        <p className="mt-10 text-sm text-neutral-500">
          Registered for every sales tax that applies.
        </p>
      )}
    </>
  )
}

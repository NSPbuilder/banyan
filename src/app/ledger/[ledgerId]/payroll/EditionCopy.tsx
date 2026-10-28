import { ActionForm, type FormAction } from '@/components/ActionForm'
import { EDITION_HEAD } from '@/lib/payroll/edition-fields'
import { QUIET } from '@/lib/ui'

/**
 * The copy of a built-in edition that was added in the app before a release
 * built it in (critic, 2026-09-16). The list computes with the release's
 * figures and ignores the copy; this says so, says whether the two agree, and
 * offers Remove — which the door refuses while stubs computed under the copy
 * differ from the release, because the copy is then their only record.
 */
export function EditionCopy({ ledgerId, editionId, copy, remove }: {
  ledgerId: string
  editionId: string
  copy: { at: string; by: string; sameFigures: boolean }
  remove: FormAction
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-500" data-edition-copy={editionId}>
      <span>
        {editionId} was also added here on {copy.at.slice(0, 10)} by {copy.by}. The app now builds it in and computes
        with its own figures, which {copy.sameFigures ? 'are the same as the copy' : 'DIFFER from the copy'}.
      </span>
      <ActionForm action={remove} submit="Remove the added copy" working="…" className="inline" buttonClassName={QUIET}>
        <input type="hidden" name="ledgerId" value={ledgerId} />
        <input type="hidden" name={EDITION_HEAD.editionId} value={editionId} />
      </ActionForm>
    </div>
  )
}

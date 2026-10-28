
import { PageHeading } from '@/components/DialogHeading'
import { addEditionAction } from '@/app/ledger/[ledgerId]/payroll/actions'
import { ALL_FIGURES, figureOf } from '@/lib/payroll/edition-fields'
import { loadEditions } from '@/lib/payroll/editions'
import { FREQUENCY_LABEL } from '@/lib/payroll/labels'
import { EditionForm } from './EditionForm'
import { notFound } from 'next/navigation'

/**
 * Adding a CRA T4127 edition, body only — floated over Pay runs by "Add an
 * edition", a full page on a deep link (0082).
 *
 * The form opens on the LAST edition on file, starting where CRA's next one
 * usually does: 1 July after a January edition, 1 January after a July one.
 */
export async function NewEditionBody({ ledgerId, copyId }: { ledgerId: string; copyId?: string }) {
  const editions = await loadEditions()
  const last = editions[editions.length - 1]
  const source = copyId ? editions.find((edition) => edition.id === copyId) : last
  if (!last || !source) notFound()
  const year = Number(last.startsOn.slice(0, 4))
  const startsOn = last.startsOn.slice(5, 7) === '01' ? `${year}-07-01` : `${year + 1}-01-01`
  return (
    <>
      <PageHeading className="mt-2" title={<>{copyId ? 'Copy CRA edition' : 'Add a CRA edition'}</>} />
      <p className="mt-1 text-sm text-neutral-500">
        Opened on {source.id}&apos;s figures — change what the new T4127 changed.
      </p>

      <EditionForm
        ledgerId={ledgerId}
        startsOn={startsOn}
        figures={Object.fromEntries(ALL_FIGURES.map((f) => [f.path, figureOf(source, f.path)]))}
        frequencies={Object.entries(FREQUENCY_LABEL).map(([value, label]) => ({ value, label }))}
        pdocDefaults={{
          payDate: `${startsOn.slice(0, 8)}15`,
          federalClaim: source.federal.bpaf.max,
          bcClaim: source.bc.basicPersonalAmount,
        }}
        action={addEditionAction}
      />
    </>
  )
}

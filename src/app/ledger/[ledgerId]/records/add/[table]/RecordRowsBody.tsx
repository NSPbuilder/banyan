
import { PageHeading } from '@/components/DialogHeading'
import { formatNumber } from '@/lib/numbers'
import { notFound } from 'next/navigation'
import { ledgerHead } from '@/lib/ledger-head'
import { localToday } from '@/lib/today'
import { readingById } from '@/lib/bill-reading'
import { destinationOf } from '@/lib/destinations'
import { recordChoices } from '../../screen-data'
import { TABLE_WORDS, blankRow, formRowsFrom, isRecordTable } from '@/lib/record-rows'
import { enterRowsAction } from '@/app/records-actions'
import { RowsForm } from './RowsForm'
import { allDirectorships, allOffices, allSignificantIndividuals, minuteBookOf, movementRows } from '@/lib/records'

/**
 * One register's add form, body only — the overlay and the full page both
 * render exactly this (the one-renderer rule for screens).
 *
 * With `?reading=`, it opens with the rows the model read for THIS table, each
 * for a person to check; once those rows have been entered it says so and
 * opens blank, because the door would refuse them a second time anyway and a
 * form full of rows that cannot go in is a trap.
 */
export async function RecordRowsBody({ ledgerId, table, readingId, copyId }: {
  ledgerId: string; table: string; readingId: string | null; copyId?: string
}) {
  if (!isRecordTable(table)) notFound()
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const today = localToday()
  const [reading, choices] = await Promise.all([
    readingId ? readingById(ledgerId, readingId) : null,
    recordChoices(head.entity_id),
  ])
  const kinds = choices.minuteKinds

  const entered = reading?.records_entered[table] ?? null
  const read = reading && !entered ? reading.proposal?.rows[table] ?? [] : []
  let copied: Record<string, string> | null = null
  if (copyId) {
    if (table === 'offices') {
      const row = (await allOffices(head.entity_id)).find((r) => r.id === copyId)
      if (row) copied = { office: row.office, deliveryAddress: row.delivery_address,
        deliveryCity: row.delivery_city, deliveryPostal: row.delivery_postal ?? '',
        effectiveFrom: row.effective_from }
    } else if (table === 'directors') {
      const row = (await allDirectorships(head.entity_id)).find((r) => r.id === copyId)
      if (row) copied = { name: row.name, address: row.prescribed_delivery,
        appointedOn: row.appointed_on, ceasedOn: row.ceased_on ?? '' }
    } else if (table === 'shares') {
      const row = (await movementRows(head.entity_id)).find((r) => r.id === copyId)
      if (row) copied = { kind: row.kind, shareClass: row.share_class, onDate: row.on_date,
        from: row.from_name, to: row.to_name, quantity: row.quantity,
        consideration: row.consideration, certificateNo: '', surrenderedNo: '',
        balanceNo: '', details: row.details }
    } else if (table === 'transparency') {
      const row = (await allSignificantIndividuals(head.entity_id)).find((r) => r.id === copyId)
      if (row) copied = { name: row.name, howControl: row.how_control,
        becameOn: row.became_on, ceasedOn: row.ceased_on ?? '',
        birthDate: row.birth_date ?? '', lastKnownAddress: row.last_known_address ?? '',
        citizenOrPr: row.citizen_or_pr ? 'yes' : 'no', citizenships: row.citizenships ?? '',
        taxResidentCa: row.tax_resident_ca ? 'yes' : 'no' }
    } else if (table === 'minute_book') {
      const row = (await minuteBookOf(head.entity_id)).find((r) => r.id === copyId)
      if (row) copied = { recordKind: row.record_kind, onDate: row.on_date,
        title: row.title, keptAt: row.kept_at, note: row.note ?? '' }
    }
    if (!copied) notFound()
  }
  const initial = copied
    ? formRowsFrom(table, [copied], { minuteKinds: kinds })
    : read.length > 0
    ? formRowsFrom(table, read, { minuteKinds: kinds }).map((r) => (
        // Where a read record is kept, when the model could not say: the file
        // it was read from is the one place this system knows it exists.
        table === 'minute_book' && !r.values.keptAt && reading?.filename
          ? { ...r, values: { ...r.values, keptAt: reading.filename } }
          : r))
    : [blankRow(table, 0, today)]
  const words = TABLE_WORDS[table]

  return (
    <>
      <PageHeading className="mt-2" title={<>
        {copied ? `Copy ${words.one}` : destinationOf(table)?.label ?? `Add to the ${words.title.toLowerCase()}`}
      </>} />
      <p className="mt-1 text-sm text-neutral-500">{head.entity}</p>

      {(table === 'directors' || table === 'transparency') && (
        null
      )}
      {table === 'shares' && (
        null
      )}

      {reading && (
        <div className="mt-4 rounded border border-clay-300 bg-clay-50 p-3 text-sm dark:border-clay-800 dark:bg-neutral-900"
             data-reading={reading.id}>
          {entered ? (
            <p>
              The rows read from {reading.filename ?? 'that sentence'} are already in the{' '}
              {words.title.toLowerCase()} — entered {entered.at.slice(0, 10)} by {entered.by}. Anything still
              missing can be added below by hand.
            </p>
          ) : read.length > 0 ? (
            <>
              <p className="font-medium">
                {formatNumber(read.length)} {read.length === 1 ? words.one : words.many} read from{' '}
                {reading.filename !== null
                  ? <a href={`/ledger/${ledgerId}/readings/${reading.id}/file`} target="_blank" className="underline underline-offset-2">{reading.filename}</a>
                  : 'a sentence you wrote'}.
              </p>
              <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
                Nothing is entered until you press the button. Check every row against the document: a
                model read these, not a person.
              </p>
            </>
          ) : (
            <p>Nothing was read for the {words.title.toLowerCase()} from {reading.filename ?? 'that sentence'}.</p>
          )}
        </div>
      )}

      <RowsForm
        ledgerId={ledgerId}
        table={table}
        readingId={reading && !entered && read.length > 0 ? reading.id : null}
        initial={initial}
        today={today}
        names={choices.names}
        localNames={choices.localNames}
        classes={choices.classes}
        minuteKinds={kinds}
        action={enterRowsAction}
      />
    </>
  )
}

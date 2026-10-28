/**
 * Render the corporate-records screen and an add form of rows with stand-in
 * doors, and read them back — `CR43` runs this.
 *
 * A process of its own, like render-sred-record: react-dom/server does not
 * exist under the react-server condition the suites run in, and both take
 * their doors as props so this file needs nothing that imports `server-only`.
 *
 * What it can see: STATIC markup. That the screen at rest carries no box to
 * type in — every add is a link to a floating form, every Cease a button — and
 * what the add form would submit: one named field per column per row, the
 * table, and the reading the rows came from. It cannot press anything, so a
 * row's Edit is opened by `data.initialEditing` (`<table>:<id>`, 0083).
 *
 *   npx tsx scripts/render-records.tsx '<json>'
 *   { what: 'screen', data }                                      → { html }
 *   { what: 'rows', table, readingId, rows, names, localNames, minuteKinds }  → { html }
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { RecordsScreen } from '../src/app/ledger/[ledgerId]/records/RecordsScreen'
import { RowsForm } from '../src/app/ledger/[ledgerId]/records/add/[table]/RowsForm'
import { formRowsFrom, type RecordTable } from '../src/lib/record-rows'

const input = JSON.parse(process.argv[2]) as {
  what: 'screen' | 'rows'
  data?: Omit<Parameters<typeof RecordsScreen>[0], 'actions' | 'ledgerId'>
  table?: RecordTable
  readingId?: string | null
  rows?: Array<Record<string, string>>
  names?: string[]
  localNames?: string[]
  minuteKinds?: string[]
}
const stub = async () => ({})
const L = 'L'.repeat(36)

const tree = input.what === 'screen'
  ? <RecordsScreen {...input.data!} ledgerId={L}
                   actions={{
                     cease: stub, ceaseSi: stub, attachMinute: stub, detachMinute: stub,
                     correct: stub, remove: stub, renameClass: stub, deleteClass: stub,
                     setShareholderAddress: stub,
                   }} />
  : <RowsForm ledgerId={L} table={input.table!} readingId={input.readingId ?? null}
              initial={formRowsFrom(input.table!, input.rows ?? [], { minuteKinds: input.minuteKinds ?? [] })}
              today="2026-09-16" names={input.names ?? []} localNames={input.localNames ?? input.names ?? []}
              classes={[]} minuteKinds={input.minuteKinds ?? []}
              action={stub} />

console.log(JSON.stringify({ html: renderToStaticMarkup(tree) }))

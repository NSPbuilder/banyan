/**
 * Renders the bank import screen against a fixture and prints what a person
 * would actually see, as JSON:
 *
 *   npx tsx scripts/render-bank-screen.tsx '<{text, roles?, order?, flip?}>'
 *
 * The library checks prove that `screenFor` refuses to produce rows while the
 * date format is unsettled. They cannot prove the screen asks it. That gap is
 * how a rule stayed correct in `registrations.ts` for six rounds while the page
 * above it kept the defect — so the page is rendered and read, not reasoned about.
 *
 * A separate process because the other suites run under
 * `--conditions=react-server`, where `react-dom/server` will not load.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { unescape } from './suite'
import {
  findHeaderRow, guessMapping, parseCsv, profileColumns, screenFor, sniffDelimiter, withRole,
  type ColumnRole, type Mapping,
} from '../src/lib/bank-csv'
import type { DateOrder } from '../src/lib/dates'
import { ImportScreen } from '../src/app/ledger/[ledgerId]/bank/import/ImportScreen'
import { LandRows, type ImportableAccount } from '../src/app/ledger/[ledgerId]/bank/import/LandRows'

const input = JSON.parse(process.argv[2]) as {
  text: string
  roles?: ColumnRole[]
  order?: DateOrder | null
  flip?: boolean
  /** Role changes made AFTER the order is set, in order, the way a person would. */
  moves?: Array<{ index: number; role: ColumnRole }>
  /** When given, the save form is rendered too and its fields reported. */
  accounts?: ImportableAccount[]
}

const delimiter = sniffDelimiter(input.text)
const grid = parseCsv(input.text, delimiter)
const headerRow = findHeaderRow(grid)
const profiles = profileColumns(grid, headerRow)
const guessed = guessMapping(profiles)

const initial: Mapping = {
  roles: input.roles ?? guessed.roles,
  order: input.order === undefined ? guessed.order : input.order,
  flip: input.flip ?? false,
}

// Through `withRole`, because that is the path the screen's own handler takes.
// Rewriting `roles` here instead would test a sequence the application never
// performs, which is how the defect this exists to catch got in.
const mapping = (input.moves ?? []).reduce(
  (m, mv) => withRole(m, mv.index, mv.role), initial)

const screen = screenFor(profiles, grid, headerRow, mapping)

const markup = renderToStaticMarkup(
  <ImportScreen
    fileName="statement.csv"
    rowCount={grid.length}
    delimiter={delimiter}
    headerRow={headerRow}
    profiles={profiles}
    mapping={mapping}
    screen={screen}
    onRole={() => {}}
    onOrder={() => {}}
    onFlip={() => {}} />)

/**
 * The save form, rendered from the SAME rows the preview above was given.
 *
 * That is the whole point of rendering it here rather than testing it apart: a
 * form that submits something other than what was on screen is not a defect any
 * check over either half alone could see.
 */
const landMarkup = input.accounts && screen.applied
  ? renderToStaticMarkup(
      <LandRows
        ledgerId="LEDGER" accounts={input.accounts} fileName="statement.csv"
        rows={screen.applied.rows} action="/save" />)
  : ''

/** Attribute values come back HTML-escaped; a check needs what the browser would post. */

const landFields: Record<string, string> = {}
for (const tag of landMarkup.matchAll(/<input\b[^>]*>/g)) {
  const name = /name="([^"]+)"/.exec(tag[0])
  if (name) landFields[name[1]] = unescape(/value="([^"]*)"/.exec(tag[0])?.[1] ?? '')
}
// The account is picked with a combobox now, not a `<select>`, so its choices
// are buttons carrying the id they stand for. They are still in the markup —
// the picker renders the whole list and hides it — which is what keeps this
// check meaningful (2026-09-07).
const accountOptions = [...landMarkup.matchAll(/data-option="([^"]*)"/g)].map((m) => m[1])

/**
 * The rows as the PREVIEW table renders them — read out of the markup, not out
 * of the object the markup was built from.
 *
 * A check that compares the form's payload with `screen.applied.rows` compares
 * one value with itself. This is the other side: what a person can see.
 */
const tables = [...markup.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map((m) => m[1])
const previewRows = (tables[tables.length - 1] ?? '')
  .split('</tr>')
  .map((tr) => [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
    .map((c) => unescape(c[1].replace(/<[^>]+>/g, '').trim())))
  .filter((cells) => cells.length === 3)
  .map(([date, description, amount]) => ({ date, description, amount }))

const text = markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/&#x2F;/g, '/').replace(/\s+/g, ' ').trim()

/** Which option each select actually has marked selected, keyed by field name. */
const selected: Record<string, string> = {}
for (const m of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
  const name = /name="([^"]+)"/.exec(m[1])?.[1]
  if (!name) continue
  const chosen = /<option[^>]*\bselected(?:="")?[^>]*value="([^"]*)"/.exec(m[2])
    ?? /<option[^>]*value="([^"]*)"[^>]*\bselected/.exec(m[2])
  selected[name] = chosen?.[1] ?? ''
}

/** Every option offered for the date format, in order. */
const orderSelect = /<select\b[^>]*name="date-order"[^>]*>([\s\S]*?)<\/select>/.exec(markup)
const orderOptions = orderSelect
  ? [...orderSelect[1].matchAll(/value="([^"]*)"/g)].map((m) => m[1])
  : null

/**
 * Whether the RESULT is on screen, not merely whether digits are.
 *
 * The obvious detector — "does any money figure appear" — is a false positive
 * here: the mapper shows sample values from the file, and it should. The
 * summary sentence is written by the preview and by nothing else, so it is the
 * one string that means "these rows were read".
 */
const showsResults = /In .*?, out .*?, net /.test(text)

process.stdout.write(JSON.stringify({
  // Read off the rendered markup — what a person would see.
  showsResults,
  blockedNotice: /Nothing is read until these are settled/.test(text),
  // Library facts, reported alongside so a disagreement between what the
  // library decided and what the screen showed is visible rather than assumed.
  problems: screen.problems.map((p) => `${p.level}:${p.code}`),
  hasRows: screen.applied !== null,
  rowCount: screen.applied?.rows.length ?? null,
  order: mapping.order,
  selected,
  orderOptions,
  // The save form, when accounts were supplied.
  landFields,
  previewRows,
  landAction: /<form\b[^>]*action="([^"]*)"/.exec(landMarkup)?.[1] ?? null,
  accountOptions,
  text: text.slice(0, 1200),
}))

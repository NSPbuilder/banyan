/**
 * THE ROWS A CORPORATE RECORD TAKES — one list, read three ways.
 *
 * The owner had a model read a minute book into the corporate records
 * (2026-09-16) and it could not: 「可能因为 corporate records 不是表单」. They
 * were right about the cause. A minute book is many events — directors in and
 * out, shares issued and moved, meetings, resolutions, an office that changed —
 * and a reading could carry one flat map of facts, which fits a certificate of
 * incorporation and nothing longer. The screens were single-row boxes sitting
 * under each register, so there was no form for a proposal to fill.
 *
 * So each register is now a table with an ADD FORM of rows, and this file is
 * where a row's columns are said once:
 *
 *   the prompt     `rowsMenu()` tells the model the shape of each row, generated
 *                  from these arrays — the discipline `destinationMenu` has;
 *   the form       the add form draws one input per column, in this order;
 *   the reader     `rowsFrom` keeps only these columns out of whatever the model
 *                  answered, and the door reads the same names back.
 *
 * Nothing here decides anything about the books. A row read by a model arrives
 * in a form for a person to check, and is entered only when they press the
 * button — the promise every other reading makes.
 *
 * Client-safe (no `server-only`): the add form renders these, and checks read
 * them with no server runtime.
 */

export type RowColumn = {
  /** The name on the wire, in the model's JSON and in the form. */
  key: string
  /** The column's heading on the form. */
  label: string
  /** What the model is told this column holds. One phrase; it goes into the prompt. */
  says: string
  /**
   * How the form draws it and how a model's value is taken:
   *   text    as read
   *   name    a person or company, matched to this company's list by name
   *   date    YYYY-MM-DD or nothing — a date that is not one is not guessed at
   *   count   a whole number of shares, commas allowed
   *   choice  one of `options`, matched loosely; otherwise left for a person
   */
  type: 'text' | 'name' | 'date' | 'count' | 'choice'
  required?: boolean
  /** Blank for facts that must be explicitly confirmed; other choices use their first option. */
  defaultValue?: string
  /** For `choice`. The minute book's kinds are not here: they come from the database's own CHECK. */
  options?: ReadonlyArray<{ value: string; label: string }>
  /** Placeholder on the form. */
  hint?: string
  /** Tailwind width for the cell. */
  width?: string
}

/** Offices: a change of registered or records office address. */
export const OFFICE_COLUMNS: readonly RowColumn[] = [
  { key: 'office', label: 'Office', says: '"registered" or "records"', type: 'choice', required: true,
    options: [{ value: 'registered', label: 'Registered' }, { value: 'records', label: 'Records' }], width: 'w-32' },
  { key: 'deliveryAddress', label: 'Delivery address', says: 'the street address', type: 'text', required: true, width: 'w-64' },
  { key: 'deliveryCity', label: 'City', says: 'the city', type: 'text', required: true, width: 'w-36' },
  { key: 'deliveryPostal', label: 'Postal', says: 'the postal code', type: 'text', width: 'w-28' },
  { key: 'effectiveFrom', label: 'Effective from', says: 'the day it took effect (YYYY-MM-DD)', type: 'date', required: true },
]

/**
 * The minute book: that a record exists, what kind, when, and where it is kept.
 * The text of a resolution stays a document (0035).
 */
export const MINUTE_COLUMNS: readonly RowColumn[] = [
  { key: 'recordKind', label: 'Kind', type: 'choice', required: true, width: 'w-52',
    says: "what kind of record, in a few words — directors' resolution, shareholders' minutes, "
        + 'consent to act, resignation, certificate, articles' },
  { key: 'onDate', label: 'Date', says: 'the date it bears (YYYY-MM-DD)', type: 'date', required: true },
  { key: 'title', label: 'Title', says: 'what it is, in one line', type: 'text', required: true, width: 'w-80' },
  { key: 'keptAt', label: 'Kept at', says: 'where the original is kept, if the document says', type: 'text', required: true,
    hint: 'minute book vol. 1, drive folder…', width: 'w-56' },
  { key: 'note', label: 'Note', says: 'anything else worth a line', type: 'text', width: 'w-56' },
]

/** One director's term: appointed, and ceased when the document says so. */
export const DIRECTOR_COLUMNS: readonly RowColumn[] = [
  { key: 'name', label: 'Director', says: "the director's full name", type: 'name', required: true, width: 'w-56' },
  { key: 'address', label: 'Prescribed address', says: 'their address as the document gives it', type: 'text', width: 'w-64',
    hint: "blank = the one on file" },
  { key: 'appointedOn', label: 'Appointed', says: 'the day appointed (YYYY-MM-DD), or "" when the document only records them ceasing', type: 'date' },
  { key: 'ceasedOn', label: 'Ceased', says: 'the day they ceased (YYYY-MM-DD), or ""', type: 'date' },
]

/** The securities register's movements: an issue, a transfer, a cancellation. */
export const SHARE_COLUMNS: readonly RowColumn[] = [
  { key: 'kind', label: 'What', says: '"issue", "transfer" or "cancellation"', type: 'choice', required: true, width: 'w-36',
    options: [
      { value: 'issue', label: 'Issue' },
      { value: 'transfer', label: 'Transfer' },
      { value: 'cancellation', label: 'Cancel (buy back)' },
    ] },
  { key: 'shareClass', label: 'Class', says: 'the class as the document names it, e.g. Class A Common', type: 'text', required: true,
    hint: 'Class A', width: 'w-40' },
  { key: 'onDate', label: 'On', says: 'the date (YYYY-MM-DD)', type: 'date', required: true },
  { key: 'from', label: 'From', says: 'who gives the shares up — a transfer or a cancellation; "" for an issue', type: 'name', width: 'w-48' },
  { key: 'to', label: 'To', says: 'who receives them — an issue or a transfer; "" for a cancellation', type: 'name', width: 'w-48' },
  { key: 'quantity', label: 'Shares', says: 'how many shares, a whole number', type: 'count', required: true, width: 'w-24' },
  { key: 'consideration', label: 'Consideration', says: 'what was given for them', type: 'text', hint: '$1.00 per share, cash', width: 'w-44' },
  { key: 'certificateNo', label: 'Cert. issued', says: 'the certificate issued to whoever receives the shares', type: 'text', hint: 'C-1', width: 'w-24' },
  { key: 'surrenderedNo', label: 'Cert. surrendered', says: 'the certificate given up', type: 'text', hint: 'C-1', width: 'w-24' },
  { key: 'balanceNo', label: 'Balance cert.', says: 'the certificate issued back for what the giver still holds', type: 'text', hint: 'C-3', width: 'w-24' },
  { key: 'details', label: 'Details', says: 'the resolution or agreement it rests on, with its date', type: 'text', hint: 'resolution date…', width: 'w-44' },
]

/** The transparency register: a significant individual, and when they stopped being one. */
export const INDIVIDUAL_COLUMNS: readonly RowColumn[] = [
  { key: 'name', label: 'Individual', says: 'their full name', type: 'name', required: true, width: 'w-56' },
  { key: 'citizenOrPr', label: 'Canadian citizen or PR', says: '"yes" or "no"; leave blank unless stated', type: 'choice', defaultValue: '',
    options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], width: 'w-44' },
  { key: 'taxResidentCa', label: 'Canadian tax resident', says: '"yes" or "no"; leave blank unless stated', type: 'choice', defaultValue: '',
    options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], width: 'w-44' },
  { key: 'citizenships', label: 'Citizenships (if neither)', says: 'countries of citizenship if not Canadian citizen or PR', type: 'text', width: 'w-56' },
  { key: 'howControl', label: 'How they control', says: 'how they are significant — e.g. registered owner of 75% of the shares', type: 'text',
    hint: 'registered owner of 75%…', width: 'w-64' },
  { key: 'becameOn', label: 'Since', says: 'the day they became one (YYYY-MM-DD)', type: 'date' },
  { key: 'ceasedOn', label: 'Ceased', says: 'the day they ceased (YYYY-MM-DD), or ""', type: 'date' },
  { key: 'birthDate', label: 'Born', says: 'date of birth (YYYY-MM-DD), if the document gives it', type: 'date' },
  { key: 'lastKnownAddress', label: 'Last known address', says: 'their address, if given', type: 'text', width: 'w-64' },
]

export type RecordTable = 'offices' | 'minute_book' | 'directors' | 'shares' | 'transparency'

/**
 * Each table's columns, by the DESTINATION key the table lives under
 * (`destinations.ts`). The key is the same word in three places — the model's
 * `"rows"` object, the add form's address, and the door's `table` field — so
 * there is no second name to translate through.
 */
export const RECORD_COLUMNS: Record<RecordTable, readonly RowColumn[]> = {
  offices: OFFICE_COLUMNS,
  minute_book: MINUTE_COLUMNS,
  directors: DIRECTOR_COLUMNS,
  shares: SHARE_COLUMNS,
  transparency: INDIVIDUAL_COLUMNS,
}

export const RECORD_TABLES = Object.keys(RECORD_COLUMNS) as RecordTable[]

export const isRecordTable = (v: unknown): v is RecordTable =>
  typeof v === 'string' && (RECORD_TABLES as string[]).includes(v)

/**
 * What each add form is called, what one row of it is, and the screen that
 * lists what it adds — where its Add button lives and where "back" goes.
 */
export const TABLE_WORDS: Record<RecordTable, { title: string; one: string; many: string; list: string }> = {
  offices: { title: 'Offices', one: 'office', many: 'offices', list: '/records' },
  minute_book: { title: 'Minute book', one: 'minute-book record', many: 'minute-book records', list: '/records/minute-book' },
  directors: { title: 'Directors register', one: 'director', many: 'directors', list: '/records/register/directors' },
  shares: { title: 'Securities register', one: 'share movement', many: 'share movements', list: '/records/register/central_securities' },
  transparency: { title: 'Transparency register', one: 'significant individual', many: 'significant individuals', list: '/records/register/transparency' },
}

/** How many rows one reading may carry into one table. A minute book is long; an answer is not endless. */
export const ROWS_PER_TABLE = 100

/** Fold a key to letters only, lowercased — `appointed_on`, `appointedOn` and `Appointed On` meet here. */
const plain = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

export type ReadRows = Partial<Record<RecordTable, Array<Record<string, string>>>>

/**
 * The model's `rows`, made safe: only the tables above, only their columns
 * (whatever spelling the model used for a column's name), strings only, and a
 * row with nothing in it is no row. Anything else it said is dropped here,
 * once, so no screen has to be careful about it.
 */
export function rowsFrom(raw: unknown): ReadRows {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const tables = new Map(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [plain(k), v]))
  const out: ReadRows = {}
  for (const table of RECORD_TABLES) {
    const list = tables.get(plain(table))
    if (!Array.isArray(list)) continue
    const rows: Array<Record<string, string>> = []
    for (const item of list) {
      if (rows.length >= ROWS_PER_TABLE) break
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
      const cells = new Map(Object.entries(item as Record<string, unknown>).map(([k, v]) => [plain(k), v]))
      const row: Record<string, string> = {}
      for (const c of RECORD_COLUMNS[table]) {
        const v = cells.get(plain(c.key))
        const t = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : ''
        if (t) row[c.key] = t.slice(0, 300)
      }
      if (Object.keys(row).length > 0) rows.push(row)
    }
    if (rows.length > 0) out[table] = rows
  }
  return out
}

/** How many rows a reading carries, table by table — what the reading card counts. */
export const rowCounts = (rows: ReadRows): Array<[RecordTable, number]> =>
  RECORD_TABLES.flatMap((t) => (rows[t]?.length ? [[t, rows[t]!.length] as [RecordTable, number]] : []))

/**
 * The prompt's half of this file: the shape of every table's rows, in words.
 *
 * Built from the arrays above, so a column added to a table is a column the
 * model is asked for the same day.
 */
export function rowsMenu(): string {
  const shape = (t: RecordTable) =>
    `"${t}" rows are {${RECORD_COLUMNS[t].map((c) => `"${c.key}": ${c.says}`).join('; ')}}`
  return [
    'For the corporate record, put every event you read into "rows", one object per event, under the',
    'table it belongs to — never into "facts". A minute book usually fills several tables: every meeting,',
    'resolution, consent or certificate is a "minute_book" row, and what it decided about directors, shares,',
    'significant individuals or offices is ALSO a row of that table. The tables:',
    `${RECORD_TABLES.map(shape).join('. ')}.`,
  ].join(' ')
}

// ------------------------------------------------------ into the add form --

/** What a model wrote for a choice, folded to compare: `Directors' Resolution` → `directors resolution`. */
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** And without a plural `s`, so `director consent` still finds `directors_consent`. */
const stem = (w: string) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)

/**
 * The option a model's words name, or null.
 *
 * Exact first (`transfer`, `directors_resolution`, `Directors resolution`),
 * then the one option whose every word appears in what was read — `consent to
 * act as a director` finds `directors_consent`. Two options that both fit is
 * not a match: a person picks.
 */
export function choiceOf(read: string, options: readonly string[]): string | null {
  const said = words(read)
  const exact = options.find((o) => words(o) === said)
  if (exact) return exact
  const have = new Set(said.split(' ').map(stem))
  const fits = options.filter((o) => words(o).split(' ').every((w) => have.has(stem(w))))
  return fits.length === 1 ? fits[0] : null
}

export type FormRow = {
  /** Allocated once, never the position — the invoice editor's rule (`invoice-rows.ts`). */
  key: number
  values: Record<string, string>
  /** What was read but could not be put in a cell as it stood: shown under the row. */
  unplaced: string[]
}

/**
 * A reading's rows as the add form opens with them.
 *
 * A date that is not a date, a share count that is not a count, and a choice
 * that is none of the options arrive BLANK, with what was read said beneath —
 * the same rule `dateFact` keeps for the profile: a value is not guessed into
 * a box. `options` supplies the lists a column does not carry itself (the
 * minute book's kinds, read from the database).
 */
export function formRowsFrom(
  table: RecordTable, rows: Array<Record<string, string>>,
  options: { minuteKinds?: readonly string[] } = {},
): FormRow[] {
  return rows.map((row, key) => {
    const values: Record<string, string> = {}
    const unplaced: string[] = []
    for (const c of RECORD_COLUMNS[table]) {
      const v = (row[c.key] ?? '').trim()
      if (!v) { values[c.key] = ''; continue }
      if (c.type === 'date') {
        const ok = /^\d{4}-\d{2}-\d{2}$/.test(v)
        values[c.key] = ok ? v : ''
        if (!ok) unplaced.push(`${c.label}: ${v}`)
      } else if (c.type === 'count') {
        const n = v.replace(/[,\s]/g, '')
        const ok = /^\d+$/.test(n)
        values[c.key] = ok ? n : ''
        if (!ok) unplaced.push(`${c.label}: ${v}`)
      } else if (c.type === 'choice') {
        const list = c.options?.map((o) => o.value) ?? (c.key === 'recordKind' ? options.minuteKinds ?? [] : [])
        const hit = choiceOf(v, list)
        values[c.key] = hit ?? ''
        if (hit === null || words(hit) !== words(v)) unplaced.push(`${c.label} read as: ${v}`)
      } else {
        values[c.key] = v
      }
    }
    return { key, values, unplaced }
  })
}

/** A blank row with the form's defaults: today in the first required date, the first option in each fixed choice. */
export function blankRow(table: RecordTable, key: number, today: string): FormRow {
  const values: Record<string, string> = {}
  let dated = false
  for (const c of RECORD_COLUMNS[table]) {
    if (c.type === 'date' && !dated && (c.required || c.key === 'appointedOn' || c.key === 'becameOn')) {
      values[c.key] = today
      dated = true
    } else if (c.type === 'choice' && c.options) {
      values[c.key] = c.defaultValue ?? c.options[0].value
    } else {
      values[c.key] = ''
    }
  }
  return { key, values, unplaced: [] }
}

/**
 * The add form's rows and what a button does to them — pure, the invoice line
 * editor's shape (`invoice-rows.ts`): a row is its KEY, never its position,
 * and the values live here rather than in the DOM, so a refused form keeps
 * what was typed and removing a middle row takes that row's values with it.
 */
export type RowsState = { rows: FormRow[]; nextKey: number }

export const rowsStateOf = (rows: FormRow[]): RowsState =>
  ({ rows, nextKey: rows.reduce((m, r) => Math.max(m, r.key + 1), 0) })

export const addFormRow = (s: RowsState, table: RecordTable, today: string): RowsState =>
  ({ rows: [...s.rows, blankRow(table, s.nextKey, today)], nextKey: s.nextKey + 1 })

/** Taking the last row out leaves a blank one: a form with no rows is a form nobody can use. */
export function removeFormRow(s: RowsState, key: number, table: RecordTable, today: string): RowsState {
  const rows = s.rows.filter((r) => r.key !== key)
  return rows.length > 0 ? { ...s, rows } : { rows: [blankRow(table, s.nextKey, today)], nextKey: s.nextKey + 1 }
}

export const editFormRow = (s: RowsState, key: number, column: string, value: string): RowsState =>
  ({ ...s, rows: s.rows.map((r) => (r.key === key ? { ...r, values: { ...r.values, [column]: value } } : r)) })

/** Whether a row carries anything at all. A blank row on a submitted form is not a row. */
export const rowIsBlank = (table: RecordTable, values: Record<string, string>): boolean =>
  RECORD_COLUMNS[table].every((c) => c.type === 'choice' || c.type === 'date' || !(values[c.key] ?? '').trim())

/**
 * A party's name the way `party_name_key` (0026) reads it — lowercased, runs of
 * space made one, trimmed. For the form's "new — will be added" mark only; the
 * door asks the database's own function, which is the one that decides.
 */
export const nameKey = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

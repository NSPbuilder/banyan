import { parseMoney } from './money'
import { INVOICE_LINE_SLOTS } from './forms'
import { computeEnteredTax, parseTaxOverride, type TaxCode } from './tax-rates'
import { moveLineTo } from './line-order'

/**
 * The rows of the line editor, and what happens to them.
 *
 * All of it is here, as pure functions over a list, because none of it can be
 * checked where it is used. Adding a row is a click; a check can render the
 * screen once and read the markup, and that is all — it cannot press anything.
 * A transition that only exists inside a component is a transition nothing
 * watches.
 *
 * THE ROW IS NOT ITS POSITION. Every operation takes a `key`, and the key is
 * allocated once when the row appears and never reused. Position is a rendering
 * fact — it decides the number in the field names and the number the person
 * reads — and it changes under a row whenever another row is removed above it.
 *
 * That distinction is the whole file. `src/lib/forms.ts` states the rule it
 * comes from: an index is safe when it binds fields WITHIN a row, and dangerous
 * when it binds a row to a list rendered elsewhere. A remove button holding an
 * index is exactly the dangerous shape — the index is read after the render
 * that produced it, against a list that may have moved.
 *
 * And the values live here rather than in the DOM. Uncontrolled inputs keyed by
 * position do something specific and quiet when a row in the middle is removed:
 * React keeps the input elements and only drops the last one, so every row
 * below the removed one keeps ITS OWN box while the values slide up by one. The
 * screen shows a full form. The values are attached to the wrong accounts.
 */

export type LineRow = {
  /** Allocated once, never reused, never the position. */
  key: number
  account: string
  description: string
  amount: string
  /** The tag driving resident tax computation; out of scope computes nothing. */
  taxCode: string
  gst?: string
  pst?: string
}

export type RowState = {
  rows: LineRow[]
  /** The next key to hand out. Only ever goes up. */
  nextKey: number
  inclusive?: boolean
}

function blank(key: number): LineRow {
  return { key, account: '', description: '', amount: '', taxCode: 'OUT_OF_SCOPE' }
}

/** The rows the form opens with. */
export function initialRows(count: number = INVOICE_LINE_SLOTS): RowState {
  return { rows: Array.from({ length: count }, (_, i) => blank(i)), nextKey: count }
}

export function addRow(state: RowState): RowState {
  return { ...state, rows: [...state.rows, blank(state.nextKey)], nextKey: state.nextKey + 1 }
}

/** Copy values, including tax overrides, while allocating a new stable key. */
export function duplicateRow(state: RowState, key: number): RowState {
  const index = state.rows.findIndex(row => row.key === key)
  if (index < 0) return state
  const row = { ...state.rows[index], key: state.nextKey }
  return { ...state, rows: [...state.rows.slice(0, index + 1), row, ...state.rows.slice(index + 1)], nextKey: state.nextKey + 1 }
}

/**
 * Remove one row by key.
 *
 * Removing the last remaining row leaves a blank one rather than an empty form.
 * A form with no rows at all can only be got out of by reloading the page, and
 * the person who emptied it was trying to clear it, not to leave.
 */
export function removeRow(state: RowState, key: number): RowState {
  const rows = state.rows.filter((r) => r.key !== key)
  if (rows.length > 0) return { ...state, rows }
  return { ...state, rows: [blank(state.nextKey)], nextKey: state.nextKey + 1 }
}

/**
 * Move one row up (-1) or down (+1). Off either end, nothing happens — the
 * button is disabled there, and a disabled button is a courtesy rather than a
 * guarantee.
 */
export function moveRow(state: RowState, key: number, by: -1 | 1): RowState {
  const from = state.rows.findIndex((r) => r.key === key)
  if (from < 0) return state
  const to = from + by
  if (to < 0 || to >= state.rows.length) return state
  const rows = [...state.rows]
  ;[rows[from], rows[to]] = [rows[to], rows[from]]
  return { ...state, rows }
}

/** Move the row identified by its stable key to its final visible position. */
export function moveRowTo(state: RowState, key: number, to: number): RowState {
  const rows = moveLineTo(state.rows, state.rows.findIndex((r) => r.key === key), to)
  return rows === state.rows ? state : { ...state, rows }
}

/** Type into one field of one row. Again by key: the row may have moved. */
export function editRow(
  state: RowState, key: number, field: 'account' | 'description' | 'amount' | 'taxCode' | 'gst' | 'pst', value: string,
): RowState {
  return { ...state, rows: state.rows.map((r) => r.key !== key ? r
    : field === 'taxCode' ? { ...r, taxCode: value, gst: undefined, pst: undefined }
    : { ...r, [field]: value }) }
}

export function resetRowTax(state: RowState, key: number): RowState {
  return { ...state, rows: state.rows.map(r => r.key === key ? { ...r, gst: undefined, pst: undefined } : r) }
}

export type TypedTotal = {
  /** The sum of the rows that read as amounts, in the sense the person types. */
  total: bigint
  /** Rows with something in them that does not read as an amount. */
  unreadable: number
  /** Rows with an account or an amount — the ones that will become lines. */
  filled: number
}

/**
 * What the form adds up to as it stands.
 *
 * In the sense the person types: what the lines ADD to the invoice, positive on
 * both kinds of document. The sign the ledger gets is applied by the reader,
 * from the direction — see `ledgerAmount`.
 *
 * A row that does not read as an amount is counted rather than guessed at, so
 * the screen can say the total is short of what is typed instead of showing a
 * confident figure that leaves a line out. That is the failure the bank reader
 * shipped: a lone bracket read as 0.00 and every total agreed with it.
 *
 * `V85` checks this against what `linesFrom` returns for the same rows, because
 * a total under a form that disagrees with the reader above it is a lie the
 * screen cannot show.
 */
export function typedTotal(rows: LineRow[], tax?: { inclusive: boolean; on: string }): TypedTotal {
  let total = 0n
  let unreadable = 0
  let filled = 0
  for (const r of rows) {
    const amount = r.amount.trim()
    if (!r.account.trim() && !amount && !r.gst?.trim() && !r.pst?.trim()) continue
    filled++
    if (!amount) { unreadable++; continue }
    try {
      const parsed = parseMoney(amount)
      if (parsed === 0n) unreadable++
      else total += tax ? computeEnteredTax(parsed, r.taxCode as TaxCode, tax.inclusive, tax.on, {
        gst: parseTaxOverride(r.gst),
        pst: parseTaxOverride(r.pst),
      }).total : parsed
    } catch {
      unreadable++
    }
  }
  return { total, unreadable, filled }
}

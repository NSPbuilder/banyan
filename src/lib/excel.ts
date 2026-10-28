import 'server-only'
import ExcelJS from 'exceljs'
import type { PdfBlock } from './pdf'
import { localToday } from './today'

/**
 * A report as an Excel workbook — the same blocks the PDF prints, laid onto
 * a sheet (owner, 2026-09-04: "我想要的是一个 excel，并且有完善的报表格式").
 *
 * ONE source for both papers: every report builds `PdfBlock[]` once and hands
 * it to `reportPdf` or to this. A workbook that read the figures a second time
 * would be the two-renderers defect with a spreadsheet on one side of it.
 *
 * What "proper report formatting" means here, so it is decided once:
 *   - a title block: company, report name in bold, the subtitle lines;
 *   - a heading is a bold row; a note is an italic wrapped row;
 *   - a table's header row is bold with a rule under it; its money cells are
 *     NUMBERS with an accounting format (negatives in parentheses), right
 *     aligned, so the reader can add a column up; a `rule` row gets a rule
 *     over it; a bold row is bold; an indent is an indent;
 *   - column widths from the same weights the PDF uses; the first table's
 *     header stays frozen at the top.
 */

export const MONEY_FORMAT = '#,##0.00;(#,##0.00);"-"'

/** "1,234.56", "-12.50", "(12.50)" → cents; anything else is text. */
export function moneyCells(text: string): number | null {
  const t = text.trim()
  const m = /^\(?(-?)([\d,]+)\.(\d\d)\)?$/.exec(t)
  if (!m) return null
  const v = Number(m[2].replace(/,/g, '')) + Number(m[3]) / 100
  return m[1] === '-' || t.startsWith('(') ? -v : v
}

export async function reportXlsx(head: {
  company: string
  title: string
  subtitle?: string[]
  landscape?: boolean
}, blocks: PdfBlock[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Banyan'
  wb.created = new Date()
  const ws = wb.addWorksheet(head.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), {
    pageSetup: { orientation: head.landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })

  // The widest table decides the columns; every table shares them, so a
  // two-column summary sits over a seven-column ledger without the ledger's
  // columns being squeezed. Widths come from the PDF's weights, scaled so a
  // sheet is about a hundred characters wide.
  const tables = blocks.filter((b): b is Extract<PdfBlock, { kind: 'table' }> => b.kind === 'table')
  const widest = tables.reduce((n, t) => Math.max(n, t.columns.length), 2)
  const weights = new Array<number>(widest).fill(1)
  for (const t of tables) t.columns.forEach((c, i) => { weights[i] = Math.max(weights[i], c.weight ?? 1) })
  const total = weights.reduce((a, b) => a + b, 0)
  weights.forEach((w, i) => { ws.getColumn(i + 1).width = Math.max(10, Math.round((w / total) * 110)) })

  let r = 1
  const put = (values: Array<string | number>, style?: (cell: ExcelJS.Cell, i: number) => void) => {
    const row = ws.getRow(r)
    values.forEach((v, i) => {
      const cell = row.getCell(i + 1)
      cell.value = v
      style?.(cell, i)
    })
    r += 1
    return row
  }

  put([head.company], (c) => { c.font = { size: 9, color: { argb: 'FF666666' } } })
  put([head.title], (c) => { c.font = { size: 14, bold: true } })
  for (const line of head.subtitle ?? []) put([line], (c) => { c.font = { size: 9, color: { argb: 'FF666666' } } })
  r += 1

  // A header row is frozen only when it is the header of EVERYTHING below it:
  // one column set across every table. The reconciliation report opens with a
  // two-column summary over five-column details, and freezing the summary's
  // header pinned a row that never matched what scrolled under it (critic).
  // A header whose labels are all empty — the statement's — is not written at
  // all; a ruled blank row is not a header.
  const columnSets = new Set(tables.map((t) => t.columns.map((c) => c.label).join('')))
  const oneShape = columnSets.size === 1
  let frozen = false
  for (const block of blocks) {
    if (block.kind === 'gap') { r += 1; continue }
    if (block.kind === 'heading') {
      r += 1
      put([block.text], (c) => { c.font = { bold: true, size: 10 } })
      continue
    }
    if (block.kind === 'note') {
      const row = put([block.text], (c) => {
        c.font = { italic: true, size: 9, color: { argb: 'FF666666' } }
        c.alignment = { wrapText: true, vertical: 'top' }
      })
      ws.mergeCells(row.number, 1, row.number, widest)
      row.height = Math.max(15, Math.ceil(block.text.length / 100) * 14)
      continue
    }
    // A table: the header (when it says anything), then each row with money
    // as numbers.
    const labelled = block.columns.some((c) => c.label !== '')
    if (labelled) {
      const header = put(block.columns.map((c) => c.label), (cell, i) => {
        cell.font = { bold: true, size: 9 }
        cell.alignment = { horizontal: block.columns[i]?.align ?? 'left' }
        cell.border = { bottom: { style: 'thin' } }
      })
      if (!frozen && oneShape) { ws.views = [{ state: 'frozen', ySplit: header.number }]; frozen = true }
    }
    for (const row of block.rows) {
      put(row.cells.map((c) => (typeof c === 'string' ? c : c.text)), (cell, i) => {
        const text = String(cell.value ?? '')
        const num = moneyCells(text)
        const align = block.columns[i]?.align ?? 'left'
        if (num !== null && align === 'right') {
          cell.value = num
          cell.numFmt = MONEY_FORMAT
        }
        cell.alignment = { horizontal: align, indent: i === 0 ? (row.indent ?? 0) : 0 }
        const raw = row.cells[i]
        const bold = row.bold || (typeof raw === 'object' && raw.bold)
        if (bold) cell.font = { bold: true }
        if (row.rule) cell.border = { top: { style: 'thin' } }
      })
    }
    r += 1
  }

  r += 1
  put([`Generated ${localToday()} — every figure derived from the journal at that moment`],
    (c) => { c.font = { size: 8, color: { argb: 'FF888888' } } })

  return Buffer.from(await wb.xlsx.writeBuffer())
}

/**
 * A plain row grid — what the CSV exits build — as a workbook: the first row
 * is the title block, the first row after a blank is the header, money is
 * numbers. For the THREE exports that have no PDF of their own (the journal,
 * an account's history, the PD7A worksheet) — the /export route admits
 * `format=xlsx` for exactly those, because the header heuristic below is
 * right for their shape and wrong for a grid that opens with a warning row
 * (critic). Every other report's Excel comes from its own blocks above.
 *
 * Money is decided PER COLUMN: a column is money when every filled cell
 * under the header parses as money. A cell-by-cell parse would have turned
 * an entry number or a code shaped like 1000.00 into a figure; a count (the
 * PD7A's runs and employees) is a plain integer, not "2.00".
 */
export async function rowsXlsx(
  title: string, rows: Array<Array<string | number | null | undefined>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '))
  const widest = rows.reduce((n, row) => Math.max(n, row.length), 1)
  for (let i = 1; i <= widest; i++) ws.getColumn(i).width = i === 1 ? 14 : 18

  const isBlank = (values: typeof rows[number]) =>
    values.length === 0 || values.every((v) => v === '' || v == null)
  // The header: the first non-blank row after a blank, past the title row.
  let headerAt = -1
  for (let i = 1; i < rows.length && headerAt < 0; i++) {
    if (!isBlank(rows[i]) && isBlank(rows[i - 1])) headerAt = i
  }
  const moneyColumn = new Array<boolean>(widest).fill(false)
  for (let i = 0; i < widest; i++) {
    const filled = rows.slice(headerAt + 1)
      .map((row) => row[i]).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    // Party names remain text even when a name happens to look like 1000.00.
    moneyColumn[i] = rows[headerAt]?.[i] !== 'Party'
      && filled.length > 0 && filled.every((v) => moneyCells(v) !== null)
  }

  rows.forEach((values, idx) => {
    const row = ws.getRow(idx + 1)
    const isTitle = idx === 0
    const isHeader = idx === headerAt
    values.forEach((v, i) => {
      const cell = row.getCell(i + 1)
      const num = typeof v === 'string' && moneyColumn[i] && !isHeader && !isTitle ? moneyCells(v) : null
      if (num !== null) {
        cell.value = num
        cell.numFmt = MONEY_FORMAT
        cell.alignment = { horizontal: 'right' }
      } else if (typeof v === 'number') {
        cell.value = v
        cell.alignment = { horizontal: 'right' }
      } else {
        cell.value = v ?? ''
      }
      if (isTitle) cell.font = { bold: i === 1 || i === 0, size: i === 1 ? 12 : 10 }
      if (isHeader) { cell.font = { bold: true, size: 9 }; cell.border = { bottom: { style: 'thin' } } }
    })
    if (isHeader) ws.views = [{ state: 'frozen', ySplit: idx + 1 }]
    // A total row: the last non-blank row whose first cells are empty and
    // whose label says so.
    const label = String(values.find((v) => typeof v === 'string' && v) ?? '')
    if (/^total/i.test(label) && idx > 2) {
      values.forEach((_, i) => { const c = row.getCell(i + 1); c.font = { bold: true }; c.border = { top: { style: 'thin' } } })
    }
  })
  return Buffer.from(await wb.xlsx.writeBuffer())
}

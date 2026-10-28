import 'server-only'
import PDFDocument from 'pdfkit'
import { localToday } from './today'

/**
 * The one PDF builder every report goes through.
 *
 * A report's PDF is a SECOND EXIT for the same derivation the screen renders —
 * the route calls the same lib function the page calls and hands the result
 * here. This file knows nothing about accounting: it takes labelled tables and
 * prose and lays them on paper. Numbers arrive pre-formatted, because the
 * moment this file formats money it becomes a place money formatting can
 * disagree with `formatMoney`.
 *
 * `compress: false` on purpose: the content streams stay readable text, so the
 * export suite can assert a figure is IN the file the way it asserts a CSV
 * cell — by looking. The files are small either way; reports are text.
 */

export type PdfCell = string | { text: string; bold?: boolean }

export type PdfBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'gap' }
  | {
      kind: 'table'
      columns: Array<{ label: string; align?: 'left' | 'right'; weight?: number }>
      rows: Array<{ cells: PdfCell[]; rule?: boolean; indent?: number; bold?: boolean }>
    }

const PORTRAIT = { width: 612, height: 792, margin: 54 } // LETTER
/**
 * The same sheet turned. Asked for only when a table has more columns than the
 * upright page can hold a legible figure in — a statement cut into twelve
 * months is 13 money columns, and portrait gives each of them about thirty
 * points, which is not a number anybody can read (owner, 2026-09-12).
 */
const LANDSCAPE = { width: 792, height: 612, margin: 54 }
type Page = typeof PORTRAIT
const bottomOf = (page: Page) => page.height - 72
const FONT = 'Helvetica'
const BOLD = 'Helvetica-Bold'
const INK = '#171717'
const FAINT = '#737373'
const LINE = '#d4d4d4'

export function reportPdf(head: {
  company: string
  title: string
  /** Lines under the title: the span, the as-at date, whatever names the run. */
  subtitle?: string[]
  /** Turn the sheet. For a table too wide to read upright, nothing else. */
  landscape?: boolean
  /** Invoice paper may use a denser layout and a customer-facing footer. */
  compact?: boolean
  footerText?: string
  /** Verified static image bytes for invoice letterheads; never a path or URL. */
  logo?: { bytes: Buffer; width: number; height: number } | null
}, blocks: PdfBlock[]): Promise<Buffer> {
  const PAGE = head.landscape ? LANDSCAPE : PORTRAIT
  const doc = new PDFDocument({
    size: 'LETTER', layout: head.landscape ? 'landscape' : 'portrait',
    margin: PAGE.margin, compress: false, bufferPages: true,
    info: { Title: `${head.company} — ${head.title}` },
  })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  const innerWidth = PAGE.width - 2 * PAGE.margin

  if (head.logo) {
    const scale = Math.min(180 / head.logo.width, 52 / head.logo.height)
    const height = head.logo.height * scale, y = doc.y
    doc.image(head.logo.bytes, PAGE.margin, y, {width: head.logo.width * scale, height})
    doc.y = y + height + 12
  }

  doc.font(FONT).fontSize(9).fillColor(FAINT).text(head.company, { width: innerWidth })
  doc.moveDown(0.2)
  doc.font(BOLD).fontSize(head.compact ? 15 : 17).fillColor(INK).text(head.title, { width: innerWidth })
  for (const line of head.subtitle ?? []) {
    doc.moveDown(0.15)
    doc.font(FONT).fontSize(9).fillColor(FAINT).text(line, { width: innerWidth })
  }
  doc.moveDown(0.4)
  rule(doc, PAGE, doc.y)
  doc.moveDown(head.compact ? 0.4 : 0.8)

  for (const block of blocks) {
    if (block.kind === 'gap') { doc.moveDown(head.compact ? 0.4 : 0.9); continue }
    // Explicit x on every free-standing line. pdfkit leaves `doc.x` wherever
    // the last `text(…, x, y)` put it, and a table's last cell is its
    // right-most column — so a heading after a table started at the amount
    // column and ran off the page. Every multi-section report had it; it was
    // seen on the reconciliation report (owner, 2026-09-04).
    if (block.kind === 'heading') {
      breakIfNeeded(doc, PAGE, 40)
      doc.moveDown(0.5)
      doc.font(BOLD).fontSize(8).fillColor(FAINT)
        .text(block.text.toUpperCase(), PAGE.margin, doc.y, { width: innerWidth, characterSpacing: 0.6 })
      doc.moveDown(0.35)
      continue
    }
    if (block.kind === 'note') {
      breakIfNeeded(doc, PAGE, 30)
      doc.font(FONT).fontSize(8.5).fillColor(FAINT)
        .text(block.text, PAGE.margin, doc.y, { width: innerWidth * 0.9 })
      doc.moveDown(0.4)
      continue
    }
    table(doc, PAGE, block, innerWidth, head.compact)
  }

  // Page numbers and the generated-on line, once the page count is known.
  // The LOCAL day — toISOString here dated every evening's report tomorrow,
  // and R47 caught it before the first one was ever generated.
  const range = doc.bufferedPageRange()
  const today = localToday()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    // Writing inside the bottom margin makes pdfkit add a page — so every
    // report came out with its two footer lines on two blank pages of their
    // own, after a page that said "Page 1 of 1" (seen on the reconciliation
    // report, 2026-09-04). Lift the margin for the footer and put it back.
    const bottom = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.font(FONT).fontSize(7.5).fillColor(FAINT)
    doc.text(head.footerText ?? `Generated ${today} — every figure derived from the journal at that moment`,
      PAGE.margin, PAGE.height - 40, { width: innerWidth * 0.75, lineBreak: false })
    doc.text(`Page ${i - range.start + 1} of ${range.count}`,
      PAGE.margin, PAGE.height - 40, { width: innerWidth, align: 'right', lineBreak: false })
    doc.page.margins.bottom = bottom
  }
  doc.end()
  return done
}

function rule(doc: PDFKit.PDFDocument, page: Page, y: number,
              from = page.margin, to = page.width - page.margin) {
  doc.save().moveTo(from, y).lineTo(to, y).lineWidth(0.5).strokeColor(LINE).stroke().restore()
}

function breakIfNeeded(doc: PDFKit.PDFDocument, page: Page, need: number) {
  if (doc.y + need > bottomOf(page)) doc.addPage()
}

function table(
  doc: PDFKit.PDFDocument,
  page: Page,
  block: Extract<PdfBlock, { kind: 'table' }>,
  innerWidth: number,
  compact = false,
) {
  // WIDE TABLES SET SMALLER. Past nine columns the money columns of a letter
  // sheet, even turned, get narrow — fourteen columns leave each under forty
  // points — and at the ordinary size a six-figure amount is wider than that.
  // So the type steps down and the gutters close up.
  const dense = block.columns.length > 9
  const gutter = dense ? 6 : 10
  const size = dense ? 7 : 8.5
  const headSize = dense ? 6 : 7
  const weights = block.columns.map((c) => c.weight ?? 1)
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  const widths = weights.map((w) =>
    (innerWidth - gutter * (block.columns.length - 1)) * (w / totalWeight))
  const xs: number[] = []
  let x = page.margin
  for (const w of widths) { xs.push(x); x += w + gutter }

  // A FIGURE IS NEVER BROKEN ACROSS LINES, whatever its width: a number split
  // in two is a different number. PDFKit wraps anything given a `width`, by
  // character when a word is too long, and `lineBreak: false` does not stop
  // it — so a right-aligned cell is placed by hand from its measured width
  // and drawn with no width at all. When it is wider than its column it runs
  // a few points into the gutter on its left, which the eye forgives.
  const placeRight = (text: string, i: number, y: number, opts: { characterSpacing?: number } = {}) => {
    const w = doc.widthOfString(text, opts)
    doc.text(text, xs[i] + widths[i] - w, y, { lineBreak: false, ...opts })
  }

  const header = () => {
    doc.font(BOLD).fontSize(headSize).fillColor(FAINT)
    const y = doc.y
    const spacing = { characterSpacing: 0.5 }
    // A heading wraps at its spaces, and the row is as tall as the tallest:
    // "2026-01 – 2026-03" over a quarter column becomes two lines. One whose
    // every word fits is wrapped by PDFKit; one with a word wider than the
    // column is placed whole, like a figure, rather than cut mid-word.
    const cells = block.columns.map((c, i) => {
      const label = c.label.toUpperCase()
      const wraps = label.split(' ').every((w) => doc.widthOfString(w, spacing) <= widths[i])
      const height = wraps ? doc.heightOfString(label || ' ', { width: widths[i], ...spacing })
                           : doc.currentLineHeight()
      return { label, wraps, height }
    })
    cells.forEach(({ label, wraps }, i) => {
      const align = block.columns[i]?.align ?? 'left'
      if (wraps) doc.text(label, xs[i], y, { width: widths[i], align, ...spacing })
      else if (align === 'right') placeRight(label, i, y, spacing)
      else doc.text(label, xs[i], y, { lineBreak: false, ...spacing })
    })
    doc.y = y + Math.max(12, Math.max(...cells.map((c) => c.height)) + 4)
    rule(doc, page, doc.y - 3)
  }

  breakIfNeeded(doc, page, 48)
  header()

  for (const row of block.rows) {
    // Measure the tallest cell so a wrapping description moves the whole row.
    doc.font(row.bold ? BOLD : FONT).fontSize(size)
    const heights = row.cells.map((cell, i) => {
      const text = typeof cell === 'string' ? cell : cell.text
      const indent = i === 0 ? (row.indent ?? 0) * 12 : 0
      return block.columns[i]?.align === 'right'
        ? doc.currentLineHeight()
        : doc.heightOfString(text || ' ', { width: widths[i] - indent })
    })
    const rowHeight = Math.max(12, ...heights) + (compact ? 2 : 3)
    if (doc.y + rowHeight > bottomOf(page)) { doc.addPage(); header() }
    if (row.rule) rule(doc, page, doc.y - 1)
    const y = doc.y
    row.cells.forEach((cell, i) => {
      const text = typeof cell === 'string' ? cell : cell.text
      const bold = row.bold || (typeof cell === 'object' && cell.bold)
      const indent = i === 0 ? (row.indent ?? 0) * 12 : 0
      doc.font(bold ? BOLD : FONT).fontSize(size).fillColor(INK)
      if (block.columns[i]?.align === 'right') placeRight(text, i, y)
      else doc.text(text, xs[i] + indent, y, { width: widths[i] - indent, align: 'left' })
    })
    doc.y = y + rowHeight
  }
  doc.x = page.margin
  doc.moveDown(0.5)
}

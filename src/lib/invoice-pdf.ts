import 'server-only'
import PDFDocument from 'pdfkit'
import type { InvoiceDocument } from './customer-docs'
import { invoiceContactLines } from './invoice-template-types'
import { parseInvoiceLogo } from './invoice-branding'
import { invoiceAmount, invoiceDate, invoicePaper } from './invoice-paper'

const PAGE = { width: 612, height: 792, margin: 36, bottom: 714 }
const WIDTH = PAGE.width - 2 * PAGE.margin
const INK = '#171717', MUTED = '#555555', LINE = '#e5e5e5'

/** Invoice letterhead is deliberately separate from the financial report layout. */
export async function renderInvoicePdf(invoice: InvoiceDocument): Promise<Buffer> {
  const receipt = invoice.receipt
  const documentNumber = receipt ? receipt.invoiceNumber : invoice.number
  const logo = await parseInvoiceLogo(invoice.template?.settings.logoDataUrl)
  const paper = invoicePaper(invoice)
  const compact = invoice.template?.settings.layout === 'compact'
  const gap = compact ? 18 : 26
  const size = compact ? 9 : 10
  const leading = compact ? 12 : 14
  const doc = new PDFDocument({ size: 'LETTER', margin: PAGE.margin, compress: false, bufferPages: true,
    info: { Title: `${invoice.company.name} - ${invoice.title} ${documentNumber ?? ''}`.trim() } })
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  const font = (bold = false, fontSize = size, color = INK) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(color)
  const rule = (y: number, from = PAGE.margin, to = PAGE.width - PAGE.margin, color = LINE) => {
    doc.save().moveTo(from, y).lineTo(to, y).lineWidth(0.5).strokeColor(color).stroke().restore()
  }
  const text = (value: string, x: number, y: number, width: number, bold = false, fontSize = size) => {
    font(bold, fontSize)
    doc.text(value, x, y, { width, lineGap: 2 })
    return doc.y
  }
  const right = (value: string, x: number, y: number, width: number, bold = false, fontSize = size) => {
    font(bold, fontSize)
    const measured = doc.widthOfString(value)
    if (measured > width) font(bold, fontSize * width / measured)
    doc.text(value, x + width - doc.widthOfString(value), y, { lineBreak: false })
  }
  const newPage = () => {
    doc.addPage()
    text(`${invoice.title} ${documentNumber ?? ''}`.trim(), PAGE.margin, PAGE.margin, WIDTH, true, 9)
    rule(55)
    doc.y = 68
  }
  const ensure = (need: number) => { if (doc.y + need > PAGE.bottom) newPage() }

  doc.rect(0, 0, PAGE.width, 3).fill(INK)
  text(invoice.title, PAGE.margin, 34, WIDTH - 190, true, 21)
  if (logo) {
    const scale = Math.min(150 / logo.width, 48 / logo.height)
    doc.image(logo.bytes, PAGE.width - PAGE.margin - logo.width * scale, 34, { width: logo.width * scale, height: logo.height * scale })
  }
  let y = 72
  const metadata = receipt ? [
    ...(receipt.invoiceNumber ? [['Invoice number', receipt.invoiceNumber]] : []),
    ['Date paid', invoiceDate(receipt.paidOn)],
  ] : [
    [invoice.kind === 'credit_note' ? 'Credit note number' : 'Invoice number', invoice.number ?? 'Unnumbered'],
    ['Date of issue', invoiceDate(invoice.issuedOn)],
    ...(invoice.kind === 'invoice' ? [['Date due', invoiceDate(invoice.dueOn)]] : []),
  ]
  for (const [label, value] of metadata) {
    text(label, PAGE.margin, y, 102, false, 9.5)
    const end = text(value, PAGE.margin + 106, y, WIDTH - 290, label.endsWith('number'), 9.5)
    y = Math.max(y + 14, end + 2)
  }

  y += gap
  const columnWidth = (WIDTH - 36) / 2
  const addressBlock = (title: string, lines: string[], x: number, start: number) => {
    let end = text(title, x, start, columnWidth, true)
    for (const line of lines) end = text(line, x, end + 2, columnWidth)
    return end
  }
  const companyEnd = addressBlock(invoice.company.name, [
    ...invoiceContactLines(invoice.template?.settings, invoice.company.addressLines),
    ...invoice.company.taxNumbers,
  ], PAGE.margin, y)
  const customerEnd = addressBlock(receipt?.direction === 'paid' ? 'Paid to' : invoice.kind === 'credit_note' ? 'Credit to' : 'Bill to',
    [invoice.billTo.name, ...invoice.billTo.addressLines, ...(invoice.billTo.contactLines ?? [])], PAGE.margin + columnWidth + 36, y)
  doc.y = Math.max(companyEnd, customerEnd) + gap
  ensure(62)
  const headlineEnd = text(paper.headline, PAGE.margin, doc.y, WIDTH, true, compact ? 15 : 17)
  doc.y = headlineEnd + gap

  /** Wrap with measured glyph widths so even one very long item can span pages. */
  const wrap = (value: string, width: number): string[] => {
    font()
    const lines: string[] = []
    for (const paragraph of value.replace(/\r\n?/g, '\n').split('\n')) {
      let line = ''
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? line + ' ' + word : word
        if (doc.widthOfString(candidate) <= width) { line = candidate; continue }
        if (line) { lines.push(line); line = '' }
        for (const glyph of Array.from(word)) {
          if (line && doc.widthOfString(line + glyph) > width) { lines.push(line); line = '' }
          line += glyph
        }
      }
      lines.push(line)
    }
    return lines
  }
  const table = (columns: Array<{ label: string; width: number; right?: boolean }>, rows: string[][]) => {
    const xs = columns.map((_, i) => PAGE.margin + columns.slice(0, i).reduce((sum, c) => sum + c.width, 0))
    const header = () => {
      const start = doc.y
      columns.forEach((column, i) => {
        if (column.right) right(column.label, xs[i] + 8, start, column.width - 8, false, 8.5)
        else text(column.label, xs[i], start, column.width - 12, false, 8.5)
      })
      rule(start + 17, PAGE.margin, PAGE.width - PAGE.margin, INK)
      doc.y = start + 20
    }
    ensure(50)
    header()
    for (const row of rows) {
      const cells = row.map((cell, i) => columns[i].right ? [cell] : wrap(cell || '-', columns[i].width - 16))
      const length = Math.max(...cells.map(cell => cell.length))
      let offset = 0
      while (offset < length) {
        const remainingHeight = (length - offset) * leading + 14
        // Keep ordinary rows together; an oversized row uses the available space now.
        if (remainingHeight <= PAGE.bottom - 88 && doc.y + remainingHeight > PAGE.bottom) { newPage(); header() }
        const count = Math.min(length - offset, Math.floor((PAGE.bottom - doc.y - 14) / leading))
        if (count < 1) { newPage(); header(); continue }
        const start = doc.y + 6
        columns.forEach((column, i) => {
          if (column.right) { if (offset === 0) right(row[i], xs[i] + 8, start, column.width - 8) }
          else cells[i].slice(offset, offset + count).forEach((line, j) => text(line, xs[i], start + j * leading, column.width - 16))
        })
        doc.y = start + count * leading + 6
        rule(doc.y)
        offset += count
      }
    }
  }
  table([{ label: 'Description', width: WIDTH - 126 }, { label: 'Amount', width: 126, right: true }],
    paper.items.map(item => [item.description || '-', invoiceAmount(item.amount,invoice.currency)]))

  const summaryWidth = WIDTH * 0.52, summaryX = PAGE.margin + WIDTH - summaryWidth
  doc.y += 16
  ensure(paper.summary.length * 26 + 12)
  for (const row of paper.summary) {
    if (row.balance) { rule(doc.y, summaryX, PAGE.width - PAGE.margin, INK); doc.y += 8 }
    const start = doc.y
    const value = invoiceAmount(row.amount,invoice.currency)
    font(!!row.emphasis)
    const amountWidth = Math.min(summaryWidth * 0.66, Math.max(100, doc.widthOfString(value) + 6))
    const labelEnd = text(row.label, summaryX, start, summaryWidth - amountWidth - 14, !!row.emphasis)
    right(value, summaryX + summaryWidth - amountWidth, start, amountWidth, !!row.emphasis)
    doc.y = Math.max(start + 14, labelEnd) + 7
    if (!row.balance) rule(doc.y - 3, summaryX)
  }

  if (invoice.payments.length) {
    doc.y += gap
    ensure(72)
    text(receipt ? 'Payment history' : invoice.kind === 'credit_note' ? 'Credit applications' : 'Payments received', PAGE.margin, doc.y, WIDTH, true)
    doc.y += 10
    if (receipt) table([{ label: 'Date', width: WIDTH - 126 }, { label: 'Amount paid', width: 126, right: true }],
      invoice.payments.map(payment => [invoiceDate(payment.on), invoiceAmount(payment.amount,invoice.currency)]))
    else table([{ label: 'Date', width: 118 }, { label: 'Reference', width: WIDTH - 244 }, { label: 'Amount', width: 126, right: true }],
      invoice.payments.map(payment => [invoiceDate(payment.on), payment.what, invoiceAmount(payment.amount,invoice.currency)]))
  }
  // Optional custom template prose; the system standard has neither payment instructions nor a button.
  for (const [label, value] of [
    ['Payment stages', !receipt && invoice.kind === 'invoice' ? invoice.template?.paymentStages : undefined],
    ['Payment instructions', invoice.template?.settings.paymentInstructions],
    ['', invoice.template?.settings.footer],
  ]) {
    if (typeof value !== 'string' || !value) continue
    doc.y += gap
    ensure(50)
    if (label) { text(label, PAGE.margin, doc.y, WIDTH, true, 9); doc.y += 6 }
    else { rule(doc.y); doc.y += 12 }
    for (const line of wrap(value, WIDTH)) {
      ensure(leading)
      const start = doc.y
      text(line, PAGE.margin, start, WIDTH, false, 9)
      doc.y = start + leading
    }
  }

  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const bottomMargin = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    rule(746)
    font(false, 8, MUTED)
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, PAGE.margin, 757, { width: WIDTH, align: 'right', lineBreak: false })
    doc.page.margins.bottom = bottomMargin
  }
  doc.end()
  return done
}

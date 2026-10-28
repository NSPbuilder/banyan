import 'server-only'
import PDFDocument from 'pdfkit'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { formatMoney } from '../money'
import { filename } from '../csv'
import { formatHours } from './labels'
import { yearToDate } from './employees'
import { nextDay } from '../date-range'

/**
 * The separate pay stub — the paper an employee is handed on payday.
 *
 * The owner rejected the first version (2026-09-04): it was laid out as a
 * report and called a statement, and payroll paper does not look like that.
 * They supplied one of their own as the specification, and this is that
 * layout — a voucher band at the top carrying the employer, the employee and
 * the headline figures where a window envelope shows them, a tear line, then
 * the detail: pay, deductions, taxes, and a summary ending in the net. The
 * coordinates below were measured off their page, not invented.
 *
 * It does NOT go through `pdf.ts`. That draws reports — heading, note, table,
 * one column down the page — and this is two columns, banded, with a tear
 * line. `certificate.ts` made the same departure for the same reason and says
 * so. What it keeps from the house style is `compress: false`, so a check can
 * read the words back off the page.
 *
 * WHAT IS NOT ON IT, though the example has them:
 *
 *   — The employee's deposit account ("Acct#....5583"). Nothing here stores an
 *     employee's bank details, and a paycheque naming an account is making a
 *     claim about where the money went.
 *   — Vacation accrued, used, available. This module keeps no vacation bank.
 *     An empty BENEFITS box asserts zero days available, which is not the same
 *     as not knowing.
 *   — A wage rate. Payroll here records what somebody is PAID for a period,
 *     not the rate it was worked out from, so Rate is a dash.
 *
 * Every figure is the stub the pay run stored, or the year to date summed from
 * those stubs. Nothing is computed on the way to the paper.
 */

const PAGE = { width: 612, height: 792 }
const LEFT = 36
const MID = 316
const RIGHT = PAGE.width - 36
const HEADER_RIGHT = 545
/**
 * The left detail table runs LEFT..LEFT+PAY_W, and must END BEFORE `MID`:
 * the first render had it 24pt wider than the gutter, so its YTD column landed
 * on top of the DEDUCTIONS heading and the SUMMARY box.
 */
const PAY_W = 259
/** Right edges of the left table's four figure columns. */
const COL = { hours: LEFT + 110, rate: LEFT + 150, current: LEFT + 197, ytd: LEFT + PAY_W }
const NAVY = '#1a1a5e'
const INK = '#111111'
const FAINT = '#5f5f5f'
const HAIR = '#b4b4b4'

const money = (v: bigint) => `$${formatMoney(v)}`

/** 2026-01-15 as 15-01-2026 — the example's own order. */
const stamp = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return `${d}-${m}-${y}`
}

export type Paycheque = { filename: string; buffer: Buffer }

export async function paychequePdf(
  ledgerId: string, runId: string, employeeId: string,
): Promise<Paycheque | null> {
  const [row] = await db.execute<{
    company: string; company_address: string | null
    pay_date: string; period_start: string | null; period_end: string | null
    name: string; address: string | null; occupation: string | null
    edition: string; gross: string; hours: string
    cpp: string; cpp2: string; ei: string; federal_tax: string; provincial_tax: string
    additional_tax: string; income_tax: string; net_pay: string
    entry_no: string | null; status: string | null
  }>(sql`
    SELECT ent.name AS company,
           (SELECT concat_ws(E'\n', o.delivery_address,
                             concat_ws(' ', o.delivery_city, o.delivery_province, o.delivery_postal))
              FROM corporate_office o
             WHERE o.entity_id = ent.id
             ORDER BY (o.office <> 'registered') LIMIT 1) AS company_address,
           pr.pay_date::text, pr.period_start::text, pr.period_end::text,
           p.name, pe.occupation,
           (SELECT concat_ws(E'\n', a.line1, nullif(a.line2, ''),
                             concat_ws(' ', a.city, a.region, a.postal_code))
              FROM party_address a JOIN party_address_purpose pp ON pp.code = a.purpose
             WHERE a.party_id = p.id ORDER BY pp.sort_order, a.purpose LIMIT 1) AS address,
           ps.edition, ps.gross::text, ps.hours::text,
           ps.cpp::text, ps.cpp2::text, ps.ei::text, ps.federal_tax::text,
           ps.provincial_tax::text, ps.additional_tax::text, ps.income_tax::text,
           ps.net_pay::text, je.entry_no, je.status::text
      FROM pay_stub ps
      JOIN pay_run pr ON pr.id = ps.pay_run_id
      JOIN payroll_employee pe ON pe.id = ps.employee_id
      JOIN party p ON p.id = pe.party_id
      JOIN ledger l ON l.id = pr.ledger_id
      JOIN entity ent ON ent.id = l.entity_id
      LEFT JOIN journal_entry je ON je.id = pr.entry_id
     WHERE ps.pay_run_id = ${runId}::uuid
       AND ps.employee_id = ${employeeId}::uuid
       AND pr.ledger_id = ${ledgerId}::uuid`)
  if (!row) return null

  const n = (v: string) => BigInt(v)
  // The year up to and INCLUDING this payday — what an employee means by
  // "year to date" on a pay slip.
  const ytd = (await yearToDate(ledgerId, [employeeId], nextDay(row.pay_date), Number(row.pay_date.slice(0, 4)))).get(employeeId)!
  const ytdAdditional = ytd.incomeTax - ytd.federalTax - ytd.provincialTax

  // "Taxes" on this paper means everything the government took, added the way
  // the example's own summary adds it: income tax plus both social premiums.
  const taxes = n(row.income_tax) + n(row.ei) + n(row.cpp) + n(row.cpp2)
  const ytdTaxes = ytd.incomeTax + ytd.ei + ytd.cpp + ytd.cpp2

  const doc = new PDFDocument({
    size: 'LETTER', margin: 0, compress: false,
    info: { Title: `${row.name} — pay stub — ${row.pay_date}` },
  })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  const band = (y: number) => {
    doc.save().lineWidth(5).strokeColor(NAVY)
      .moveTo(0, y).lineTo(PAGE.width, y).stroke().restore()
  }
  const rule = (y: number, from: number, to: number, dashed = false) => {
    doc.save().lineWidth(0.7).strokeColor(dashed ? HAIR : FAINT)
    if (dashed) doc.dash(2, { space: 3 })
    doc.moveTo(from, y).lineTo(to, y).stroke().restore()
  }
  const at = (text: string, x: number, y: number, o: {
    size?: number; bold?: boolean; width?: number
    align?: 'left' | 'right'; color?: string
  } = {}) => {
    doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(o.size ?? 9).fillColor(o.color ?? INK)
      .text(text, x, y, { width: o.width, align: o.align ?? 'left', lineBreak: false })
  }
  /** A figure hard against a right edge. */
  const rightAt = (text: string, edge: number, y: number, o: Parameters<typeof at>[3] = {}) =>
    at(text, edge - 62, y, { ...o, width: 62, align: 'right' })
  const heading = (text: string, x: number, y: number) =>
    at(text, x, y, { size: 8.5, color: FAINT })
  const address = (value: string | null, x: number, y: number) =>
    value?.split('\n').forEach((line, i) => at(line, x, y + i * 13, { size: 10 }))

  // -------------------------------------------------------- the voucher band
  band(14)
  at(row.company, 77, 42, { size: 10 })
  address(row.company_address, 77, 55)

  at('Pay Stub Detail', MID, 100, { size: 10, width: HEADER_RIGHT - MID, align: 'right' })
  at(`PAY DATE: ${stamp(row.pay_date)}`, MID, 113,
     { size: 10, width: HEADER_RIGHT - MID, align: 'right' })
  at(`NET PAY: ${money(n(row.net_pay))}`, MID, 126,
     { size: 10, width: HEADER_RIGHT - MID, align: 'right' })

  // Where a window envelope shows it.
  at(row.name, 77, 149, { size: 10 })
  address(row.address, 77, 162)

  band(240)

  // -------------------------------------------------------------- who and when
  heading('EMPLOYER', LEFT, 281)
  at(row.company, LEFT, 295)
  address(row.company_address, LEFT, 308)

  heading('PAY PERIOD', MID, 281)
  ;([
    ['Period Beginning', row.period_start ? stamp(row.period_start) : '—'],
    ['Period Ending:', row.period_end ? stamp(row.period_end) : '—'],
    ['Pay Date:', stamp(row.pay_date)],
  ] as const).forEach(([label, value], i) => {
    at(label, MID, 295 + i * 13)
    rightAt(value, MID + 190, 295 + i * 13)
  })

  heading('EMPLOYEE', LEFT, 352)
  at(row.name, LEFT, 366)
  address(row.address, LEFT, 379)
  if (row.occupation) at(row.occupation, LEFT, 409, { color: FAINT })

  heading('BENEFITS', LEFT, 421)
  at('Not tracked in payroll', LEFT, 438, { color: FAINT, size: 8.5 })

  at('NET PAY:', MID, 439, { bold: true })
  rightAt(money(n(row.net_pay)), RIGHT, 439, { bold: true })
  at(row.entry_no ? `Journal ${row.entry_no}` : 'Not posted', MID, 455, { color: FAINT })
  if (row.status !== null && row.status !== 'posted') {
    at('This pay run has been reversed in the books.', MID, 469,
       { color: FAINT, size: 8.5 })
  }

  heading('MEMO:', LEFT, 474)
  rule(490, LEFT + 40, MID - 30)

  // The tear line.
  rule(497, LEFT, RIGHT, true)

  // ---------------------------------------------------------------- earnings
  heading('PAY', LEFT, 531)
  for (const [head, edge] of [['Hours', COL.hours], ['Rate', COL.rate],
                              ['Current', COL.current], ['YTD', COL.ytd]] as const) {
    rightAt(head, edge, 531, { size: 8.5, color: FAINT })
  }
  rule(543, LEFT, LEFT + PAY_W)
  at('Salary', LEFT, 549)
  rightAt(n(row.hours) > 0n ? formatHours(n(row.hours)) : '-', COL.hours, 549)
  rightAt('-', COL.rate, 549)
  rightAt(formatMoney(n(row.gross)), COL.current, 549)
  rightAt(formatMoney(ytd.gross), COL.ytd, 549)

  // Deductions that are not tax. There are none — the module does not withhold
  // any (0052) — and the box SAYS none, because an empty box reads as one
  // somebody forgot to fill.
  heading('DEDUCTIONS', MID, 531)
  rightAt('Current', RIGHT - 90, 531, { size: 8.5, color: FAINT })
  rightAt('YTD', RIGHT, 531, { size: 8.5, color: FAINT })
  rule(543, MID, RIGHT)
  at('None', MID, 549, { color: FAINT })

  // ------------------------------------------------------------------- taxes
  heading('TAXES', LEFT, 651)
  rightAt('Current', COL.current, 651, { size: 8.5, color: FAINT })
  rightAt('YTD', COL.ytd, 651, { size: 8.5, color: FAINT })
  rule(663, LEFT, LEFT + PAY_W)
  ;([
    ['Income Tax', n(row.income_tax), ytd.incomeTax],
    ['Employment Insurance', n(row.ei), ytd.ei],
    ['Canada Pension Plan', n(row.cpp), ytd.cpp],
    ['Second Canada Pension Plan', n(row.cpp2), ytd.cpp2],
  ] as const).forEach(([label, current, toDate], i) => {
    const y = 669 + i * 13
    at(label, LEFT, y)
    rightAt(formatMoney(current), COL.current, y)
    rightAt(formatMoney(toDate), COL.ytd, y)
  })
  // Extra tax the employee asked for on their TD1 is inside Income Tax above,
  // by the same CHECK that defines it on the stub. Named when there is some,
  // so nobody has to wonder where it went.
  if (n(row.additional_tax) > 0n || ytdAdditional > 0n) {
    at('of which extra tax you asked for', LEFT + 10, 669 + 4 * 13,
       { size: 8, color: FAINT })
    rightAt(formatMoney(n(row.additional_tax)), COL.current, 669 + 4 * 13,
            { size: 8, color: FAINT })
    rightAt(formatMoney(ytdAdditional), COL.ytd, 669 + 4 * 13,
            { size: 8, color: FAINT })
  }

  // ----------------------------------------------------------------- summary
  doc.save().lineWidth(0.7).strokeColor(FAINT)
    .rect(MID, 658, RIGHT - MID, 56).stroke().restore()
  heading('SUMMARY', MID + 8, 664)
  rightAt('Current', RIGHT - 90, 664, { size: 8.5, color: FAINT })
  rightAt('YTD', RIGHT - 8, 664, { size: 8.5, color: FAINT })
  ;([
    ['Total Pay', n(row.gross), ytd.gross],
    ['Taxes', taxes, ytdTaxes],
    ['Deductions', 0n, 0n],
  ] as const).forEach(([label, current, toDate], i) => {
    const y = 680 + i * 12
    at(label, MID + 8, y)
    rightAt(money(current), RIGHT - 90, y)
    rightAt(money(toDate), RIGHT - 8, y)
  })

  at('Net Pay', MID + 8, 728, { size: 12, bold: true })
  at(money(n(row.net_pay)), MID + 120, 726, { size: 14, bold: true })

  at(`CRA payroll deduction tables, edition ${row.edition}.`, LEFT, 760,
     { size: 7.5, color: FAINT })

  doc.end()
  const buffer = await done
  return { filename: filename([row.pay_date, row.name], 'pdf'), buffer }
}

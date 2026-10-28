import 'server-only'
import PDFDocument from 'pdfkit'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { chequeById } from './cheques'
import { formatMoney } from './money'
import { filename } from './csv'

const SMALL = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen']
const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety']
export class ChequePrintError extends Error {}
function underThousand(n: number): string {
  if (n < 20) return SMALL[n]
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${SMALL[n % 10]}` : '')
  return `${SMALL[Math.floor(n / 100)]} hundred${n % 100 ? ` ${underThousand(n % 100)}` : ''}`
}
export function chequeAmountWords(cents: bigint): string {
  if (cents < 0n || cents > 999_999_999_999_99n) throw new ChequePrintError('Cheque amount is outside the printable range.')
  let dollars = cents / 100n
  const groups: string[] = []
  for (const [divisor, name] of [[1_000_000_000n, 'billion'], [1_000_000n, 'million'], [1_000n, 'thousand'], [1n, '']] as const) {
    const part = Number(dollars / divisor)
    dollars %= divisor
    if (part) groups.push(`${underThousand(part)}${name ? ` ${name}` : ''}`)
  }
  const whole = groups.join(' ') || 'zero'
  return `${whole.charAt(0).toUpperCase()}${whole.slice(1)} and ${String(cents % 100n).padStart(2, '0')}/100`
}

/** Letter sheet with a 3.5 in top cheque and two vouchers, after print.pdf. */
export async function chequePdf(ledgerId: string, chequeId: string): Promise<{ filename: string; buffer: Buffer } | null> {
  const cheque = await chequeById(ledgerId, chequeId)
  if (!cheque || cheque.status !== 'issued' || cheque.source_status !== 'posted' || !cheque.source_matches) return null
  const detail = cheque.source_kind === 'payment'
    ? await db.execute<{ label: string; amount: string }>(sql`
        SELECT ('Bill ' || coalesce(i.their_ref, i.number::text, '')) AS label,
               ia.amount::text AS amount
          FROM invoice_application ia JOIN invoice i ON i.id = ia.invoice_id
         WHERE ia.entry_id = ${cheque.entry_id}::uuid AND i.direction = 'purchase'
         ORDER BY i.issued_on, i.id`)
    : cheque.source_kind === 'payroll'
      ? [{ label: 'Net pay', amount: cheque.amount }]
      : await db.execute<{ label: string; amount: string }>(sql`
          SELECT coalesce(nullif(jl.description, ''), a.name) AS label,
                 jl.amount::text AS amount
            FROM journal_line jl JOIN account a ON a.id = jl.account_id
           WHERE jl.entry_id = ${cheque.entry_id}::uuid AND jl.amount > 0
           ORDER BY jl.line_no`)
  // A voucher has nine detail rows. If a source is longer, preserve the
  // cheque total and point to the complete posted entry instead of refusing
  // to print issued paper or silently dropping some of its lines.
  const voucherLines = detail.length > 9
    ? [{ label: `${detail.length} lines — see ${cheque.source_entry_no}`, amount: cheque.amount }]
    : detail
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, compress: false,
    info: { Title: `Cheque ${cheque.number} — ${cheque.payee}` } })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })
  const at = (value: string, x: number, y: number, width: number, size = 10,
    align: 'left' | 'right' = 'left', maxHeight = 15) => {
    doc.font('Helvetica').fontSize(size).fillColor('#111111')
    const h = doc.heightOfString(value, { width, lineGap: 0, align })
    if (h > maxHeight) throw new ChequePrintError(`Cheque text is too long to print safely: ${value.slice(0, 50)}`)
    if (y < 252 && y + h > 207) throw new ChequePrintError('Cheque text would overlap the MICR band.')
    doc.text(value, x, y, { width, align, lineGap: 0 })
  }
  const fitVoucherText = (value: string, width: number) => {
    doc.font('Helvetica').fontSize(10)
    if (doc.widthOfString(value) <= width) return value
    const chars = Array.from(value)
    while (chars.length && doc.widthOfString(`${chars.join('')}…`) > width) chars.pop()
    return `${chars.join('')}…`
  }
  const dollars = (v: string) => formatMoney(BigInt(v))
  const dateDigits = cheque.cheque_date.replaceAll('-', '')
  // Only variable fields: bank-approved stock supplies cheque furniture and MICR.
  at('DATE', 474, 59, 34, 10)
  at(dateDigits.split('').join(' '), 511, 59, 82, 10)
  at('Y Y Y Y M M D D', 511, 72, 82, 7)
  at(chequeAmountWords(BigInt(cheque.amount)), 57, 89, 425, 10, 'left', 26)
  at(`**${dollars(cheque.amount)}`, 500, 89, 70, 10, 'right')
  at(cheque.payee, 57, 123, 410, 11)
  if (cheque.payee_address) at(cheque.payee_address, 57, 136, 410, 10, 'left', 45)
  if (cheque.memo) at(fitVoucherText(cheque.memo, 500), 57, 191, 500, 10)
  for (const top of [272, 544]) {
    at(cheque.cheque_date, 60, top + 6, 85, 10)
    at(cheque.payee, 149, top + 6, 390, 10)
    voucherLines.forEach((line, i) => {
      const y = top + 22 + i * 13
      at(fitVoucherText(line.label, 245), 234, y, 245, 10)
      at(dollars(line.amount), 490, y, 80, 10, 'right')
    })
    const bottom = top === 272 ? 482 : 749
    at(fitVoucherText(`${cheque.bank_name} #${cheque.number}`, 190), 36, bottom, 190, 10)
    at(fitVoucherText(cheque.memo || cheque.source_entry_no, 245), 234, bottom, 245, 10)
    at(dollars(cheque.amount), 490, bottom, 80, 10, 'right')
  }
  doc.end()
  return { filename: filename(['cheque', cheque.number, cheque.cheque_date], 'pdf'), buffer: await done }
}

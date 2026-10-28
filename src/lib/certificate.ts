import 'server-only'
import PDFDocument from 'pdfkit'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { profileOf, securitiesRegister, shareMovements } from './records'

/**
 * The share certificate — the piece of paper a shareholder actually keeps.
 *
 * Its FACTS come from the register's own derivation and from nowhere else: a
 * certificate that says a different number from the central securities
 * register is worse than no certificate, and the only way to make that
 * impossible is to have one source. `certificateData` reads
 * `securitiesRegister` (holding, last known address, became-holder date) and
 * `shareMovements` (the certificate number the register recorded); it
 * computes nothing of its own except the number in words.
 *
 * Its DRAWING is not `pdf.ts`'s. That file is the one builder every REPORT
 * goes through — a company line, a title, a table, page numbers — and a
 * certificate is not a report: it is landscape, it is bordered, it is set in
 * a serif face, and it ends in two signature lines. Sending it through the
 * report painter would produce a report that says "Share Certificate" at the
 * top. What is shared is the convention that matters for evidence:
 * `compress: false`, so a check can read the words out of the file.
 *
 * One certificate is one holder's WHOLE current holding of one class (owner
 * picked this shape, 2026-09-03). That is why a transfer surrenders the old
 * certificate and issues new ones — see 0050, which records the numbers.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const SCALES: Array<[bigint, string]> = [
  [1_000_000_000_000n, 'trillion'], [1_000_000_000n, 'billion'],
  [1_000_000n, 'million'], [1_000n, 'thousand'],
]

/**
 * A whole number in words, the way a certificate writes it — "one hundred and
 * twenty". The figures are on the paper too; the words are what makes altering
 * the figures pointless, which is the entire reason certificates carry both.
 */
export function inWords(n: bigint): string {
  if (n < 0n) return `minus ${inWords(-n)}`
  if (n < 20n) return ONES[Number(n)]
  if (n < 100n) {
    const rest = n % 10n
    return TENS[Number(n / 10n)] + (rest ? `-${ONES[Number(rest)]}` : '')
  }
  if (n < 1000n) {
    const rest = n % 100n
    return `${ONES[Number(n / 100n)]} hundred` + (rest ? ` and ${inWords(rest)}` : '')
  }
  for (const [scale, name] of SCALES) {
    if (n >= scale) {
      const rest = n % scale
      // "and" only before a tail under a hundred: one thousand and five, but
      // one thousand one hundred.
      const joiner = rest === 0n ? '' : rest < 100n ? ' and ' : ' '
      return `${inWords(n / scale)} ${name}${joiner}${rest ? inWords(rest) : ''}`
    }
  }
  return String(n)
}

export type CertificateFacts = {
  entityId: string
  company: string
  incorporationNumber: string | null
  className: string
  series: string | null
  holder: string
  address: string | null
  shares: bigint
  /**
   * The certificate this holding is evidenced by — only when exactly ONE is
   * outstanding. When several are, this is null and `evidencedBy` names them:
   * a piece of paper that claims to be the certificate for the whole holding
   * while two earlier certificates are still out there is a claim the
   * register does not support (critic, 2026-09-03).
   */
  certificateNo: string | null
  /** Every certificate of this holder's, in this class, not yet surrendered. */
  evidencedBy: string[]
  becameHolder: string
  asOf: string
}

/**
 * Everything a certificate says, read from the register.
 *
 * Returns null when the holder does not hold anything of that class as at the
 * date: there is no certificate for nothing, and a page that printed one
 * would be issuing paper the register does not support.
 */
export async function certificateFacts(
  ledgerId: string, shareClassId: string, partyId: string, asOf: string,
): Promise<CertificateFacts | null> {
  const [head] = await db.execute<{ entity_id: string; company: string }>(sql`
    SELECT e.id::text AS entity_id, e.name AS company
      FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  if (!head) return null

  const [holding] = (await securitiesRegister(head.entity_id, asOf))
    .filter((h) => h.share_class_id === shareClassId && h.party_id === partyId)
  if (!holding || BigInt(holding.holding) <= 0n) return null

  const profile = await profileOf(head.entity_id)

  // Which of this holder's certificates are still OUT: every number the
  // register issued to them in this class, less every number anybody has
  // surrendered.
  //
  // The first version took the last number recorded and printed it over the
  // whole holding. That is right after a transfer out — which surrenders the
  // old certificate and issues a balance one — and WRONG after an
  // acquisition, where the earlier certificate is still in the holder's
  // hands: the register would have two certificates outstanding and the
  // paper would name one of them as covering both (critic, 2026-09-03).
  const movements = (await shareMovements(head.entity_id, asOf))
    .filter((m) => m.share_class_id === shareClassId)
  const surrendered = new Set(movements.map((m) => m.surrendered_no).filter(Boolean))
  const evidencedBy = movements
    .filter((m) => m.party_id === partyId && m.certificate_no
                && !surrendered.has(m.certificate_no))
    .map((m) => m.certificate_no as string)
  const certificateNo = evidencedBy.length === 1 ? evidencedBy[0] : null

  return {
    entityId: head.entity_id,
    company: head.company,
    incorporationNumber: profile?.incorporation_number ?? null,
    className: holding.class_name,
    series: holding.series,
    holder: holding.holder,
    address: holding.address,
    shares: BigInt(holding.holding),
    certificateNo,
    evidencedBy,
    becameHolder: holding.became_on,
    asOf,
  }
}

const PAGE = { width: 792, height: 612 } // LETTER, landscape
const INK = '#171717'
const FAINT = '#6b6b6b'
const RULE = '#8a8a8a'

/** The certificate itself: one page, bordered, set in a serif face. */
export function drawCertificate(facts: CertificateFacts): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER', layout: 'landscape', margin: 0, compress: false,
    info: { Title: `${facts.company} — share certificate — ${facts.holder}` },
  })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  // The border: a heavy frame, a hairline inside it, and a corner mark at
  // each turn. Drawn rather than imported, so there is no asset to lose.
  const frame = (inset: number, width: number) => {
    doc.save().lineWidth(width).strokeColor(RULE)
      .rect(inset, inset, PAGE.width - 2 * inset, PAGE.height - 2 * inset).stroke().restore()
  }
  frame(24, 2.5)
  frame(31, 0.6)
  for (const [x, y] of [[31, 31], [PAGE.width - 31, 31],
                        [31, PAGE.height - 31], [PAGE.width - 31, PAGE.height - 31]]) {
    doc.save().translate(x, y).rotate(45).rect(-5, -5, 10, 10)
      .lineWidth(0.8).strokeColor(RULE).stroke().restore()
  }

  const W = PAGE.width - 2 * 72
  const centred = { width: W, align: 'center' as const }
  const at = (y: number) => { doc.y = y; doc.x = 72 }

  at(64)
  doc.font('Times-Roman').fontSize(9).fillColor(FAINT)
    .text('INCORPORATED UNDER THE LAWS OF THE PROVINCE OF BRITISH COLUMBIA',
          { ...centred, characterSpacing: 1.6 })

  doc.moveDown(0.9)
  doc.font('Times-Bold').fontSize(28).fillColor(INK).text(facts.company, centred)

  if (facts.incorporationNumber) {
    doc.moveDown(0.3)
    doc.font('Times-Roman').fontSize(9.5).fillColor(FAINT)
      .text(`Incorporation No. ${facts.incorporationNumber}`, centred)
  }

  doc.moveDown(1.1)
  doc.font('Times-Roman').fontSize(11).fillColor(FAINT)
    .text('SHARE CERTIFICATE', { ...centred, characterSpacing: 3 })

  // The two shoulders: the certificate's own number, and the count in figures.
  const shoulderY = doc.y + 18
  doc.font('Times-Roman').fontSize(10).fillColor(INK)
    .text(`Certificate No. ${facts.certificateNo ?? '—'}`, 72, shoulderY, { width: W / 2 })
  doc.font('Times-Bold').fontSize(12).fillColor(INK)
    .text(`${facts.shares} shares`, 72 + W / 2, shoulderY, { width: W / 2, align: 'right' })

  at(shoulderY + 40)
  const classLabel = facts.series ? `${facts.className} — ${facts.series}` : facts.className
  doc.font('Times-Roman').fontSize(12.5).fillColor(INK).text(
    `This is to certify that ${facts.holder}`
    + (facts.address ? ` of ${facts.address}` : '')
    + ` is the registered holder of ${inWords(facts.shares)} (${facts.shares})`
    + ` fully paid ${classLabel} shares in the capital of ${facts.company},`
    + ' transferable only on the books of the Company by the holder in person or by'
    + ' attorney on surrender of this certificate properly endorsed.',
    { width: W, align: 'justify', lineGap: 3 })

  doc.moveDown(1.0)
  doc.font('Times-Italic').fontSize(9.5).fillColor(FAINT).text(
    'The shares represented by this certificate are subject to the restrictions on'
    + ' transfer contained in the Articles of the Company. This certificate evidences the'
    + " holder's entire registered holding of this class as at the date below;"
    + ' a transfer or purchase of any part of it takes this certificate in and issues new ones.'
    // Said on the paper, because the paper is what leaves the building: a
    // holding already evidenced by two outstanding certificates cannot also
    // be evidenced by this one until those are taken in.
    + (facts.evidencedBy.length > 1
      ? ` The register shows this holding evidenced by certificates ${facts.evidencedBy.join(' and ')},`
        + ' which are to be surrendered and cancelled on the issue of this certificate.'
      : ''),
    { width: W, align: 'justify', lineGap: 2 })

  // An ornament between the words and the signatures. Certificates are mostly
  // white space by design; a rule across the middle of it keeps the page from
  // reading as an unfinished form.
  const ornamentY = Math.min(doc.y + 46, PAGE.height - 210)
  doc.save().lineWidth(0.6).strokeColor(RULE)
    .moveTo(PAGE.width / 2 - 150, ornamentY).lineTo(PAGE.width / 2 - 12, ornamentY).stroke()
    .moveTo(PAGE.width / 2 + 12, ornamentY).lineTo(PAGE.width / 2 + 150, ornamentY).stroke()
    .translate(PAGE.width / 2, ornamentY).rotate(45).rect(-4, -4, 8, 8).stroke().restore()

  // The foot: the date on the left, two director signatures on the right,
  // and a seal ring between them.
  const footY = PAGE.height - 150
  doc.font('Times-Roman').fontSize(10.5).fillColor(INK)
    .text(`Dated ${facts.asOf}`, 72, footY, { width: W / 3 })
  doc.font('Times-Roman').fontSize(9).fillColor(FAINT)
    .text(`Registered holder since ${facts.becameHolder}`, 72, footY + 18, { width: W / 3 })

  doc.save().lineWidth(0.8).strokeColor(RULE)
    .circle(PAGE.width / 2, footY + 30, 30).stroke().restore()
  doc.font('Times-Roman').fontSize(7.5).fillColor(FAINT)
    .text('SEAL', PAGE.width / 2 - 30, footY + 27, { width: 60, align: 'center' })

  const sigWidth = 170
  const sigX = PAGE.width - 72 - sigWidth
  for (const [i, label] of ['Director', 'Director'].entries()) {
    const y = footY + i * 46
    doc.save().moveTo(sigX, y + 22).lineTo(sigX + sigWidth, y + 22)
      .lineWidth(0.6).strokeColor(RULE).stroke().restore()
    doc.font('Times-Roman').fontSize(8.5).fillColor(FAINT)
      .text(label, sigX, y + 26, { width: sigWidth, align: 'center' })
  }

  doc.end()
  return done
}

/** The whole thing: facts from the register, drawn. Null when there is no holding. */
export async function shareCertificate(
  ledgerId: string, shareClassId: string, partyId: string, asOf: string,
): Promise<{ facts: CertificateFacts; buffer: Buffer } | null> {
  const facts = await certificateFacts(ledgerId, shareClassId, partyId, asOf)
  if (!facts) return null
  return { facts, buffer: await drawCertificate(facts) }
}

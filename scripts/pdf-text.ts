/**
 * Reads the text back out of a generated PDF, the way a PDF reader would —
 * independently of the builder that wrote it. `reportPdf` writes uncompressed
 * content streams (deliberately), where each shown string is a TJ array of
 * hex-encoded chunks split at kerning pairs:
 *
 *   [<496e> 40 <76> 30 <6f696365> ...] TJ     ->  "Invoice"
 *
 * Joining every chunk inside one array reconstructs the string exactly. A
 * check that greps the raw buffer instead would miss any figure the font
 * happens to kern, and pass or fail on typography.
 */
// Where WinAnsi departs from Latin-1: the 0x80-0x9F block. An em dash is
// 0x97 on the page, and decoding it as Latin-1 turned "Cash — Operating"
// into a control character nothing could .includes() — X17 caught it.
const WINANSI: Record<number, string> = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160',
  0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a', 0x9c: '\u0153',
  0x9e: '\u017e', 0x9f: '\u0178',
}

export function pdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1')
  const lines: string[] = []
  for (const m of raw.matchAll(/\[((?:<[0-9a-fA-F]*>|\s+|-?\d+(?:\.\d+)?)+)\]\s*TJ/g)) {
    const text = [...m[1].matchAll(/<([0-9a-fA-F]*)>/g)]
      .map((h) => [...Buffer.from(h[1], 'hex')].map((b) => WINANSI[b] ?? String.fromCharCode(b)).join(''))
      .join('')
    if (text) lines.push(text)
  }
  return lines.join('\n')
}

/**
 * The same text with where each string was drawn: `y` is the PDF's own,
 * measured UP from the bottom edge of the sheet, so a line drawn lower on the
 * page has the smaller number. (The builder thinks top-down and PDFKit
 * converts at the `Tm`; the `cm` flip at the top of each page is for the
 * graphics, not the text.) A check on layout — a row sitting below a wrapped
 * heading, text staying above the bottom margin — reads this rather than the
 * text alone.
 */
export function pdfTextAt(buffer: Buffer): Array<{ text: string; x: number; y: number; size: number }> {
  const raw = buffer.toString('latin1')
  const out: Array<{ text: string; x: number; y: number; size: number }> = []
  // One shown string: its matrix, then the font and size it was set in, then
  // the glyphs — `Tm`, `Tf`, `TJ`, in that order, inside one text object.
  for (const m of raw.matchAll(/1 0 0 1 ([-\d.]+) ([-\d.]+) Tm\s*\/F\d+ ([\d.]+) Tf[^\[]*\[((?:<[0-9a-fA-F]*>|\s+|-?\d+(?:\.\d+)?)+)\]\s*TJ/g)) {
    const text = [...m[4]!.matchAll(/<([0-9a-fA-F]*)>/g)]
      .map((h) => [...Buffer.from(h[1]!, 'hex')].map((b) => WINANSI[b] ?? String.fromCharCode(b)).join(''))
      .join('')
    if (text) out.push({ text, x: Number(m[1]), y: Number(m[2]), size: Number(m[3]) })
  }
  return out
}

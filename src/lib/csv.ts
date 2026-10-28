/**
 * CSV, written out rather than imported.
 *
 * The rules are short and the failure is silent: an account called
 * "Cash — Operating, USD" splits into two columns if the quoting is wrong, and
 * every row after it shifts. A dependency for ten lines is not worth the
 * surface, but neither is getting the ten lines wrong, so they are tested.
 */

/** A plain number, including a negative one. These are never formulas. */
const NUMERIC = /^-?\d+(\.\d+)?$/

/** Quote a cell if it could otherwise change the shape of the row. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)

  // A leading =, +, - or @ is executed as a formula when Excel opens the file,
  // so such a cell is prefixed with a tab to keep it text.
  //
  // But a negative amount also starts with '-', and mangling every credit
  // balance into "\t-1500.00" would make the export useless for the one thing
  // it is for: adding the figures up again. Only cells that are NOT plain
  // numbers are treated as suspect.
  const safe = !NUMERIC.test(text) && /^[\s\uFEFF]*[=+\-@]/.test(text) ? `\t${text}` : text

  return /[",\r\n\t]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function csvRow(cells: Array<string | number | null | undefined>): string {
  return cells.map(csvCell).join(',')
}

/**
 * A whole file: CRLF line endings and a byte-order mark, because that is what
 * Excel needs to open a UTF-8 file with an em dash in it without mangling it.
 */
export function csvFile(rows: Array<Array<string | number | null | undefined>>): string {
  return '﻿' + rows.map(csvRow).join('\r\n') + '\r\n'
}

/** Cents to a plain decimal — no thousands separators, so it can be summed. */
export function csvMoney(cents: bigint | string): string {
  const n = typeof cents === 'bigint' ? cents : BigInt(cents)
  const negative = n < 0n
  const abs = negative ? -n : n
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
}

export function filename(parts: Array<string | undefined>, extension = 'csv'): string {
  return parts.filter(Boolean)
    .map((p) => p!.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, ''))
    .join('_') + '.' + extension
}

/** Shared text-only CSV reader. Line numbers refer to physical source lines. */
export type CsvRow = { cells: string[]; line: number; blank: boolean }

export function parseCsvRows(text: string, delimiters: readonly string[], opts: {
  commentPrefix?: string
  /** Keep a final quoted empty record for account-row validation. */
  includeEmptyFinalRecord?: boolean
  /** Account pastes historically trim unquoted whitespace at record edges. */
  trimRecordWhitespace?: boolean
} = {}): CsvRow[] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: CsvRow[] = []
  let row: string[] = []
  let cur = ''
  let quoted = false
  let line = 1
  let startLine = 1
  let atStart = true
  let blank = true
  let trailingDelimiters = 0

  const finishRow = () => {
    row.push(cur)
    if (opts.trimRecordWhitespace && trailingDelimiters) row.splice(row.length - trailingDelimiters)
    rows.push({ cells: row, line: startLine, blank })
    row = []; cur = ''; trailingDelimiters = 0
  }

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    // Comments are a chart-of-accounts convention, not a bank-file convention.
    // Check before quote parsing so an unmatched quote in a comment is harmless.
    if (atStart && (opts.commentPrefix || opts.trimRecordWhitespace)) {
      let j = i
      while (j < s.length && s[j] !== '\r' && s[j] !== '\n' && !s[j].trim()) j++
      if (opts.commentPrefix && s.startsWith(opts.commentPrefix, j)) {
        while (i < s.length && s[i] !== '\r' && s[i] !== '\n') i++
        if (i === s.length) break
        if (s[i] === '\r' && s[i + 1] === '\n') i++
        line++; startLine = line
        continue
      }
      if (opts.trimRecordWhitespace && j > i) { i = j - 1; continue }
    }
    atStart = false
    if (ch.trim()) { blank = false; trailingDelimiters = 0 }
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else {
        cur += ch
        if (ch === '\n' || (ch === '\r' && s[i + 1] !== '\n')) line++
      }
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (delimiters.includes(ch)) {
      if (!ch.trim()) trailingDelimiters++
      row.push(cur); cur = ''; continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      finishRow()
      line++; startLine = line; atStart = true
      blank = true
      continue
    }
    cur += ch
  }
  if (cur !== '' || row.length > 0 || (opts.includeEmptyFinalRecord && !blank)) {
    finishRow()
  }
  return rows
}

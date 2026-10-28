import 'server-only'
import { READING_QUESTION_STARTS } from './reading-question'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { ask, type Send, type Service, type Prices, sendToRelay } from './assistant'
import { TAX_CODES } from './tax-rates'
import { DESTINATION_KEYS, NO_DESTINATION, destinationMenu } from './destinations'
import { type ReadRows, structuredRowsFrom as rowsFrom, structuredRowsMenu as rowsMenu } from './structured-readings'
import { SAME_PAYEE } from './bank'
import { saveAttachment } from './attachments'
import { ledgerHead } from './ledger-head'
import { localToday } from './today'

/**
 * Reading a bill: the model looks at a supplier's invoice or receipt and says
 * what it thinks it is. It does not enter anything.
 *
 * The owner's ask (2026-09-06): upload a bill, have it read, then CHOOSE —
 * an expense paid now, or a bill into accounts payable — and REVIEW before it
 * is entered. So this file ends where the choice begins: it produces a
 * `Proposal`, stores it with the file (0064), and stops. The two paths that
 * follow are the ordinary quick-entry and purchase-invoice forms, prefilled
 * from the proposal and posted through the doors they always used, so nothing
 * the model suggests reaches the books except through a form a person read.
 *
 * What is sent: what the person wrote and the document, whichever of the two
 * arrived (a sentence alone is enough since 0077); this company's chart of
 * accounts (codes, names, types — no balances), because a proposal that
 * cannot name an account is not worth reviewing; and today's date, because
 * "yesterday" means nothing without one. That text is kept on the exchange row
 * like every other asking, so what left the machine is on record.
 *
 * A PDF is sent as a PDF (2026-09-07). See `READABLE` below for why nothing
 * converts it, and `filePart` in `assistant.ts` for how it travels.
 */

export class BillReadingError extends Error {
  constructor(public code: 'NOT_A_BILL' | 'TOO_BIG' | 'TOO_LONG' | 'EMPTY' | 'NO_LEDGER' | 'UNREADABLE' | 'NO_READING' | 'ALREADY_ENTERED', message: string) {
    super(message)
  }
}

/** What a model may say. Everything is optional: a bill it could not read is a proposal of nothing. */
export type ProposalLine = {
  description: string
  /** Cents, before tax, as the model read them. */
  amount: string
  taxCode: string
  /** The account code the model named, IF this ledger has it. Null otherwise. */
  accountCode: string | null
  accountName: string | null
  /**
   * What the model actually said, kept even when the chart has no such code.
   *
   * The first version threw it away, so a model that answered "6200" for a
   * chart with no 6200 left a blank box and no trace of having had an
   * opinion — the person saw nothing and could not tell a silent model from
   * a mismatched one (owner, 2026-09-07: the account was the one field that
   * never filled). The screen shows it as a suggestion this chart cannot
   * honour, which is information rather than a hole.
   */
  suggestedCode: string | null
}

export type Proposal = {
  /**
   * What the model thinks this is: money already gone (`expense`), a bill to
   * pay later (`bill`), money already in (`income`), an invoice to a customer
   * to be paid later (`sale`) — or `other`, meaning IT IS NOT A TRANSACTION
   * and this screen cannot enter it.
   *
   * Since 2026-09-16 it is a key from `src/lib/destinations.ts` — the app's own
   * list of places a document can go — and no longer a closed four. The four
   * money ones keep their exact spelling, so rows stored before that still
   * read. `other` means the model looked at the list and said none of them.
   *
   * It was a closed four, and anything else was quietly rewritten to
   * `expense`: the owner uploaded a company registration document, the model
   * read it correctly, and the app filed it as money spent. It looked like the
   * model choosing wrong when in truth it was never asked the question.
   */
  suggests: string
  /**
   * WHAT THE MODEL ACTUALLY CALLED IT, kept whatever it said.
   *
   * The same fix `suggestedCode` already carries for account codes: a model
   * whose answer is discarded leaves a person unable to tell a silent model
   * from a mismatched one. Null when it answered with one of the four.
   */
  suggestedKind: string | null
  /** Why the model chose that destination, in its own words. */
  belongs: string | null
  /**
   * WHAT IT READ THAT IS NOT A TRANSACTION — an incorporation number, a
   * director's name, a share class.
   *
   * One open map rather than a typed field per destination, so a destination
   * added tomorrow needs a catalogue entry and a screen that reads `facts`,
   * and never a change to this type. Keys are the model's; each screen takes
   * the ones it knows and shows the rest as read-but-not-placed, which is the
   * same promise `suggestedCode` makes about an account the chart lacks.
   */
  facts: Record<string, string>
  /**
   * THE EVENTS IT READ FOR THE CORPORATE RECORD, table by table (2026-09-16).
   *
   * `facts` is one flat map, which holds a certificate of incorporation and
   * nothing longer: a minute book is five directors, a dozen share movements
   * and thirty resolutions, and a map has one `director`. So a reading carries
   * rows too, under the table each belongs to, in the columns `record-rows.ts`
   * declares — and each table's add form opens with them. Empty for anything
   * that is not about the corporate record, and for every reading stored
   * before this field existed.
   */
  rows: ReadRows
  /**
   * The other side, as the document or the sentence names it — a supplier or a
   * customer. Proposals stored before 2026-09-15 call it `supplier`; every
   * reader reads them through `proposalOf`, which says `party`.
   */
  party: string
  documentRef: string
  issuedOn: string | null
  dueOn: string | null
  currency: string
  lines: ProposalLine[]
  /** Cents as text, as read off the document: the totals to check the lines against. */
  subtotal: string | null
  gst: string | null
  pst: string | null
  total: string | null
  /** The model's own words about what it could not read. */
  notes: string
}

export type Reading = {
  id: string
  ledger_id: string
  read_by: string
  read_at: string
  /** The document's name, type and hash — all three, or none for a reading from a sentence alone (0077). */
  filename: string | null
  mime: string | null
  sha256: string | null
  /** What the person wrote, when they wrote something. */
  sentence: string | null
  proposal: Proposal | null
  error: string | null
  used_entry_id: string | null
  used_at: string | null
  /**
   * Which of the corporate record's tables this reading's rows have been
   * entered into, and when and by whom (0080) — `{}` until one is. The
   * record's counterpart of `used_entry_id`: the same rows cannot go into the
   * same table twice, and a reading that has put rows anywhere is kept.
   */
  records_entered: Record<string, { at: string; by: string; rows: number }>
}

const MAX_BYTES = 8 * 1024 * 1024
/**
 * What a bill may arrive as. PDFs joined the pictures on 2026-09-07 — the
 * owner's word was 「很不实用」, and they were right: most bills arrive as a
 * PDF and telling a person to photograph their screen is not a feature.
 *
 * Nothing here converts one. There is no way to turn a PDF into a picture in
 * this tree without a new dependency, and that is a frozen decision — so the
 * PDF goes as a PDF, in the `file` part the OpenAI format defines
 * (`assistant.ts`, `filePart`). Whether a particular relay carries it is not
 * something this system can promise, and the answer is not guessed at: it is
 * sent, and whatever comes back is the reading's own recorded sentence.
 */
const READABLE = /^(image\/(png|jpe?g|webp|gif)|application\/pdf)$/

/** The longest sentence a reading takes; `readBill` says why this and no more. */
export const SENTENCE_MAX = 2000
/** How much of a file's name goes out with the question. */
export const NAME_SHOWN = 200
/** A line break as one character, whichever way the browser sent it: the box counted it as one. */
const oneLineBreak = (s: string) => s.replace(/\r\n?/g, '\n')

/**
 * This company's chart, for a proposal to name accounts from. Codes, names
 * and types only: reading a bill needs to know what accounts exist, not what
 * is in them.
 */
export async function chartContext(ledgerId: string): Promise<string> {
  const head = await ledgerHead(ledgerId)
  if (!head) throw new BillReadingError('NO_LEDGER', 'That company does not exist.')
  const accounts = await db.execute<{ code: string; name: string; account_type: string }>(sql`
    SELECT a.code, a.name, a.account_type
      FROM account a
     WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND a.is_active AND a.is_postable
     ORDER BY a.code`)
  return [
    'The books',
    `Company: ${head.entity}. Currency: CAD. Tax tags available: ${TAX_CODES.map((t) => t.code).join(', ')}.`,
    `Today: ${localToday()}.`,
    '',
    'code | account | type',
    ...accounts.map((a) => `${a.code} | ${a.name} | ${a.account_type}`),
  ].join('\n')
}

const INSTRUCTION = [
  READING_QUESTION_STARTS[READING_QUESTION_STARTS.length - 1],
  'Shape: {"suggests":"","kind":"","belongs":"","facts":{},"rows":{},',
  '"party":"","documentRef":"","issuedOn":"YYYY-MM-DD"|null,',
  '"dueOn":"YYYY-MM-DD"|null,"currency":"CAD","lines":[{"description":"","amount":"0.00","taxCode":"",',
  '"accountCode":""}],"subtotal":"0.00"|null,"gst":"0.00"|null,"pst":"0.00"|null,"total":"0.00"|null,"notes":""}.',
  'Amounts are decimal strings in the document\'s currency, BEFORE tax for each line.',
  // THE MENU IS THE APP'S OWN LIST (src/lib/destinations.ts), generated here
  // rather than written out — so a destination added there is one the model
  // may choose the same day, with no prompt to remember to edit.
  '"suggests" says where this belongs, and is exactly one of:',
  destinationMenu(),
  'Say what the document IS in "kind", a few words, always.',
  'For anything that is NOT one of the money ones, leave "lines" empty and the totals null, and put',
  'what you read into "facts" as flat name/value pairs — incorporationNumber, businessNumber,',
  'recognitionDate (YYYY-MM-DD), companyType, legalName, and whatever else the document states.',
  'Say in "belongs" why you chose that destination.',
  // THE ROWS' SHAPES ARE THE ADD FORMS' OWN COLUMNS (src/lib/record-rows.ts),
  // generated for the same reason the menu above is.
  rowsMenu(),
  '"party" is the other side — the supplier or the customer — as the document or the sentence names it.',
  'For every line give the accountCode from the chart above that fits BEST, even when the fit is',
  'imperfect — a person reviews this before anything is entered, so a near miss they can correct beats',
  'an empty box they must fill from nothing. Use "" only when no account in the chart could plausibly',
  'take the line. Say in notes which choices you were unsure of, and why.',
  'Use a taxCode from the list above when the document shows that tax, else "".',
  'Put in notes anything you could not read, and anything a person should check.',
  'The person may have written a sentence about it: use it with the document, or on its own when nothing is attached.',
].join(' ')

/**
 * How long the prompt is, exported so a check can hold it against the room a
 * person has to write in.
 *
 * INSTRUCTION and the person's sentence travel as ONE question under
 * `QUESTION_MAX`, so every sentence added here silently takes characters away
 * from what somebody may type. Adding "other" on 2026-09-16 did exactly that
 * and pushed the longest allowed sentence over the cap; B31 is that coupling
 * made visible, so the next line added to the prompt fails a check instead of
 * shortening a person's typing.
 */
export const INSTRUCTION_LENGTH = INSTRUCTION.length

const money = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(2)
  if (typeof v !== 'string') return null
  const t = v.trim().replace(/[^\d.,-]/g, '').replace(/,/g, '')
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null
}
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * A destination the model named, or `other`.
 *
 * Validated against the CATALOGUE, so the answers it accepts and the doors the
 * app has are the same list. It used to answer `expense` for anything it did
 * not recognise, which is how a company registration document became money
 * spent (owner, 2026-09-16); `other` is the honest fallback — the screen says
 * it could not place this rather than placing it wrongly and saying nothing.
 */
const suggestsOf = (v: unknown): string =>
  DESTINATION_KEYS.includes(v as string) ? (v as string) : NO_DESTINATION

/** The model's facts map, made safe: strings in, strings out, nothing else. */
const factsOf = (v: unknown): Record<string, string> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const t = text(val)
    if (t && k.length <= 60 && Object.keys(out).length < 24) out[k] = t.slice(0, 300)
  }
  return out
}

/** The model's JSON, read defensively: one object out of whatever came back. */
export function parseProposal(answer: string, codes: Set<string>): Proposal | null {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const linesIn = Array.isArray(raw.lines) ? raw.lines : []
  const lines: ProposalLine[] = []
  for (const l of linesIn) {
    if (typeof l !== 'object' || l === null) continue
    const row = l as Record<string, unknown>
    const amount = money(row.amount)
    if (amount === null) continue
    const code = text(row.accountCode)
    const taxCode = text(row.taxCode)
    lines.push({
      description: text(row.description),
      amount,
      suggestedCode: code || null,
      // A tag this ledger does not know is no tag: the review form would
      // refuse it, and a refusal the person cannot act on is worse than blank.
      taxCode: TAX_CODES.some((t) => t.code === taxCode) ? taxCode : '',
      // An account the chart does not have is no account, for the same reason
      // — and because a model naming a plausible code that belongs to another
      // company's chart is exactly the mistake a review cannot catch by eye.
      accountCode: codes.has(code) ? code : null,
      accountName: null,
    })
  }
  const date = (v: unknown): string | null => {
    const s = text(v)
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
  }
  return {
    suggests: suggestsOf(text(raw.suggests)),
    // Kept whatever it said, so a person can see the model DID have an opinion
    // even when this screen has no door for it.
    suggestedKind: text(raw.kind) || null,
    belongs: text(raw.belongs) || null,
    facts: factsOf(raw.facts),
    rows: rowsFrom(raw.rows),
    // `supplier` is what the instruction asked for until 2026-09-15; a model
    // answering in the old words is still understood.
    party: text(raw.party) || text(raw.supplier),
    documentRef: text(raw.documentRef),
    issuedOn: date(raw.issuedOn),
    dueOn: date(raw.dueOn),
    currency: text(raw.currency) || 'CAD',
    lines,
    subtotal: money(raw.subtotal),
    gst: money(raw.gst),
    pst: money(raw.pst),
    total: money(raw.total),
    notes: text(raw.notes),
  }
}

/**
 * Read what a person gave: a sentence, a document, or both. Send them with the
 * chart and today's date; keep what arrived, the proposal and the asking. A
 * model that answers with something unreadable leaves a reading with an error
 * and no proposal — what arrived is still there, and the person can enter it
 * by hand from the same page.
 *
 * Why a sentence stops at 2,000 characters: `ask` refuses a question over
 * `QUESTION_MAX` (4,000), and the question is this instruction, the file's name
 * cut to 200, and the sentence. `BR20` reads the longest input there is, so the
 * day the instruction grows past what fits, a check says so and not a person.
 */
export async function readBill(input: {
  ledgerId: string
  /** The document, when there is one — all three, or none. */
  filename?: string; mime?: string; bytes?: Buffer
  /** What the person wrote, when they wrote something. */
  sentence?: string
  actor: string; service: Service; prices: Prices | null
}, send: Send = sendToRelay): Promise<Reading> {
  const parts = [input.filename, input.mime, input.bytes].filter((v) => v !== undefined).length
  if (parts !== 0 && parts !== 3) {
    throw new BillReadingError('EMPTY', 'The document arrived without its name, its type or its contents — choose it again.')
  }
  const file = parts === 3 ? { filename: input.filename!, mime: input.mime!, bytes: input.bytes! } : null
  const sentence = input.sentence === undefined ? null : oneLineBreak(input.sentence).trim() || null
  if (!file && !sentence) {
    throw new BillReadingError('EMPTY', 'Write what happened, or choose the document — nothing arrived to read.')
  }
  if (sentence && sentence.length > SENTENCE_MAX) {
    throw new BillReadingError('TOO_LONG',
      `That is longer than ${SENTENCE_MAX} characters. Say it in fewer words, or attach the document.`)
  }
  if (file) {
    if (file.bytes.length === 0) throw new BillReadingError('EMPTY', 'The file is empty — nothing arrived to read.')
    if (file.bytes.length > MAX_BYTES) {
      throw new BillReadingError('TOO_BIG',
        `That file is ${(file.bytes.length / 1024 / 1024).toFixed(1)} MB; the limit for reading is 8 MB. `
        + 'A photo at a lower resolution reads just as well.')
    }
    if (!READABLE.test(file.mime)) {
      throw new BillReadingError('NOT_A_BILL',
        'A bill is read from a PDF, a photo or a screenshot (PDF, PNG, JPEG, WebP or GIF). '
        + 'Whatever you send is filed against the entry when you enter it.')
    }
  }
  const chart = await chartContext(input.ledgerId)
  const codes = new Set((await db.execute<{ code: string }>(sql`
    SELECT a.code FROM account a
     WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${input.ledgerId}::uuid)
       AND a.is_active AND a.is_postable`)).map((r) => r.code))

  const name = file && file.filename.length > NAME_SHOWN ? `${file.filename.slice(0, NAME_SHOWN)}…` : file?.filename
  // Beside the instruction: the file's name and what the person wrote, each when there is one.
  const withFile = name ? `(The file is ${name}.)` : null
  const withSentence = sentence ? `The person wrote:\n${sentence}` : null
  const exchange = await ask({
    ledgerId: input.ledgerId,
    question: [INSTRUCTION, withFile, withSentence].filter((line) => line !== null).join('\n\n'),
    booksOverride: chart,
    file: file ? { mime: file.mime, base64: file.bytes.toString('base64'), filename: file.filename } : undefined,
    actor: input.actor,
    service: input.service,
    prices: input.prices,
  }, send)

  const proposal = exchange.answer === null ? null : parseProposal(exchange.answer, codes)
  const error = exchange.error !== null
    ? exchange.error
    : proposal === null ? 'The model answered, but not with a proposal this could read.' : null

  const sha = file ? createHash('sha256').update(file.bytes).digest('hex') : null
  const [row] = await db.execute<Reading>(sql`
    INSERT INTO ai_bill_reading (ledger_id, exchange_id, read_by, filename, mime, bytes, sha256, sentence, proposal, error)
    VALUES (${input.ledgerId}::uuid, ${exchange.id}::uuid, ${input.actor}, ${file?.filename ?? null}, ${file?.mime ?? null},
            ${file?.bytes ?? null}, ${sha}, ${sentence}, ${proposal ? JSON.stringify(proposal) : null}::jsonb, ${error})
    RETURNING id::text, ledger_id::text, read_by, read_at::text, filename, mime, sha256, sentence, proposal, error,
              used_entry_id::text, used_at::text, records_entered`)
  return rowOf(row)
}

/**
 * A stored proposal in today's shape, whichever way the driver hands a jsonb
 * column back. Rows written before 2026-09-15 say `supplier` and know two
 * directions; nothing rewrites them, so every reader comes through here.
 */
export function proposalOf(stored: unknown): Proposal | null {
  if (stored === null || stored === undefined) return null
  const p = (typeof stored === 'string' ? JSON.parse(stored) : stored) as Partial<Proposal> & { supplier?: unknown }
  const { supplier, ...rest } = p
  return {
    ...(rest as Proposal),
    party: typeof p.party === 'string' ? p.party : typeof supplier === 'string' ? supplier : '',
    suggests: suggestsOf(p.suggests),
    // Rows stored before 2026-09-16 carry neither field, and null is the
    // honest reading of "this was never asked" rather than a value somebody
    // chose. Written after the spread so the absent case is explicit.
    suggestedKind: typeof p.suggestedKind === 'string' && p.suggestedKind ? p.suggestedKind : null,
    belongs: typeof p.belongs === 'string' && p.belongs ? p.belongs : null,
    facts: factsOf(p.facts),
    rows: rowsFrom(p.rows),
  }
}

const rowOf = (r: Reading): Reading => ({
  ...r,
  proposal: proposalOf(r.proposal),
  // A jsonb column arrives as an object from one driver path and as text from
  // another; `{}` when neither — a reading that predates 0080 entered nothing.
  records_entered: typeof r.records_entered === 'string'
    ? JSON.parse(r.records_entered) as Reading['records_entered']
    : r.records_entered ?? {},
})

/** What a reading is called in a sentence: its file's name, or "That sentence" for one from a sentence alone. */
export const readingLabel = (r: { filename: string | null }): string => r.filename ?? 'That sentence'

/** One reading, by id, in this company. */
export async function readingById(ledgerId: string, id: string): Promise<Reading | null> {
  const [row] = await db.execute<Reading>(sql`
    SELECT id::text, ledger_id::text, read_by, read_at::text, filename, mime, sha256, sentence, proposal, error,
           used_entry_id::text, used_at::text, records_entered
      FROM ai_bill_reading WHERE id = ${id}::uuid AND ledger_id = ${ledgerId}::uuid`)
  return row ? rowOf(row) : null
}

/** The readings waiting to be entered, newest first, and the ones just entered. */
export async function readingsFor(ledgerId: string, limit = 10): Promise<Reading[]> {
  return (await db.execute<Reading>(sql`
    SELECT id::text, ledger_id::text, read_by, read_at::text, filename, mime, sha256, sentence, proposal, error,
           used_entry_id::text, used_at::text, records_entered
      FROM ai_bill_reading WHERE ledger_id = ${ledgerId}::uuid
       AND NOT EXISTS(SELECT 1 FROM inbox_item WHERE reading_id=ai_bill_reading.id)
     ORDER BY read_at DESC LIMIT ${limit}`)).map(rowOf)
}

/** The file itself, for showing it beside the review form. None for a reading from a sentence alone. */
export async function readingFile(ledgerId: string, id: string): Promise<{ bytes: Buffer; mime: string; filename: string } | null> {
  const [row] = await db.execute<{ bytes: Buffer; mime: string; filename: string }>(sql`
    SELECT bytes, mime, filename FROM ai_bill_reading
     WHERE id = ${id}::uuid AND ledger_id = ${ledgerId}::uuid AND bytes IS NOT NULL`)
  return row ? { bytes: Buffer.from(row.bytes), mime: row.mime, filename: row.filename } : null
}

/**
 * Why a form carrying this reading may NOT post — asked by both review forms
 * BEFORE they post, because the refusal after the posting is too late: the
 * entry is in the books by then, and a second tab or a resubmitted page
 * would make one bill two entries (critic). Null means go ahead.
 */
export async function readingRefusal(ledgerId: string, readingId: string): Promise<string | null> {
  const reading = await readingById(ledgerId, readingId)
  if (!reading) return 'That reading is not in these books.'
  const claimed=await db.execute(sql`SELECT 1 FROM ai_bill_reading r WHERE r.id=${readingId}::uuid AND (r.used_invoice_id IS NOT NULL OR EXISTS(SELECT 1 FROM inbox_item WHERE reading_id=r.id))`)
  if(claimed.length)return 'Review this document from its Inbox item; that source has a single accounting target.'
  if (reading.used_entry_id !== null) {
    return 'That reading has already been entered.'
  }
  return null
}

/**
 * What the assistant page hands the browser for each reading: the card, and
 * nothing else. One function, watched by `BR12` on real rows — a client
 * component's props travel to the browser whether or not they are printed.
 * The bytes never get this far: `readingsFor` does not select them.
 */
export type ReadingCard = {
  id: string
  when: string
  by: string
  filename: string | null
  sentence: string | null
  proposal: Proposal | null
  error: string | null
  usedEntryId: string | null
  /** The corporate record's tables this reading's rows went into, and how many rows each took (0080). */
  recordsEntered: Record<string, number>
}

export function readingCards(rows: Reading[]): ReadingCard[] {
  return rows.map((r) => ({
    id: r.id, when: r.read_at.replace('T', ' ').slice(0, 16), by: r.read_by, filename: r.filename, sentence: r.sentence,
    proposal: r.proposal, error: r.error, usedEntryId: r.used_entry_id,
    // The count the DOOR stored — what went in, which is not what was read
    // when somebody removed or added a row first (critic round 1).
    recordsEntered: Object.fromEntries(Object.entries(r.records_entered).map(([t, m]) => [t, m.rows])),
  }))
}

/**
 * WHERE THIS SUPPLIER'S MONEY WENT LAST TIME.
 *
 * The books already know things the model cannot: this company put the last
 * Fido bill on 5200, and the one before that too. So when a proposal leaves a
 * line's account blank — or names a code this chart does not have — the
 * answer is often sitting in the ledger, and asking it costs one query.
 *
 * This is the bank feed's own idea (`rememberedContra`, and the `SAME_PAYEE`
 * normalisation it compares with), applied at the other door. Two ways in,
 * strongest first:
 *
 *   the PARTY   a line carrying a party whose NAME reads as this supplier's:
 *               take the account that entry used. Preferred, not exact — a
 *               reading knows a name off a bill, never a party id.
 *   the WORDS   failing that, an entry whose description reads as the same
 *               payee — digits stripped, case and spacing ignored, which is
 *               how a statement writes the same shop three different ways.
 *
 * A suggestion, never an answer: it fills a box the person is about to look
 * at, and the door still refuses a line with no account.
 *
 * OF THE DIRECTION ASKED FOR. Every form offers the whole chart, so what a form
 * offers cannot keep a sale off an expense account: a party who is both a
 * customer and a supplier would have its last purchase remembered onto an
 * invoice to it (critic, 2026-09-15). Money out asks for `expense`, money in
 * for `revenue`.
 */
export async function rememberedAccount(
  ledgerId: string, party: string, type: 'expense' | 'revenue',
  /** Only an account the form actually offers; see `accountIdOf`. */
  allowed?: string[],
): Promise<string | null> {
  const name = party.trim()
  if (!name) return null
  const rows = await db.execute<{ account_id: string }>(sql`
    WITH theirs AS (
      -- A line carrying a party whose NAME reads as this supplier's. Not an
      -- exact fact: a reading knows a name off a bill, not a party id, so
      -- this is the same fuzzy comparison as the branch below, on a
      -- different column (critic, 2026-09-07).
      SELECT e.id, e.posted_at, e.created_at, 2 AS how
        FROM journal_entry e
        JOIN journal_line jl ON jl.entry_id = e.id
        JOIN party p ON p.id = jl.party_id
       WHERE e.ledger_id = ${ledgerId}::uuid AND e.status = 'posted'
         -- NOT the reversal half of a correction pair: it carries the same
         -- account and the same party as the entry it cancels, so after a
         -- correction the newest entry naming this supplier is the very
         -- account somebody corrected away (critic).
         AND e.reverses_id IS NULL
         AND ${SAME_PAYEE(sql`p.name`)} = ${SAME_PAYEE(sql`${name}::text`)}
      UNION ALL
      SELECT e.id, e.posted_at, e.created_at, 1 AS how
        FROM journal_entry e
       WHERE e.ledger_id = ${ledgerId}::uuid AND e.status = 'posted'
         AND e.reverses_id IS NULL
         AND ${SAME_PAYEE(sql`e.description`)} = ${SAME_PAYEE(sql`${name}::text`)}
    )
    SELECT a.id::text AS account_id
      FROM theirs t
      JOIN journal_line jl ON jl.entry_id = t.id
      JOIN account a ON a.id = jl.account_id
     WHERE a.account_type = ${type}
       AND a.is_postable AND a.is_active
     -- line_no last, so an entry with several expense lines answers the
     -- same way twice rather than picking among them at the database's
     -- convenience (critic).
     ORDER BY t.how DESC, t.posted_at DESC NULLS LAST, t.created_at DESC, jl.line_no
     LIMIT 20`)
  if (allowed === undefined) return rows[0]?.account_id ?? null
  const offered = new Set(allowed)
  return rows.find((r) => offered.has(r.account_id))?.account_id ?? null
}

/** Throw a reading away. Only one nobody has entered — the trigger says so too. */
export async function discardReading(ledgerId: string, id: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM ai_bill_reading WHERE id = ${id}::uuid AND ledger_id = ${ledgerId}::uuid`)
}

/** What a door says when a reading was entered as another entry while this one posted. */
const ENTERED_TWICE = 'That reading has already been entered as another entry, so the same thing may now be in the books twice — check the two entries and delete one.'

/**
 * Filing the bill against the entry it became, and closing the reading.
 *
 * The two review forms post through the doors they always used; this is what
 * happens after, when the form carried a reading id: the same bytes that were
 * read — when there are any; a sentence alone has none — go through `saveAttachment` — the one door for receipts, with its tree
 * links and its audit row — and the reading remembers which entry it became.
 * A reading that has been used cannot be used again — the forms ask
 * `readingRefusal` before they post, this refuses again, and 0064's trigger
 * refuses beneath both — so the same photo cannot quietly become two entries.
 */
export async function attachReadingTo(input: {
  ledgerId: string; readingId: string; entryId: string; actor: string
}): Promise<{ filed: boolean }> {
  const [row] = await db.execute<{ filename: string | null; mime: string | null; bytes: Buffer | null; used_entry_id: string | null }>(sql`
    SELECT filename, mime, bytes, used_entry_id::text FROM ai_bill_reading
     WHERE id = ${input.readingId}::uuid AND ledger_id = ${input.ledgerId}::uuid`)
  if (!row) throw new BillReadingError('NO_READING', 'That reading is not in these books.')
  if (row.used_entry_id !== null) {
    throw new BillReadingError('ALREADY_ENTERED', ENTERED_TWICE)
  }
  // A reading from a sentence alone has no paper to file: the entry is marked, and that is all.
  const filed = row.bytes !== null && row.filename !== null && row.mime !== null
  if (filed) {
    await saveAttachment({
      ledgerId: input.ledgerId, entryId: input.entryId,
      filename: row.filename!, bytes: Buffer.from(row.bytes!), mime: row.mime!,
      note: 'Read by the assistant', actor: input.actor,
    })
  }
  // Only if nobody marked it meanwhile: two forms that both passed `readingRefusal` race to here, and the
  // second must hear that its entry may be the same thing twice, not a trigger's words (critic, 2026-09-15).
  const marked = await db.execute<{ id: string }>(sql`
    UPDATE ai_bill_reading SET used_entry_id = ${input.entryId}::uuid, used_at = now()
     WHERE id = ${input.readingId}::uuid AND used_entry_id IS NULL
     RETURNING id::text`)
  if (marked.length === 0) {
    throw new BillReadingError('ALREADY_ENTERED', filed ? `${ENTERED_TWICE} Its file was filed against this entry too.` : ENTERED_TWICE)
  }
  return { filed }
}

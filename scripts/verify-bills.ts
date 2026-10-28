/**
 * Reading a bill: a picture goes out with the chart, a proposal comes back,
 * a person chooses and reviews, the ordinary door posts, the picture is filed.
 *   npm run db:verify-bills   (resets the database first)
 *
 * NOTHING HERE REACHES THE NETWORK. The model is a server this suite starts
 * on the loopback address, answering in the OpenAI-compatible shape from a
 * script chosen per check; the refusals before anything leaves are checked
 * against a sentinel sender that throws if reached (`BR1`). What is checked
 * is what does not depend on a model: what leaves (`BR2`), what is kept and
 * how it is read (`BR3`, `BR4`), how a proposal fills the two forms (`BR5`,
 * `BR6`, `BR12`), that the forms post through their own doors and file the
 * picture after — never before — the posting (`BR7`, `BR9`, `BR10`), and that
 * a reading is used once and in its own company only (`BR8`).
 */
import './env'
import { reporter } from './suite'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// The attachment store for this run is a scratch directory, set BEFORE the
// lib is ever called — the dev store must never be touched by a suite.
process.env.ATTACHMENTS_DIR = mkdtempSync(path.join(os.tmpdir(), 'erp-bills-'))
import { byHand } from './by-hand'
import { trailNamesPeople } from './actor-trail'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { sql as raw, type SQL } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { deleteEntry, postEntry, reverseEntry } from '../src/lib/posting'
import { parseMoney } from '../src/lib/money'
import { causesOf } from '../src/lib/db-errors'
import { createParty } from '../src/lib/parties'
import { createFirstOwner } from '../src/lib/users'
import { saveService } from '../src/lib/ai-service'
import { PROMPT_MAX, exchangesFor, serviceFrom, type Reply, type Service } from '../src/lib/assistant'
import { DESTINATION_KEYS } from '../src/lib/destinations'
import {
  BillReadingError, INSTRUCTION_LENGTH, NAME_SHOWN, SENTENCE_MAX, attachReadingTo, chartContext, discardReading, parseProposal, proposalOf, readBill,
  readingById, readingCards, readingFile, readingRefusal, readingsFor, rememberedAccount,
} from '../src/lib/bill-reading'
import { discardReadingFromForm, readBillFromForm } from '../src/lib/bill-forms'
import { chequeInitialFrom, invoiceInitialFrom, invoiceSideFor, quickInitialFrom, rememberedLines, rowStateFrom } from '../src/lib/prefill'
import { quickAccountsFor } from '../src/lib/quick'
import { chequeById, createManualCheque } from '../src/lib/cheques'
import { localToday } from '../src/lib/today'
import { quickEntryFromForm } from '../src/lib/quick-forms'
import { createInvoiceFromForm } from '../src/lib/invoice-forms'
import { attachmentsOf } from '../src/lib/attachments'
import { ADD_MENU, AI_WORKSPACE_PATH, DETAIL_ROUTES } from '../src/lib/nav'
import {
  BILL_FIELDS as B, INVOICE_FIELDS as I, QUICK_FIELDS as Q, READING_FIELD, lineAccount, lineAmount,
  lineDescription, lineTaxCode,
} from '../src/lib/forms'

const r = reporter(66)
const { check } = r
const said = (e: unknown) => (e instanceof BillReadingError ? `${e.code}: ${e.message}` : causesOf(e)).replace(/\s+/g, ' ')

const NORTH = 'NORTHMARK', SOUTH = 'SOUTHMARK'
const MODEL = 'relay-model-under-test'
/** The key the suite saves. It must never appear in a row. */
const KEY = 'sk-suite-secret-7f3a9c'
/** A one-pixel PNG: what a picture is to a suite. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const chartFor = (marker: string) => `1000,Cash ${marker},asset,,cash_and_cash_equivalents
1100,Trade receivables ${marker},asset,,trade_receivables
1300,GST recoverable ${marker},asset,,gst_hst_recoverable
2100,Trade payables ${marker},liability,,trade_payables
3000,Share capital ${marker},equity,,share_capital
4000,Revenue ${marker},revenue,,revenue_from_contracts
5300,Office supplies ${marker},expense,,
5400,Software ${marker},expense,,`

/** What the scripted model says about the Staples bill. */
const STAPLES = {
  suggests: 'bill', party: 'STAPLES CANADA, ULC.', documentRef: '4471',
  issuedOn: '2026-02-03', dueOn: '2026-03-05', currency: 'CAD',
  lines: [
    { description: 'Printer paper', amount: '42.99', taxCode: 'GST_PST', accountCode: '5300' },
    { description: 'Toner', amount: 89, taxCode: 'GST_PST', accountCode: '9999' },
    { description: 'Stapler', amount: '$10.00', taxCode: 'VAT', accountCode: '5400' },
    { description: 'Loyalty points', amount: 'n/a', taxCode: '', accountCode: '' },
  ],
  subtotal: '141.99', gst: '7.10', pst: '9.94', total: '159.03', notes: 'The PST rate looked like 7%.',
}

/** What the scripted model makes of a sentence about money coming in. */
const BETA = {
  suggests: 'income', party: 'Beta Services', documentRef: '', issuedOn: null, dueOn: null, currency: 'CAD',
  lines: [{ description: 'August consulting', amount: '1200.00', taxCode: '', accountCode: '4000' }],
  subtotal: null, gst: null, pst: null, total: '1200.00', notes: '',
}

async function main() {
  const north = await createCompanyWithYear({ code: 'NOR', name: `Northwind ${NORTH} Ltd.` }, 'alicio@example.test')
  const south = await createCompanyWithYear({ code: 'SOU', name: `Southwind ${SOUTH} Ltd.` }, 'alicio@example.test')
  const ids: Record<string, Record<string, string>> = {}
  for (const [co, marker] of [[north, NORTH], [south, SOUTH]] as const) {
    const accts = await importAccounts(co.company.id,
      parseAccountsCsv(chartFor(marker)).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
    ids[marker] = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  }
  const L = north.ledger.id
  const yr = Number(north.year.endDate.slice(0, 4))
  const day = (mmdd: string) => `${yr}-${mmdd}`
  // A balance, so BR2 can look for it in what leaves.
  await postEntry({
    ledgerId: L, entryDate: day('01-15'), description: 'Capital in', actor: 'alicio@example.test',
    lines: [{ accountId: ids[NORTH]['1000'], amount: parseMoney('1234.00') },
            { accountId: ids[NORTH]['3000'], amount: -parseMoney('1234.00') }],
  })
  const southEntry = await postEntry({
    ledgerId: south.ledger.id, entryDate: day('01-15'), description: 'Capital in', actor: 'alicio@example.test',
    lines: [{ accountId: ids[SOUTH]['1000'], amount: parseMoney('50.00') },
            { accountId: ids[SOUTH]['3000'], amount: -parseMoney('50.00') }],
  })
  const staples = await createParty({
    kind: 'organisation', name: 'Staples Canada ULC', actor: 'alicio@example.test',
    roles: [{ entityId: north.company.id, role: 'supplier', heldFrom: day('01-01') }],
  })
  const actor = 'pat@x.test'
  const pat = await createFirstOwner({ email: actor, firstName: 'Pat', lastName: null, password: 'a long ordinary sentence' })
  const who = { id: pat.id, email: pat.email }
  process.env.AI_KEY_SECRET = 'suite-secret-for-encrypting-keys'

  // The model, on the loopback address: answers from a script, keeps every request.
  type Seen = { authorization: string | undefined; body: { messages: Array<{ role: string; content: unknown }> } }
  const seen: Seen[] = []
  let script: 'proposal' | 'paid' | 'garbage' | 'error' | 'sentence' = 'proposal'
  const relay = createServer((req: IncomingMessage, res: ServerResponse) => {
    let rawBody = ''
    req.on('data', (c) => { rawBody += c })
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(rawBody) })
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (script === 'error') return reply(401, { error: { message: 'invalid key', type: 'authentication_error' } })
      const usage = { prompt_tokens: 900, completion_tokens: 120 }
      const content = script === 'garbage' ? 'Sorry, I cannot see an image in this conversation.'
        : script === 'paid' ? `Here it is:\n${JSON.stringify({ ...STAPLES, suggests: 'expense', party: 'Tim Hortons', documentRef: '', dueOn: null, lines: STAPLES.lines.slice(0, 2) })}\nDone.`
        : script === 'sentence' ? JSON.stringify(BETA)
        : JSON.stringify(STAPLES)
      return reply(200, { id: 'x', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage })
    })
  })
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r))
  const port = (relay.address() as { port: number }).port
  const service: Service = serviceFrom({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: KEY, model: MODEL })!
  await saveService({ userId: pat.id, actor, baseUrl: service.baseUrl, apiKey: KEY, model: MODEL })
  const mine = { actor, service, prices: null }
  const read = (filename = 'staples.png', mime = 'image/png', bytes = PNG) =>
    readBill({ ledgerId: L, filename, mime, bytes, ...mine })
  const sha = createHash('sha256').update(PNG).digest('hex')

  // ------------------------------------------------------------------- BR1
  // What is refused before anything leaves: a file that is neither a picture
  // nor a PDF, an empty one, an oversized one. Nothing sent, nothing
  // recorded — not a reading, not an asking. A PDF is READ now (BR1b).
  {
    let reached = 0
    const sentinel = async (): Promise<Reply> => { reached++; throw new Error('the sentinel sender was reached') }
    const attempt = async (filename: string, mime: string, bytes: Buffer) => {
      try { await readBill({ ledgerId: L, filename, mime, bytes, ...mine }, sentinel); return 'read' }
      catch (e) { return said(e) }
    }
    const wrong = await attempt('bill.docx', 'application/msword', Buffer.from('not a bill'))
    const empty = await attempt('nothing.png', 'image/png', Buffer.alloc(0))
    const big = await attempt('huge.png', 'image/png', Buffer.alloc(8 * 1024 * 1024 + 1))
    const rows = await readingsFor(L)
    const asked = await exchangesFor(L)
    check(wrong.startsWith('NOT_A_BILL') && wrong.includes('PDF') && empty.startsWith('EMPTY') && big.startsWith('TOO_BIG')
      && reached === 0 && rows.length === 0 && asked.length === 0,
      'BR1 a file that is not a bill, an empty one and a big one are refused before anything leaves',
      `${wrong.slice(0, 40)} / ${empty.slice(0, 30)} / ${big.slice(0, 30)}; sender reached ${reached}; ${rows.length} reading(s), ${asked.length} asking(s)`)
  }

  // ------------------------------------------------------------------ BR1b
  // A PDF IS READ (owner, 2026-09-07). It goes in the `file` part the format
  // defines — filename and a data URL — not as an `image_url`, because that
  // is what an OpenAI-compatible service reads a document from. Nothing here
  // converts it: there is no way to turn a PDF into a picture in this tree
  // without a new dependency, and that is frozen.
  {
    script = 'proposal'
    const bill = Buffer.from('%PDF-1.4 a supplier bill\n%%EOF')
    // Caught: a mutant that puts PDFs back on the refused list throws here,
    // and a throw kills the suite instead of turning this line red.
    let reading: Awaited<ReturnType<typeof readBill>> | null = null
    let refused = ''
    try {
      reading = await readBill({
        ledgerId: L, filename: 'coastal-4471.pdf', mime: 'application/pdf', bytes: bill, ...mine,
      })
    } catch (e) { refused = said(e) }
    const sent = reading ? seen[seen.length - 1] : null
    const parts = sent ? sent.body.messages[1].content as Array<{
      type: string; text?: string; file?: { filename: string; file_data: string }
      image_url?: { url: string }
    }> : []
    const filePart = Array.isArray(parts) ? parts.find((p) => p.type === 'file') : undefined
    const kept = reading ? await readingFile(L, reading.id) : null
    check(!!reading && Array.isArray(parts) && parts.length === 2 && !parts.some((p) => p.type === 'image_url')
      && filePart?.file?.filename === 'coastal-4471.pdf'
      && filePart.file.file_data === `data:application/pdf;base64,${bill.toString('base64')}`
      && reading.proposal !== null && reading.error === null
      && kept?.mime === 'application/pdf' && kept.bytes.equals(bill),
      'BR1b a PDF is read: it goes as a file part with its name, not as a picture, and is kept as it arrived',
      refused ? `refused: ${refused.slice(0, 70)}`
              : `${Array.isArray(parts) ? parts.map((p) => p.type).join('+') : typeof parts}; `
                + `named ${filePart?.file?.filename}; proposal ${reading?.proposal !== null}`)
    if (reading) await discardReading(L, reading.id)
  }

  // ------------------------------------------------------------------- BR2
  // What leaves: the picture as a data URL part beside the instruction, and
  // this company's chart — codes, names, types — as the books context. Not
  // its balances, not the other company. The exchange row keeps that text.
  let first: Awaited<ReturnType<typeof read>>
  {
    script = 'proposal'
    first = await read()
    const sent = seen[seen.length - 1]
    const system = String(sent.body.messages[0].content)
    const user = sent.body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    const text = Array.isArray(user) ? user.find((p) => p.type === 'text')?.text ?? '' : ''
    const image = Array.isArray(user) ? user.find((p) => p.type === 'image_url')?.image_url?.url ?? '' : ''
    const chart = await chartContext(L)
    const [x] = await exchangesFor(L)
    check(sent.authorization === `Bearer ${KEY}` && Array.isArray(user) && user.length === 2
      && text.includes('ONE JSON object') && text.includes('staples.png')
      && image === `data:image/png;base64,${PNG.toString('base64')}`
      && system.includes(`5300 | Office supplies ${NORTH} | expense`) && system.includes('GST_PST')
      && !system.includes(SOUTH) && !system.includes('1234') && !system.includes('1,234')
      && x.books_sent === chart && chart.includes(`2100 | Trade payables ${NORTH} | liability`) && !chart.includes('1234'),
      'BR2 the picture and the chart leave — codes, names, types; no balances, no other company',
      `${Array.isArray(user) ? user.map((p) => p.type).join('+') : typeof user}; system ${system.length} chars, chart in books_sent: ${x.books_sent === chart}; balance in it: ${system.includes('1234')}`)
  }

  // ------------------------------------------------------------------ BR2b
  // A LONG FILE NAME ARRIVES SHORTENED.
  //
  // `NAME_SHOWN` truncates it. That used to matter because the name, the
  // instruction and the sentence shared one 4,000-character cap and a long
  // name could push a legal sentence over it — the reason mutation block
  // "A long file name crowds the question out" existed. Splitting the caps on
  // 2026-09-16 (PROMPT_MAX for what leaves, QUESTION_MAX for what a person
  // types) put that ceiling out of reach and left the block toothless, which
  // `db:toothless` said out loud.
  //
  // The truncation still does something: it bounds what this machine sends
  // about a file somebody named. So the block is pointed at THAT instead, and
  // this is the check it turns red.
  {
    script = 'proposal'
    const longName = `${'n'.repeat(400)}.png`
    const at = seen.length
    const extra = await read(longName)
    const sent = seen[at]
    const user = sent.body.messages[1].content as Array<{ type: string; text?: string }>
    const text = Array.isArray(user) ? user.find((p) => p.type === 'text')?.text ?? '' : ''
    const carried = /\(The file is (n+)/.exec(text)?.[1].length ?? 0
    check(carried > 0 && carried <= NAME_SHOWN && text.includes('…'),
      'BR2b a long file name is shortened before it leaves',
      `${longName.length} characters named, ${carried} sent (cap ${NAME_SHOWN}), ellipsis ${text.includes('…')}`)
    // Discarded straight away: every check after this one counts readings, and
    // a row left behind by a check about a FILE NAME would be a count nobody
    // could explain.
    await discardReading(L, extra.id)
  }

  // ------------------------------------------------------------------- BR3
  // The proposal, read defensively and kept with the file: an account code the
  // chart lacks is no account, a tag the ledger lacks is no tag, a line whose
  // amount does not read is dropped, a number is a string. This company sees
  // it; the other does not — the row, the file, the list.
  {
    const p = first.proposal!
    const back = await readingById(L, first.id)
    const file = await readingFile(L, first.id)
    const mine = await readingsFor(L)
    const theirs = await readingsFor(south.ledger.id)
    check(p.suggests === 'bill' && p.party === 'STAPLES CANADA, ULC.' && p.documentRef === '4471'
      && p.issuedOn === '2026-02-03' && p.dueOn === '2026-03-05' && p.lines.length === 3
      && p.lines[0].accountCode === '5300' && p.lines[0].taxCode === 'GST_PST' && p.lines[0].amount === '42.99'
      && p.lines[1].accountCode === null && p.lines[1].amount === '89.00'
      && p.lines[2].accountCode === '5400' && p.lines[2].taxCode === '' && p.lines[2].amount === '10.00'
      && p.subtotal === '141.99' && p.gst === '7.10' && p.pst === '9.94' && p.total === '159.03' && p.notes.includes('7%')
      && first.sha256 === sha && first.error === null && first.used_entry_id === null && first.read_by === actor
      && back?.proposal?.lines.length === 3 && back.proposal.lines[1].accountCode === null
      && file?.bytes.equals(PNG) === true && file.mime === 'image/png' && file.filename === 'staples.png'
      && mine.length === 1 && theirs.length === 0
      && (await readingById(south.ledger.id, first.id)) === null && (await readingFile(south.ledger.id, first.id)) === null,
      'BR3 the proposal is kept with the file: unknown code → no account, unknown tag → no tag, unreadable line dropped; this company only',
      `${p.lines.length} lines; codes ${p.lines.map((l) => l.accountCode).join(',')}; tags ${p.lines.map((l) => l.taxCode || '∅').join(',')}; here ${mine.length}, there ${theirs.length}`)
    // The parser on its own, for the shapes a model produces around its JSON.
    const codes = new Set(['5300'])
    // B-not-a-transaction — THE MODEL MAY SAY THIS IS NOT ONE (2026-09-16).
    //
    // Until then `suggests` was a closed four — expense, bill, income, sale —
    // and `suggestsOf` rewrote anything else to `expense` in silence. The
    // owner uploaded a company registration document, the model read it
    // correctly, and the app filed it as money spent: it looked like a wrong
    // choice when in truth the question was never asked. These three are that
    // hole, from both sides.
    {
      // AND THE INSTRUCTION MUST LEAVE ROOM FOR THE PERSON. Both travel as one
      // composed question, so every line added to the prompt eats into what
      // somebody may write. It used to eat into QUESTION_MAX — the PERSON's
      // own limit — which is why adding "other" broke BR20 and why generating
      // the destination menu broke this. Two numbers now, and this guards the
      // one that matters here.
      const room = PROMPT_MAX - SENTENCE_MAX - INSTRUCTION_LENGTH
      check(room > 200,
        'B31 the prompt leaves room for the longest sentence a person may write',
        `instruction ${INSTRUCTION_LENGTH} + sentence ${SENTENCE_MAX} of ${PROMPT_MAX}: ${room} to spare`)

      const registration = parseProposal(JSON.stringify({
        suggests: 'other', kind: 'a certificate of incorporation',
        belongs: "the company's own details and the directors register",
        party: 'Ontario', documentRef: '', lines: [],
      }), codes)
      const said = parseProposal(JSON.stringify({ suggests: 'a contract', lines: [] }), codes)
      const old = proposalOf({ suggests: 'bill', party: 'Fido', lines: [] })
      check(registration?.suggests === 'other'
        && registration.suggestedKind === 'a certificate of incorporation'
        && registration.belongs?.includes('directors register') === true
        // Anything unrecognised is `other`, NOT `expense`: an answer nobody
        // gave must not be dressed as one the model gave.
        && said?.suggests === 'other'
        // And a proposal stored before this existed still reads, with null
        // rather than an invented opinion.
        && old?.suggests === 'bill' && old.suggestedKind === null && old.belongs === null,
        'B32 a reading that is not a transaction says so, and is not filed as an expense',
        `"other" kept as "${registration?.suggestedKind}"; an unknown answer -> ${said?.suggests}; `
          + `a pre-2026-09-16 row -> ${old?.suggests} with suggestedKind ${old?.suggestedKind}`)
    }

    const wrapped = parseProposal('Sure! ```json\n{"suggests":"expense","lines":[{"amount":"1,234.50","accountCode":"5300"}]}\n```', codes)
    const nothing = parseProposal('I could not read the image.', codes)
    check(wrapped?.suggests === 'expense' && wrapped.lines[0].amount === '1234.50' && wrapped.lines[0].accountCode === '5300'
      && wrapped.currency === 'CAD' && nothing === null,
      'BR3b JSON inside prose is found; prose alone is no proposal',
      `${wrapped?.lines[0].amount} / ${nothing}`)
  }

  // ------------------------------------------------------------------- BR4
  // A model that answers with prose, or a service that fails: the reading is
  // kept with its error and no proposal — the file is there to enter by hand.
  // And the key is in no row of either table.
  {
    script = 'garbage'
    const prose = await read('till.png')
    script = 'error'
    const failed = await read('till2.png')
    const rows = await readingsFor(L)
    const readingText = (await db.execute<{ t: string }>(raw`
      SELECT r::text AS t FROM ai_bill_reading r WHERE ledger_id = ${L}::uuid`)).map((r) => r.t).join('\n')
    const exchangeText = (await db.execute<{ t: string }>(raw`
      SELECT x::text AS t FROM ai_exchange x WHERE ledger_id = ${L}::uuid`)).map((r) => r.t).join('\n')
    check(prose.proposal === null && (prose.error ?? '').includes('not with a proposal')
      && failed.proposal === null && (failed.error ?? '').includes('401')
      && rows.length === 3 && (await readingFile(L, prose.id))?.bytes.equals(PNG) === true
      && !readingText.includes(KEY) && !exchangeText.includes(KEY) && exchangeText.includes('Sorry, I cannot see'),
      'BR4 prose and a failed call are readings with an error and no proposal; the file is kept; the key is in no row',
      `${prose.error?.slice(0, 50)} / ${failed.error?.slice(0, 40)}; ${rows.length} readings; key in rows: ${readingText.includes(KEY) || exchangeText.includes(KEY)}`)
    await discardReading(L, prose.id)
    await discardReading(L, failed.id)
  }

  // ------------------------------------------------------------------- BR5
  // The quick-expense form's opening values: the account by code when the
  // chart has it, blank when the model could not name one; the date from the
  // document or today; the tax tag as read, out of scope when none.
  const { plAccounts, bankAccounts } = await quickAccountsFor(L, 'expense')
  {
    const p = first.proposal!
    const e = quickInitialFrom('expense', first.id, p, plAccounts, day('09-06'))
    const undated = quickInitialFrom('expense', first.id, { ...p, issuedOn: null }, plAccounts, day('09-06'))
    check(e.rows.length === 3 && e.rows[0].accountId === ids[NORTH]['5300'] && e.rows[0].tax === 'GST_PST'
      && e.rows[0].amount === '42.99' && e.rows[0].description === 'Printer paper'
      && e.rows[1].accountId === '' && e.rows[2].accountId === ids[NORTH]['5400'] && e.rows[2].tax === 'OUT_OF_SCOPE'
      && e.entryDate === '2026-02-03' && e.description === 'STAPLES CANADA, ULC.' && e.documentRef === '4471'
      && e.inclusive === false && e.readingId === first.id && undated.entryDate === day('09-06'),
      'BR5 the expense form opens with the proposal: account by code or blank, date from the document or today',
      `rows ${e.rows.map((r) => (r.accountId ? 'acct' : 'blank')).join(',')}; date ${e.entryDate}; undated → ${undated.entryDate}`)
  }

  // ------------------------------------------------------------------- BR6
  // The purchase-bill form's opening values: the supplier matched by name as
  // loosely as a name can be without guessing, else named as unknown; the
  // payable account; the dates; their reference; the model's notes as the
  // note. And the line editor's rows, keyed by position once and padded.
  const suppliers = [{ id: staples.id, label: 'Staples Canada ULC' }, { id: randomUUID(), label: 'Staples Warehouse' }]
  {
    const p = first.proposal!
    const b = invoiceInitialFrom('purchase', first.id, p, plAccounts, day('09-06'), suppliers, ids[NORTH]['2100'])
    const stranger = invoiceInitialFrom('purchase', first.id, { ...p, party: 'Grand & Toy', dueOn: null }, plAccounts, day('09-06'),
                                     suppliers, ids[NORTH]['2100'])
    const rows = rowStateFrom(b.rows)
    check(b.direction === 'purchase' && b.header.partyId === staples.id && b.unknownParty === null
      && b.header.controlAccountId === ids[NORTH]['2100'] && b.header.issuedOn === '2026-02-03' && b.header.dueOn === '2026-03-05'
      && b.header.theirRef === '4471' && b.header.number === '' && b.header.note.includes('7%')
      && b.rows[0].accountId === ids[NORTH]['5300'] && b.rows[1].accountId === '' && b.rows[2].taxCode === ''
      && stranger.header.partyId === '' && stranger.unknownParty === 'Grand & Toy' && stranger.header.dueOn === '2026-02-03'
      && rows.rows.length === 6 && rows.nextKey === 6 && rows.rows.map((r) => r.key).join(',') === '0,1,2,3,4,5'
      && rows.rows[0].account === ids[NORTH]['5300'] && rows.rows[2].taxCode === 'OUT_OF_SCOPE' && rows.rows[5].amount === '',
      'BR6 the bill form opens with the supplier matched by name or named as unknown, the payable account, the dates, the rows',
      `party ${b.header.partyId === staples.id ? 'matched' : b.header.partyId || 'blank'}; stranger → ${stranger.unknownParty}; ${rows.rows.length} rows`)
  }

  // ------------------------------------------------------------------ BR19
  // A supplier named in another script, with accents, in full-width letters or
  // with a Chinese company suffix, is matched by the same rule as any other
  // name — and a different name is still a different name.
  {
    const p = first.proposal!
    const [north, cafe, cafOl, sony, artDe, artDeco, fido, northTrad] = Array.from({ length: 8 }, () => randomUUID())
    const named = [...suppliers,
      { id: north, label: '北方贸易' }, { id: randomUUID(), label: '南方物流有限公司' }, { id: northTrad, label: '北方貿易' },
      { id: artDe, label: 'Art Dé' }, { id: artDeco, label: 'Art Déco' }, { id: randomUUID(), label: 'The Store' },
      { id: cafOl, label: 'Caf Ol' }, { id: cafe, label: 'CAFÉ OLÉ' }, { id: sony, label: 'Sony Canada' },
      { id: fido, label: 'Fido' }]
    const matched = (supplier: string) =>
      invoiceInitialFrom('purchase', first.id, { ...p, party: supplier }, plAccounts, day('09-06'), named, ids[NORTH]['2100']).header.partyId
    const got = {
      chineseWithSuffix: matched('北方贸易有限公司') === north,
      differentChinese: matched('东方贸易有限公司') === '',
      accents: matched('Café Olé Ltd.') === cafe,
      withoutAccents: matched('Caf Ol') === cafOl,
      decomposed: matched('Café Olé') === cafe,
      fullWidth: matched('Ｓｏｎｙ Ｃａｎａｄａ') === sony,
      suffixInsideAWord: matched('Art Déco Inc.') === artDeco,
      legalWordInTheMiddle: matched('The Company Store') === '',
      symbol: matched('Fido™') === fido,
      traditionalSuffix: matched('北方貿易有限責任公司') === northTrad,
    }
    check(Object.values(got).every(Boolean),
      'BR19 a supplier name matches across scripts, accents, full-width letters, symbols and a closing company suffix, and only the same name',
      Object.entries(got).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join('; '))
  }

  // ------------------------------------------------------------------- BR7
  // The quick-expense door, from the form, with the reading's id: the entry
  // posts through the door it always did, and THEN the picture is filed
  // against it through the attachment door, and the reading is closed.
  const bank = bankAccounts[0].id
  const expenseForm = (readingId: string, account: string, ref = '4471') => {
    const f = new FormData()
    f.set(Q.ledgerId, L); f.set(Q.kind, 'expense'); f.set(Q.entryDate, day('02-03'))
    f.set(Q.description, 'Staples'); f.set(Q.documentRef, ref); f.set(Q.bankAccountId, bank)
    f.set(Q.amounts, 'exclusive')
    f.set(lineAccount(0), account); f.set(lineDescription(0), 'Printer paper')
    f.set(lineAmount(0), '42.99'); f.set(lineTaxCode(0), 'GST_PST')
    f.set(READING_FIELD, readingId)
    return f
  }
  let expenseEntry = ''
  {
    const r = await quickEntryFromForm(expenseForm(first.id, ids[NORTH]['5300']), actor)
    expenseEntry = r.entryId ?? ''
    const files = expenseEntry ? await attachmentsOf(expenseEntry) : []
    const back = await readingById(L, first.id)
    check(!!r.ok && r.ok.includes('filed against it') && files.length === 1 && files[0].sha256 === sha
      // Renamed on filing for the entry's date and amount (2026-09-07); the
      // name the reading was uploaded under is kept in the note beside the
      // assistant's own.
      && files[0].filename === `${day('02-03')} 48.15.png`
      && files[0].note === 'Read by the assistant' && files[0].uploaded === 'staples.png'
      && back?.used_entry_id === expenseEntry && back.used_at !== null,
      'BR7 the expense posts through its own door and the picture is filed against the entry; the reading is closed',
      `${r.ok ?? r.error}; ${files.length} file(s) named ${files[0]?.filename}, note "${files[0]?.note}"; `
      + `used_entry_id ${back?.used_entry_id === expenseEntry ? 'is the entry' : back?.used_entry_id}`)
  }

  // ------------------------------------------------------------------- BR8
  // Once, and here only. A used reading cannot be attached again, moved to
  // another entry, or deleted — the code refuses and so does the trigger. A
  // reading is attachable in its own company only, and discardable only
  // while unused.
  {
    // At a DIFFERENT entry: the same entry would be refused by the store's
    // own dedup, which is not the refusal this checks (critic).
    const other = await postEntry({
      ledgerId: L, entryDate: day('02-10'), description: 'Another', actor,
      lines: [{ accountId: ids[NORTH]['1000'], amount: 100n }, { accountId: ids[NORTH]['3000'], amount: -100n }],
    })
    let again = ''
    try { await attachReadingTo({ ledgerId: L, readingId: first.id, entryId: other.entry.id, actor }); again = 'attached' }
    catch (e) { again = said(e) }
    const files = await attachmentsOf(expenseEntry)
    const otherFiles = await attachmentsOf(other.entry.id)
    let moved = ''
    try {
      await byHand(async (tx) => {
        await tx.execute(raw`UPDATE ai_bill_reading SET used_entry_id = ${southEntry.entry.id}::uuid WHERE id = ${first.id}::uuid`)
      })
      moved = 'moved'
    } catch (e) { moved = causesOf(e).replace(/\s+/g, ' ') }
    let deleted = ''
    try { await discardReading(L, first.id); deleted = 'deleted' } catch (e) { deleted = causesOf(e).replace(/\s+/g, ' ') }
    const still = await readingById(L, first.id)
    // A fresh one, and the other company's hands on it.
    script = 'proposal'
    const fresh = await read('second.png')
    let elsewhere = ''
    try { await attachReadingTo({ ledgerId: south.ledger.id, readingId: fresh.id, entryId: southEntry.entry.id, actor }); elsewhere = 'attached' }
    catch (e) { elsewhere = said(e) }
    const southFiles = await attachmentsOf(southEntry.entry.id)
    const untouched = await readingById(L, fresh.id)
    const f = new FormData(); f.set(B.ledgerId, south.ledger.id); f.set(B.readingId, fresh.id)
    const theirDiscard = await discardReadingFromForm(f)
    // A mutant that let the other company use it leaves it undeletable; the
    // check below is red either way, and must be reached (block 446).
    try { await discardReading(L, fresh.id) } catch { /* the trigger refused */ }
    check(again.includes('already been entered') && again.includes('in the books twice') && files.length === 1 && otherFiles.length === 0
      && moved.includes('READING_ALREADY_USED') && deleted.includes('READING_ALREADY_USED')
      && still?.used_entry_id === expenseEntry
      && elsewhere.startsWith('NO_READING') && elsewhere.includes('not in these books') && southFiles.length === 0
      && untouched?.used_entry_id === null && !!theirDiscard.error && (await readingById(L, fresh.id)) === null,
      'BR8 a used reading cannot be attached, moved or deleted; a reading is attachable and discardable in its own company only',
      `again: ${again.slice(0, 40)}; moved: ${moved.slice(0, 30)}; deleted: ${deleted.slice(0, 30)}; elsewhere: ${elsewhere.slice(0, 40)}; ${files.length}/${otherFiles.length}/${southFiles.length} files`)
  }

  // ------------------------------------------------------------------- BR9
  // The purchase-bill door, from the form, with the reading's id: the bill is
  // created and posted as always, and the picture is filed against the entry
  // the document raised.
  const billForm = (readingId: string, partyId: string, ref: string, account = ids[NORTH]['5300']) => {
    const f = new FormData()
    f.set(I.ledgerId, L); f.set(I.direction, 'purchase'); f.set(I.kind, 'invoice')
    f.set(I.partyId, partyId); f.set(I.controlAccountId, ids[NORTH]['2100'])
    f.set(I.issuedOn, day('02-03')); f.set(I.dueOn, day('03-05')); f.set(I.theirRef, ref); f.set(I.amounts, 'exclusive')
    f.set(lineAccount(0), account); f.set(lineDescription(0), 'Printer paper')
    f.set(lineAmount(0), '42.99'); f.set(lineTaxCode(0), 'GST_PST')
    f.set(READING_FIELD, readingId)
    return f
  }
  const nameOf = (id: string) => id
  {
    script = 'proposal'
    const reading = await read('bill.png')
    const r = await createInvoiceFromForm(billForm(reading.id, staples.id, '4471-b'), nameOf, actor)
    const [inv] = await db.execute<{ entry_id: string | null; status: string }>(raw`
      SELECT entry_id::text, status FROM invoice WHERE ledger_id = ${L}::uuid AND their_ref = '4471-b'`)
    const files = inv?.entry_id ? await attachmentsOf(inv.entry_id) : []
    const back = await readingById(L, reading.id)
    check(!!r.ok && inv?.status === 'posted' && !!inv.entry_id && files.length === 1 && files[0].sha256 === sha
      && files[0].filename.startsWith(day('02-03')) && files[0].filename.endsWith('.png')
      && files[0].uploaded === 'bill.png' && back?.used_entry_id === inv.entry_id,
      'BR9 the purchase bill posts through its own door and the picture is filed against the entry it raised',
      `${r.ok ?? r.error}; invoice ${inv?.status}; ${files.length} file(s); reading used by ${back?.used_entry_id === inv?.entry_id ? 'that entry' : back?.used_entry_id}`)
  }

  // ------------------------------------------------------------------ BR10
  // A refused posting leaves the reading unused and files nothing: the
  // attachment happens after the posting, never before. Both doors.
  {
    script = 'proposal'
    const reading = await read('refused.png')
    const before = Number((await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM attachment WHERE sha256 = ${sha}`))[0].n)
    const noAccount = await quickEntryFromForm(expenseForm(reading.id, ''), actor)
    const noAccountBill = await createInvoiceFromForm(billForm(reading.id, staples.id, '4471-c', ''), nameOf, actor)
    const after = Number((await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM attachment WHERE sha256 = ${sha}`))[0].n)
    const back = await readingById(L, reading.id)
    check(!!noAccount.error && !noAccount.ok && !!noAccountBill.error && !noAccountBill.ok && after === before
      && back?.used_entry_id === null && back.used_at === null,
      'BR10 a refused posting leaves the reading unused and files nothing, at both doors',
      `${noAccount.error?.slice(0, 40)} / ${noAccountBill.error?.slice(0, 40)}; attachments ${before} → ${after}; used: ${back?.used_entry_id}`)
    try { await discardReading(L, reading.id) } catch { /* a mutant that filed it first leaves it undeletable */ }
  }

  // ------------------------------------------------------------------ BR11
  // The form door: the person's saved service, the file from the form. No
  // service is a sentence; no file is a sentence; a reading comes back with
  // its id, and can be discarded from the form.
  {
    script = 'paid'
    const f = new FormData(); f.set(B.ledgerId, L)
    f.set(B.file, new File([new Uint8Array(PNG)], 'till.png', { type: 'image/png' }))
    const r = await readBillFromForm(f, who)
    const back = r.readingId ? await readingById(L, r.readingId) : null
    const bare = new FormData(); bare.set(B.ledgerId, L)
    const noFile = await readBillFromForm(bare, who)
    const emptyFile = new FormData(); emptyFile.set(B.ledgerId, L); emptyFile.set(B.file, new File([], 'blank.png', { type: 'image/png' }))
    const emptied = await readBillFromForm(emptyFile, who)
    const nobody = await readBillFromForm(f, { id: randomUUID(), email: 'nobody@x.test' })
    const d = new FormData(); d.set(B.ledgerId, L); d.set(B.readingId, r.readingId ?? '')
    const discarded = await discardReadingFromForm(d)
    check(!!r.ok && r.ok.includes('2 lines') && back?.proposal?.suggests === 'expense' && back.proposal.party === 'Tim Hortons'
      && back.read_by === actor && !!noFile.error && noFile.error.includes('Write what happened')
      && (emptied.error ?? '').includes('blank.png is empty')
      && !!nobody.error && nobody.error.includes('Save your service first')
      && !!discarded.ok && (await readingById(L, r.readingId ?? '')) === null,
      'BR11 the form door reads with the saved service; no file and no service are sentences; discard from the form',
      `${r.ok ?? r.error}; ${noFile.error?.slice(0, 30)}; empty file: ${emptied.error?.slice(0, 30)}; ${nobody.error?.slice(0, 30)}; ${discarded.ok ?? discarded.error}`)
  }

  // ------------------------------------------------------------------ BR12
  // The section as the browser gets it, built from REAL rows through the one
  // function the page uses (`readingCards`; critic): for a proposal, two
  // links carrying the reading's id to the two forms — the likelier first; a
  // line without an account said so; a used reading points at its entry and
  // offers no door; an unreadable one shows its error; no service, no
  // upload box; no bytes anywhere.
  {
    const render = (canRead: boolean, readings: unknown[]) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-read-bill.tsx',
      JSON.stringify({ ledgerId: L, canRead, chart: { '5300': `5300 — Office supplies ${NORTH}`, '5400': `5400 — Software ${NORTH}` }, readings }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    script = 'proposal'
    const bill = await read('card-bill.png')
    script = 'paid'
    const paid = await read('card-paid.png')
    script = 'garbage'
    const broken = await read('card-broken.png')
    const cards = readingCards(await readingsFor(L))
    const cardOf = (id: string) => cards.find((c) => c.id === id)
    const usedCardData = cardOf(first.id), brokenCardData = cardOf(broken.id)
    const html = render(true, cards)
    // The cards are newest first; each card's markup runs to the next card's.
    const order = cards.map((c) => c.id)
    const between = (id: string) => {
      const from = html.indexOf(`data-reading="${id}"`)
      const next = order[order.indexOf(id) + 1]
      const to = next ? html.indexOf(`data-reading="${next}"`) : html.length
      return html.slice(from, to)
    }
    const billCard = between(bill.id), paidCard = between(paid.id), usedCard = between(first.id), brokenCard = between(broken.id)
    const expenseHref = (id: string) => `href="/ledger/${L}/entries/quick/expense?reading=${id}"`
    const billHref = (id: string) => `href="/ledger/${L}/bills/new?reading=${id}"`
    const noService = render(false, [])
    check(usedCardData?.usedEntryId === expenseEntry && usedCardData.by === actor && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(usedCardData.when)
      && (brokenCardData?.error ?? '').includes('not with a proposal') && brokenCardData?.proposal === null
      && cards.every((c) => !('bytes' in c) && !('sha256' in c))
      && billCard.includes(expenseHref(bill.id)) && billCard.includes(billHref(bill.id))
      && billCard.indexOf('data-enter="bill"') < billCard.indexOf('data-enter="expense"')
      && paidCard.indexOf('data-enter="expense"') < paidCard.indexOf('data-enter="bill"')
      && billCard.includes(`5300 — Office supplies ${NORTH}`) && (billCard.match(/data-no-account/g) ?? []).length === 1
      && billCard.includes(`/readings/${bill.id}/file`) && billCard.includes('looks like a bill to pay') && paidCard.includes('looks paid')
      && usedCard.includes(`/entries/${expenseEntry}`) && !usedCard.includes('data-enter') && !usedCard.includes('Discard')
      && brokenCard.includes('Could not be read:') && !brokenCard.includes('data-enter')
      && html.includes('type="file"') && !noService.includes('type="file"')
      && noService.includes('Save your AI service in Settings') && noService.includes('Read &amp; add')
      && !html.includes(PNG.toString('base64')),
      'BR12 the page\'s cards, from real rows: both doors with the id, likelier first; a missing account said; used and broken ones offer no door',
      `used card → ${usedCardData?.usedEntryId === expenseEntry ? 'its entry' : usedCardData?.usedEntryId}; bill card: expense link ${billCard.includes(expenseHref(bill.id))}, bill link ${billCard.includes(billHref(bill.id))}; no-account ${(billCard.match(/data-no-account/g) ?? []).length}; used doors ${usedCard.includes('data-enter')}`)

    const chequeProposal = parseProposal(JSON.stringify({ suggests: 'cheque', party: 'Office Store',
      issuedOn: '2026-09-25', currency: 'CAD', total: '35.00',
      lines: [{ description: 'Paper', amount: '35.00', taxCode: '', accountCode: '5300' }],
    }), new Set(['5300']))!
    const chequeCard = render(true, [{ ...cardOf(paid.id)!, id: 'cheque-reading', proposal: chequeProposal }])
    const initial = chequeInitialFrom('cheque-reading', chequeProposal,
      [{ id: ids[NORTH]['5300'], code: '5300', name: 'Office supplies' }], '2026-09-26')
    const taxed = chequeInitialFrom('cheque-reading', { ...chequeProposal, gst: '1.75' },
      [{ id: ids[NORTH]['5300'], code: '5300', name: 'Office supplies' }], '2026-09-26')
    const madeCheque = await createManualCheque({ ledgerId: L, bankAccountId: ids[NORTH]['1000'],
      expenseAccountId: initial.expenseAccountId, chequeDate: initial.chequeDate, payee: initial.payee,
      amount: parseMoney(initial.amount), memo: initial.memo, actor, startingNumber: 1n })
    const postedCheque = await chequeById(L, madeCheque)
    const filedCheque = postedCheque?.entry_id
      ? await attachReadingTo({ ledgerId: L, readingId: paid.id, entryId: postedCheque.entry_id, actor }) : null
    const chequeFiles = postedCheque?.entry_id ? await attachmentsOf(postedCheque.entry_id) : []
    check(chequeCard.includes('looks like a cheque to issue')
      && chequeCard.includes('href="/ledger/' + L + '/cheques/new?reading=cheque-reading"')
      && chequeCard.indexOf('data-enter="cheque"') < chequeCard.indexOf('data-enter="expense"')
      && initial.payee === 'Office Store' && initial.chequeDate === '2026-09-25'
      && initial.amount === '35.00' && initial.expenseAccountId === ids[NORTH]['5300']
      && taxed.amount === '' && !!taxed.warning
      && filedCheque?.filed === true && chequeFiles.length === 1
      && !!(await readingRefusal(L, paid.id)),
      'BR12a AI Add offers a cheque first, fills only safe fields, and files its reading against the posted cheque expense')
    for (const r of [bill, paid, broken]) { try { await discardReading(L, r.id) } catch { /* a mutant may have used it */ } }
  }

  // ------------------------------------------------------------------ BR14
  // The posting worked and the filing did not — the store refused. The entry
  // IS in the books, so the door says so, with why the bill is not on it;
  // an error here would read as "not posted" and invite a second posting.
  {
    script = 'proposal'
    const reading = await read('unfiled.png')
    const store = process.env.ATTACHMENTS_DIR
    process.env.ATTACHMENTS_DIR = path.join(store!, 'not-a-directory')
    await import('node:fs').then((fs) => fs.writeFileSync(process.env.ATTACHMENTS_DIR!, 'a file where the store should be'))
    const r = await quickEntryFromForm(expenseForm(reading.id, ids[NORTH]['5300'], '4471-d'), actor)
    process.env.ATTACHMENTS_DIR = store
    const [entry] = r.entryId ? await db.execute<{ n: string }>(raw`
      SELECT entry_no::text AS n FROM journal_entry WHERE id = ${r.entryId}::uuid`) : []
    const back = await readingById(L, reading.id)
    const files = r.entryId ? await attachmentsOf(r.entryId) : []
    check(!!r.ok && r.ok.startsWith('Posted as') && r.ok.includes('could not be filed') && !r.error && !!entry
      && files.length === 0 && back?.used_entry_id === null,
      'BR14 a posting whose filing failed is reported as posted, with why the bill is not on it',
      `${(r.ok ?? r.error ?? '').slice(0, 90)}; entry ${entry?.n ?? 'none'}; ${files.length} file(s); used: ${back?.used_entry_id}`)
    await discardReading(L, reading.id)
  }

  // ----------------------------------------------------------------- BR14b
  // The same at the bill door: created and posted, the store refused, and
  // the door says so — not "the save failed".
  {
    script = 'proposal'
    const reading = await read('unfiled-bill.png')
    const store = process.env.ATTACHMENTS_DIR
    process.env.ATTACHMENTS_DIR = path.join(store!, 'not-a-directory')
    let r: { ok?: string; error?: string }
    try { r = await createInvoiceFromForm(billForm(reading.id, staples.id, '4471-e'), nameOf, actor) }
    catch (e) { r = { error: `threw: ${causesOf(e)}` } }
    process.env.ATTACHMENTS_DIR = store
    const [inv] = await db.execute<{ entry_id: string | null; status: string }>(raw`
      SELECT entry_id::text, status FROM invoice WHERE ledger_id = ${L}::uuid AND their_ref = '4471-e'`)
    const files = inv?.entry_id ? await attachmentsOf(inv.entry_id) : []
    const back = await readingById(L, reading.id)
    check(!!r.ok && r.ok.startsWith('Saved to the books.') && r.ok.includes('could not be filed') && !r.error
      && inv?.status === 'posted' && files.length === 0 && back?.used_entry_id === null,
      'BR14b at the bill door too: saved and posted, not filed, and the door says which',
      `${(r.ok ?? r.error ?? '').slice(0, 90)}; invoice ${inv?.status ?? 'none'}; ${files.length} file(s); used: ${back?.used_entry_id}`)
    try { await discardReading(L, reading.id) } catch { /* a mutant may have used it */ }
  }

  // ------------------------------------------------------------------ BR15
  // Deleting the entry a bill was filed against — allowed while the month is
  // open, as for any entry — puts the reading back on the page, unused, with
  // its file: the foreign key's SET NULL, which the trigger lets through and
  // completes by clearing used_at. And it can then be entered again.
  {
    let gone = ''
    try { gone = (await deleteEntry(expenseEntry, actor)).entryNo ?? 'deleted' } catch (e) { gone = `refused: ${causesOf(e).replace(/\s+/g, ' ')}` }
    const back = await readingById(L, first.id)
    const card = readingCards(back ? [back] : [])[0]
    const file = await readingFile(L, first.id)
    const again = await quickEntryFromForm(expenseForm(first.id, ids[NORTH]['5300'], '4471-again'), actor)
    const files = again.entryId ? await attachmentsOf(again.entryId) : []
    const after = await readingById(L, first.id)
    check(!gone.startsWith('refused') && back?.used_entry_id === null && back.used_at === null && card?.usedEntryId === null
      && file?.bytes.equals(PNG) === true && !!again.ok && files.length === 1 && after?.used_entry_id === again.entryId,
      'BR15 deleting the entry puts the reading back on the page, unused and with its file, and it can be entered again',
      `delete: ${gone.slice(0, 60)}; used after delete: ${back?.used_entry_id}/${back?.used_at}; re-entered: ${again.ok?.slice(0, 30) ?? again.error}`)
    expenseEntry = again.entryId || expenseEntry
  }

  // ------------------------------------------------------------------ BR16
  // One reading, one entry — decided BEFORE the posting, at both doors: a
  // second form carrying a used reading is refused with nothing in the books;
  // so is a form carrying another company's reading.
  {
    script = 'proposal'
    const reading = await read('twice.png')
    const count = async () => Number((await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry WHERE ledger_id = ${L}::uuid`))[0].n)
    const before = await count()
    const one = await quickEntryFromForm(expenseForm(reading.id, ids[NORTH]['5300'], '4471-f'), actor)
    const two = await quickEntryFromForm(expenseForm(reading.id, ids[NORTH]['5300'], '4471-g'), actor)
    let three: { ok?: string; error?: string }
    try { three = await createInvoiceFromForm(billForm(reading.id, staples.id, '4471-h'), nameOf, actor) }
    catch (e) { three = { error: `threw: ${causesOf(e)}` } }
    const theirs = await readBill({ ledgerId: south.ledger.id, filename: 'south.png', mime: 'image/png', bytes: PNG, ...mine })
    const four = await quickEntryFromForm(expenseForm(theirs.id, ids[NORTH]['5300'], '4471-i'), actor)
    const after = await count()
    const [h] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM invoice WHERE ledger_id = ${L}::uuid AND their_ref = '4471-h'`)
    const why = await readingRefusal(L, reading.id)
    check(!!one.ok && !!two.error && two.error.includes('already been entered') && !two.entryId
      && !!three.error && three.error.includes('already been entered') && Number(h.n) === 0
      && !!four.error && four.error.includes('not in these books') && after === before + 1
      && (why ?? '').includes('already been entered') && (await readingRefusal(L, theirs.id)) !== null,
      'BR16 one reading, one entry: a used or foreign reading refuses the form before anything posts, at both doors',
      `${one.ok?.slice(0, 20)}; second: ${two.error?.slice(0, 40)}; bill: ${three.error?.slice(0, 40)}; foreign: ${four.error?.slice(0, 30)}; entries ${before} → ${after}`)
    try { await discardReading(south.ledger.id, theirs.id) } catch { /* a mutant may have used it */ }
  }

  // ------------------------------------------------------------------ BR18
  // THE ACCOUNT, which is the one box that never filled (owner, 2026-09-07:
  // 「ai能读到file了，但是不能自动填表单」). Three answers, in order:
  //
  //   the model's code, when this chart has it
  //   else WHERE THIS SUPPLIER'S MONEY WENT LAST TIME, from the books
  //   else blank, and the door refuses until a person picks
  //
  // And what the model suggested survives even when the chart cannot honour
  // it, so a person can see the difference between a silent model and a
  // mismatched one.
  {
    // Last month's Fido bill, posted to 5400 with the supplier on the line.
    const fido = await createParty({
      kind: 'organisation', name: 'Fido', actor: 'alicio@example.test',
      roles: [{ entityId: north.company.id, role: 'supplier', heldFrom: day('01-01') }],
    })
    await postEntry({
      ledgerId: L, entryDate: day('07-31'), description: 'Fido', actor: 'alicio@example.test',
      lines: [
        { accountId: ids[NORTH]['5400'], amount: 3300n, partyId: fido.id },
        { accountId: ids[NORTH]['1000'], amount: -3300n },
      ],
    })
    const remembered = await rememberedAccount(L, 'Fido 3213775599', 'expense')
    const stranger = await rememberedAccount(L, 'Somebody Never Seen', 'expense')

    // A proposal shaped like the one the owner's own bill produced: a good
    // line, no account code at all.
    const codes = new Set(['5300', '5400'])
    const blank = parseProposal(JSON.stringify({
      suggests: 'bill', party: 'Fido', documentRef: '3213775599',
      lines: [{ description: 'Mobile service', amount: '33.00', taxCode: 'GST_PST', accountCode: '' }],
    }), codes)!
    // And one naming a code this chart has not.
    const elsewhere = parseProposal(JSON.stringify({
      suggests: 'bill', party: 'Fido',
      lines: [{ description: 'Mobile service', amount: '33.00', taxCode: '', accountCode: '6200' }],
    }), codes)!

    const withMemory = quickInitialFrom('expense', 'r', blank, plAccounts, day('09-07'), remembered)
    const without = quickInitialFrom('expense', 'r', blank, plAccounts, day('09-07'), null)
    const billWithMemory = invoiceInitialFrom('purchase', 'r', blank, plAccounts, day('09-07'), [], ids[NORTH]['2100'], remembered)

    // A REVERSAL carries the same account and the same party as the entry it
    // cancels, so without the guard the newest entry naming this supplier is
    // the very account somebody corrected away (critic, 2026-09-07).
    const wrong = await postEntry({
      ledgerId: L, entryDate: day('08-01'), description: 'Fido', actor: 'alicio@example.test',
      lines: [
        { accountId: ids[NORTH]['5300'], amount: 3300n, partyId: fido.id },
        { accountId: ids[NORTH]['1000'], amount: -3300n },
      ],
    })
    await reverseEntry(wrong.entry.id, day('08-02'), 'wrong account', 'alicio@example.test')
    const afterCorrection = await rememberedAccount(L, 'Fido', 'expense')

    // "Staples" and "Taple" are the same payee only if the normalisation is
    // deleting the letter S instead of collapsing spaces — which is what a
    // `\s` inside a tagged template does, because the escape never reaches
    // Postgres (critic). One spelling now, shared with the bank feed.
    await postEntry({
      ledgerId: L, entryDate: day('08-10'), description: 'Staples', actor: 'alicio@example.test',
      lines: [
        { accountId: ids[NORTH]['5300'], amount: 1000n },
        { accountId: ids[NORTH]['1000'], amount: -1000n },
      ],
    })
    const sLetters = await rememberedAccount(L, 'Taple', 'expense')
    const spaced = await rememberedAccount(L, 'Staples', 'expense')

    // And an account this form does not OFFER is not used. A box handed a
    // value matching no option holds neither the memory nor the blank, and
    // looks like something a person chose (critic).
    //
    // ANOTHER COMPANY'S account. It used to be a revenue account, on the
    // grounds that a quick-expense form offered only expense ones — that
    // stopped being true on 2026-09-07, when the form began offering the
    // whole chart so a laptop could be entered on it. This is the case that
    // does not depend on which types a form is willing to show: an account
    // belonging to somebody else's books is offered by nothing, ever.
    const notOffered = ids[SOUTH]['5300']
    const revenueOnly = quickInitialFrom('expense', 'r', blank, plAccounts, day('09-07'), notOffered)

    check(remembered === ids[NORTH]['5400'] && stranger === null
      && afterCorrection === ids[NORTH]['5400'] && sLetters === null && spaced === ids[NORTH]['5300']
      && !!notOffered && !plAccounts.some((a) => a.id === notOffered)
      && revenueOnly.rows[0].accountId === '' && revenueOnly.rows[0].fromMemory === false
      && withMemory.rows[0].fromMemory === true && without.rows[0].fromMemory === false
      && blank.lines[0].accountCode === null && blank.lines[0].suggestedCode === null
      && elsewhere.lines[0].accountCode === null && elsewhere.lines[0].suggestedCode === '6200'
      && withMemory.rows[0].accountId === ids[NORTH]['5400']
      && billWithMemory.rows[0].accountId === ids[NORTH]['5400']
      && without.rows[0].accountId === '',
      'BR18 an account the model could not place is filled from where this supplier went last time, and its own suggestion is kept',
      `remembered ${remembered === ids[NORTH]['5400'] ? '5400' : remembered}; a stranger → ${stranger}; `
      + `after a correction still ${afterCorrection === ids[NORTH]['5400'] ? '5400' : afterCorrection}; `
      + `"Taple" is not "Staples": ${sLetters === null}; an account the form does not offer → `
      + `${revenueOnly.rows[0].accountId === '' ? 'blank' : 'USED ANYWAY'}; `
      + `the model's unmatched 6200 kept as ${elsewhere.lines[0].suggestedCode}; `
      + `without a memory the box stays blank: ${without.rows[0].accountId === ''}`)
  }

  // ----------------------------------------------------------------- BR18b
  // THE REFUSAL, which is what makes filling a box from the books safe. A
  // line with an amount and no account is refused at the door, whatever the
  // form opened with — the doc calls this refusal the review, and until now
  // it cited checks that only read opening values (critic, 2026-09-07).
  {
    const f = new FormData()
    f.set(Q.ledgerId, L); f.set(Q.kind, 'expense'); f.set(Q.entryDate, day('09-20'))
    f.set(Q.description, 'No account picked'); f.set(Q.bankAccountId, bank)
    f.set(lineAccount(0), ''); f.set(lineAmount(0), '33.00')
    const refused = await quickEntryFromForm(f, actor)
    const before = Number((await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry WHERE ledger_id = ${L}::uuid`))[0].n)
    check(!!refused.error && refused.error.includes('no account') && !refused.entryId,
      'BR18b a line with an amount and no account is refused at the door — the review the memory does not replace',
      `${refused.error ?? 'allowed'}; ${before} entr(ies) stand`)
  }

  // ----------------------------------------------------------------- BR18c
  // THE DIRECTION of a remembered account. Every form offers the whole chart,
  // so what a form offers cannot keep a sale off an expense account: a party
  // who is both a customer and a supplier would have its last purchase
  // remembered onto an invoice to it (critic, 2026-09-15). The lookup asks for
  // the type, and the newest entry is the purchase, so the sale must be found
  // past it.
  {
    const both = await createParty({
      kind: 'organisation', name: 'Harbour Two Ways', actor: 'alicio@example.test',
      roles: [{ entityId: north.company.id, role: 'supplier', heldFrom: day('01-01') },
              { entityId: north.company.id, role: 'customer', heldFrom: day('01-01') }],
    })
    await postEntry({
      ledgerId: L, entryDate: day('08-20'), description: 'Harbour Two Ways', actor: 'alicio@example.test',
      lines: [{ accountId: ids[NORTH]['4000'], amount: -5000n, partyId: both.id }, { accountId: ids[NORTH]['1000'], amount: 5000n }],
    })
    await postEntry({
      ledgerId: L, entryDate: day('08-21'), description: 'Harbour Two Ways', actor: 'alicio@example.test',
      lines: [{ accountId: ids[NORTH]['5300'], amount: 2000n, partyId: both.id }, { accountId: ids[NORTH]['1000'], amount: -2000n }],
    })
    const asExpense = await rememberedAccount(L, 'Harbour Two Ways', 'expense')
    const asRevenue = await rememberedAccount(L, 'Harbour Two Ways', 'revenue')
    const name = (id: string | null) => Object.entries(ids[NORTH]).find(([, v]) => v === id)?.[0] ?? String(id)
    check(asExpense === ids[NORTH]['5300'] && asRevenue === ids[NORTH]['4000'],
      'BR18c a remembered account is of the direction asked for: a party on both sides gives its purchase to money out and its sale to money in',
      `money out → ${name(asExpense)}; money in → ${name(asRevenue)}`)
  }

  // ------------------------------------------------------------------ BR20
  // A SENTENCE ALONE (0077): no document, and it is read all the same. What
  // leaves is the sentence and today's date beside the chart, and no file
  // part; the row keeps the sentence and no file. Nothing, a blank, a sentence
  // too long and half a document are refused before anything leaves. The
  // longest input there is still reads — the question has a cap of its own in
  // `ask`, and a reading must not trip it after its own checks passed. And the
  // form: a file box left empty still arrives, as an unnamed file of no bytes,
  // which is no file.
  {
    script = 'sentence'
    const sentence = 'Received $1,200 from Beta Services for August consulting today.'
    let reached = 0
    const sentinel = async (): Promise<Reply> => { reached++; throw new Error('the sentinel sender was reached') }
    const refusal = async (input: { sentence?: string; filename?: string }) => {
      try { await readBill({ ledgerId: L, ...input, ...mine }, sentinel); return 'read' } catch (e) { return said(e) }
    }
    const count = async () => Number((await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM ai_bill_reading WHERE ledger_id = ${L}::uuid`))[0].n)
    const before = await count()
    const nothing = await refusal({})
    const blank = await refusal({ sentence: '   ' })
    const long = await refusal({ sentence: 'x'.repeat(SENTENCE_MAX + 1) })
    const half = await refusal({ sentence, filename: 'half.png' })
    const afterRefusals = await count()
    // Caught: a mutant that makes the row unwritable throws here, and a throw
    // must redden this line, not end the suite (block 809, 2026-09-15).
    let reading: Awaited<ReturnType<typeof readBill>> | null = null
    let readSaid = ''
    try { reading = await readBill({ ledgerId: L, sentence: `  ${sentence}  `, ...mine }) } catch (e) { readSaid = said(e) }
    const sent = seen[seen.length - 1]
    const user = sent.body.messages[1].content
    const system = String(sent.body.messages[0].content)
    const [row] = reading ? await db.execute<{ sentence: string | null; filename: string | null; mime: string | null; no_bytes: boolean; sha256: string | null }>(raw`
      SELECT sentence, filename, mime, bytes IS NULL AS no_bytes, sha256 FROM ai_bill_reading WHERE id = ${reading.id}::uuid`) : []
    let file: unknown = 'not asked'
    if (reading) { try { file = await readingFile(L, reading.id) } catch (e) { file = `threw: ${said(e)}` } }
    const card = reading ? readingCards([reading])[0] : undefined
    let longest = ''
    try {
      const r = await readBill({
        ledgerId: L, sentence: 'y'.repeat(SENTENCE_MAX), filename: `${'n'.repeat(1000)}.png`, mime: 'image/png', bytes: PNG, ...mine,
      })
      longest = r.error ?? 'read'
    } catch (e) { longest = said(e) }
    // A line break is one character in the box and two on the wire; the cap counts it as the box did.
    let crlf = ''
    try {
      const r = await readBill({ ledgerId: L, sentence: `${'a'.repeat(998)}\r\n\r\n\r\n${'b'.repeat(998)}`, ...mine })
      crlf = r.error ?? 'read'
      try { await discardReading(L, r.id) } catch { /* nothing uses it */ }
    } catch (e) { crlf = said(e) }
    const f = new FormData(); f.set(B.ledgerId, L); f.set(B.sentence, sentence); f.set(B.file, new File([], ''))
    const viaForm = await readBillFromForm(f, who)
    const formRow = viaForm.readingId ? await readingById(L, viaForm.readingId) : null
    const today = localToday()
    check(nothing.startsWith('EMPTY') && blank.startsWith('EMPTY') && long.startsWith('TOO_LONG') && half.startsWith('EMPTY')
          && reached === 0 && afterRefusals === before
          && typeof user === 'string' && user.includes(`The person wrote:\n${sentence}`) && !user.includes('(The file is')
          && system.includes(`Today: ${today}.`)
          && row?.sentence === sentence && row.filename === null && row.mime === null && row.no_bytes && row.sha256 === null
          && !!reading && reading.proposal?.party === 'Beta Services' && file === null && card?.sentence === sentence && card.filename === null
          && longest === 'read' && crlf === 'read'
          && viaForm.ok?.startsWith('Your sentence read') === true && formRow?.sentence === sentence && formRow.filename === null,
      'BR20 a sentence alone is read with today\'s date and no file and kept without one; nothing, a blank, too long and half a document are refused first; the longest input reads; an empty file box is no file',
      `${readSaid ? `the sentence was refused: ${readSaid.slice(0, 60)}; ` : ''}`
      + `refusals ${nothing.slice(0, 5)}/${blank.slice(0, 5)}/${long.slice(0, 8)}/${half.slice(0, 5)}, sender reached ${reached}, rows ${before} → ${afterRefusals}; `
      + `user ${typeof user === 'string' ? 'text' : 'parts'}, date sent ${system.includes(`Today: ${today}.`)}; `
      + `row sentence ${row?.sentence === sentence}, file columns ${row?.filename}/${row?.mime}/${row?.no_bytes}/${row?.sha256}; `
      + `file ${file === null ? 'none' : String(file).slice(0, 30)}; card sentence ${card?.sentence === sentence}; `
      + `longest → ${longest.slice(0, 50)}; line breaks → ${crlf.slice(0, 40)}; form → ${viaForm.ok ?? viaForm.error}`)
    for (const id of [reading?.id, formRow?.id]) { if (id) { try { await discardReading(L, id) } catch { /* a mutant may have used it */ } } }
    await db.execute(raw`
      DELETE FROM ai_bill_reading WHERE ledger_id = ${L}::uuid AND sentence = ${'y'.repeat(SENTENCE_MAX)} AND used_entry_id IS NULL`)
  }

  // ------------------------------------------------------------------ BR21
  // A SENTENCE AND A DOCUMENT: both leave in the one question, both are kept.
  {
    script = 'proposal'
    let both: Awaited<ReturnType<typeof readBill>> | null = null
    let bothSaid = ''
    try {
      both = await readBill({
        ledgerId: L, sentence: 'Staples again, paid by card', filename: 'both.png', mime: 'image/png', bytes: PNG, ...mine,
      })
    } catch (e) { bothSaid = said(e) }
    const sent = seen[seen.length - 1]
    const parts = sent.body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    const text = Array.isArray(parts) ? parts.find((p) => p.type === 'text')?.text ?? '' : ''
    const [row] = both ? await db.execute<{ sentence: string | null; filename: string | null; sha256: string | null }>(raw`
      SELECT sentence, filename, sha256 FROM ai_bill_reading WHERE id = ${both.id}::uuid`) : []
    check(Array.isArray(parts) && parts.some((p) => p.type === 'image_url') && text.includes('(The file is both.png.)')
          && text.includes('The person wrote:\nStaples again, paid by card')
          && row?.sentence === 'Staples again, paid by card' && row.filename === 'both.png' && row.sha256 === sha
          && !!both && both.proposal !== null,
      'BR21 a sentence and a document leave together in one question and are kept together',
      `${bothSaid ? `refused: ${bothSaid.slice(0, 60)}; ` : ''}${Array.isArray(parts) ? parts.map((p) => p.type).join('+') : typeof parts}; file named ${text.includes('(The file is both.png.)')}, `
      + `sentence ${text.includes('The person wrote:')}; row ${row?.filename} / ${row?.sentence}`)
    if (both) { try { await discardReading(L, both.id) } catch { /* a mutant may have used it */ } }
  }

  // ------------------------------------------------------------------ BR22
  // THE TABLE says it too (0077): the four file columns together or not at
  // all; a file or a sentence, at least one; no blank sentence; and the
  // sentence behind an entered reading does not change, as its file does not.
  {
    const attempt = async (q: SQL) => {
      try { await byHand((tx) => tx.execute(q)); return 'written' } catch (e) { return causesOf(e).replace(/\s+/g, ' ') }
    }
    const half = await attempt(raw`
      INSERT INTO ai_bill_reading (ledger_id, read_by, filename, sentence) VALUES (${L}::uuid, ${actor}, 'half.png', 'half a file')`)
    const nothing = await attempt(raw`INSERT INTO ai_bill_reading (ledger_id, read_by) VALUES (${L}::uuid, ${actor})`)
    const blank = await attempt(raw`INSERT INTO ai_bill_reading (ledger_id, read_by, sentence) VALUES (${L}::uuid, ${actor}, '   ')`)
    // Newlines and a tab are blank too: the library trims them, and the table must be as strict.
    const newlines = await attempt(raw`INSERT INTO ai_bill_reading (ledger_id, read_by, sentence) VALUES (${L}::uuid, ${actor}, ${'\n\t\n'})`)
    const [kept] = await db.execute<{ id: string }>(raw`
      INSERT INTO ai_bill_reading (ledger_id, read_by, sentence) VALUES (${L}::uuid, ${actor}, 'Paid the harbour dues')
      RETURNING id::text`)
    const entry = await postEntry({
      ledgerId: L, entryDate: day('09-01'), description: 'Harbour dues', actor,
      lines: [{ accountId: ids[NORTH]['5300'], amount: 700n }, { accountId: ids[NORTH]['1000'], amount: -700n }],
    })
    let attached = 'attached'
    try { await attachReadingTo({ ledgerId: L, readingId: kept.id, entryId: entry.entry.id, actor }) } catch (e) { attached = said(e) }
    const changed = await attempt(raw`UPDATE ai_bill_reading SET sentence = 'Paid something else' WHERE id = ${kept.id}::uuid`)
    const [still] = await db.execute<{ sentence: string | null }>(raw`SELECT sentence FROM ai_bill_reading WHERE id = ${kept.id}::uuid`)
    check(half.includes('ai_bill_reading_file_whole') && nothing.includes('ai_bill_reading_something')
          && blank.includes('ai_bill_reading_sentence_said') && newlines.includes('ai_bill_reading_sentence_said')
          && changed.includes('READING_ALREADY_USED')
          && still?.sentence === 'Paid the harbour dues' && attached === 'attached',
      'BR22 the table refuses half a file, a reading of nothing and a blank sentence, and keeps an entered reading\'s sentence',
      `half: ${half.slice(0, 70)}; nothing: ${nothing.slice(0, 70)}; blank: ${blank.slice(0, 70)}; newlines: ${newlines.slice(0, 40)}; entering it: ${attached.slice(0, 50)}; changed: ${changed.slice(0, 50)}`)
  }

  // ------------------------------------------------------------------ BR23
  // THE PROPOSAL'S WORDS: `party` for the other side, four directions, and a
  // model answering in the old words (`supplier`) understood. A proposal stored
  // before 2026-09-15 says `supplier` and is never rewritten: it reads as
  // `party` through both readers, and a direction nobody knows reads as expense.
  {
    const codes = new Set(['5300'])
    const kinds = ['expense', 'bill', 'income', 'sale']
      .map((k) => parseProposal(JSON.stringify({ suggests: k, party: 'Acme', lines: [] }), codes))
    const oldWords = parseProposal(JSON.stringify({ suggests: 'bill', supplier: 'Old Words Ltd.', lines: [] }), codes)
    const odd = parseProposal(JSON.stringify({ suggests: 'refund', party: 'Acme', lines: [] }), codes)
    const stored = {
      suggests: 'bill', supplier: 'Stored Before Ltd.', documentRef: '77', issuedOn: null, dueOn: null, currency: 'CAD',
      lines: [], subtotal: null, gst: null, pst: null, total: null, notes: '',
    }
    const [old] = await db.execute<{ id: string }>(raw`
      INSERT INTO ai_bill_reading (ledger_id, read_by, filename, mime, bytes, sha256, proposal)
      VALUES (${L}::uuid, ${actor}, 'stored.png', 'image/png', ${PNG}, ${sha}, ${JSON.stringify(stored)}::jsonb)
      RETURNING id::text`)
    const byId = await readingById(L, old.id)
    const listed = (await readingsFor(L, 1000)).find((x) => x.id === old.id)
    const weird = proposalOf({ ...stored, suggests: 'refund' })
    check(kinds.map((p) => p?.suggests).join(',') === 'expense,bill,income,sale' && kinds.every((p) => p?.party === 'Acme')
          // 'refund' is not one of the five, and since 2026-09-16 that is
          // `other` rather than `expense` — an answer nobody gave must not be
          // dressed as one the model gave (B32).
          && oldWords?.party === 'Old Words Ltd.' && odd?.suggests === 'other'
          && byId?.proposal?.party === 'Stored Before Ltd.' && !('supplier' in (byId?.proposal ?? {}))
          && listed?.proposal?.party === 'Stored Before Ltd.'
          && weird?.suggests === 'other' && weird.party === 'Stored Before Ltd.',
      'BR23 a proposal names the other side as party, in four directions; a model\'s old words and a proposal stored in them read as party',
      `directions ${kinds.map((p) => p?.suggests).join(',')}; old answer → ${oldWords?.party}; unknown → ${odd?.suggests}; `
      + `stored → ${byId?.proposal?.party} / listed ${listed?.proposal?.party}; supplier left on it ${'supplier' in (byId?.proposal ?? {})}`)
    try { await discardReading(L, old.id) } catch { /* nothing uses it */ }
  }

  // ------------------------------------------------------------------ BR26
  // A READING FROM A SENTENCE ALONE, entered through the expense door and the
  // bill door as any reading is: nothing to file, the reading closed, and the
  // door's sentence does not claim a file that never existed.
  {
    script = 'sentence'
    const sentenceReading = async (words: string) => {
      try { return await readBill({ ledgerId: L, sentence: words, ...mine }) } catch (e) { return said(e) }
    }
    const one = await sentenceReading('Paid Staples 42.99 for printer paper by card')
    const two = await sentenceReading('Staples billed us 42.99 for printer paper, due next month')
    const expense = typeof one === 'string' ? { error: `not read: ${one}` } as { ok?: string; error?: string; entryId?: string }
      : await quickEntryFromForm(expenseForm(one.id, ids[NORTH]['5300'], 'S-1'), actor)
    let bill: { ok?: string; error?: string }
    if (typeof two === 'string') bill = { error: `not read: ${two}` }
    else {
      try { bill = await createInvoiceFromForm(billForm(two.id, staples.id, 'S-2'), nameOf, actor) }
      catch (e) { bill = { error: `threw: ${causesOf(e)}` } }
    }
    const [inv] = await db.execute<{ entry_id: string | null }>(raw`
      SELECT entry_id::text FROM invoice WHERE ledger_id = ${L}::uuid AND their_ref = 'S-2'`)
    const oneBack = typeof one === 'string' ? null : await readingById(L, one.id)
    const twoBack = typeof two === 'string' ? null : await readingById(L, two.id)
    const oneFiles = expense.entryId ? await attachmentsOf(expense.entryId) : []
    const twoFiles = inv?.entry_id ? await attachmentsOf(inv.entry_id) : []
    check(!!expense.ok && expense.ok.includes('marked entered') && !expense.ok.includes('filed against')
          && !!bill.ok && bill.ok.includes('marked entered') && !bill.ok.includes('filed against')
          && oneFiles.length === 0 && twoFiles.length === 0
          && !!expense.entryId && oneBack?.used_entry_id === expense.entryId
          && !!inv?.entry_id && twoBack?.used_entry_id === inv.entry_id,
      'BR26 a reading from a sentence alone is entered at both doors with nothing filed, closed, and not said to be filed',
      `expense: ${(expense.ok ?? expense.error ?? '').slice(0, 70)}; bill: ${(bill.ok ?? bill.error ?? '').slice(0, 70)}; `
      + `files ${oneFiles.length}/${twoFiles.length}; closed ${oneBack?.used_entry_id === expense.entryId}/${twoBack?.used_entry_id === inv?.entry_id}`)
  }

  // ------------------------------------------------------------------ BR24
  // MONEY IN, on the quick form. The instruction names the four directions and
  // says the party may be a customer; a reading of income opens the income form
  // on its party, its date and its lines, the account by code; a line the model
  // could not place is filled from a revenue account — BR18c's party on both
  // sides has its purchase newer than its sale — and the page asks for that
  // type (read from its source, which is all a check can say of a page body).
  {
    script = 'sentence'
    let readSaid = ''
    let reading: Awaited<ReturnType<typeof readBill>> | null = null
    try { reading = await readBill({ ledgerId: L, sentence: 'Received 1,200 from Beta Services for August consulting.', ...mine }) }
    catch (e) { readSaid = said(e) }
    const sent = seen[seen.length - 1]
    const question = typeof sent.body.messages[1].content === 'string' ? sent.body.messages[1].content : ''
    const incomeAccounts = (await quickAccountsFor(L, 'income')).plAccounts
    const opened = reading?.proposal ? quickInitialFrom('income', reading.id, reading.proposal, incomeAccounts, day('09-06')) : null
    const codes = new Set(Object.keys(ids[NORTH]))
    const unplaced = parseProposal(JSON.stringify({
      suggests: 'income', party: 'Harbour Two Ways', lines: [{ description: 'Moorage', amount: '50.00', taxCode: '', accountCode: '' }],
    }), codes)!
    const remembered = await rememberedAccount(L, 'Harbour Two Ways', 'revenue', incomeAccounts.map((a) => a.id))
    const fromMemory = quickInitialFrom('income', 'r', unplaced, incomeAccounts, day('09-06'), remembered)
    const unnamed = quickInitialFrom('income', 'r', { ...unplaced, party: '' }, incomeAccounts, day('09-06'))
    const partied = reading?.proposal
      ? quickInitialFrom('income', reading.id, reading.proposal, incomeAccounts, day('09-06'), null,
                         [{ id: 'hardware', label: 'Beta Hardware' }, { id: 'beta', label: 'Beta Services Ltd.' }])
      : null
    const saleAsIncome = quickInitialFrom('income', 'r', { ...unplaced, suggests: 'sale', documentRef: 'INV-9' }, incomeAccounts, day('09-06'))
    const billAsExpense = quickInitialFrom('expense', 'r', { ...unplaced, suggests: 'bill', documentRef: 'B-1' }, incomeAccounts, day('09-06'))
    const quickBody = readFileSync('src/app/ledger/[ledgerId]/entries/quick/[kind]/QuickBody.tsx', 'utf8')
    const code = (id: string | undefined) => Object.entries(ids[NORTH]).find(([, v]) => v === id)?.[0] ?? (id || 'blank')
    // EVERY DESTINATION THE APP HAS IS ONE THE MODEL IS OFFERED.
    //
    // This used to assert the four money ones by their sentences, which is
    // what it meant to be hardcoded (owner, 2026-09-16: 「我希望 ai 理解整个
    // app 自己选择正确的处理方式」). The prompt is generated from
    // src/lib/destinations.ts now, so the claim worth holding is that the
    // menu and the doors are the SAME list — add a destination and this fails
    // until the model can choose it.
    const offered = DESTINATION_KEYS.filter((k) => question.includes(`"${k}"`))
    check(offered.length === DESTINATION_KEYS.length
          && question.includes('the supplier or the customer')
          && opened?.description === 'Beta Services' && opened.entryDate === day('09-06')
          && opened.rows[0]?.accountId === ids[NORTH]['4000'] && opened.rows[0].amount === '1200.00'
          && fromMemory.rows[0]?.accountId === ids[NORTH]['4000'] && fromMemory.rows[0].fromMemory === true
          && unnamed.description === 'Income' && partied?.partyId === 'beta'
          && saleAsIncome.documentRef === '' && billAsExpense.documentRef === 'B-1'
          && quickBody.includes("expense ? 'expense' : 'revenue'") && quickBody.includes('expense ? parties.suppliers : parties.customers'),
      'BR24 the instruction offers every destination the app has; income opens the income form, a line it could not place is filled from a revenue account, and the page asks for that type',
      `${readSaid ? `refused: ${readSaid.slice(0, 50)}; ` : ''}destinations offered ${offered.length}/${DESTINATION_KEYS.length}; `
      + `opened ${opened?.description} on ${code(opened?.rows[0]?.accountId)}; remembered ${code(fromMemory.rows[0]?.accountId)}; `
      + `unnamed → ${unnamed.description}; party ${partied?.partyId || 'blank'}; a sale's number as income → ${saleAsIncome.documentRef || '∅'}, a bill's → ${billAsExpense.documentRef}; `
      + `the page asks by kind ${quickBody.includes("expense ? 'expense' : 'revenue'")} and offers its own parties ${quickBody.includes('expense ? parties.suppliers : parties.customers')}`)
    if (reading) { try { await discardReading(L, reading.id) } catch { /* nothing uses it */ } }
  }

  // ------------------------------------------------------------------ BR25
  // A SALES INVOICE from a reading: the customer matched by the same rule as a
  // supplier, the receivable account, the dates, the document's number as OURS
  // — a bill's goes to theirs — a stranger named rather than guessed, and the
  // page asking for the revenue type (source).
  {
    const acme = await createParty({
      kind: 'organisation', name: 'Acme Consulting Clients Inc', actor: 'alicio@example.test',
      roles: [{ entityId: north.company.id, role: 'customer', heldFrom: day('01-01') }],
    })
    const codes = new Set(Object.keys(ids[NORTH]))
    const sale = parseProposal(JSON.stringify({
      suggests: 'sale', party: 'ACME CONSULTING CLIENTS, INC.', documentRef: 'INV-042', issuedOn: day('09-01'), dueOn: day('10-01'),
      lines: [{ description: 'September consulting', amount: '2000.00', taxCode: '', accountCode: '4000' }],
    }), codes)!
    const customers = [{ id: acme.id, label: 'Acme Consulting Clients Inc' }, { id: randomUUID(), label: 'Acme Hardware' }]
    const receivable = ids[NORTH]['1100']
    const opened = invoiceInitialFrom('sales', 'r', sale, plAccounts, day('09-06'), customers, receivable)
    const stranger = invoiceInitialFrom('sales', 'r', { ...sale, party: 'Nobody Known Ltd' }, plAccounts, day('09-06'), customers, receivable)
    const asBill = invoiceInitialFrom('purchase', 'r', sale, plAccounts, day('09-06'), [], ids[NORTH]['2100'])
    const invoiceBody = readFileSync('src/app/ledger/[ledgerId]/invoices/new/NewInvoiceBody.tsx', 'utf8')
    const sides = [invoiceSideFor('sales'), invoiceSideFor('purchase'), invoiceSideFor(undefined), invoiceSideFor('SALES')]
      .map((x) => `${x.key}/${x.rememberedType}/${x.role}`).join(',')
    const unplacedSale = parseProposal(JSON.stringify({
      suggests: 'sale', party: 'ACME CONSULTING CLIENTS, INC.',
      lines: [{ description: 'Workshop', amount: '100.00', taxCode: '', accountCode: '4000' },
              { description: 'Travel', amount: '50.00', taxCode: '', accountCode: '' }],
    }), codes)!
    const withMemory = invoiceInitialFrom('sales', 'r', unplacedSale, plAccounts, day('09-06'), customers, receivable, ids[NORTH]['4000'])
    // What the page body does with those, read from its source — all a check can say of a server page.
    const bodyUses = ['reading.proposal.party, side.rememberedType,', "data.parties[side.key], data.controlAccounts[side.key][0]?.id ?? ''",
                      '{start && rememberedLines(start.rows).length > 0 && (', 'invoiceSideFor(copy?.invoice.direction ?? direction)']
    check(opened.direction === 'sales' && opened.header.partyId === acme.id && opened.unknownParty === null
          && opened.header.controlAccountId === receivable && opened.header.issuedOn === day('09-01') && opened.header.dueOn === day('10-01')
          && opened.header.number === 'INV-042' && opened.header.theirRef === ''
          && opened.rows[0]?.accountId === ids[NORTH]['4000']
          && stranger.header.partyId === '' && stranger.unknownParty === 'Nobody Known Ltd'
          && asBill.direction === 'purchase' && asBill.header.theirRef === 'INV-042' && asBill.header.number === ''
          && sides === 'sales/revenue/customer,purchase/expense/supplier,purchase/expense/supplier,purchase/expense/supplier'
          && rememberedLines(withMemory.rows).join(',') === '2'
          && bodyUses.every((u) => invoiceBody.includes(u)),
      'BR25 a sales invoice opens on the customer by name, the receivable account and the document\'s number as ours; a bill keeps it as theirs',
      `customer ${opened.header.partyId === acme.id ? 'matched' : opened.header.partyId || 'blank'}; number ${opened.header.number || '∅'} / theirs ${opened.header.theirRef || '∅'}; `
      + `stranger → ${stranger.unknownParty}; as a bill → theirs ${asBill.header.theirRef || '∅'}, ours ${asBill.header.number || '∅'}; `
      + `sides ${sides}; remembered lines ${rememberedLines(withMemory.rows).join(',') || 'none'}; the page body uses ${bodyUses.filter((u) => invoiceBody.includes(u)).length} of ${bodyUses.length}`)
  }

  // ----------------------------------------------------------------- BR26b
  // A READING FROM A SENTENCE ALONE, as money coming in: through the income
  // door and the sales-invoice door, nothing filed, the reading closed, and
  // neither door claiming a file.
  {
    script = 'sentence'
    const [{ id: acmeId }] = await db.execute<{ id: string }>(raw`
      SELECT id::text FROM party WHERE name = 'Acme Consulting Clients Inc'`)
    const sentenceReading = async (words: string) => {
      try { return await readBill({ ledgerId: L, sentence: words, ...mine }) } catch (e) { return said(e) }
    }
    const one = await sentenceReading('Received 1,200 from Beta Services for August consulting')
    const two = await sentenceReading('Invoiced Acme 2,000 for September consulting, INV-043')
    const incomeForm = (readingId: string) => {
      const f = new FormData()
      f.set(Q.ledgerId, L); f.set(Q.kind, 'income'); f.set(Q.entryDate, day('09-02'))
      f.set(Q.description, 'Beta Services'); f.set(Q.bankAccountId, bank); f.set(Q.amounts, 'exclusive')
      f.set(lineAccount(0), ids[NORTH]['4000']); f.set(lineDescription(0), 'August consulting')
      f.set(lineAmount(0), '1200.00'); f.set(lineTaxCode(0), '')
      f.set(READING_FIELD, readingId)
      return f
    }
    const saleForm = (readingId: string) => {
      const f = new FormData()
      f.set(I.ledgerId, L); f.set(I.direction, 'sales'); f.set(I.kind, 'invoice')
      f.set(I.partyId, acmeId); f.set(I.controlAccountId, ids[NORTH]['1100'])
      f.set(I.issuedOn, day('09-03')); f.set(I.dueOn, day('10-03')); f.set(I.number, 'INV-043'); f.set(I.amounts, 'exclusive')
      f.set(lineAccount(0), ids[NORTH]['4000']); f.set(lineDescription(0), 'September consulting')
      f.set(lineAmount(0), '2000.00'); f.set(lineTaxCode(0), '')
      f.set(READING_FIELD, readingId)
      return f
    }
    const income = typeof one === 'string' ? { error: `not read: ${one}` } as { ok?: string; error?: string; entryId?: string }
      : await quickEntryFromForm(incomeForm(one.id), actor)
    let sale: { ok?: string; error?: string }
    if (typeof two === 'string') sale = { error: `not read: ${two}` }
    else {
      try { sale = await createInvoiceFromForm(saleForm(two.id), nameOf, actor) }
      catch (e) { sale = { error: `threw: ${causesOf(e)}` } }
    }
    const [inv] = await db.execute<{ entry_id: string | null }>(raw`
      SELECT entry_id::text FROM invoice WHERE ledger_id = ${L}::uuid AND number = 'INV-043'`)
    const oneBack = typeof one === 'string' ? null : await readingById(L, one.id)
    const twoBack = typeof two === 'string' ? null : await readingById(L, two.id)
    const incomeFiles = income.entryId ? (await attachmentsOf(income.entryId)).length : -1
    const saleFiles = inv?.entry_id ? (await attachmentsOf(inv.entry_id)).length : -1
    check(!!income.ok && income.ok.includes('marked entered') && !income.ok.includes('filed against')
          && !!income.entryId && oneBack?.used_entry_id === income.entryId && incomeFiles === 0
          && !!sale.ok && sale.ok.includes('marked entered') && !sale.ok.includes('filed against')
          && !!inv?.entry_id && twoBack?.used_entry_id === inv.entry_id && saleFiles === 0,
      'BR26b a reading from a sentence alone is entered as income and as a sales invoice, nothing filed, closed, and not said to be filed',
      `income: ${(income.ok ?? income.error ?? '').slice(0, 70)}; sale: ${(sale.ok ?? sale.error ?? '').slice(0, 70)}; files ${incomeFiles}/${saleFiles}`)
  }

  // ------------------------------------------------------------------ BR27
  // THE PAGE, rendered from real rows: a box to write in and a file it does not
  // require; a reading of money in offers income and a sales invoice, the
  // model's choice first, with money out in a quiet line below — and the other
  // way round for money out; a reading from a sentence shows the sentence and
  // links no file.
  {
    const render = (readings: unknown[]) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-read-bill.tsx',
      JSON.stringify({ ledgerId: L, canRead: true, chart: { '4000': `4000 — Revenue ${NORTH}` }, readings, sentenceMax: SENTENCE_MAX }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const insert = async (sentence: string, proposal: object) => (await db.execute<{ id: string }>(raw`
      INSERT INTO ai_bill_reading (ledger_id, read_by, sentence, proposal)
      VALUES (${L}::uuid, ${actor}, ${sentence}, ${JSON.stringify(proposal)}::jsonb) RETURNING id::text`))[0].id
    const incomeId = await insert('Received 1,200 from Beta Services', BETA)
    const saleId = await insert('Invoiced Beta 2,000 for September', { ...BETA, suggests: 'sale' })
    const billId = await insert('Staples billed us 42.99', { ...STAPLES, suggests: 'bill' })
    const cards = readingCards((await readingsFor(L, 1000)).filter((x) => [incomeId, saleId, billId].includes(x.id)))
    const html = render(cards)
    const order = cards.map((c) => c.id)
    const cardOf = (id: string) => {
      const from = html.indexOf(`data-reading="${id}"`)
      const next = order[order.indexOf(id) + 1]
      return from < 0 ? '' : html.slice(from, next ? html.indexOf(`data-reading="${next}"`) : html.length)
    }
    const income = cardOf(incomeId), sale = cardOf(saleId), bill = cardOf(billId)
    const at = (card: string, key: string) => card.indexOf(`data-enter="${key}"`)
    const fileTag = html.match(/<input[^>]*type="file"[^>]*>/)?.[0] ?? ''
    check(html.includes('name="sentence"') && new RegExp(`maxlength="${SENTENCE_MAX}"`, 'i').test(html)
          && fileTag !== '' && !fileTag.includes('required')
          && income.includes(`href="/ledger/${L}/entries/quick/income?reading=${incomeId}"`)
          && sale.includes(`href="/ledger/${L}/invoices/new?direction=sales&amp;reading=${saleId}"`)
          && at(income, 'income') >= 0 && at(income, 'income') < at(income, 'sale') && at(income, 'sale') < at(income, 'expense')
          && at(sale, 'sale') >= 0 && at(sale, 'sale') < at(sale, 'income') && at(sale, 'income') < at(sale, 'expense')
          && at(bill, 'bill') >= 0 && at(bill, 'bill') < at(bill, 'expense') && at(bill, 'expense') < at(bill, 'income')
          && income.includes('Money out, not in?') && bill.includes('Money in, not out?')
          && income.includes('Received 1,200 from Beta Services') && income.includes('from a sentence')
          && !income.includes(`/readings/${incomeId}/file`)
          && income.includes('looks received') && sale.includes('looks like an invoice to a customer'),
      'BR27 the page has a box to write in and a file it does not require; a card offers its direction\'s pair, the model\'s choice first, and the other direction quietly; a sentence shows and links no file',
      `box ${html.includes('name="sentence"')}, file required ${fileTag.includes('required')}; `
      + `income ${at(income, 'income')}<${at(income, 'sale')}<${at(income, 'expense')}; sale ${at(sale, 'sale')}<${at(sale, 'income')}; `
      + `bill ${at(bill, 'bill')}<${at(bill, 'expense')}<${at(bill, 'income')}; file link on the sentence ${income.includes(`/readings/${incomeId}/file`)}`)
    for (const id of [incomeId, saleId, billId]) { try { await discardReading(L, id) } catch { /* nothing uses it */ } }
  }

  // ------------------------------------------------------------------ BR32
  // A READING THAT FILLED THE CORPORATE RECORD'S TABLES OFFERS EACH OF THEM
  // (2026-09-16). A minute book reads into several tables, and each has its
  // own add form: the card offers one link per table that has rows, counted,
  // carrying the reading — the one the model led with as the main button —
  // and a table already entered says so instead of offering it twice. A
  // reading whose rows are in the record is kept (0080), so the card does not
  // offer Discard for it.
  {
    const render = (readings: unknown) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-read-bill.tsx',
      JSON.stringify({ ledgerId: L, canRead: true, chart: {}, readings, sentenceMax: SENTENCE_MAX }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const book = {
      ...BETA, suggests: 'minute_book', kind: 'minute book', belongs: 'minutes', facts: {}, lines: [],
      subtotal: null, gst: null, pst: null, total: null,
      rows: {
        minute_book: [{ recordKind: 'directors_resolution', onDate: '2024-01-02', title: 'Resolutions', keptAt: 'Vol. 1' }],
        directors: [{ name: 'Avery Stone', appointedOn: '2024-01-02' }, { name: 'Blake Stone', appointedOn: '2024-01-02' }],
      },
    }
    let fresh = '', entered = '', made = ''
    try {
      fresh = (await db.execute<{ id: string }>(raw`
        INSERT INTO ai_bill_reading (ledger_id, read_by, sentence, proposal)
        VALUES (${L}::uuid, ${actor}, 'Our minute book', ${JSON.stringify(book)}::jsonb) RETURNING id::text`))[0].id
      entered = (await db.execute<{ id: string }>(raw`
        INSERT INTO ai_bill_reading (ledger_id, read_by, sentence, proposal, records_entered)
        VALUES (${L}::uuid, ${actor}, 'Our minute book again', ${JSON.stringify(book)}::jsonb,
                ${JSON.stringify({ directors: { at: '2026-09-16T10:00:00Z', by: actor, rows: 1 } })}::jsonb) RETURNING id::text`))[0].id
    } catch (e) { made = said(e) }
    const cards = readingCards((await readingsFor(L, 1000)).filter((x) => [fresh, entered].includes(x.id)))
    const html = cards.length === 2 ? render(cards) : ''
    const cardOf = (id: string) => {
      const from = html.indexOf(`data-reading="${id}"`)
      const other = id === fresh ? entered : fresh
      const to = html.indexOf(`data-reading="${other}"`)
      return from < 0 ? '' : html.slice(from, to > from ? to : html.length)
    }
    const a = cardOf(fresh), b = cardOf(entered)
    const link = (table: string, id: string) => `href="/ledger/${L}/records/add/${table}?reading=${id}"`
    const seen = [
      a.includes(link('minute_book', fresh)) ? 'minute book offered' : 'minute book NOT offered',
      a.includes(link('directors', fresh)) ? 'directors offered' : 'directors NOT offered',
      a.includes('Add to the directors register — 2 rows') ? 'counted' : 'NOT counted',
      a.includes('Discard') ? 'discard offered' : 'DISCARD MISSING on the fresh one',
      b.includes(link('directors', entered)) ? 'the entered table OFFERED AGAIN' : 'the entered table not offered again',
      // The mark says 1 went in while 2 were read: the card shows what went in.
      b.includes('Entered: 1 director —') ? 'says 1 entered' : b.includes('Entered: 2') ? 'says what was READ, not entered' : 'does NOT say entered',
      b.includes(link('minute_book', entered)) ? 'the other table still offered' : 'the other table NOT offered',
      b.includes('Discard') ? 'DISCARD OFFERED on a kept reading' : 'no discard on a kept reading',
    ]
    check(made === '' && a.includes(link('minute_book', fresh)) && a.includes(link('directors', fresh))
          && a.includes('Add to the directors register — 2 rows') && a.includes('Discard')
          && !b.includes(link('directors', entered)) && b.includes('Entered: 1 director —')
          && b.includes(link('minute_book', entered)) && !b.includes('Discard'),
      'BR32 a reading offers every record table it filled, once, counts what went in, and one entered anywhere is kept',
      made || seen.join('; '))
  }

  // ------------------------------------------------------------------ BR17
  // Where the reader LIVES: on Expenses and on Invoices, not on the
  // Assistant page, and then again the same day: the owner found it in the
  // way at the foot of two browse screens and asked for a button of its own
  // (「把它做一个新的 +AI Add 的按钮吧」). ONE place now, in the Add flyout,
  // which is where the other five ways of starting an entry are. Read from
  // the route tree and the sources, which is what a check without a browser
  // can say: the component is on that page and on no other, the file route
  // is out from under /assistant, and the doors accept every seat that can
  // open it — a panel on a screen whose seat the action refuses throws the
  // person off the page (the attachment doors' lesson).
  {
    const src = (p: string) => readFileSync(p, 'utf8')
    const expenses = src('src/app/ledger/[ledgerId]/expenses/page.tsx')
    const invoices = src('src/app/ledger/[ledgerId]/invoices/page.tsx')
    const assistant = src('src/app/ledger/[ledgerId]/assistant/page.tsx')
    const aiAdd = src('src/app/ledger/[ledgerId]/readings/page.tsx')
    const actions = src('src/app/actions.ts')
    // ONE FUNCTION AT A TIME, the way `N18` does it. Slicing from one name to
    // the next spans whatever functions were declared between them — and
    // `deleteCompanyAction` sits between these two, so the substring was
    // satisfied by a neighbour rather than by the door being checked
    // (critic, 2026-09-07).
    const fnNamed = (name: string) => actions
      .split(/\n(?=(?:export )?async function )/)
      .find((f) => f.includes(`function ${name}(`)) ?? ''
    const readAction = fnNamed('readBillAction')
    const discardAction = fnNamed('discardReadingAction')
    // The moved route answers only because it is DECLARED: `seatsForPath`
    // returns nothing for an undeclared segment and `refuseFor` reads that
    // as a refusal for everybody but an owner. N18 and US20 caught this the
    // moment the route moved; this says which seats it was given.
    const readings = DETAIL_ROUTES.find((d) => d.segment === 'readings')
    const seats = ['/expenses', '/invoices', '/assistant']
    const rail = src('src/components/NavRail.tsx')
    check(aiAdd.includes('<ReadBill') && aiAdd.includes('<AiModeNav')
      && !expenses.includes('ReadBill') && !invoices.includes('ReadBill')
      && !ADD_MENU.some((m) => m.path === '/readings')
      && AI_WORKSPACE_PATH === '/readings' && rail.includes('AI_WORKSPACE_PATH')
      && rail.includes('aria-label="AI workspace"') && rail.includes('> AI</span>')
      && !assistant.includes('ReadBill') && !assistant.includes('readingsFor')
      && existsSync('src/components/ReadBill.tsx')
      && !existsSync('src/app/ledger/[ledgerId]/assistant/ReadBill.tsx')
      && existsSync('src/app/ledger/[ledgerId]/readings/[readingId]/file/route.ts')
      && !existsSync('src/app/ledger/[ledgerId]/assistant/readings')
      && readAction.includes("'/expenses', '/invoices'") && discardAction.includes("'/expenses', '/invoices'")
      && !!readings && seats.every((x) => readings.seats.includes(x))
      // And the picker offers what the code reads: the help text said PDF
      // while the file dialog filtered them out (critic).
      && src('src/components/ReadBill.tsx').includes('accept=".pdf,'),
      'BR17 the reader shares the + AI workspace and accepts every seat that opens it',
      `Read & add page ${aiAdd.includes('<ReadBill')}, separate + AI control `
      + `${AI_WORKSPACE_PATH === '/readings' && rail.includes('aria-label="AI workspace"')}; `
      + `expenses ${expenses.includes('ReadBill') ? 'STILL HAS IT' : 'clear'}, `
      + `invoices ${invoices.includes('ReadBill') ? 'STILL HAS IT' : 'clear'}, `
      + `assistant ${assistant.includes('ReadBill') ? 'STILL HAS IT' : 'clear'}; `
      + `route moved ${existsSync('src/app/ledger/[ledgerId]/readings/[readingId]/file/route.ts')}; `
      + `readBillAction accepts ${(readAction.match(/requireLedger\([^)]*\)/) ?? ['?'])[0].slice(0, 60)}; `
      + `the route is declared for ${readings?.seats.join(' ') ?? 'NOTHING'}`)
  }

  // ------------------------------------------------------------------ BR13
  await trailNamesPeople(check, 'BR13 every audit row this suite wrote names a person, not the database role')

  relay.close()
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

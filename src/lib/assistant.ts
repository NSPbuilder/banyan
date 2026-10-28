import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { accessFor, refuseForLedger } from './access'
import { READING_QUESTION_STARTS } from './reading-question'
import type { UserRecord } from './users'

/**
 * The assistant: a place to ask, with a record of every asking.
 *
 * The owner asked for the module before deciding what it should do
 * (2026-09-06). So this is the plumbing that any later purpose will stand on,
 * and nothing that presumes one:
 *
 *   the service  an OpenAI-compatible chat-completions endpoint — the format
 *                the relay services the owner uses speak (sub2api, new-api,
 *                aimixhub and their kind). EACH PERSON BRINGS THEIR OWN:
 *                address, key and model, saved for them by `ai-service.ts`
 *                with the key encrypted under AI_KEY_SECRET (0063), and
 *                decrypted for the one request. The key is in nothing this
 *                file writes: it is struck out of any recorded text
 *                (`withoutKey`). No service, no assistant.
 *
 *                (0062, the same morning, kept nothing at all and made every
 *                question carry the key from the browser. The owner used it
 *                and asked for it to be kept — encrypted — instead.)
 *   the door     `ask()` — one question in, one answer out, one row written.
 *   the books    go only when a caller hands `ask` a text to send — the chart
 *                of accounts when a bill is read (`booksOverride`) — and the
 *                row keeps that exact text. Questions about the books go
 *                through `inquiry.ts` instead (docs/design/38).
 *   the trail    `ai_exchange` (0061, 0062), append-only: who, when, the
 *                question, what the books contributed, the answer, the stop
 *                reason, the token counts, which host and model answered, and
 *                the prices the person typed — so money is derived per row
 *                from that row's own figures and never stored.
 *   the seat     `/assistant` in nav.ts, grantable like every other module.
 *
 * No SDK. The wire shape is one POST with a bearer token and a JSON body,
 * written out below in `sendToRelay`, and `AI13` holds it against a local
 * server that answers in that format.
 *
 * `ask` takes the sender as a parameter so a check can stand in for the
 * network and read exactly what would have been sent (`BR2`). The default is
 * the real thing.
 */

/**
 * What a PERSON may type. The assistant's box carries it as `max`, and
 * `inquiry.ts` refuses past it before anything is composed.
 */
export const QUESTION_MAX = 4000
/**
 * What may reach the relay once this system has composed a question around
 * what the person wrote.
 *
 * Separate from QUESTION_MAX since 2026-09-16, because they were one number
 * doing two jobs: reading a bill sends an INSTRUCTION plus the person's
 * sentence, so every line added to that prompt silently shortened what
 * somebody was allowed to type — and when the destination menu started being
 * generated from the catalogue, the longest legal sentence stopped fitting at
 * all (B31 went red). The person's limit is theirs; this one guards what
 * leaves the machine.
 */
export const PROMPT_MAX = 12000
export const MAX_ANSWER_TOKENS = 8000
export const REQUEST_TIMEOUT_MS = 120_000

export class AssistantError extends Error {
  constructor(public code: 'NOT_CONFIGURED' | 'EMPTY' | 'TOO_LONG' | 'NO_LEDGER'
    | 'NO_INQUIRY' | 'NOT_YOURS' | 'NOT_OFFERED' | 'ALREADY' | 'NO_SEAT' | 'SERVICE_CHANGED', message: string) {
    super(message)
  }
}

const NOT_CONFIGURED_MESSAGE =
  'The assistant needs your service: its address, your key and a model name, saved in "Your service" '
  + 'above. The key is kept encrypted, and never written into an asking.'

/** The service a question goes to. All three, or nothing is configured. */
export type Service = { baseUrl: string; apiKey: string; model: string }

/**
 * A service from what the form carried. The address however it was pasted:
 * parsed as a URL, http or https only, and reduced to origin and path — no
 * user:password, no query, no fragment — with a trailing slash or the whole
 * `/chat/completions` path taken off, so the one path `sendToRelay` appends
 * is not doubled. Credentials typed into the address never reach fetch,
 * whose own error would otherwise quote them into the trail (critic).
 */
export function serviceFrom(input: { baseUrl?: string | null; apiKey?: string | null; model?: string | null }): Service | null {
  const apiKey = (input.apiKey ?? '').trim()
  const model = (input.model ?? '').trim()
  const typed = (input.baseUrl ?? '').trim()
  if (!typed || !apiKey || !model) return null
  let url: URL
  try {
    url = new URL(typed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  return { baseUrl: url.origin + path, apiKey, model }
}

/** The host of a service's address — what the trail keeps of it. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.replace(/^[a-z]+:\/\//i, '').split('/')[0]
  }
}

/**
 * What the person says their service charges per million tokens, in whatever
 * currency they pay in. Blank means unknown, not zero: a wrong figure is
 * worse than none. A cached prompt token is a tenth of an input token when
 * unsaid; the unit is "$" when unsaid.
 */
export type Prices = { input: number; output: number; cached: number; unit: string }

export function pricesFrom(input: {
  priceInput?: string | null; priceOutput?: string | null; priceCached?: string | null; priceUnit?: string | null
}): Prices | null {
  const said = (v: string | null | undefined) => (v ?? '').trim()
  if (said(input.priceInput) === '' || said(input.priceOutput) === '') return null
  const inputPrice = Number(said(input.priceInput))
  const outputPrice = Number(said(input.priceOutput))
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice) || inputPrice < 0 || outputPrice < 0) return null
  const cachedSaid = Number(said(input.priceCached))
  const cached = said(input.priceCached) !== '' && Number.isFinite(cachedSaid) && cachedSaid >= 0 ? cachedSaid : inputPrice / 10
  return { input: inputPrice, output: outputPrice, cached, unit: said(input.priceUnit) || '$' }
}

export type Exchange = {
  id: string
  ledger_id: string
  asked_at: string
  asked_by: string
  model: string
  service: string | null
  question: string
  books_sent: string | null
  answer: string | null
  stop_reason: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  error: string | null
  price_input: string | null
  price_output: string | null
  price_cached: string | null
  price_unit: string | null
}

/** What the model said, and what it cost — the part of a response this keeps. */
export type Reply = {
  model: string
  text: string | null
  /** end_turn | max_tokens | refusal | tool_use, or the service's own word when it is none of these. */
  stopReason: string
  /** The refusal's explanation, when there is one. */
  explanation: string | null
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export type Request = {
  system: string
  question: string
  /**
   * A document that goes with the question — a photo of a bill, or the bill
   * itself as a PDF (0064; PDFs from 2026-09-07).
   *
   * The two travel differently, because the OpenAI-compatible format says
   * so: a picture is an `image_url` part carrying a data URL, and a PDF is a
   * `file` part carrying `filename` and `file_data`. Which one this is comes
   * from the mime type, so the caller hands over bytes and a type and does
   * not have to know the wire.
   */
  file?: { mime: string; base64: string; filename: string }
}
export type Send = (req: Request, service: Service) => Promise<Reply>

/**
 * How a document goes on the wire.
 *
 *   a picture   `image_url`, a data URL — what every service reads
 *   a PDF       `file`, with `filename` and `file_data` — the shape the
 *               OpenAI format defines for a document
 *
 * WHETHER A RELAY CARRIES THE SECOND IS NOT SOMETHING THIS SYSTEM CAN
 * PROMISE. A forwarding service passes the body to whatever is behind it,
 * and what is behind it may take PDFs, may refuse them, or may take them
 * only on some models. That is why sending one is not a special path: it
 * goes, and whatever comes back is recorded on the reading like any other
 * answer, so the person reads a sentence rather than meeting a blank screen
 * (owner, 2026-09-07: 「ai 现在还不能读取 pdf，这个很不实用」).
 */
function filePart(file: { mime: string; base64: string; filename: string }) {
  return file.mime === 'application/pdf'
    ? { type: 'file', file: { filename: file.filename, file_data: `data:${file.mime};base64,${file.base64}` } }
    : { type: 'image_url', image_url: { url: `data:${file.mime};base64,${file.base64}` } }
}

const SYSTEM = [
  'You are the assistant inside a small accounting application used by the owner of a few private',
  'companies in British Columbia, Canada. The books are kept under IFRS, in Canadian dollars, with',
  'amounts in cents on the wire. Answer plainly and briefly, in English.',
  'When a section headed "The books" follows, answer from it and name the figures you used;',
  'when it does not, say what you would need rather than guessing. Never invent a figure.',
  'You cannot change the books: every change is made by a person through the application.',
].join(' ')

type LedgerHead = { entity: string; standard: string; year: string | null; start: string | null; end: string | null }

/**
 * The company behind a ledger id — and the existence check `ask` runs before
 * anything is sent, whether or not the books go: a well-formed id that names
 * no ledger used to reach the model and then fail the INSERT's foreign key —
 * a question that left with no row (critic).
 */
async function ledgerHead(ledgerId: string): Promise<LedgerHead> {
  const [head] = await db.execute<LedgerHead>(sql`
    SELECT e.name AS entity, l.accounting_standard AS standard,
           fy.name AS year, fy.start_date::text AS start, fy.end_date::text AS "end"
      FROM ledger l
      JOIN entity e ON e.id = l.entity_id
      LEFT JOIN LATERAL (
        SELECT name, start_date, end_date FROM fiscal_year
         WHERE ledger_id = l.id ORDER BY end_date DESC LIMIT 1) fy ON true
     WHERE l.id = ${ledgerId}::uuid`)
  if (!head) throw new AssistantError('NO_LEDGER', 'That company does not exist.')
  return head
}

/** The shape an OpenAI-compatible service answers with — the parts read here. */
type ChatCompletion = {
  model?: string
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null
      refusal?: string | null
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

/** The service's finish reasons, in this system's words. Anything else is kept as said. */
const FINISH: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
  tool_calls: 'tool_use',
}

/**
 * The real sender: one POST to `{address}/chat/completions` with a bearer
 * token, the system text and the question, and the answer read back from the
 * first choice. Everything about the wire is here and nowhere else.
 *
 * A refusal is either `finish_reason: "content_filter"` or a `refusal` text on
 * the message (OpenAI's newer shape); both become a reply with no text, the
 * stop reason 'refusal', and an explanation. A non-2xx answer is an error
 * carrying the status and the start of the body, which `ask` records — with
 * the key struck out, should the service have echoed it.
 */
export const sendToRelay: Send = async (req, service) => {
  const res = await fetch(service.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + service.apiKey,
    },
    body: JSON.stringify({
      model: service.model,
      max_tokens: MAX_ANSWER_TOKENS,
      messages: [
        { role: 'system', content: req.system },
        {
          role: 'user',
          // A document rides in the parts array — the shape every
          // OpenAI-compatible service reads. Without one the content stays a
          // plain string, which is what the services with the narrowest
          // reading of the format accept.
          content: req.file ? [{ type: 'text', text: req.question }, filePart(req.file)] : req.question,
        },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const bodyText = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${bodyText.slice(0, 300)}`.trim())
  let body: ChatCompletion
  try {
    body = JSON.parse(bodyText) as ChatCompletion
  } catch {
    throw new Error(`the service answered with something that is not JSON: ${bodyText.slice(0, 200)}`)
  }
  const choice = body.choices?.[0]
  if (!choice) throw new Error(`the service answered without a choice: ${bodyText.slice(0, 200)}`)

  const content = choice.message?.content
  const text = typeof content === 'string'
    ? content.trim()
    : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('\n').trim() : ''
  const finish = choice.finish_reason ?? 'stop'
  const refusalText = (choice.message?.refusal ?? '').trim()
  const refused = FINISH[finish] === 'refusal' || refusalText.length > 0
  // A 200 with nothing in it is not an answer of nothing; it is a failed
  // asking, recorded with the finish reason so the reader knows which kind.
  if (!refused && !text) {
    throw new Error(`the service answered with no text (finish_reason ${finish}): ${bodyText.slice(0, 200)}`)
  }
  // In this format `prompt_tokens` INCLUDES the cached part; the row's
  // input_tokens means the uncached part (0061, from the other format's
  // meaning), so the cached count is taken out of it — or every cached token
  // would be counted, and priced, twice.
  const prompt = body.usage?.prompt_tokens ?? 0
  const cached = Math.min(prompt, body.usage?.prompt_tokens_details?.cached_tokens ?? 0)
  return {
    model: body.model || service.model,
    text: refused ? null : (text || null),
    stopReason: refused ? 'refusal' : (FINISH[finish] ?? finish),
    explanation: refused
      ? (refusalText || `The service stopped the answer (${finish}).`)
      : null,
    usage: {
      input: prompt - cached,
      output: body.usage?.completion_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: 0,
    },
  }
}

/**
 * The key, struck out of anything that is about to be recorded. A service
 * that echoes the bearer token in an error body — some do, on a malformed
 * one — must not put it in the trail through the back door.
 */
export function withoutKey(text: string | null, apiKey: string): string | null {
  if (text === null || !apiKey) return text
  return text.split(apiKey).join('[key]')
}

/**
 * One question, one row. The row is written whether the model answered,
 * refused, or the call failed — a trail of what was asked is the point, and
 * a failed asking is part of it. Only a question that never left this
 * process (no service given, empty, too long, no such company) writes nothing.
 * The key is used for the one request and is in nothing that is written.
 */
export async function ask(input: {
  ledgerId: string; question: string; actor: string
  service: Service | null; prices: Prices | null
  /** A picture to read (0064). */
  /** The bill itself, when there is one: a picture or a PDF (`filePart`). */
  file?: { mime: string; base64: string; filename: string }
  /**
   * The books text to send with the question — the chart of accounts
   * when a bill is being read, which needs names and not balances. It is
   * kept in `books_sent` like any other, so what left is still on record.
   */
  booksOverride?: string
}, send: Send = sendToRelay): Promise<Exchange> {
  if (!input.service) throw new AssistantError('NOT_CONFIGURED', NOT_CONFIGURED_MESSAGE)
  const service = input.service
  const question = input.question.trim()
  if (!question) throw new AssistantError('EMPTY', 'Ask something.')
  if (question.length > PROMPT_MAX) {
    throw new AssistantError('TOO_LONG', `That is longer than ${PROMPT_MAX} characters. Ask it in parts.`)
  }
  // The ledger must exist BEFORE anything leaves, books or no books: the row
  // that records the asking references it, and a question sent for a ledger
  // that cannot take the row is a question that left with no trail.
  await ledgerHead(input.ledgerId)
  const books = input.booksOverride ?? null
  const system = books ? `${SYSTEM}\n\n${books}` : SYSTEM

  let reply: Reply | null = null
  let error: string | null = null
  try {
    reply = await send({ system, question, file: input.file }, service)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  if (reply && reply.stopReason === 'refusal') {
    error = reply.explanation ?? 'The model declined to answer.'
  }
  const p = input.prices
  const [row] = await db.execute<Exchange>(sql`
    INSERT INTO ai_exchange (ledger_id, asked_by, model, service, question, books_sent, answer, stop_reason,
                             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, error,
                             price_input, price_output, price_cached, price_unit)
    VALUES (${input.ledgerId}::uuid, ${input.actor}, ${withoutKey(reply?.model ?? service.model, service.apiKey)},
            ${hostOf(service.baseUrl)},       ${withoutKey(question, service.apiKey)}, ${books === null ? null : withoutKey(books, service.apiKey)},
            ${withoutKey(reply?.text ?? null, service.apiKey)}, ${withoutKey(reply?.stopReason ?? null, service.apiKey)},
            ${reply?.usage.input ?? 0}, ${reply?.usage.output ?? 0},
            ${reply?.usage.cacheRead ?? 0}, ${reply?.usage.cacheWrite ?? 0}, ${withoutKey(error, service.apiKey)},
            ${p?.input ?? null}, ${p?.output ?? null}, ${p?.cached ?? null}, ${withoutKey(p?.unit ?? null, service.apiKey)})
    RETURNING id::text, ledger_id::text, asked_at::text, asked_by, model, service, question, books_sent, answer,
              stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, error,
              price_input::text, price_output::text, price_cached::text, price_unit`)
  return row
}

/** The most recent exchanges of one company, newest first. */
export async function exchangesFor(ledgerId: string, limit = 30): Promise<Exchange[]> {
  return db.execute<Exchange>(sql`
    SELECT id::text, ledger_id::text, asked_at::text, asked_by, model, service, question, books_sent, answer,
           stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, error,
           price_input::text, price_output::text, price_cached::text, price_unit
      FROM ai_exchange WHERE ledger_id = ${ledgerId}::uuid
     ORDER BY asked_at DESC, id DESC LIMIT ${limit}`)
}

/**
 * The questions the old form asked, for the page's "Earlier questions". A bill
 * reading writes an exchange too, and those are not questions a person typed:
 * the ones a reading still points at, and the ones a discarded reading left
 * behind. Nothing without the Assistant seat; the viewer's own, unless the
 * viewer is an owner — an exchange kept the books text it sent, which a
 * narrower seat must not read back.
 */
export async function earlierQuestionsFor(ledgerId: string, viewer: UserRecord, limit = 30): Promise<Exchange[]> {
  if (await refuseForLedger(viewer, ledgerId, '/assistant')) return []
  const access = await accessFor(viewer)
  const everyone = access.entities === null && access.modules === null
  const notAReading = sql.join(READING_QUESTION_STARTS.map((start) =>
    sql`left(x.question, ${start.length}) <> ${start}`), sql` AND `)
  return db.execute<Exchange>(sql`
    SELECT x.id::text, x.ledger_id::text, x.asked_at::text, x.asked_by, x.model, x.service, x.question, x.books_sent,
           x.answer, x.stop_reason, x.input_tokens, x.output_tokens, x.cache_read_tokens, x.cache_write_tokens, x.error,
           x.price_input::text, x.price_output::text, x.price_cached::text, x.price_unit
      FROM ai_exchange x
     WHERE x.ledger_id = ${ledgerId}::uuid
       AND NOT EXISTS (SELECT 1 FROM ai_bill_reading r WHERE r.exchange_id = x.id)
       AND ${notAReading}
       ${everyone ? sql`` : sql`AND x.asked_by = ${viewer.email}`}
     ORDER BY x.asked_at DESC, x.id DESC LIMIT ${limit}`)
}

/**
 * What an exchange cost, from its own token counts and the prices typed when
 * it was asked. Null when no prices were given, which is the honest figure.
 */
export function costOf(x: Pick<Exchange,
  'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'price_input' | 'price_output' | 'price_cached'
>): number | null {
  if (x.price_input === null || x.price_output === null) return null
  const input = Number(x.price_input), output = Number(x.price_output)
  const cached = x.price_cached === null ? input / 10 : Number(x.price_cached)
  return (x.input_tokens * input + x.output_tokens * output
        + x.cache_read_tokens * cached + x.cache_write_tokens * input) / 1_000_000
}

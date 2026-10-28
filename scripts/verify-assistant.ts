/**
 * The assistant: a place to ask, with a record of every asking — and a key
 * that is kept nowhere.
 *   npm run db:verify-assistant   (resets the database first)
 *
 * NOTHING HERE REACHES THE NETWORK. Every `ask` below is handed a sender of
 * the suite's own: a stub that records what it was given and answers from a
 * script, or a sentinel that throws if it is ever reached. The real sender,
 * `sendToRelay`, is exercised against a server this suite starts on the
 * loopback address and answers in the OpenAI-compatible shape (`AI13`), so
 * the wire format is checked without a service. What is checked is the part
 * that does not depend on the model: what is kept (`AI4`, `AI5`, `AI7`), what
 * is refused before it leaves (`AI1`, `AI9`, `AI12`), what it costs (`AI6`),
 * and that the key is in none of it (`AI14`). What leaves is checked where it
 * is decided: a question to the books in verify-inquiry (`IQ1`, `IQ5`, `IQ7`),
 * a bill reading in verify-bills (`BR2`).
 */
import './env'
import { reporter } from './suite'
import { byHand } from './by-hand'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { postEntry } from '../src/lib/posting'
import { parseMoney } from '../src/lib/money'
import { causesOf } from '../src/lib/db-errors'
import {
  AssistantError, PROMPT_MAX, ask, costOf, exchangesFor, hostOf, pricesFrom, sendToRelay,
  serviceFrom, withoutKey, type Reply, type Request, type Service,
} from '../src/lib/assistant'
import { saveServiceFromForm, type Asker } from '../src/lib/assistant-forms'
import { inquireFromForm } from '../src/lib/inquiry-forms'
import {
  AiServiceError, clearService, decryptKey, encryptKey, hintOf, panelStateFrom, saveService, secretIsSet,
  serviceState,
} from '../src/lib/ai-service'
import { createFirstOwner } from '../src/lib/users'
import { ASSISTANT_FIELDS as F } from '../src/lib/forms'
import { MODULE_PATHS } from '../src/lib/nav'

const r = reporter(58)
const { check } = r

const NORTH = 'NORTHMARK', SOUTH = 'SOUTHMARK'
/** The model name the suite configures; nothing here knows a real one. */
const MODEL = 'relay-model-under-test'
/** The key the suite types. It must never appear in a row. */
const KEY = 'sk-suite-secret-7f3a9c'
const chartFor = (marker: string) => `1000,Cash ${marker},asset,,cash_and_cash_equivalents
1200,Receivables ${marker},asset,,trade_receivables
3000,Share capital ${marker},equity,,share_capital
4000,Revenue ${marker},revenue,,revenue_from_contracts`

/** A sender that answers from a script and keeps what it was asked. */
function stub(reply: Partial<Reply> | Error) {
  const seen: Array<{ req: Request; service: Service }> = []
  const send = async (req: Request, service: Service): Promise<Reply> => {
    seen.push({ req, service })
    if (reply instanceof Error) throw reply
    return {
      model: MODEL, text: 'Forty-two.', stopReason: 'end_turn', explanation: null,
      usage: { input: 120, output: 7, cacheRead: 0, cacheWrite: 0 }, ...reply,
    }
  }
  return { send, seen }
}

async function main() {
  const north = await createCompanyWithYear({ code: 'NOR', name: `Northwind ${NORTH} Ltd.` }, 'alicio@example.test')
  const south = await createCompanyWithYear({ code: 'SOU', name: `Southwind ${SOUTH} Ltd.` }, 'alicio@example.test')
  for (const [co, marker] of [[north, NORTH], [south, SOUTH]] as const) {
    const accts = await importAccounts(co.company.id,
      parseAccountsCsv(chartFor(marker)).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
    const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
    const yr = Number(co.year.endDate.slice(0, 4))
    await postEntry({
      ledgerId: co.ledger.id, entryDate: `${yr}-02-01`, description: `Invoice ${marker}`, actor: 'alicio@example.test',
      lines: [{ accountId: id['1200'], amount: parseMoney(marker === NORTH ? '1234.00' : '9876.00') },
              { accountId: id['4000'], amount: -parseMoney(marker === NORTH ? '1234.00' : '9876.00') }],
    })
  }
  const L = north.ledger.id
  const actor = 'pat@x.test'
  // Somebody to own a saved service (0063 keys the row on app_user).
  const pat = await createFirstOwner({ email: actor, firstName: 'Pat', lastName: null, password: 'a long ordinary sentence' })
  const who: Asker = { id: pat.id, email: pat.email }
  const SECRET = 'suite-secret-for-encrypting-keys'
  process.env.AI_KEY_SECRET = SECRET

  // A service of the suite's own, on the loopback address: it answers in the
  // OpenAI-compatible shape from a script chosen per check, and keeps every
  // request it was sent. The checks before AI13 never reach it (they hand in stubs);
  // AI13 and AI14 do, on purpose.
  type Seen = { method: string; path: string; authorization: string | undefined; body: unknown }
  const seen: Seen[] = []
  let script: 'answer' | 'filter' | 'refusal-field' | 'error' | 'error-echo' | 'not-json' | 'empty' = 'answer'
  const relay = createServer((req: IncomingMessage, res: ServerResponse) => {
    let rawBody = ''
    req.on('data', (c) => { rawBody += c })
    req.on('end', () => {
      let body: unknown = null
      try { body = JSON.parse(rawBody) } catch { body = rawBody }
      seen.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization, body })
      const reply = (status: number, payload: unknown, json = true) => {
        res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain' })
        res.end(json ? JSON.stringify(payload) : String(payload))
      }
      if (script === 'error') return reply(401, { error: { message: 'invalid key', type: 'authentication_error' } })
      if (script === 'error-echo') return reply(401, { error: { message: `key ${req.headers.authorization?.replace('Bearer ', '')} is not valid` } })
      if (script === 'not-json') return reply(200, '<html>upstream is down</html>', false)
      if (script === 'empty') return reply(200, { id: 'x', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 0 } })
      const usage = { prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 20 } }
      if (script === 'filter') return reply(200, { id: 'x', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }], usage })
      if (script === 'refusal-field') return reply(200, { id: 'x', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }], usage })
      return reply(200, { id: 'x', model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'Forty-two.' }, finish_reason: 'stop' }], usage })
    })
  })
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r))
  const port = (relay.address() as { port: number }).port
  // A trailing slash, on purpose: it must not double.
  const service: Service = serviceFrom({ baseUrl: `http://127.0.0.1:${port}/v1/`, apiKey: KEY, model: MODEL })!
  const nothing = { service: null, prices: null }
  const mine = { service, prices: null }

  // ------------------------------------------------------------------- AI1
  // Without a service — no address, no key, no model — a question is refused
  // in a sentence, and nothing is written: not sent, not recorded.
  {
    let said = '', reached = 0
    const sentinel = async (): Promise<Reply> => { reached++; throw new Error('the sentinel sender was reached') }
    try { await ask({ ledgerId: L, question: 'Is the cash right?', actor, ...nothing }, sentinel) }
    catch (e) { said = e instanceof AssistantError ? `${e.code}: ${e.message}` : causesOf(e) }
    const partial = serviceFrom({ baseUrl: 'https://x.example/v1', apiKey: '', model: 'm' })
    const rows = await exchangesFor(L)
    check(said.startsWith('NOT_CONFIGURED') && said.includes('your key') && rows.length === 0 && reached === 0 && partial === null,
      'AI1 with no service of their own, the person is refused in a sentence; nothing is sent or recorded',
      `${said.slice(0, 60) || 'no refusal'}; sender reached ${reached} time(s); ${rows.length} row(s); two of three fields → ${partial}`)
  }

  // ------------------------------------------------------------------- AI4
  {
    const refusing = stub({ text: null, stopReason: 'refusal', explanation: 'Declined: category cyber.' })
    const x = await ask({ ledgerId: L, question: 'Write me an exploit.', actor, ...mine }, refusing.send)
    check(x.answer === null && x.stop_reason === 'refusal' && x.error === 'Declined: category cyber.',
      'AI4 a refusal is recorded as one: no answer, the stop reason, the explanation',
      `answer ${x.answer === null ? 'null' : JSON.stringify(x.answer)}, stop ${x.stop_reason}, error ${x.error}`)
  }

  // ------------------------------------------------------------------- AI5
  {
    const failing = stub(new Error('connect ECONNREFUSED'))
    const x = await ask({ ledgerId: L, question: 'Anything?', actor, ...mine }, failing.send)
    check(x.answer === null && x.error === 'connect ECONNREFUSED' && x.input_tokens === 0,
      'AI5 a failed call is recorded with its error and no tokens', `${x.error}`)
  }

  // ------------------------------------------------------------------- AI6
  // Money is derived from each row's own tokens and the prices typed when it
  // was asked; none when none were typed; a blank price is unset, not zero.
  {
    const priced = pricesFrom({ priceInput: '5', priceOutput: '25', priceCached: '0.5', priceUnit: '¥' })
    const x = await ask({ ledgerId: L, question: 'Priced?', actor, service, prices: priced },
      stub({ usage: { input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 0 } }).send)
    const y = await ask({ ledgerId: L, question: 'Unpriced?', actor, ...mine }, stub({}).send)
    const blank = pricesFrom({ priceInput: '', priceOutput: '25' })
    const tenth = pricesFrom({ priceInput: '5', priceOutput: '25' })
    const [{ stored }] = await db.execute<{ stored: string | null }>(raw`
      SELECT string_agg(column_name, ' ') AS stored FROM information_schema.columns
       WHERE table_name = 'ai_exchange' AND (column_name LIKE '%cost%' OR column_name LIKE '%dollar%' OR column_name LIKE '%key%')`)
    check(Math.abs((costOf(x) ?? 0) - (0.005 + 0.0025 + 0.005)) < 1e-9 && x.price_unit === '¥'
          && costOf(y) === null && blank === null && tenth?.cached === 0.5 && tenth?.unit === '$' && stored === null,
      'AI6 money is derived from each row\'s own tokens and typed prices; none without them; no cost, dollar or key column exists',
      `priced row ${x.price_unit}${costOf(x)?.toFixed(4)}; unpriced ${costOf(y)}; blank ${blank}; cached default ${tenth?.cached}`)
  }

  // ------------------------------------------------------------------- AI7
  {
    const [{ id }] = await db.execute<{ id: string }>(raw`SELECT id::text FROM ai_exchange ORDER BY asked_at LIMIT 1`)
    let update = '', del = ''
    try { await byHand((tx) => tx.execute(raw`UPDATE ai_exchange SET answer = 'edited' WHERE id = ${id}::uuid`)) } catch (e) { update = causesOf(e) }
    try { await byHand((tx) => tx.execute(raw`DELETE FROM ai_exchange WHERE id = ${id}::uuid`)) } catch (e) { del = causesOf(e) }
    check(update.includes('AI_EXCHANGE_IMMUTABLE') && del.includes('AI_EXCHANGE_IMMUTABLE'),
      'AI7 an exchange can be neither edited nor deleted', `update: ${update.slice(0, 40)}… delete: ${del.slice(0, 40)}…`)
  }

  // ------------------------------------------------------ AI15, AI16, AI17, AI18
  // The key is kept, and kept encrypted (0063): under the application's
  // secret, which lives in .env.local and not in the database.
  {
    // The service the checks below read back, saved through the form a person
    // uses. AI8 saved it while it checked the old question form; that form is
    // gone (docs/design/38), and the save stays here as this section's setup.
    const save = new FormData()
    save.set(F.baseUrl, `http://127.0.0.1:${port}/v1`); save.set(F.apiKey, KEY); save.set(F.model, MODEL)
    save.set(F.priceInput, '2'); save.set(F.priceOutput, '10')
    const saved = await saveServiceFromForm(save, who)

    const blob = encryptKey('sk-round-trip-1234', SECRET)
    const same = encryptKey('sk-round-trip-1234', SECRET)
    const altered = Buffer.from(blob); altered[altered.length - 1] ^= 0xff
    const wrongSecret = decryptKey(blob, 'a-different-secret-entirely')
    const alteredRead = decryptKey(altered, SECRET)
    const tooShort = decryptKey(Buffer.alloc(4), SECRET)
    check(decryptKey(blob, SECRET) === 'sk-round-trip-1234'
          && !blob.toString('utf8').includes('sk-round-trip') && !blob.toString('hex').includes(Buffer.from('sk-round-trip').toString('hex'))
          && !blob.equals(same)
          && wrongSecret === null && alteredRead === null && tooShort === null,
      'AI15 a key encrypts and comes back; a different secret or an altered blob gives nothing, not garbage',
      // The values, not the hoped-for words: a mutant that returns noise used
      // to be recorded under a line that still said "→ null" (critic).
      `${blob.length} bytes, twice different: ${!blob.equals(same)}; wrong secret → ${wrongSecret === null ? 'null' : JSON.stringify(wrongSecret).slice(0, 30)}; altered → ${alteredRead === null ? 'null' : JSON.stringify(alteredRead).slice(0, 30)}`)

    // The bytes, not the row rendered as text: Postgres prints a bytea as hex
    // inside a composite ::text, so a plaintext key in key_enc never matched
    // the string test this used to make — a check that could not see the
    // thing it was written to see (critic).
    const [row] = await db.execute<{ clean: boolean; hint: string; enc_hex: string }>(raw`
      SELECT position(convert_to(${KEY}, 'UTF8') in key_enc) = 0 AS clean,
             key_hint AS hint, encode(key_enc, 'hex') AS enc_hex
        FROM user_ai_service WHERE user_id = ${pat.id}::uuid`)
    const keyIsInTheBytes = row !== undefined && !row.clean
    const state = await serviceState(pat.id)
    check(row !== undefined && row.clean && row.hint === hintOf(KEY) && !row.enc_hex.includes(Buffer.from(KEY, 'utf8').toString('hex')),
      'AI16 the key is nowhere in the bytes of the saved row, which keep only ciphertext and its last four characters',
      `key found in key_enc: ${keyIsInTheBytes}; hint ${row?.hint}; ${row?.enc_hex.length ?? 0} hex chars`)
    check(saved.ok?.includes(`…${KEY.slice(-4)}`) === true && state.kind === 'ready' && state.saved.service.apiKey === KEY && secretIsSet(),
      'AI16b and reading the row back under the same secret gives the key again',
      `saved: ${saved.ok ?? saved.error}; state ${state.kind}`)

    // A key too short for a hint that hides anything is refused, so neither
    // the row nor the trail nor the door's own sentence half-publishes it.
    let shortSaid = ''
    try { await saveService({ userId: pat.id, actor, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-1', model: MODEL }) }
    catch (e) { shortSaid = e instanceof AiServiceError ? e.code : causesOf(e) }
    check(shortSaid === 'SHORT_KEY' && hintOf('sk-1') === '' && hintOf(KEY) === KEY.slice(-4),
      'AI16c a key too short to hide behind its own hint is refused', `${shortSaid}; hint of a 4-character key: "${hintOf('sk-1')}"`)

    // A blank key keeps the saved one: changing the model must not mean typing
    // it again. Caught, not awaited bare: a mutant that loses the saved key
    // makes this refuse, and a refusal here must be red, not a dead suite.
    let changedModel = '', changedKey = false, blankSaid = ''
    try {
      const changed = await saveService({ userId: pat.id, actor, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '   ', model: 'another-model' })
      changedModel = changed.service.model; changedKey = changed.service.apiKey === KEY
    } catch (e) { blankSaid = e instanceof AiServiceError ? e.code : causesOf(e) }
    const after = await serviceState(pat.id)
    let refused = ''
    try { await saveService({ userId: pat.id, actor, baseUrl: 'not-a-web-address', apiKey: KEY, model: MODEL }) }
    catch (e) { refused = e instanceof AiServiceError ? e.code : causesOf(e) }
    check(changedKey && changedModel === 'another-model' && blankSaid === ''
          && after.kind === 'ready' && after.saved.service.apiKey === KEY && refused === 'BAD_ADDRESS',
      'AI17 a blank key keeps the saved one, and an address that is not a web address is refused',
      `model now ${changedModel || 'unchanged'}, key kept: ${changedKey}${blankSaid ? ` (refused: ${blankSaid})` : ''}; bad address → ${refused}`)

    // The secret changes: the key cannot be read, and the page is told so
    // rather than shown a wrong key or a crash.
    process.env.AI_KEY_SECRET = 'a-completely-different-secret'
    const lost = await serviceState(pat.id)
    const asked = await inquireFromForm((() => { const f = new FormData(); f.set(F.ledgerId, L); f.set(F.question, 'Still there?'); return f })(), pat, stub({}).send)
    process.env.AI_KEY_SECRET = SECRET

    // With no secret at all, nothing can be saved and the sentence says where
    // to put one; the row already saved stays, unreadable.
    const keep = process.env.AI_KEY_SECRET
    delete process.env.AI_KEY_SECRET
    const noSecret = secretIsSet()
    let saidNoSecret = ''
    try { await saveService({ userId: pat.id, actor, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: KEY, model: MODEL }) }
    catch (e) { saidNoSecret = e instanceof AiServiceError ? `${e.code}: ${e.message}` : causesOf(e) }
    process.env.AI_KEY_SECRET = keep

    await clearService(pat.id, actor)
    const gone = await serviceState(pat.id)
    // The NEWEST row must be the forgetting itself — not the save before it.
    const [audit] = await db.execute<{ action: string; actor: string; before: { key_hint: string } | null }>(raw`
      SELECT action, actor, before FROM audit_log
       WHERE table_name = 'user_ai_service' ORDER BY id DESC LIMIT 1`)
    const [{ n }] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM audit_log WHERE table_name = 'user_ai_service' AND audit_log::text LIKE ${'%' + KEY + '%'}`)
    // Save it again for the checks after this one.
    try { await saveService({ userId: pat.id, actor, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: KEY, model: MODEL }) }
    catch { /* a mutant may refuse; the checks above have already spoken */ }
    check(lost.kind === 'unreadable' && lost.hint === hintOf(KEY) && asked.error?.includes('can no longer be read') === true
          && noSecret === false && saidNoSecret.startsWith('NO_SECRET') && saidNoSecret.includes('AI_KEY_SECRET')
          && gone.kind === 'none' && audit?.action === 'clear_ai_service' && audit.actor === actor
          && audit.before?.key_hint === hintOf(KEY) && n === '0',
      'AI18 a changed secret makes the key unreadable and says so; with no secret nothing saves; forgetting removes it and is trailed without it',
      `changed secret → ${lost.kind}; no secret → ${saidNoSecret.slice(0, 40)}; cleared → ${gone.kind}, newest trail row ${audit?.action}; rows carrying the key: ${n}`)
  }

  // ------------------------------------------------------------------- AI9
  {
    const s = stub({})
    let empty = '', long = ''
    try { await ask({ ledgerId: L, question: '   ', actor, ...mine }, s.send) } catch (e) { empty = e instanceof AssistantError ? e.code : causesOf(e) }
    // TWO CAPS, EACH AT ITS OWN DOOR (2026-09-16). They were one number doing
    // two jobs: `ask` composes a question around what a person wrote — reading
    // a bill sends a long instruction with it — so capping the composed thing
    // at the PERSON's limit meant every line added to that prompt shortened
    // what somebody was allowed to type, until the longest legal sentence
    // stopped fitting at all (B31). So `ask` guards what leaves the machine,
    // and `inquire` guards what a person may write. Both still guard.
    try { await ask({ ledgerId: L, question: 'x'.repeat(PROMPT_MAX + 1), actor, ...mine }, s.send) } catch (e) { long = e instanceof AssistantError ? e.code : causesOf(e) }
    check(empty === 'EMPTY' && long === 'TOO_LONG' && s.seen.length === 0,
      'AI9 an empty or over-long question is refused before anything is sent',
      `${empty}, past ${PROMPT_MAX}: ${long}; sent ${s.seen.length}. The person's own cap is IQ-typed.`)
  }

  // ------------------------------------------------------------------ AI10
  {
    const s = stub({})
    await ask({ ledgerId: south.ledger.id, question: 'South?', actor, ...mine }, s.send)
    const here = await exchangesFor(L)
    const there = await exchangesFor(south.ledger.id)
    check(here.every((x) => x.ledger_id === L) && there.length === 1 && there[0].question === 'South?' && !here.some((x) => x.question === 'South?'),
      'AI10 each company sees its own exchanges only', `${here.length} here, ${there.length} there`)
  }

  // ------------------------------------------------------------------ AI12
  {
    const s = stub({})
    let said = ''
    try { await ask({ ledgerId: '00000000-0000-4000-8000-000000000000', question: 'Anyone there?', actor, ...mine }, s.send) }
    catch (e) { said = e instanceof AssistantError ? e.code : causesOf(e) }
    const [{ n }] = await db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM ai_exchange WHERE question = 'Anyone there?'`)
    check(said === 'NO_LEDGER' && s.seen.length === 0 && n === '0',
      'AI12 a ledger that does not exist is refused before the question leaves', `${said}; sent ${s.seen.length}; rows ${n}`)
  }

  // ------------------------------------------------------------------ AI13
  // The real sender, against the suite's own service: the wire shape out —
  // POST {address}/chat/completions, a bearer token, the model, the system
  // text and the question as two messages — and the answer read back in.
  {
    seen.length = 0; script = 'answer'
    const r = await sendToRelay({ system: 'SYSTEM TEXT', question: 'How many?' }, service)
    const w = seen[0]
    const b = w?.body as { model?: string; max_tokens?: number; messages?: Array<{ role: string; content: string }> } | undefined
    check(seen.length === 1 && w.method === 'POST' && w.path === '/v1/chat/completions' && w.authorization === `Bearer ${KEY}`
          && b?.model === MODEL && typeof b?.max_tokens === 'number'
          && b?.messages?.length === 2 && b.messages[0].role === 'system' && b.messages[0].content === 'SYSTEM TEXT'
          && b.messages[1].role === 'user' && b.messages[1].content === 'How many?'
          && r.text === 'Forty-two.' && r.stopReason === 'end_turn' && r.model === MODEL
          // prompt_tokens 120 INCLUDES the 20 cached: the row keeps 100 uncached + 20 cached, never 140
          && r.usage.input === 100 && r.usage.output === 7 && r.usage.cacheRead === 20 && r.usage.cacheWrite === 0,
      'AI13 the sender speaks the OpenAI-compatible shape: one POST, a bearer token, two messages, the first choice read back; cached tokens are not counted twice',
      w ? `${w.method} ${w.path} auth=${w.authorization?.slice(0, 12)}…; model ${b?.model}; ${b?.messages?.length} messages; reply ${r.stopReason} ${r.usage.input}/${r.usage.output}/${r.usage.cacheRead}` : 'the service saw nothing')

    // Caught, not awaited bare: a mutant that turns a refusal into an error
    // must make this line red, not kill the suite (block 435 did, once).
    const tryReply = async (): Promise<Reply | { failed: string }> => {
      try { return await sendToRelay({ system: 'S', question: 'Q' }, service) } catch (e) { return { failed: e instanceof Error ? e.message : String(e) } }
    }
    script = 'filter'
    const f = await tryReply()
    script = 'refusal-field'
    const g = await tryReply()
    const isRefusal = (x: Reply | { failed: string }): x is Reply => !('failed' in x) && x.stopReason === 'refusal' && x.text === null
    check(isRefusal(f) && (f.explanation ?? '').includes('content_filter')
          && isRefusal(g) && g.explanation === 'I cannot help with that.',
      'AI13b a content filter and a refusal text are both a refusal with an explanation, never an empty answer',
      `filter: ${'failed' in f ? `FAILED ${f.failed.slice(0, 50)}` : `${f.stopReason} "${f.explanation}"`}; refusal field: ${'failed' in g ? `FAILED ${g.failed.slice(0, 50)}` : `${g.stopReason} "${g.explanation}"`}`)

    script = 'error'
    const err = await tryReply()
    script = 'not-json'
    const notJson = await tryReply()
    check('failed' in err && err.failed.startsWith('401') && err.failed.includes('invalid key')
          && 'failed' in notJson && notJson.failed.includes('not JSON'),
      'AI13c a refused key and a page of HTML are errors that say what came back, not a crash or a blank answer',
      `401: ${'failed' in err ? err.failed.slice(0, 60) : 'no error'}; html: ${'failed' in notJson ? notJson.failed.slice(0, 50) : 'no error'}`)

    script = 'empty'
    const empty = await tryReply()
    const x = await ask({ ledgerId: L, question: 'Say nothing.', actor, ...mine })
    check('failed' in empty && empty.failed.includes('no text') && empty.failed.includes('finish_reason stop')
          && x.answer === null && (x.error ?? '').includes('no text'),
      'AI13d an empty 200 is a failed asking that names the finish reason, and the row says so',
      `${'failed' in empty ? empty.failed.slice(0, 60) : 'no error'}; row error ${x.error?.slice(0, 40)}`)
    script = 'answer'

    // The address however it was pasted: with the whole path on the end, the path is not doubled.
    seen.length = 0
    const pasted = serviceFrom({ baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: KEY, model: MODEL })!
    await sendToRelay({ system: 'S', question: 'Q' }, pasted)
    // With credentials and a query string typed into it: both are dropped
    // before fetch sees the address, so neither can be quoted into an error.
    const SECRET = 'p-typed-into-the-address'
    const messy = serviceFrom({ baseUrl: `http://u:${SECRET}@127.0.0.1:${port}/v1/?x=1#f`, apiKey: KEY, model: MODEL })!
    const pastedPath = seen[0]?.path
    seen.length = 0
    const m = await ask({ ledgerId: L, question: 'Messy address?', actor, service: messy, prices: null })
    const [{ leaked }] = await db.execute<{ leaked: string }>(raw`
      SELECT count(*)::text AS leaked FROM ai_exchange WHERE ai_exchange::text LIKE ${'%' + SECRET + '%'}`)
    const ftp = serviceFrom({ baseUrl: 'ftp://relay.example/v1', apiKey: KEY, model: MODEL })
    const notUrl = serviceFrom({ baseUrl: 'relay.example/v1', apiKey: KEY, model: MODEL })
    check(pastedPath === '/v1/chat/completions' && hostOf(pasted.baseUrl) === `127.0.0.1:${port}`
          && messy.baseUrl === `http://127.0.0.1:${port}/v1` && seen[0]?.path === '/v1/chat/completions'
          && m.answer === 'Forty-two.' && leaked === '0' && ftp === null && notUrl === null,
      'AI13e an address is reduced to origin and path: a pasted /chat/completions, a user:password, a query — none reach the wire or a row',
      `pasted → ${pastedPath}; messy → ${messy.baseUrl} → ${seen[0]?.path}; rows with the typed password: ${leaked}; ftp ${ftp}, bare ${notUrl}`)
  }

  // ------------------------------------------------------------------ AI14
  // The key is in nothing that is written. A service that echoes the bearer
  // token in its error body is the back door: the row keeps '[key]' instead.
  // And no row anywhere — question, answer, books, error, service, model —
  // carries it, whichever way the asking went.
  {
    script = 'error-echo'
    const x = await ask({ ledgerId: L, question: 'Echo my key back?', actor, ...mine })
    script = 'answer'
    // The WHOLE row as text, so a column added by a later migration cannot
    // fall outside the proof.
    const [{ n }] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM ai_exchange WHERE ai_exchange::text LIKE ${'%' + KEY + '%'}`)
    check((x.error ?? '').includes('[key]') && !(x.error ?? '').includes(KEY) && n === '0'
          && withoutKey(`bad ${KEY} twice ${KEY}`, KEY) === 'bad [key] twice [key]' && withoutKey(null, KEY) === null,
      'AI14 the key is in no row: a service that echoes it in an error is recorded with it struck out',
      `error: ${x.error?.slice(0, 50)}; rows carrying the key: ${n}`)
  }

  // ------------------------------------------------------------------ AI19
  // The panel, rendered in each state it can be in: it says where the secret
  // goes when there is none, names the saved service by its hint, and in no
  // state does the key or the ciphertext reach the markup — the only thing
  // between `serviceState` and the browser is the hand-built PanelState on
  // the page, and nothing else watches it (critic).
  {
    const render = (state: unknown, secretSet: boolean) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-assistant-panel.tsx', JSON.stringify({ state, secretSet }),
      // WITHOUT this suite's react-server condition, which the child would
      // otherwise inherit and react-dom/server would refuse under.
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const cipherHex = (await db.execute<{ enc_hex: string }>(raw`
      SELECT encode(key_enc, 'hex') AS enc_hex FROM user_ai_service WHERE user_id = ${pat.id}::uuid`))[0]?.enc_hex ?? ''
    // The props the PAGE would hand the client component — the boundary, since
    // a client component's props reach the browser whether or not they are
    // printed. Built by the same function the page calls, not by this check.
    const readyProps = panelStateFrom(await serviceState(pat.id))
    const propsJson = JSON.stringify(readyProps)
    const lostProps = panelStateFrom({ kind: 'unreadable', host: `127.0.0.1:${port}`,
                                       baseUrl: `http://127.0.0.1:${port}/v1`, model: MODEL, hint: hintOf(KEY) })
    const ready = render(readyProps, true)
    const none = render(panelStateFrom({ kind: 'none' }), true)
    const noSecret = render(panelStateFrom({ kind: 'none' }), false)
    const lost = render(lostProps, true)
    const carriesKey = propsJson.includes(KEY) || propsJson.includes(cipherHex)
    const clean = !carriesKey && [ready, none, noSecret, lost].every((h) => !h.includes(KEY) && !h.includes(cipherHex))
    check(clean
          && readyProps.kind === 'ready' && readyProps.hint === hintOf(KEY)
          && ready.includes(`…${hintOf(KEY)}`) && ready.includes(MODEL)
          && noSecret.includes('AI_KEY_SECRET') && noSecret.includes('.env.local')
          && !none.includes('AI_KEY_SECRET')
          && lost.includes('can no longer be read') && lost.includes(`http://127.0.0.1:${port}/v1`),
      'AI19 what the page hands the panel carries no key and no ciphertext, and the panel names the service by its hint and says where the secret goes',
      `props carry the key: ${carriesKey} (${propsJson.length} chars); markup clean: ${clean}; ready ${ready.length}, none ${none.length}, no secret ${noSecret.length}, unreadable ${lost.length}`)
  }

  // ------------------------------------------------------------------ AI11
  {
    check(MODULE_PATHS.includes('/assistant') && existsSync('src/app/ledger/[ledgerId]/assistant/page.tsx'),
      'AI11 the assistant remains a grantable seat with a page behind the shared + AI entry', MODULE_PATHS.join(' '))
  }

  relay.close()
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

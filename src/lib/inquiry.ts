import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import {
  AssistantError, QUESTION_MAX, hostOf, sendToRelay, withoutKey,
  type Prices, type Reply, type Send, type Service,
} from './assistant'
import { accessFor, refuseForLedger } from './access'
import { ledgerHead } from './ledger-head'
import { runTool, toolList, type ToolContext } from './inquiry-tools'
import {
  availableSkills, parseSkillRoute, routerSystem, skillById, type SkillCommandExecution, type SkillId,
} from './assistant-skills'
import type { UserRecord } from './users'
import { MCP_PROPOSAL_MODEL, MCP_PROPOSAL_SYSTEM } from './mcp-proposal-inputs'

/**
 * Asking the books (docs/design/38-a-sentence-to-the-books.md).
 *
 * The model looks things up with read-only tools, one JSON object per turn,
 * and answers in a paragraph. Every request is built from rows that are
 * already committed: the question and system text before the first request,
 * each step before the next. Nothing about a question is stored that can be
 * derived from its steps — the answer, the totals, why it stopped, whether
 * Keep looking is offered.
 */

export const LOOKUPS_PER_ROUND = 8
export const ROUND_MS = 5 * 60_000
/** Every tool result and every reply of one question, together. */
export const QUESTION_CHARS = 60_000

export type Outcome =
  | 'route' | 'clarify' | 'call' | 'unreadable' | 'too_much' | 'answer' | 'answer_unformatted'
  | 'refusal' | 'error' | 'cut_off' | 'call_after_limit' | 'too_slow' | 'more'

export type Step = {
  n: number
  at: string
  outcome: Outcome
  model_text: string | null
  stop_reason: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  error: string | null
  tool: string | null
  args: Record<string, unknown> | null
  result: string | null
  capped: boolean
  asked_by: string | null
}

export type InquiryHead = {
  id: string
  ledger_id: string
  asked_at: string
  asked_by: string
  question: string
  system: string
  model: string
  service: string | null
  price_input: string | null
  price_output: string | null
  price_cached: string | null
  price_unit: string | null
}

export type InquiryRoute = {
  skill: SkillId
  routed_at: string
  route_reason: string
  request: string
  system: string
}

export type Inquiry = InquiryHead & {
  steps: Step[]
  /** Absent on questions saved before the ERP Skill Router was introduced. */
  route?: InquiryRoute | null
  executions?: SkillCommandExecution[]
}

const UNREADABLE = 'That was not the agreed format. Reply with exactly one JSON object: '
  + '{"call":"<tool>","args":{...},"why":"..."} or {"answer":"..."}.'
const TOO_MUCH = 'This question has looked up too much to go on. Answer with what you have.'
const LAST_TURN = 'No more look-ups: answer now with what you have, and say what you could not settle.'
const NOT_RUN = '(this look-up was not run)'
const PRESSED = 'The person asked you to keep looking.'

const INQUIRY_SYSTEM = [
  'You answer questions about one company\'s books inside a small accounting application kept by the owner of a few',
  'private companies in British Columbia, Canada. The books are kept under IFRS, in Canadian dollars.',
  '',
  'Look things up with the tools listed below. Reply with exactly ONE JSON object and nothing else — either',
  '{"call":"<tool>","args":{...},"why":"<one sentence>"} to look something up, or {"answer":"<your answer>"} when you can answer.',
  '',
  'Rules:',
  '- Answer in the language the question is asked in.',
  '- Every figure in your answer must come from a tool result or from the calculate tool. Do not add, subtract or',
  '  estimate in your head: use totals for sums over many rows, and calculate for anything else.',
  '- Amounts in results are dollars with two decimals. The first lines of each result say what a positive number means.',
  '- To link to a page, copy an address exactly as it appears in a result, written as [label](address). Never make one up.',
  '- If you cannot settle something, say plainly what is missing and which tool, with which arguments, would settle it.',
  '- You cannot change the books.',
].join('\n')

// ------------------------------------------------------------------ reading --

export type Parsed =
  | { kind: 'call'; tool: string; args: Record<string, unknown>; why: string }
  | { kind: 'answer'; text: string }
  | { kind: 'unreadable' }

const asObject = (s: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(s)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** One reply, read by the protocol: an answer, a call, or neither. */
export function parseReply(text: string | null): Parsed {
  if (text === null) return { kind: 'unreadable' }
  const bare = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let o = asObject(bare)
  if (!o) {
    const i = bare.indexOf('{')
    const j = bare.lastIndexOf('}')
    if (i !== -1 && j > i) o = asObject(bare.slice(i, j + 1))
  }
  if (!o) return { kind: 'unreadable' }
  const hasCall = Object.hasOwn(o, 'call')
  const hasAnswer = Object.hasOwn(o, 'answer')
  if (hasAnswer && !hasCall && typeof o.answer === 'string') return { kind: 'answer', text: o.answer }
  if (hasCall && !hasAnswer && typeof o.call === 'string') {
    const args = o.args !== null && typeof o.args === 'object' && !Array.isArray(o.args)
      ? o.args as Record<string, unknown> : {}
    return { kind: 'call', tool: o.call, args, why: typeof o.why === 'string' ? o.why : '' }
  }
  return { kind: 'unreadable' }
}

// ----------------------------------------------------------------- counting --

/** A reply that asked for a look-up, whether or not the look-up ran. */
const LOOKUP: ReadonlySet<Outcome> = new Set<Outcome>(['call', 'unreadable', 'too_much', 'too_slow'])
/** A step after which the loop sends another request. */
const GOES_ON: ReadonlySet<Outcome> = new Set<Outcome>(['call', 'unreadable', 'too_much'])

/** Look-ups since the question, or since the person last pressed Keep looking. */
export function lookupsThisRound(steps: Step[]): number {
  let count = 0
  for (const s of steps) {
    if (s.outcome === 'more') count = 0
    else if (LOOKUP.has(s.outcome)) count++
  }
  return count
}

export function answerOnly(steps: Step[]): boolean {
  return lookupsThisRound(steps) >= LOOKUPS_PER_ROUND || (steps.at(-1)?.capped ?? false)
}

export const charsSoFar = (steps: Step[]): number =>
  steps.reduce((t, s) => t + (s.model_text?.length ?? 0) + (s.result?.length ?? 0), 0)

/**
 * Whether the question stopped for want of look-ups, so that another round
 * could help. Not after a refusal, a failure or a cut-off reply, and never
 * once any step reached the question's character limit.
 */
export function offersKeepLooking(steps: Step[]): boolean {
  if (steps.some((s) => s.capped)) return false
  const last = steps.at(-1)
  if (!last) return false
  if (last.outcome === 'call_after_limit' || last.outcome === 'too_slow') return true
  if (last.outcome === 'answer' || last.outcome === 'answer_unformatted') {
    return lookupsThisRound(steps.slice(0, -1)) >= LOOKUPS_PER_ROUND
  }
  return false
}

/** The user message of a request, rebuilt the same way from the same rows. */
export function transcript(question: string, steps: Step[], lastTurn: boolean): string {
  const parts = [`Question: ${question}`]
  for (const s of steps) {
    // Routing belongs to the audit trail, not to the selected skill's chat.
    if (s.outcome === 'route' || s.outcome === 'clarify') continue
    if (s.outcome === 'more') {
      parts.push(PRESSED)
      continue
    }
    parts.push(`You replied:\n${s.model_text ?? ''}`)
    if (s.outcome === 'call_after_limit' || s.outcome === 'too_slow') parts.push(NOT_RUN)
    else if (s.result !== null) parts.push(`Result:\n${s.result}`)
  }
  if (lastTurn) parts.push(LAST_TURN)
  return parts.join('\n\n')
}

// ------------------------------------------------------------------ figures --

/** A two-decimal amount in a tool result, as absolute cents. */
const LOOKED_UP = /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?!\d)/g

/** Every amount this question's sent results carry — what an answer may cite. */
export function lookedUp(steps: Step[]): Set<bigint> {
  const known = new Set<bigint>()
  for (const s of steps) {
    if (s.result === null) continue
    for (const m of s.result.matchAll(LOOKED_UP)) {
      known.add(BigInt(m[1].replace(/,/g, '')) * 100n + BigInt(m[2]))
    }
  }
  return known
}

/**
 * An amount in an answer: two decimals, or a dollar sign, or thousands
 * commas. A bare whole number — a year, a count of days — is not one, and
 * neither is a percentage.
 */
const FIGURE = /(?<![\d.,])(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d%]|[.,]\d)/g

export function figuresIn(text: string): Array<{ index: number; text: string; cents: bigint }> {
  const out: Array<{ index: number; text: string; cents: bigint }> = []
  // A comma straight after an amount's cents separates two amounts; a space of
  // the same length keeps every index where it was.
  const scan = text.replace(/(?<=\.\d{2}),(?=\d)/g, ' ')
  for (const m of scan.matchAll(FIGURE)) {
    const [whole, dollar, int, frac] = m
    if (frac !== undefined && frac.length !== 2) continue
    if (frac === undefined && !dollar && !int.includes(',')) continue
    out.push({ index: m.index, text: whole, cents: BigInt(int.replace(/,/g, '')) * 100n + BigInt(frac ?? '0') })
  }
  return out
}

/**
 * The addresses in this ledger that a result carried, without the punctuation a
 * sentence leaves on them. A link in an answer is clickable only if it is one of
 * these, exactly — an address to another ledger stays text even when some
 * description or bank line happens to spell it out.
 */
export function sentLinks(steps: Step[], ledgerId: string): Set<string> {
  const mine = `/ledger/${ledgerId}/`
  const links = new Set<string>()
  for (const s of steps) {
    for (const m of (s.result ?? '').matchAll(/\/ledger\/[^\s|]+/g)) {
      const link = m[0].replace(/[.,;:!?)\]'"]+$/, '')
      if (link.startsWith(mine) && !/\/\.\.?(\/|\?|$)/.test(link)) links.add(link)
    }
  }
  return links
}

export type AnswerPart = { text: string; href?: string; unverified?: boolean }

const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g

/** The answer as the page prints it: links only where a result gave them, figures marked where nothing did. */
export function answerParts(answer: string, steps: Step[], ledgerId: string): AnswerPart[] {
  const known = lookedUp(steps)
  const links = sentLinks(steps, ledgerId)
  const parts: AnswerPart[] = []
  const plain = (t: string) => {
    let at = 0
    for (const f of figuresIn(t)) {
      if (f.index > at) parts.push({ text: t.slice(at, f.index) })
      parts.push(known.has(f.cents) ? { text: f.text } : { text: f.text, unverified: true })
      at = f.index + f.text.length
    }
    if (at < t.length) parts.push({ text: t.slice(at) })
  }
  let at = 0
  for (const m of answer.matchAll(LINK)) {
    plain(answer.slice(at, m.index))
    const [whole, label, href] = m
    if (links.has(href)) {
      const unmatched = figuresIn(label).some((f) => !known.has(f.cents))
      parts.push(unmatched ? { text: label, href, unverified: true } : { text: label, href })
    } else plain(whole)
    at = m.index + whole.length
  }
  plain(answer.slice(at))
  return parts
}

/** The answer a question ended with, if it has one. */
export function answerOf(steps: Step[]): { text: string; unformatted: boolean } | null {
  const last = steps.at(-1)
  if (!last) return null
  if (last.outcome === 'answer') {
    const p = parseReply(last.model_text)
    return p.kind === 'answer' ? { text: p.text, unformatted: false } : null
  }
  if (last.outcome === 'answer_unformatted') return { text: last.model_text ?? '', unformatted: true }
  return null
}

export function costOfInquiry(q: Inquiry): number | null {
  if (q.price_input === null || q.price_output === null) return null
  const input = Number(q.price_input)
  const output = Number(q.price_output)
  const cached = q.price_cached === null ? input / 10 : Number(q.price_cached)
  const t = q.steps.reduce((acc, s) => ({
    input: acc.input + s.input_tokens, output: acc.output + s.output_tokens, cached: acc.cached + s.cache_read_tokens,
  }), { input: 0, output: 0, cached: 0 })
  return (t.input * input + t.output * output + t.cached * cached) / 1_000_000
}

// -------------------------------------------------------------------- rows --

const STEP_COLUMNS = sql.raw(`n, at::text, outcome, model_text, stop_reason, input_tokens, output_tokens,
  cache_read_tokens, error, tool, args, result, capped, asked_by`)
const HEAD_COLUMNS = sql.raw(`id::text, ledger_id::text, asked_at::text, asked_by, question, system, model, service,
  price_input::text, price_output::text, price_cached::text, price_unit`)

type NewStep = Omit<Step, 'at' | 'asked_by'>

async function writeStep(inquiryId: string, s: NewStep, key: string): Promise<Step> {
  const [row] = await db.execute<Step>(sql`
    INSERT INTO ai_inquiry_step (inquiry_id, n, outcome, model_text, stop_reason, input_tokens, output_tokens,
                                 cache_read_tokens, error, tool, args, result, capped)
    VALUES (${inquiryId}::uuid, ${s.n}, ${s.outcome}, ${withoutKey(s.model_text, key)},
            ${withoutKey(s.stop_reason, key)}, ${s.input_tokens}, ${s.output_tokens}, ${s.cache_read_tokens},
            ${withoutKey(s.error, key)}, ${withoutKey(s.tool, key)},
            ${s.args === null ? null : withoutKey(JSON.stringify(s.args), key)}::jsonb,
            ${withoutKey(s.result, key)}, ${s.capped})
    RETURNING ${STEP_COLUMNS}`)
  return row
}

async function stepsOf(inquiryId: string): Promise<Step[]> {
  return db.execute<Step>(sql`
    SELECT ${STEP_COLUMNS} FROM ai_inquiry_step WHERE inquiry_id = ${inquiryId}::uuid ORDER BY n`)
}

async function routeOf(inquiryId: string): Promise<InquiryRoute | null> {
  const [route] = await db.execute<InquiryRoute>(sql`
    SELECT skill, routed_at::text, route_reason, request, system
      FROM ai_inquiry_skill WHERE inquiry_id = ${inquiryId}::uuid`)
  return route ?? null
}

const isDuplicate = (e: unknown): boolean => {
  for (let c: unknown = e; c; c = (c as { cause?: unknown }).cause) {
    if ((c as { code?: unknown }).code === '23505') return true
  }
  return false
}

// -------------------------------------------------------------------- loop --

type Round = {
  head: InquiryHead
  ctx: ToolContext
  service: Service
  skill?: SkillId
  system?: string
  question?: string
}

/**
 * Requests until the model answers, stops, or the round runs out. Each step
 * is written before the next request is sent, so the rows always hold every
 * thing a request that has left carried.
 */
async function runRound(round: Round, steps: Step[], send: Send, clock: () => number): Promise<Step[]> {
  const started = clock()
  const { head, service } = round
  const ctx = round.skill ? { ...round.ctx, skill: round.skill } : round.ctx
  const system = round.system ?? head.system
  const question = round.question ?? head.question
  for (;;) {
    const lastTurn = answerOnly(steps)
    let reply: Reply | null = null
    let error: string | null = null
    try {
      reply = await send({ system, question: transcript(question, steps, lastTurn) }, service)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const base: NewStep = {
      n: (steps.at(-1)?.n ?? 0) + 1,
      outcome: 'error',
      model_text: reply?.text ?? null,
      stop_reason: reply?.stopReason ?? null,
      input_tokens: reply?.usage.input ?? 0,
      output_tokens: reply?.usage.output ?? 0,
      cache_read_tokens: reply?.usage.cacheRead ?? 0,
      error,
      tool: null,
      args: null,
      result: null,
      capped: false,
    }
    let step: NewStep
    if (!reply) {
      step = base
    } else if (reply.stopReason === 'max_tokens') {
      step = { ...base, outcome: 'cut_off' }
    } else if (reply.stopReason === 'refusal') {
      step = { ...base, outcome: 'refusal', error: reply.explanation ?? 'The model declined to answer.' }
    } else {
      const parsed = parseReply(reply.text)
      if (parsed.kind === 'answer') {
        step = { ...base, outcome: 'answer' }
      } else if (lastTurn) {
        step = parsed.kind === 'call'
          ? { ...base, outcome: 'call_after_limit', tool: parsed.tool, args: parsed.args }
          : { ...base, outcome: 'answer_unformatted' }
      } else {
        const call = parsed.kind === 'call' ? parsed : null
        let result = call ? await runTool(ctx, call.tool, call.args, lookedUp(steps)) : UNREADABLE
        let outcome: Outcome = call ? 'call' : 'unreadable'
        let capped = false
        if (charsSoFar(steps) + (reply.text?.length ?? 0) + result.length > QUESTION_CHARS) {
          outcome = 'too_much'
          result = TOO_MUCH
          capped = true
        }
        const late = clock() - started > ROUND_MS
        step = {
          ...base,
          outcome: late ? 'too_slow' : outcome,
          tool: call?.tool ?? null,
          args: call?.args ?? null,
          result: late ? null : result,
          capped,
        }
      }
    }
    const saved = await writeStep(head.id, step, service.apiKey)
    steps = [...steps, saved]
    if (!GOES_ON.has(saved.outcome)) return steps
  }
}

async function contextFor(ledgerId: string, user: UserRecord): Promise<ToolContext> {
  const head = await ledgerHead(ledgerId)
  if (!head) throw new AssistantError('NO_LEDGER', 'That company does not exist.')
  return { ledgerId, entityId: head.entity_id, entityName: head.entity, user }
}

function checkService(service: Service | null): Service {
  if (!service) {
    throw new AssistantError('NOT_CONFIGURED',
      'Save your service first — its address, your key and a model name, in the box above.')
  }
  return service
}

/** Ask the books one question. Refused before anything is written or sent when it cannot be asked at all. */
export async function inquire(input: {
  ledgerId: string; question: string; user: UserRecord; service: Service | null; prices: Prices | null
}, send: Send = sendToRelay, clock: () => number = Date.now): Promise<Inquiry> {
  const service = checkService(input.service)
  const refused = await refuseForLedger(input.user, input.ledgerId, '/assistant')
  if (refused) throw new AssistantError('NO_SEAT', refused.message)
  const question = input.question.trim()
  if (!question) throw new AssistantError('EMPTY', 'Ask something.')
  if (question.length > QUESTION_MAX) {
    throw new AssistantError('TOO_LONG', `That is longer than ${QUESTION_MAX} characters. Ask it in parts.`)
  }
  const ctx = await contextFor(input.ledgerId, input.user)
  const tools = await toolList(ctx)
  const system = [INQUIRY_SYSTEM, '', 'Tools:', ...tools.map((t) => `- ${t.name} ${t.args}: ${t.does}`)].join('\n')
  const key = service.apiKey
  const p = input.prices
  const [head] = await db.execute<InquiryHead>(sql`
    INSERT INTO ai_inquiry (ledger_id, asked_by, question, system, model, service,
                            price_input, price_output, price_cached, price_unit)
    VALUES (${input.ledgerId}::uuid, ${input.user.email}, ${withoutKey(question, key)}, ${withoutKey(system, key)},
            ${withoutKey(service.model, key)}, ${hostOf(service.baseUrl)},
            ${p?.input ?? null}, ${p?.output ?? null}, ${p?.cached ?? null}, ${withoutKey(p?.unit ?? null, key)})
    RETURNING ${HEAD_COLUMNS}`)
  const steps = await runRound({ head, ctx, service }, [], send, clock)
  return { ...head, steps }
}

const moduleSystem = (skill: SkillId, tools: Awaited<ReturnType<typeof toolList>>): string => {
  const selected = skillById(skill)
  return [
    INQUIRY_SYSTEM,
    '',
    `Selected ERP skill: ${selected.label} (${selected.id}).`,
    selected.instructions,
    selected.mode === 'confirm'
      ? 'A draft tool only proposes a change. Never say it was saved; the person must confirm the proposal in Banyan.'
      : 'This skill is read-only. Do not propose a tool or workflow that changes data.',
    '',
    'Tools:',
    ...tools.map((tool) => `- ${tool.name} ${tool.args}: ${tool.does}`),
  ].join('\n')
}

const routerBase = (reply: Reply | null, error: string | null): NewStep => ({
  n: 1,
  outcome: 'error',
  model_text: reply?.text ?? null,
  stop_reason: reply?.stopReason ?? null,
  input_tokens: reply?.usage.input ?? 0,
  output_tokens: reply?.usage.output ?? 0,
  cache_read_tokens: reply?.usage.cacheRead ?? 0,
  error,
  tool: null,
  args: null,
  result: null,
  capped: false,
})

/**
 * The normal UI entrypoint: decide which ERP capability owns the request,
 * persist that decision, then expose only that capability's tools.  The old
 * `inquire` entrypoint remains for reconstructing and testing pre-router
 * questions; every new form submission comes through here.
 */
export async function inquireRouted(input: {
  ledgerId: string; question: string; user: UserRecord; service: Service | null; prices: Prices | null
}, send: Send = sendToRelay, clock: () => number = Date.now): Promise<Inquiry> {
  const service = checkService(input.service)
  const routeDenied = await refuseForLedger(input.user, input.ledgerId, '/assistant')
  if (routeDenied) throw new AssistantError('NO_SEAT', routeDenied.message)
  const question = input.question.trim()
  if (!question) throw new AssistantError('EMPTY', 'Ask something.')
  if (question.length > QUESTION_MAX) {
    throw new AssistantError('TOO_LONG', `That is longer than ${QUESTION_MAX} characters. Ask it in parts.`)
  }

  const ctx = await contextFor(input.ledgerId, input.user)
  const skills = await availableSkills(input.ledgerId, input.user)
  const system = routerSystem(skills)
  const key = service.apiKey
  const p = input.prices
  const [head] = await db.execute<InquiryHead>(sql`
    INSERT INTO ai_inquiry (ledger_id, asked_by, question, system, model, service,
                            price_input, price_output, price_cached, price_unit)
    VALUES (${input.ledgerId}::uuid, ${input.user.email}, ${withoutKey(question, key)}, ${withoutKey(system, key)},
            ${withoutKey(service.model, key)}, ${hostOf(service.baseUrl)},
            ${p?.input ?? null}, ${p?.output ?? null}, ${p?.cached ?? null}, ${withoutKey(p?.unit ?? null, key)})
    RETURNING ${HEAD_COLUMNS}`)

  let reply: Reply | null = null
  let error: string | null = null
  try {
    reply = await send({ system: head.system, question: head.question }, service)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const base = routerBase(reply, error)
  if (!reply) {
    const step = await writeStep(head.id, base, key)
    return { ...head, steps: [step], route: null, executions: [] }
  }
  if (reply.stopReason === 'max_tokens') {
    const step = await writeStep(head.id, { ...base, outcome: 'cut_off' }, key)
    return { ...head, steps: [step], route: null, executions: [] }
  }
  if (reply.stopReason === 'refusal') {
    const step = await writeStep(head.id, {
      ...base, outcome: 'refusal', error: reply.explanation ?? 'The model declined to route the request.',
    }, key)
    return { ...head, steps: [step], route: null, executions: [] }
  }

  const routed = parseSkillRoute(reply.text, new Set(skills.map((skill) => skill.id)))
  if (routed.kind === 'unreadable') {
    const step = await writeStep(head.id, {
      ...base, outcome: 'unreadable',
      result: 'The request could not be routed to one permitted ERP skill. Ask it again with the module named.',
    }, key)
    return { ...head, steps: [step], route: null, executions: [] }
  }
  if (routed.kind === 'clarify') {
    const step = await writeStep(head.id, {
      ...base, outcome: 'clarify', args: { choices: routed.choices }, result: withoutKey(routed.question, key),
    }, key)
    return { ...head, steps: [step], route: null, executions: [] }
  }

  const routeStep = await writeStep(head.id, {
    ...base, outcome: 'route',
    args: { skill: routed.skill, request: routed.request, reason: routed.reason },
  }, key)
  const scopedTools = await toolList({ ...ctx, skill: routed.skill }, routed.skill)
  const scopedSystem = moduleSystem(routed.skill, scopedTools)
  const [route] = await db.execute<InquiryRoute>(sql`
    INSERT INTO ai_inquiry_skill (inquiry_id, skill, route_reason, request, system)
    VALUES (${head.id}::uuid, ${routed.skill}, ${withoutKey(routed.reason, key)},
            ${withoutKey(routed.request, key)}, ${withoutKey(scopedSystem, key)})
    RETURNING skill, routed_at::text, route_reason, request, system`)
  const steps = await runRound({
    head, ctx, service, skill: route.skill, system: route.system, question: route.request,
  }, [routeStep], send, clock)
  return { ...head, steps, route, executions: [] }
}

/**
 * Whether a saved service is the one a question was asked with — the same host
 * and model. Another round goes only there, so the record of where the question
 * went stays true; the page asks this too before it offers the button.
 */
export function askedWith(q: { service: string | null; model: string }, service: Service): boolean {
  return hostOf(service.baseUrl) === q.service && service.model === q.model
}

/**
 * What the page offers under a question: the Keep looking button to the person
 * who asked it, while it stopped for want of look-ups and their saved service is
 * the one it was asked with; `'elsewhere'` when only the service differs, so the
 * page can say why there is no button; otherwise nothing.
 */
export function keepLookingOffer(q: Inquiry, viewerEmail: string, saved: Service | null): 'button' | 'elsewhere' | null {
  if (q.asked_by !== viewerEmail || saved === null || !offersKeepLooking(q.steps)) return null
  return askedWith(q, saved) ? 'button' : 'elsewhere'
}

/**
 * Why a question ended where it did, when it did not simply answer — the line
 * the page shows under it. A refusal, a failure and a cut-off say themselves
 * first, even on a question that looked up too much: the reason on record is
 * the one the person needs.
 */
export function stopLine(steps: Step[]): string | null {
  const last = steps.at(-1)
  if (!last) return 'It has not finished — it is still looking, or it stopped part way.'
  switch (last.outcome) {
    case 'refusal': return `The model declined: ${last.error ?? 'no reason given'}`
    case 'error': return `The call failed: ${last.error ?? 'no reason given'}`
    case 'cut_off': return 'The reply was cut off before it finished.'
    case 'clarify': return null
  }
  if (steps.some((s) => s.capped)) return 'This question looked up too much to go on. Ask a narrower one.'
  switch (last.outcome) {
    case 'answer':
    case 'answer_unformatted':
      return offersKeepLooking(steps) ? 'It answered at the limit of its look-ups, so it may not have found everything.' : null
    case 'call_after_limit':
    case 'too_slow': return 'It stopped at the limit before answering.'
    default: return 'It has not finished — it is still looking, or it stopped part way.'
  }
}

/**
 * Another round on the same question, pressed by the person who asked it.
 * The press is written first; the step number it takes is the primary key,
 * so a second press racing this one is refused by the table.
 */
export async function keepLooking(input: {
  ledgerId: string; inquiryId: string; user: UserRecord; service: Service | null
}, send: Send = sendToRelay, clock: () => number = Date.now): Promise<Inquiry> {
  const service = checkService(input.service)
  const seat = await refuseForLedger(input.user, input.ledgerId, '/assistant')
  if (seat) throw new AssistantError('NO_SEAT', seat.message)
  const [head] = await db.execute<InquiryHead>(sql`
    SELECT ${HEAD_COLUMNS} FROM ai_inquiry
     WHERE id = ${input.inquiryId}::uuid AND ledger_id = ${input.ledgerId}::uuid`)
  if (!head) throw new AssistantError('NO_INQUIRY', 'There is no such question in this company.')
  if (head.asked_by !== input.user.email) {
    throw new AssistantError('NOT_YOURS', 'Only the person who asked this question can keep it going.')
  }
  if (!askedWith(head, service)) {
    throw new AssistantError('SERVICE_CHANGED',
      'Your saved service has changed since this question was asked, so another round would not go where this '
      + 'record says it went. Ask the question again.')
  }
  const steps = await stepsOf(head.id)
  if (!offersKeepLooking(steps)) {
    throw new AssistantError('NOT_OFFERED', 'This question did not stop for want of look-ups, so there is nothing to continue.')
  }
  const ctx = await contextFor(input.ledgerId, input.user)
  const route = await routeOf(head.id)
  if (route) {
    const permitted = await availableSkills(input.ledgerId, input.user)
    if (!permitted.some((skill) => skill.id === route.skill)) {
      throw new AssistantError('NO_SEAT', `You no longer have access to ${skillById(route.skill).label} in this company.`)
    }
  }
  let press: Step
  try {
    ;[press] = await db.execute<Step>(sql`
      INSERT INTO ai_inquiry_step (inquiry_id, n, outcome, asked_by)
      VALUES (${head.id}::uuid, ${(steps.at(-1)?.n ?? 0) + 1}, 'more', ${input.user.email})
      RETURNING ${STEP_COLUMNS}`)
  } catch (e) {
    if (isDuplicate(e)) throw new AssistantError('ALREADY', 'This question is already being looked into again.')
    throw e
  }
  const all = await runRound({
    head, ctx, service, skill: route?.skill, system: route?.system, question: route?.request,
  }, [...steps, press], send, clock)
  return { ...head, steps: all, route }
}

/**
 * This company's questions, newest first — the viewer's own, unless the
 * viewer is an owner (`accessFor` limits everyone else, even a person granted
 * every seat). A question's steps carry what its asker's seats
 * let the tools read, which a narrower seat must not read back here.
 */
export async function inquiriesFor(ledgerId: string, viewer: UserRecord, limit = 30): Promise<Inquiry[]> {
  if (await refuseForLedger(viewer, ledgerId, '/assistant')) return []
  const access = await accessFor(viewer)
  const everyone = access.entities === null && access.modules === null
  const heads = await db.execute<InquiryHead>(sql`
    SELECT ${HEAD_COLUMNS} FROM ai_inquiry
     WHERE ledger_id = ${ledgerId}::uuid ${everyone ? sql`` : sql`AND asked_by = ${viewer.email}`}
       AND NOT (model=${MCP_PROPOSAL_MODEL} AND system=${MCP_PROPOSAL_SYSTEM})
     ORDER BY asked_at DESC, id DESC LIMIT ${limit}`)
  if (heads.length === 0) return []
  const rows = await db.execute<Step & { inquiry_id: string }>(sql`
    SELECT inquiry_id::text, ${STEP_COLUMNS} FROM ai_inquiry_step
     WHERE inquiry_id IN (${sql.join(heads.map((h) => sql`${h.id}::uuid`), sql`, `)})
     ORDER BY inquiry_id, n`)
  const routes = await db.execute<InquiryRoute & { inquiry_id: string }>(sql`
    SELECT inquiry_id::text, skill, routed_at::text, route_reason, request, system
      FROM ai_inquiry_skill
     WHERE inquiry_id IN (${sql.join(heads.map((h) => sql`${h.id}::uuid`), sql`, `)})`)
  const executions = await db.execute<SkillCommandExecution>(sql`
    SELECT inquiry_id::text, step_n, entity_id::text, executed_at::text, executed_by, tool
      FROM ai_skill_command_execution
     WHERE inquiry_id IN (${sql.join(heads.map((h) => sql`${h.id}::uuid`), sql`, `)})
     ORDER BY inquiry_id, step_n`)
  return heads.map((h) => ({
    ...h,
    steps: rows.filter((r) => r.inquiry_id === h.id)
      .map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => key !== 'inquiry_id')) as Step),
    route: routes.find((r) => r.inquiry_id === h.id) ?? null,
    executions: executions.filter((execution) => execution.inquiry_id === h.id),
  }))
}

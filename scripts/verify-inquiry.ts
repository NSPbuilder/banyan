/**
 * Asking the books: read-only look-ups, one JSON object per turn, every
 * request built from rows already written (docs/design/38).
 *   npm run db:verify-inquiry   (resets the database first)
 *
 * NOTHING HERE REACHES THE NETWORK. The model is a scripted sender that
 * answers turn by turn and keeps what it was asked; the tools run against
 * two companies with markers in their names and amounts that appear in one
 * company only, a customer with a credit note, a pay run reversed and run
 * again for a person with a SIN, and more suppliers than a result may list.
 */
import './env'
import { reporter } from './suite'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { byHand } from './by-hand'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { postEntry, reverseEntry } from '../src/lib/posting'
import { parseMoney } from '../src/lib/money'
import { createParty } from '../src/lib/parties'
import { createInvoice, postInvoice } from '../src/lib/invoices'
import { saveEmployee } from '../src/lib/payroll/employees'
import { runPayroll } from '../src/lib/payroll/runs'
import { createFirstOwner, createUser, type UserRecord } from '../src/lib/users'
import { setGrants } from '../src/lib/access'
import { AssistantError, QUESTION_MAX, earlierQuestionsFor, serviceFrom, type Reply, type Request, type Service } from '../src/lib/assistant'
import { inquireFromForm, keepLookingFromForm } from '../src/lib/inquiry-forms'
import { saveService } from '../src/lib/ai-service'
import { ASSISTANT_FIELDS as F } from '../src/lib/forms'
import { resolvePeriodSpan, trialBalanceSpan } from '../src/lib/balances'
import { REPORTS, REPORT_KEYS, reportLink } from '../src/lib/report-catalogue'
import { runTool, toolList, type ToolContext } from '../src/lib/inquiry-tools'
import {
  answerOnly, answerParts, inquire, inquiriesFor, keepLooking, keepLookingOffer, lookedUp, offersKeepLooking, parseReply,
  stopLine, transcript,
  type Step,
} from '../src/lib/inquiry'

const r = reporter(62)
const { check } = r

const NORTH = 'NORTHMARK', SOUTH = 'SOUTHMARK'
const MODEL = 'relay-model-under-test'
const KEY = 'sk-suite-secret-5b1e2d'
const SIN = '046 454 286'
const SIN_SPELLINGS = ['046454286', '046 454 286', '046-454-286']
const ACTOR = 'alicio@example.test'

const chartFor = (marker: string) => `1000,Cash ${marker},asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
2100,Payables,liability,,trade_payables
2627,Payroll liabilities,liability,,payroll_liabilities
3000,Share capital,equity,,share_capital
4000,Revenue ${marker},revenue,,revenue_from_contracts
5300,Office supplies,expense,,
9060,Salaries and wages,expense,,employee_benefits_expense`

type Scripted = Partial<Reply> | Error | ((req: Request) => Promise<Partial<Reply> | Error>)

/** A sender that answers from a script, turn by turn, and keeps every request. */
function stub(script: Scripted[], fallback?: Scripted) {
  const seen: Request[] = []
  const services: Service[] = []
  let scriptedTurn = 0
  const send = async (req: Request, service: Service): Promise<Reply> => {
    seen.push(req)
    services.push(service)
    // Form submissions now pass through the ERP Skill Router. Existing
    // inquiry-engine cases are intentionally about the selected read-only
    // skill, so route those to Books without consuming their scripted reply.
    if (req.system.startsWith('You route one request inside Banyan.')) {
      return {
        model: MODEL,
        text: JSON.stringify({ route: { skill: 'books', request: req.question, reason: 'Inquiry suite books request' } }),
        stopReason: 'end_turn', explanation: null,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      }
    }
    const turn = script[scriptedTurn++] ?? fallback
    if (turn === undefined) throw new Error('the script ran out')
    const said = typeof turn === 'function' ? await turn(req) : turn
    if (said instanceof Error) throw said
    return {
      model: MODEL, text: '{"answer":"Done."}', stopReason: 'end_turn', explanation: null,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, ...said,
    }
  }
  return { send, seen, services }
}
const call = (tool: string, args: Record<string, unknown> = {}): Partial<Reply> =>
  ({ text: JSON.stringify({ call: tool, args, why: 'looking it up' }) })
const answer = (text: string): Partial<Reply> => ({ text: JSON.stringify({ answer: text }) })

const synthetic = (n: number, outcome: Step['outcome'], extra: Partial<Step> = {}): Step => ({
  n, at: '', outcome, model_text: null, stop_reason: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
  error: null, tool: null, args: null, result: null, capped: false, asked_by: null, ...extra,
})

const refusedWith = async (run: () => Promise<unknown>): Promise<string> => {
  try { await run(); return 'not refused' } catch (e) { return e instanceof AssistantError ? e.code : String(e) }
}

async function main() {
  // ------------------------------------------------------------- the books --
  const north = await createCompanyWithYear({ code: 'NOR', name: `Northwind ${NORTH} Ltd.` }, ACTOR)
  const south = await createCompanyWithYear({ code: 'SOU', name: `Southwind ${SOUTH} Ltd.` }, ACTOR)
  const yr = Number(north.year.endDate.slice(0, 4))
  const day = (mmdd: string) => `${yr}-${mmdd}`
  const FROM = day('01-01'), TO = day('12-31')
  const L = north.ledger.id
  const ids: Record<string, Record<string, string>> = {}
  for (const [co, marker] of [[north, NORTH], [south, SOUTH]] as const) {
    const accts = await importAccounts(co.company.id,
      parseAccountsCsv(chartFor(marker)).map((row) => ({ ...row, entityId: co.company.id })), ACTOR)
    ids[marker] = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  }
  const party = (name: string, entityId: string, role: 'customer' | 'supplier' | 'employee', kind: 'organisation' | 'person' = 'organisation') =>
    createParty({ kind, name, roles: [{ entityId, role, heldFrom: day('01-01') }], actor: ACTOR })

  const customer = await party(`Harbour Customer ${NORTH}`, north.company.id, 'customer')
  const supplier = await party('Quayside Paper Supply', north.company.id, 'supplier')
  const southBuyer = await party(`Southwind Buyer ${SOUTH}`, south.company.id, 'customer')

  const doc = async (ledgerId: string, direction: 'sales' | 'purchase', kind: 'invoice' | 'credit_note',
    partyId: string, marker: string, number: string, amount: bigint) => {
    const d = await createInvoice({
      ledgerId, direction, kind, partyId,
      controlAccountId: ids[marker][direction === 'sales' ? '1200' : '2100'],
      issuedOn: day('02-01'), dueOn: day('02-28'), number,
      lines: [{ accountId: ids[marker][direction === 'sales' ? '4000' : '5300'], amount }], actor: ACTOR,
    })
    await postInvoice(d.id, ACTOR)
  }
  await doc(L, 'sales', 'invoice', customer.id, NORTH, 'INV-N1', -parseMoney('1234.56'))
  await doc(L, 'sales', 'credit_note', customer.id, NORTH, 'CN-N1', parseMoney('150.00'))
  await doc(L, 'purchase', 'invoice', supplier.id, NORTH, 'BILL-N1', parseMoney('400.00'))
  await doc(south.ledger.id, 'sales', 'invoice', southBuyer.id, SOUTH, 'INV-S1', -parseMoney('9876.54'))
  // The same supplier through a second door: an expense line naming them, as
  // a quick expense does, beside the bill that names them on the payable.
  await postEntry({
    ledgerId: L, entryDate: day('03-05'), description: 'Paper, paid at the counter', actor: ACTOR,
    lines: [{ accountId: ids[NORTH]['5300'], amount: parseMoney('50.00'), partyId: supplier.id },
            { accountId: ids[NORTH]['1000'], amount: -parseMoney('50.00') }],
  })
  // An entry naming nobody, so the party grouping has its "No party" group.
  await postEntry({
    ledgerId: L, entryDate: day('01-02'), description: 'Capital in', actor: ACTOR,
    lines: [{ accountId: ids[NORTH]['1000'], amount: parseMoney('20000.00') },
            { accountId: ids[NORTH]['3000'], amount: -parseMoney('20000.00') }],
  })
  // An entry whose first named party is not the one on its expense line: the
  // whole entry belongs to the party on its first line that names one.
  await postEntry({
    ledgerId: L, entryDate: day('03-06'), description: 'Refund passed on', actor: ACTOR,
    lines: [{ accountId: ids[NORTH]['1000'], amount: -parseMoney('7.00'), partyId: customer.id },
            { accountId: ids[NORTH]['5300'], amount: parseMoney('7.00'), partyId: supplier.id }],
  })
  // More entries than a journal result may list.
  for (let i = 1; i <= 101; i++) {
    await postEntry({
      ledgerId: L, entryDate: day('04-10'), description: `Petty cash slip ${i}`, actor: ACTOR,
      lines: [{ accountId: ids[NORTH]['5300'], amount: parseMoney('1.00') }, { accountId: ids[NORTH]['1000'], amount: -parseMoney('1.00') }],
    })
  }
  // More parties than a result may list.
  for (let i = 1; i <= 105; i++) await party(`Bulk Supplier ${String(i).padStart(3, '0')}`, north.company.id, 'supplier')

  // A person with a SIN, paid, the pay reversed, and paid again.
  const dana = await party('Dana Payee', north.company.id, 'employee', 'person')
  const danaRec = await saveEmployee({
    ledgerId: L, partyId: dana.id, frequency: 'semi_monthly', federalClaim: parseMoney('16452.00'),
    bcClaim: parseMoney('13216.00'), sin: SIN, hiredOn: day('01-01'), actor: ACTOR,
  })
  const wrongRun = await runPayroll({
    ledgerId: L, payDate: day('01-15'), periodStart: day('01-01'), periodEnd: day('01-15'),
    bankAccountId: ids[NORTH]['1000'], actor: ACTOR, lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00') }],
  })
  await reverseEntry(wrongRun.entryId, day('01-20'), 'wrong amount', ACTOR)
  await runPayroll({
    ledgerId: L, payDate: day('01-31'), periodStart: day('01-16'), periodEnd: day('01-31'),
    bankAccountId: ids[NORTH]['1000'], actor: ACTOR, lines: [{ employeeId: danaRec.id, gross: parseMoney('2500.00') }],
  })
  // A year-end closing entry inside the year, which totals must say is there.
  let closingPosted = false
  try {
    await postEntry({
      ledgerId: L, entryDate: day('12-31'), description: 'Year-end close', sourceType: 'period_close', actor: ACTOR,
      lines: [{ accountId: ids[NORTH]['4000'], amount: parseMoney('1.00') }, { accountId: ids[NORTH]['3000'], amount: -parseMoney('1.00') }],
    })
    closingPosted = true
  } catch { closingPosted = false }
  const southPerson = await party('Sam Southside', south.company.id, 'employee', 'person')
  const southRec = await saveEmployee({
    ledgerId: south.ledger.id, partyId: southPerson.id, frequency: 'semi_monthly', federalClaim: parseMoney('16452.00'),
    bcClaim: parseMoney('13216.00'), hiredOn: day('01-01'), actor: ACTOR,
  })

  // People: the owner, and a clerk with only the Assistant and Parties seats here.
  const owner = await createFirstOwner({ email: 'pat@x.test', firstName: 'Pat', lastName: null, password: 'a long ordinary sentence' })
  const clerk = await createUser({ email: 'clerk@x.test', firstName: 'Clerk', lastName: null, password: 'a long ordinary sentence', kind: 'user', actor: ACTOR })
  await setGrants({ userId: clerk.id, entityIds: [north.company.id], modules: ['/assistant', '/parties'], actor: ACTOR })
  const spender = await createUser({ email: 'spender@x.test', firstName: 'Spender', lastName: null, password: 'a long ordinary sentence', kind: 'user', actor: ACTOR })
  await setGrants({ userId: spender.id, entityIds: [north.company.id], modules: ['/assistant', '/expenses'], actor: ACTOR })
  const outsider = await createUser({ email: 'outsider@x.test', firstName: 'Outsider', lastName: null, password: 'a long ordinary sentence', kind: 'user', actor: ACTOR })
  await setGrants({ userId: outsider.id, entityIds: [north.company.id], modules: ['/assistant', '/parties'], actor: ACTOR })

  const service: Service = serviceFrom({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: KEY, model: MODEL })!
  const ctxFor = (user: UserRecord): ToolContext => ({ ledgerId: L, entityId: north.company.id, entityName: north.company.name, user })
  const ownerCtx = ctxFor(owner)
  const ask = (question: string, send: Stubbed['send'], user: UserRecord = owner, clock?: () => number) =>
    inquire({ ledgerId: L, question, user, service, prices: null }, send, clock)
  type Stubbed = ReturnType<typeof stub>

  // --------------------------------------------------------------- IQ1
  // Two look-ups and an answer. Before each request the steps so far are
  // already in the table, read from outside the loop; every request is the
  // header's system text and the transcript rebuilt from the rows.
  {
    const question = 'IQ1 who owes us?'
    const stepsNow = async () => Number((await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM ai_inquiry_step s JOIN ai_inquiry q ON q.id = s.inquiry_id
       WHERE q.question = ${question}`))[0].n)
    const counted: number[] = []
    const s = stub([
      call('parties', { name: 'Harbour' }),
      async () => { counted.push(await stepsNow()); return call('owed', { side: 'receivable' }) },
      async () => { counted.push(await stepsNow()); return answer('The customer owes us 1,084.56.') },
    ])
    const q = await ask(question, s.send)
    const rebuilt = s.seen.every((req, i) => req.system === q.system
      && req.question === transcript(q.question, q.steps.slice(0, i), answerOnly(q.steps.slice(0, i))))
    check(q.steps.map((st) => st.outcome).join(',') === 'call,call,answer' && counted.join(',') === '1,2' && rebuilt
          && s.seen.length === 3,
      'IQ1 each step is written before the next request, and every request is rebuilt exactly from the rows',
      `${q.steps.map((st) => st.outcome).join(', ')}; steps on record at requests 2 and 3: ${counted.join(', ')}; rebuilt ${rebuilt}`)
  }

  // --------------------------------------------------------------- IQ2
  {
    const parsed = [
      parseReply('not json at all').kind, parseReply('{"call":"owed","answer":"both"}').kind, parseReply('{}').kind,
      parseReply('{"answer":"a"}{"answer":"b"}').kind, parseReply('```json\n{"answer":"fenced"}\n```').kind,
      parseReply('Here you go: {"call":"owed"}').kind,
    ].join(',')
    const cut = await ask('IQ2 cut', stub([{ text: '{"answer":"The customer ow', stopReason: 'max_tokens' }]).send)
    const declined = await ask('IQ2 declined', stub([{ text: null, stopReason: 'refusal', explanation: 'not about books' }]).send)
    const failed = await ask('IQ2 failed', stub([new Error('the service is down')]).send)
    const unreadable = await ask('IQ2 unreadable', stub([{ text: 'I think about 40?' }, answer('Forty.')]).send)
    check(parsed === 'unreadable,unreadable,unreadable,unreadable,answer,call'
          && cut.steps.at(-1)?.outcome === 'cut_off' && declined.steps.at(-1)?.outcome === 'refusal'
          && declined.steps.at(-1)?.error === 'not about books' && failed.steps.at(-1)?.outcome === 'error'
          && (failed.steps.at(-1)?.error ?? '').includes('the service is down')
          && unreadable.steps.map((st) => st.outcome).join(',') === 'unreadable,answer',
      'IQ2 a reply is a call, an answer or neither, and a cut-off, a refusal and a failure each stop as themselves',
      `parsed ${parsed}; ${[cut, declined, failed, unreadable].map((q) => q.steps.map((st) => st.outcome).join('+')).join('; ')}`)
  }

  // --------------------------------------------------------------- IQ3
  {
    const endless = stub([], call('calendar'))
    const limited = await ask('IQ3 endless', endless.send)
    const outcomes = limited.steps.map((st) => st.outcome)
    const lastTurn = endless.seen.at(-1)?.question.includes('No more look-ups') ?? false

    const heavy = stub([], call('parties'))
    const capped = await ask('IQ3 heavy', heavy.send)
    const at = capped.steps.findIndex((st) => st.outcome === 'too_much')
    const afterCap = at >= 0 ? heavy.seen[at + 1] : undefined
    const capRebuilt = afterCap !== undefined
      && afterCap.question === transcript(capped.question, capped.steps.slice(0, at + 1), true)

    let now = 0
    const clock = () => now
    const slowCall = stub([async () => { now += 6 * 60_000; return call('calendar') }])
    const tooSlow = await ask('IQ3 slow call', slowCall.send, owner, clock)
    now = 0
    const slowAnswer = stub([async () => { now += 6 * 60_000; return answer('Slow but here.') }])
    const lateAnswer = await ask('IQ3 slow answer', slowAnswer.send, owner, clock)

    check(outcomes.length === 9 && outcomes.slice(0, 8).every((o) => o === 'call') && outcomes[8] === 'call_after_limit'
          && lastTurn && at >= 0 && capped.steps[at].capped && capRebuilt
          && tooSlow.steps.at(-1)?.outcome === 'too_slow' && tooSlow.steps.at(-1)?.result === null && slowCall.seen.length === 1
          && lateAnswer.steps.at(-1)?.outcome === 'answer',
      'IQ3 eight look-ups then an answer-only turn; the character cap and the clock stop a round, never an answer',
      `${outcomes.length} requests ending ${outcomes.at(-1)}; cap at step ${at + 1} rebuilt ${capRebuilt}; `
      + `slow call → ${tooSlow.steps.at(-1)?.outcome}; slow answer → ${lateAnswer.steps.at(-1)?.outcome}`)
  }

  // ------------------------------------------- the tools on the fixture --
  const tool = (name: string, args: Record<string, unknown> = {}, ctx = ownerCtx) => runTool(ctx, name, args, new Set())
  const everyTool: Array<[string, Record<string, unknown>]> = [
    ['calendar', {}], ['search', { text: SOUTH }], ['search', { text: 'Dana' }], ['search', { text: '046454286' }], ['search', { text: 'Bulk Supplier' }],
    ['totals', { by: 'account', from: FROM, to: TO }], ['totals', { by: 'party', from: FROM, to: TO }],
    ['totals', { by: 'month', from: FROM, to: TO }], ['accounts', {}], ['parties', {}],
    ['balances', { from: FROM, to: TO }], ['account_activity', { account: '9060', from: FROM, to: TO }],
    ['statement', { which: 'balance_sheet', from: FROM, to: TO }], ['statement', { which: 'profit_loss', from: FROM, to: TO }],
    ['statement', { which: 'cash_flow', from: FROM, to: TO }], ['statement', { which: 'equity_changes', from: FROM, to: TO }],
    ['owed', { side: 'receivable' }], ['owed', { side: 'payable' }], ['open_documents', {}],
    ['party_activity', { party: customer.id, direction: 'in', from: FROM, to: TO }],
    ['party_activity', { party: supplier.id, direction: 'out', from: FROM, to: TO }],
    ['journal', {}], ['journal', { text: 'Dana' }], ['bank_lines', { account: '1000' }], ['bank_accounts', {}],
    ['tax_return', { tax: 'gst_hst', from: FROM, to: TO }], ['tax_return', { tax: 'pst', from: FROM, to: TO }],
    ['employees', {}], ['pay_runs', {}], ['pay_stubs', { employee: danaRec.id, year: String(yr) }],
    ['remittances', { year: String(yr) }], ['t4', { year: String(yr) }],
    ['register', { kind: 'directors' }], ['register', { kind: 'central_securities' }], ['register', { kind: 'transparency' }],
    ['report_link', { report: 'aging', as_of: TO }],
  ]
  const results = new Map<string, string>()
  for (const [name, args] of everyTool) results.set(`${name} ${JSON.stringify(args)}`, await tool(name, args))
  const resultOf = (name: string, args: Record<string, unknown> = {}) => results.get(`${name} ${JSON.stringify(args)}`) ?? ''
  const broken = [...results.entries()].filter(([, text]) => / could not be read: /.test(text)).map(([k, text]) => `${k}: ${text.slice(0, 80)}`)

  // --------------------------------------------------------------- IQ4
  {
    const owed = resultOf('owed', { side: 'receivable' })
    const owing = resultOf('owed', { side: 'payable' })
    const open = resultOf('open_documents')
    const activity = resultOf('party_activity', { party: customer.id, direction: 'in', from: FROM, to: TO })
    const parties = resultOf('parties')
    const stubs = resultOf('pay_stubs', { employee: danaRec.id, year: String(yr) })
    const runs = resultOf('pay_runs')
    const t4 = resultOf('t4', { year: String(yr) })
    const box14 = /14 [^:]*: ([\d,]+\.\d{2})/.exec(t4)?.[1]
    const clauses = {
      receivableTotal: owed.includes('1,084.56'),
      payablePositive: owing.includes('400.00') && !owing.includes('-400.00'),
      creditNoteNegative: open.includes('-150.00') && activity.includes('-150.00'),
      partiesCut: /\d+ more rows? not shown/.test(parties),
      stubsPostedOnly: stubs.includes('Gross for the year: 2,500.00') && !stubs.includes('3,000.00'),
      runsPostedOnly: runs.includes('2,500.00') && !runs.includes('3,000.00'),
      t4Agrees: box14 === '2,500.00',
      remittancesAgree: resultOf('remittances', { year: String(yr) }).includes('2,500.00')
        && !resultOf('remittances', { year: String(yr) }).includes('3,000.00'),
      journalSaysMore: /more beyond those|There are more rows than these/.test(resultOf('journal')),
      searchSaysCut: resultOf('search', { text: 'Bulk Supplier' }).includes('may have more: Party'),
      nothingBroke: broken.length === 0,
    }
    check(Object.values(clauses).every(Boolean),
      'IQ4 the tools write the fixture\'s own figures: signs, a reversed run left out, the cut, pay stubs equal to T4 box 14',
      Object.entries(clauses).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join('; ') + (broken.length ? ` | ${broken.join(' | ')}` : ''))
  }

  // --------------------------------------------------------------- IQ5
  {
    const leaking = [...results.entries()].filter(([, text]) => text.includes(SOUTH) || text.includes('9,876.54')).map(([k]) => k)
    const foreign = {
      stubs: await tool('pay_stubs', { employee: southRec.id, year: String(yr) }),
      activity: await tool('party_activity', { party: southBuyer.id, direction: 'in', from: FROM, to: TO }),
      link: await tool('report_link', { report: 'customer_statement', party: southBuyer.id, as_of: TO }),
      owed: await tool('owed', { side: 'receivable', party: southBuyer.id }),
      documents: await tool('open_documents', { party: southBuyer.id }),
    }
    const refused = Object.values(foreign).every((text) => text.includes("That is not in this company's books.")
      && !text.includes(southBuyer.id.slice(0, 8) + '-') && !text.includes(SOUTH))
    check(leaking.length === 0 && refused,
      'IQ5 no tool brings back the other company, and an id of theirs is refused by name',
      `${results.size} look-ups, leaking: ${leaking.join(', ') || 'none'}; foreign ids: `
      + Object.entries(foreign).map(([k, v]) => `${k} ${v.includes('not in this company') ? 'refused' : v.slice(0, 40)}`).join(', '))
  }

  // --------------------------------------------------------------- IQ6
  {
    const clerkCtx = ctxFor(clerk)
    const spenderCtx = ctxFor(spender)
    const offered = (await toolList(clerkCtx)).map((t) => t.name)
    const forced = {
      owed: await tool('owed', { side: 'receivable' }, clerkCtx),
      padded: await tool('party_activity', { party: customer.id, direction: ' in ', from: FROM, to: TO }, spenderCtx),
      shouted: await tool('party_activity', { party: customer.id, direction: 'IN', from: FROM, to: TO }, spenderCtx),
      paddedReport: await tool('report_link', { report: ' pd7a ', year: String(yr) }, clerkCtx),
      unknownReport: await tool('report_link', { report: 'PD7A', year: String(yr) }, clerkCtx),
    }
    const allRefused = Object.values(forced).every((t) => t.startsWith('Refused:'))
    const spenderOffered = (await toolList(spenderCtx)).map((t) => t.name)
    const ownSide = await tool('party_activity', { party: supplier.id, direction: ' out ', from: FROM, to: TO }, spenderCtx)

    const mine = await ask('IQ6 the clerk asks', stub([answer('Asked.')]).send, clerk)
    const atTheLimit = await ask('IQ6 the owner at the limit',
      stub([...Array.from({ length: 8 }, () => call('calendar')), answer('Partly.')]).send, owner)
    const clerkSees = (await inquiriesFor(L, clerk)).map((q) => q.asked_by)
    const ownerSees = (await inquiriesFor(L, owner)).map((q) => q.asked_by)
    const pressedByClerk = await refusedWith(() =>
      keepLooking({ ledgerId: L, inquiryId: atTheLimit.id, user: clerk, service }, stub([answer('x')]).send))
    const [{ presses }] = await db.execute<{ presses: string }>(raw`
      SELECT count(*)::text AS presses FROM ai_inquiry_step WHERE inquiry_id = ${atTheLimit.id}::uuid AND outcome = 'more'`)
    // The outsider asks while holding the Assistant seat, and then loses it.
    const outsiderOwn = await ask('IQ6 the outsider at the limit',
      stub([...Array.from({ length: 8 }, () => call('calendar')), answer('Partly.')]).send, outsider)
    await setGrants({ userId: outsider.id, entityIds: [north.company.id], modules: ['/parties'], actor: ACTOR })
    const outsiderAsks = await refusedWith(() => ask('IQ6 the outsider asks again', stub([answer('x')]).send, outsider))
    const outsiderSees = await inquiriesFor(L, outsider)
    const outsiderPresses = await refusedWith(() =>
      keepLooking({ ledgerId: L, inquiryId: outsiderOwn.id, user: outsider, service }, stub([answer('x')]).send))
    const [{ presses: outsiderPressRows }] = await db.execute<{ presses: string }>(raw`
      SELECT count(*)::text AS presses FROM ai_inquiry_step WHERE inquiry_id = ${outsiderOwn.id}::uuid AND outcome = 'more'`)
    check(offered.includes('parties') && offered.includes('calendar') && offered.includes('calculate')
          && !offered.includes('owed') && !offered.includes('employees') && !offered.includes('balances')
          && allRefused && !ownSide.startsWith('Refused:') && mine.asked_by === clerk.email
          && clerkSees.length > 0 && clerkSees.every((who) => who === clerk.email)
          && ownerSees.includes(clerk.email) && ownerSees.includes(owner.email)
          && offersKeepLooking(atTheLimit.steps) && pressedByClerk === 'NOT_YOURS' && presses === '0'
          && outsiderAsks === 'NO_SEAT' && outsiderSees.length === 0 && offersKeepLooking(outsiderOwn.steps)
          && outsiderPresses === 'NO_SEAT' && outsiderPressRows === '0' && spenderOffered.includes('party_activity'),
      'IQ6 a narrower seat is offered fewer tools, refused the rest however the arguments are spelled, and asks, sees and continues only its own',
      `clerk offered ${offered.length} tools; forced: ${Object.entries(forced).map(([k, v]) => `${k} ${v.startsWith('Refused:') ? 'refused' : v.slice(0, 24)}`).join(', ')}; `
      + `its own side ${ownSide.startsWith('Refused:') ? 'REFUSED' : 'read'}; clerk sees ${clerkSees.length} of its own; `
      + `clerk presses an offered question → ${pressedByClerk} (${presses} presses kept); outsider asks → ${outsiderAsks}, `
      + `sees ${outsiderSees.length}, presses its own → ${outsiderPresses}; spender offered party_activity ${spenderOffered.includes('party_activity')}`)
  }

  // --------------------------------------------------------------- IQ7
  {
    const carrying = [...results.entries()].filter(([, text]) => SIN_SPELLINGS.some((sin) => text.includes(sin))).map(([k]) => k)
    const named = resultOf('employees').includes('Dana Payee') && resultOf('t4', { year: String(yr) }).includes('Dana Payee')
    check(carrying.length === 0 && named,
      'IQ7 no tool result carries the SIN, while the employee lists and the T4 still name the person',
      `${results.size} look-ups; carrying a SIN: ${carrying.join(', ') || 'none'} (only employees and t4 read the column; the rest are probes)`)
  }

  // --------------------------------------------------------- IQ8, IQ9, IQ10
  {
    const steps = [synthetic(1, 'call', { result: `Owed to us\nHarbour | 1,084.56\nCredit | -150.00\nlink /ledger/${L}/parties/${customer.id}.\n`
      + `bank text: see /ledger/${south.ledger.id}/parties/${southBuyer.id} for theirs, or /ledger/${L}/../${south.ledger.id}/parties/${southBuyer.id}\n`
      + 'CAD4,444.44 on file' })]
    const parts = answerParts(
      `They owe us 1,084.56 net of a 150.00 credit; $5,000 over 60 days at 12.50%, and 3,141.59 is made up, as is CAD2,718.28 — `
      + `while CAD1,084.56 is real. Also 6,543.21USD, 1,084.56,7,777.77 and 4,444.44. `
      + `[$9,999.99](/ledger/${L}/parties/${customer.id}), [the customer](/ledger/${L}/parties/${customer.id}), `
      + `[aging](/ledger/${L}/aging), [theirs](/ledger/${south.ledger.id}/parties/${southBuyer.id}), `
      + `[sneaky](/ledger/${L}/../${south.ledger.id}/parties/${southBuyer.id}), [web](https://example.com)`, steps, L)
    const marked = parts.filter((p) => p.unverified).map((p) => p.text)
    const linked = parts.filter((p) => p.href).map((p) => p.text)
    check(marked.join('|') === '$5,000|3,141.59|2,718.28|6,543.21|7,777.77|$9,999.99',
      'IQ8 a figure is marked unless a result carried it, sign aside, in a link label or after letters too; whole numbers and percentages are not figures',
      `marked: ${marked.join(', ') || 'nothing'}`)

    const known = lookedUp([synthetic(1, 'call', { result: 'A 0.10 and a 0.20, and 1,084.56 with 84.56' })])
    const sum = await runTool(ownerCtx, 'calculate', { op: 'sum', amounts: ['0.10', '0.20'] }, known)
    const diff = await runTool(ownerCtx, 'calculate', { op: 'difference', amounts: ['1,084.56', '84.56'] }, known)
    const invented = await runTool(ownerCtx, 'calculate', { op: 'sum', amounts: ['0.10', '777.77'] }, known)
    const echoes = [
      await runTool(ownerCtx, 'account_activity', { account: '777.77', from: FROM, to: TO }, known),
      await runTool(ownerCtx, '888.88', {}, known),
      await runTool(ownerCtx, 'report_link', { report: '999.99' }, known),
    ]
    const unknownReport = reportLink(L, '999.99', {})
    const noEcho = echoes.every((t) => !/\d\.\d{2}/.test(t))
      && 'error' in unknownReport && !/\d\.\d{2}/.test(unknownReport.error)
    check(sum.includes('Result: 0.30') && diff.includes('Result: 1,000.00')
          && invented.includes('not a figure from this question') && !/\d\.\d{2}/.test(invented) && noEcho,
      'IQ9 calculate adds and subtracts in cents, and refuses an amount no result carried without repeating it',
      `${sum.split('\n').at(-1)}; ${diff.split('\n').at(-1)}; invented → ${invented.slice(0, 50)}; refusals repeat no amount ${noEcho}`)

    check(linked.join('|') === '$9,999.99|the customer',
      'IQ10 a link is clickable only when a result carried that exact address in this ledger, whatever text sat around it',
      `clickable: ${linked.join(', ') || 'none'}`)
  }

  // --------------------------------------------------------------- IQ11
  {
    const echoing = stub([call('search', { text: KEY }), { text: `{"answer":"Your key is ${KEY}."}` }])
    const q = await ask(`IQ11 echo ${KEY}`, echoing.send)
    const failing = await ask('IQ11 failing', stub([new Error(`401: key ${KEY} is not valid`)]).send)
    void failing
    const [{ leaked }] = await db.execute<{ leaked: string }>(raw`
      SELECT ((SELECT count(*) FROM ai_inquiry WHERE ai_inquiry::text LIKE ${'%' + KEY + '%'})
            + (SELECT count(*) FROM ai_inquiry_step WHERE ai_inquiry_step::text LIKE ${'%' + KEY + '%'}))::text AS leaked`)
    let edit = '', del = ''
    try { await byHand((tx) => tx.execute(raw`UPDATE ai_inquiry SET question = 'edited' WHERE id = ${q.id}::uuid`)) } catch (e) { edit = String((e as Error).message ?? e) + String((e as { cause?: unknown }).cause ?? '') }
    try { await byHand((tx) => tx.execute(raw`DELETE FROM ai_inquiry_step WHERE inquiry_id = ${q.id}::uuid`)) } catch (e) { del = String((e as Error).message ?? e) + String((e as { cause?: unknown }).cause ?? '') }
    check(leaked === '0' && edit.includes('AI_INQUIRY_IMMUTABLE') && del.includes('AI_INQUIRY_IMMUTABLE'),
      'IQ11 a question and its steps are neither edited nor deleted, and the key is in no row',
      `rows with the key: ${leaked}; edit → ${edit ? 'refused' : 'allowed'}; delete → ${del ? 'refused' : 'allowed'}`)
  }

  // --------------------------------------------------------------- IQ15
  // The catalogue against the routes: every address's path has its page or
  // route file, and every query parameter it writes is one that file reads.
  // A source check, said as one; the page pass requests each address.
  {
    const base = 'src/app/ledger/[ledgerId]'
    const problems: string[] = []
    for (const key of REPORT_KEYS) {
      const built = reportLink(L, key, { from: FROM, to: TO, as_of: TO, party: customer.id, year: String(yr) })
      if ('error' in built) { problems.push(`${key}: ${built.error}`); continue }
      for (const [href, kind] of [[built.page, 'page'], ...built.downloads.map((d) => [d.href, 'route'])] as Array<[string, string]>) {
        const url = new URL(href, 'http://x')
        const path = url.pathname.replace(`/ledger/${L}`, '').replace(customer.id, '[partyId]')
        const file = `${base}${path}/${kind === 'page' ? 'page.tsx' : 'route.ts'}`
        if (!existsSync(file)) { problems.push(`${key}: no ${file}`); continue }
        const src = readFileSync(file, 'utf8')
        for (const [param, value] of url.searchParams) {
          const reads = kind === 'page'
            ? src.includes(`${param}?:`)
            : src.includes(`q.get('${param}')`) || (['from', 'to'].includes(param) && src.includes('spanFromQuery'))
              || (param === 'format' && src.includes('formatOf('))
          if (!reads) problems.push(`${key}: ${file} does not read ${param}`)
          if (param === 'what' && !src.includes(`what === '${value}'`)) problems.push(`${key}: /export has no ${value}`)
        }
      }
    }
    check(problems.length === 0 && Object.keys(REPORTS).length === 12,
      'IQ15 every report address names a page or route that exists and reads every parameter it is given',
      problems.length === 0 ? `${REPORT_KEYS.length} reports, their pages and downloads (source check)` : problems.slice(0, 4).join(' | '))
  }

  // --------------------------------------------------------------- IQ17
  {
    const span = await resolvePeriodSpan(L, FROM, TO)
    const tb = span ? await trialBalanceSpan(L, span.fromPeriod.id, span.toPeriod.id) : []
    const money = (c: bigint) => new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2 }).format(Number(c) / 100)
    const tbDebit = money(tb.reduce((t, row) => t + BigInt(row.debit), 0n))
    const tbCredit = money(tb.reduce((t, row) => t + BigInt(row.credit), 0n))
    const together = (text: string) => /together: debit (-?[\d,]+\.\d{2}), credit (-?[\d,]+\.\d{2}), net (-?[\d,]+\.\d{2})/.exec(text)?.slice(1) ?? []
    const byAccount = together(resultOf('totals', { by: 'account', from: FROM, to: TO }))
    const byParty = together(resultOf('totals', { by: 'party', from: FROM, to: TO }))
    const byMonth = together(resultOf('totals', { by: 'month', from: FROM, to: TO }))
    const expenses = await tool('totals', { by: 'party', from: FROM, to: TO, type: 'expense' })
    const quayside = expenses.split('\n').find((line) => line.startsWith('Quayside Paper Supply |')) ?? ''
    const harbour = expenses.split('\n').find((line) => line.startsWith(`Harbour Customer ${NORTH} |`)) ?? ''
    const rounded = await tool('totals', { by: 'account', from: day('01-10'), to: day('11-20') })
    check(byAccount[0] === tbDebit && byAccount[1] === tbCredit && byParty.join() === byAccount.join()
          && byMonth.join() === byAccount.join() && quayside.includes('| 450.00 |') && harbour.includes('| 7.00 |')
          && resultOf('totals', { by: 'party', from: FROM, to: TO }).includes('\nNo party |')
          && rounded.includes('Rounded to whole periods') && closingPosted
          && resultOf('totals', { by: 'account', from: FROM, to: TO }).includes('year-end closing entry'),
      'IQ17 totals agree with the trial balance, round to periods, name a closing entry, and give an entry to its first named party',
      `trial balance debit ${tbDebit} credit ${tbCredit}; by account ${byAccount.join(' / ')}; by party ${byParty.join(' / ')}; `
      + `by month ${byMonth.join(' / ')}; Quayside "${quayside}"; Harbour "${harbour}"; rounded ${rounded.includes('Rounded')}; closing posted ${closingPosted}, `
      + `named ${resultOf('totals', { by: 'account', from: FROM, to: TO }).includes('year-end closing entry')}`)
  }

  // --------------------------------------------------------------- IQ18
  {
    const toTheLimit = () => stub([...Array.from({ length: 8 }, () => call('calendar')), answer('Partly: 1,084.56 so far.')])
    const stopped = await ask('IQ18 at the limit', toTheLimit().send)
    const offered = offersKeepLooking(stopped.steps)
    let pressedBefore = -1, sawPress = false, lastTurn = true
    const again = stub([async (req) => {
      pressedBefore = Number((await db.execute<{ n: string }>(raw`
        SELECT count(*)::text AS n FROM ai_inquiry_step WHERE inquiry_id = ${stopped.id}::uuid AND outcome = 'more'`))[0].n)
      sawPress = req.question.includes('The person asked you to keep looking.')
      lastTurn = req.question.includes('No more look-ups')
      return answer('Now complete: 1,084.56.')
    }])
    // Caught like every door here: a refusal must turn this line red, not end the suite.
    const continued = await keepLooking({ ledgerId: L, inquiryId: stopped.id, user: owner, service }, again.send)
      .catch((e: unknown) => ({ steps: [] as Step[], refused: e instanceof AssistantError ? e.code : String(e) }))
    const pressAgain = await refusedWith(() =>
      keepLooking({ ledgerId: L, inquiryId: stopped.id, user: owner, service }, stub([answer('x')]).send))
    const elsewhere = await ask('IQ18 a changed service', toTheLimit().send)
    const otherModel: Service = serviceFrom({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: KEY, model: 'another-model' })!
    const changed = await refusedWith(() =>
      keepLooking({ ledgerId: L, inquiryId: elsewhere.id, user: owner, service: otherModel }, stub([answer('x')]).send))
    const notForWant = (['refusal', 'error', 'cut_off'] as const).every((o) =>
      !offersKeepLooking([...Array.from({ length: 8 }, (_, i) => synthetic(i + 1, 'call')), synthetic(9, o)]))

    const racing = await ask('IQ18 two presses', toTheLimit().send)
    const both = await Promise.allSettled([1, 2].map(() =>
      keepLooking({ ledgerId: L, inquiryId: racing.id, user: owner, service }, stub([answer('Done once.')]).send)))
    const [{ presses }] = await db.execute<{ presses: string }>(raw`
      SELECT count(*)::text AS presses FROM ai_inquiry_step WHERE inquiry_id = ${racing.id}::uuid AND outcome = 'more'`)
    const refusals = both.filter((b) => b.status === 'rejected')
      .map((b) => ((b as PromiseRejectedResult).reason as AssistantError).code)

    const cappedSteps = [synthetic(1, 'too_much', { capped: true, result: 'too much' }), synthetic(2, 'call_after_limit')]
    const slowSteps = [synthetic(1, 'too_slow', { model_text: '{"call":"owed"}' })]
    const unrun = transcript('q', [synthetic(1, 'call_after_limit', { model_text: '{"call":"owed"}' })], false)
    check(offered && pressedBefore === 1 && sawPress && !lastTurn && continued.steps.at(-1)?.outcome === 'answer'
          && pressAgain === 'NOT_OFFERED' && presses === '1' && refusals.length === 1
          && ['ALREADY', 'NOT_OFFERED'].includes(refusals[0])
          && !offersKeepLooking(cappedSteps) && offersKeepLooking(slowSteps) && unrun.includes('(this look-up was not run)')
          && changed === 'SERVICE_CHANGED' && notForWant,
      'IQ18 Keep looking is written before it asks again, gives a fresh round, is pressed once, and is not offered past the cap',
      `offered ${offered}; press on record before the request ${pressedBefore}; fresh round ${!lastTurn}; `
      + `again → ${pressAgain}; racing presses kept ${presses}, refused ${refusals.join(', ')}; changed service → ${changed}; `
      + `refusal, error, cut-off offered ${!notForWant}`)
  }

  // --------------------------------------------------------------- IQ13
  // The question form carries nothing secret: the person's saved service is
  // the one the request goes to, and a person with none is told to save it
  // before anything is written or sent.
  {
    process.env.AI_KEY_SECRET = 'suite-secret-for-encrypting-keys'
    const s = stub([answer('Revenue is up.')])
    const bare = new FormData(); bare.set(F.ledgerId, L); bare.set(F.question, 'IQ13 with no service?')
    const none = await inquireFromForm(bare, clerk, s.send)
    const sentWithNone = s.seen.length
    const [{ n: rowsWithNone }] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM ai_inquiry WHERE question = 'IQ13 with no service?'`)
    await saveService({ userId: owner.id, actor: owner.email, baseUrl: 'http://127.0.0.1:9/v1', apiKey: KEY,
                        model: MODEL, priceInput: '2', priceOutput: '10' })
    const fd = new FormData(); fd.set(F.ledgerId, L); fd.set(F.question, '  IQ13 is revenue up?  ')
    const answered = await inquireFromForm(fd, owner, s.send)
    const latest = (await inquiriesFor(L, owner)).find((q) => q.question === 'IQ13 is revenue up?')
    // The fields the real forms render, not the ones this check built: in a
    // process of its own, since react-dom/server does not exist under the
    // react-server condition this suite runs in.
    const rendered = (JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-inquire-form.tsx'],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const fields = [...new Set([...rendered.matchAll(/\bname="([^"]*)"/g)].map((m) => m[1]))]
    check(none.error?.includes('Save your service first') === true && sentWithNone === 0 && rowsWithNone === '0'
          && answered.ok === 'Answered.' && s.services[0]?.apiKey === KEY && s.services[0]?.model === MODEL
          && latest !== undefined && Number(latest.price_output) === 10
          && fields.includes(F.question) && fields.includes(F.inquiryId)
          && fields.every((k) => ([F.ledgerId, F.question, F.inquiryId] as string[]).includes(k)),
      'IQ13 the question form carries no secret: the saved service answers it, and without one nothing is sent or kept',
      `no service → ${none.error?.slice(0, 40)} (${sentWithNone} sent, ${rowsWithNone} rows); saved → ${answered.ok ?? answered.error}; `
      + `price on record ${latest?.price_output ?? 'none'}; form fields ${fields.join(', ')}`)
  }

  // --------------------------------------------------------------- IQ14
  {
    const fd = new FormData(); fd.set(F.ledgerId, L); fd.set(F.question, 'IQ14 will it fail?')
    const failed = await inquireFromForm(fd, owner, stub([new Error('the relay said boom')]).send)
    const declined = await inquireFromForm(fd, owner, stub([{ text: null, stopReason: 'refusal', explanation: 'not today' }]).send)
    check(failed.error?.startsWith('The assistant could not answer: ') === true && failed.error.includes('boom')
          && !failed.error.includes('    at ') && declined.error === 'The model declined: not today',
      'IQ14 a failed or declined question comes back as a sentence, not a stack',
      `${failed.error?.slice(0, 60)} | ${declined.error}`)
  }

  // -------------------------------------------------------------- IQ14b
  // Keep looking from the form: the question it names, one more round, and a
  // question that was not offered it refused in a sentence, nothing sent.
  {
    const looking = { text: JSON.stringify({ call: 'calendar', args: {}, why: 'IQ14b looking' }) }
    const limitFd = new FormData(); limitFd.set(F.ledgerId, L); limitFd.set(F.question, 'IQ14b look until the limit')
    const atLimit = await inquireFromForm(limitFd, owner, stub([], looking).send)
    const asked = await inquiriesFor(L, owner)
    const limited = asked.find((q) => q.question === 'IQ14b look until the limit')
    const failedQ = asked.find((q) => q.question === 'IQ14 will it fail?')
    const press = new FormData(); press.set(F.ledgerId, L); press.set(F.inquiryId, limited?.id ?? '')
    const more = stub([answer('Nothing more to find.')])
    const pressed = await keepLookingFromForm(press, owner, more.send)
    const wrong = new FormData(); wrong.set(F.ledgerId, L); wrong.set(F.inquiryId, failedQ?.id ?? '')
    const refused = await keepLookingFromForm(wrong, owner, more.send)
    check(limited !== undefined && failedQ !== undefined
          && atLimit.ok?.startsWith('It stopped at the limit') === true && pressed.ok === 'Answered.' && more.seen.length === 1
          && refused.error === 'This question did not stop for want of look-ups, so there is nothing to continue.',
      'IQ14b Keep looking from the form asks again on the question it names, and a question not offered it is refused in a sentence',
      `at the limit → ${atLimit.ok ?? atLimit.error}; pressed → ${pressed.ok ?? pressed.error}; sent ${more.seen.length}; not offered → ${refused.error ?? refused.ok}`)
  }

  // -------------------------------------------------------------- IQ14c
  // A question that looked up too much is never offered another round, and
  // the form must not tell the person it is.
  {
    const fd = new FormData(); fd.set(F.ledgerId, L); fd.set(F.question, 'IQ14c look up everything')
    const heavy = await inquireFromForm(fd, owner, stub([], call('parties')).send)
    const q = (await inquiriesFor(L, owner)).find((x) => x.question === 'IQ14c look up everything')
    const capped = q?.steps.some((st) => st.capped) ?? false
    check(q !== undefined && capped && offersKeepLooking(q.steps) === false
          && heavy.error === 'This question looked up too much to go on. Ask a narrower one.' && heavy.ok === undefined,
      'IQ14c a question that looked up too much is told to ask a narrower one, not to keep looking',
      `last step ${q?.steps.at(-1)?.outcome}, capped ${capped}; the form said ${heavy.ok ?? heavy.error}`)
  }

  // -------------------------------------------------------------- IQ14d
  // What the page shows under a question, decided in the library so it can be
  // checked: a failure after the character limit says itself, and Keep looking
  // is offered to the asker, on the service it was asked with, and to nobody else.
  {
    const fd = new FormData(); fd.set(F.ledgerId, L); fd.set(F.question, 'IQ14d look up everything, then fail')
    await inquireFromForm(fd, owner, stub([], async (req) =>
      req.question.includes('No more look-ups') ? new Error('the relay said 502') : call('parties')).send)
    const asked = await inquiriesFor(L, owner)
    const failedAfterCap = asked.find((x) => x.question === 'IQ14d look up everything, then fail')
    const cappedOnly = asked.find((x) => x.question === 'IQ14c look up everything')
    const offered = asked.find((x) => x.question === 'IQ18 a changed service')
    const another = serviceFrom({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: KEY, model: 'another-model' })!
    const line = failedAfterCap ? stopLine(failedAfterCap.steps) : 'not found'
    const cappedLine = cappedOnly ? stopLine(cappedOnly.steps) : 'not found'
    const offers = offered
      ? [keepLookingOffer(offered, owner.email, service), keepLookingOffer(offered, owner.email, another),
         keepLookingOffer(offered, clerk.email, service), keepLookingOffer(offered, owner.email, null)]
      : []
    check((failedAfterCap?.steps.some((st) => st.capped) ?? false) && line === 'The call failed: the relay said 502'
          && cappedLine === 'This question looked up too much to go on. Ask a narrower one.'
          && cappedOnly !== undefined && keepLookingOffer(cappedOnly, owner.email, service) === null
          && offers.map(String).join(',') === 'button,elsewhere,null,null',
      'IQ14d the page\'s line names a failure even after the character limit, and Keep looking is offered only to the asker on the service it was asked with',
      `after the cap: ${line}; capped only: ${cappedLine}; offers to owner / owner on another model / clerk / no service: ${offers.map(String).join(', ')}`)
  }

  // --------------------------------------------------------------- IQ16
  // "Earlier questions" is the old form's questions in this company only: not
  // an exchange a bill reading points at, not one a discarded reading left
  // behind, not another company's, and not another person's unless the viewer
  // is an owner.
  {
    const exchange = async (ledgerId: string, askedBy: string, question: string) => (await db.execute<{ id: string }>(raw`
      INSERT INTO ai_exchange (ledger_id, asked_by, model, question) VALUES (${ledgerId}::uuid, ${askedBy}, ${MODEL}, ${question})
      RETURNING id::text`))[0].id
    await exchange(L, owner.email, 'IQ16 the owner asked the old form')
    await exchange(L, clerk.email, 'IQ16 the clerk asked the old form')
    await exchange(south.ledger.id, owner.email, 'IQ16 the other company asked the old form')
    const reading = await exchange(L, owner.email, 'IQ16 a reading whose question was written another way (bill.pdf)')
    await db.execute(raw`
      INSERT INTO ai_bill_reading (ledger_id, read_by, filename, mime, bytes, sha256, exchange_id)
      VALUES (${L}::uuid, ${owner.email}, 'bill.pdf', 'application/pdf', '\\x00'::bytea, ${'e'.repeat(64)}, ${reading}::uuid)`)
    // Both first sentences written out, not taken from the list: a list that
    // REPLACED the old sentence instead of adding to it would still match a row
    // built from itself (critic, 2026-09-15).
    await exchange(L, owner.email, 'Read the attached bill, invoice or receipt and answer with ONE JSON object and nothing else. Shape: …\n\n(The file is discarded.pdf.)')
    await exchange(L, owner.email, 'Turn what the person gave you — a sentence, a document, or both — into ONE JSON object and nothing else. Shape: …\n\nThe person wrote:\nIQ16 a sentence-only reading, discarded')
    const mine = (qs: string[]) => qs.filter((q) => q.includes('IQ16') || q.includes('.pdf'))
    const ownerSees = mine((await earlierQuestionsFor(L, owner)).map((x) => x.question))
    const clerkSees = mine((await earlierQuestionsFor(L, clerk)).map((x) => x.question))
    const instructionStarts = readFileSync('src/lib/bill-reading.ts', 'utf8')
      .includes('READING_QUESTION_STARTS[READING_QUESTION_STARTS.length - 1],')
    check(ownerSees.length === 2 && ownerSees.every((q) => q.includes('asked the old form') && !q.includes('other company'))
          && clerkSees.length === 1 && clerkSees[0] === 'IQ16 the clerk asked the old form' && instructionStarts,
      'IQ16 earlier questions leave out bill readings, used or discarded, and another company\'s, and show a narrower seat only its own',
      `owner sees ${ownerSees.length}: ${ownerSees.map((q) => q.slice(5, 30)).join('; ')}; clerk sees ${clerkSees.length}; `
      + `the reading instruction begins with the shared sentence (source) ${instructionStarts}`)
  }

  // -------------------------------------------------------------- IQ16b
  // The outsider holds only the Parties seat since IQ6: no earlier questions,
  // not even the one they asked themselves.
  {
    await db.execute(raw`
      INSERT INTO ai_exchange (ledger_id, asked_by, model, question)
      VALUES (${L}::uuid, ${outsider.email}, ${MODEL}, ${'IQ16b the outsider asked the old form'})`)
    const [{ n }] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM ai_exchange WHERE ledger_id = ${L}::uuid AND asked_by = ${outsider.email}`)
    const shown = (await earlierQuestionsFor(L, outsider)).length
    check(n === '1' && shown === 0,
      'IQ16b a person without the Assistant seat is shown no earlier questions, not even their own',
      `the outsider asked ${n}; shown ${shown}`)
  }

  // IQ-options — NO OPTION LIST IS SPELLED OUT TWICE (owner, 2026-09-16).
//
//       Every tool that takes a closed set used to carry it in the `args`
//       prose the model reads AND in the `oneOf` beside it. Nine of them. They
//       agreed on the day they were checked, which is the most that can ever
//       be said of two copies — and the failure is silent BOTH ways: a model
//       told a value the code rejects gets a refusal it cannot understand, and
//       a value the code accepts but the prose omits is a capability nobody
//       finds.
//
//       The rule a machine can hold is this: a list may not appear in prose at
//       all. `${choices(X)}` interpolates one, so an alternation surviving in a
//       plain-quoted `args` string is a list that was typed rather than
//       derived. Four are not even declared locally — statements and tax
//       returns come from the report catalogue, registers and bank states from
//       the modules that own them — so adding a statement template makes it
//       askable with no edit here.
{
  const src = ['src/lib/inquiry-tools.ts', ...['payroll', 'records', 'crm'].map(module => `src/modules/${module}/inquiry-tools.ts`)]
    .map(file => readFileSync(file, 'utf8')).join('\n')
  const spelled: string[] = []
  for (const m of src.matchAll(/args: '([^']*)'/g)) {
    if (m[1].includes('|')) spelled.push(m[1].slice(0, 56))
  }
  // And every list that IS declared must reach the prose: a const nobody
  // interpolates is the same drift wearing a better hat.
  const declared = [...src.matchAll(/^const ([A-Z_]+) = (?:\[|Object\.keys)/gm)].map((m) => m[1])
  const unused = declared.filter((n) => !src.includes(`choices(${n})`))
  const derived = ['STATEMENT_KEYS', 'TAX_RETURN_KEYS', 'REGISTER_KINDS', 'BANK_ROW_STATES']
    .filter((n) => src.includes(`choices(${n})`))

  check(spelled.length === 0 && unused.length === 0 && derived.length === 4,
    'IQ-options no option list the model is offered is typed twice',
    spelled.length > 0 ? `spelled out in prose: ${spelled.join(' / ')}`
      : unused.length > 0 ? `declared but never offered: ${unused.join(', ')}`
      : `every list interpolated; ${derived.length} come from the module that owns them`)
}

// IQ-typed — WHAT A PERSON MAY TYPE IS STILL CAPPED (2026-09-16).
//
//   `ask` used to hold one number for two jobs, and AI9 was the only check on
//   it. Splitting them — PROMPT_MAX for what leaves the machine, QUESTION_MAX
//   for what somebody writes — would have left the person's own cap guarded by
//   NOBODY, which is how a split quietly removes a control. This is the other
//   half, at the door a person actually comes through.
{
  const f = new FormData()
  f.set(F.ledgerId, L)
  f.set(F.question, 'x'.repeat(QUESTION_MAX + 1))
  const said = await inquireFromForm(f, owner, stub([]).send)
  check(!!said.error && said.error.includes(String(QUESTION_MAX)),
    'IQ-typed a question longer than a person may type is refused at their own door',
    said.error ? said.error.slice(0, 80) : 'it was accepted')
}

console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })

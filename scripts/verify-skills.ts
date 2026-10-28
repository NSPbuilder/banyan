/**
 * ERP Skill Router: every business door is owned once, permissions shape the
 * router, one selected skill bounds every tool, and CRM proposals execute
 * exactly once only after confirmation.
 *
 *   npm run db:verify-skills   (resets the test database first)
 */
import './env'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { reporter, errorText } from './suite'
import { createCompanyWithYear } from '../src/lib/setup'
import { createFirstOwner, createUser } from '../src/lib/users'
import { setGrants } from '../src/lib/access'
import { LEDGER_NAV, MODULE_PATHS } from '../src/lib/nav'
import { setCompanyModules } from '../src/lib/company-modules'
import { serviceFrom, type Reply, type Request } from '../src/lib/assistant'
import { inquireRouted } from '../src/lib/inquiry'
import {
  ASSISTANT_SKILLS, CRM_PROPOSAL_PREFIX, availableSkills, confirmSkillCommand,
  parseSkillRoute, skillForNavPath,
} from '../src/lib/assistant-skills'
import { runTool, toolList, type ToolContext } from '../src/lib/inquiry-tools'

const r = reporter(58)
const { check } = r
const ACTOR = 'skills@example.test'
const MODEL = 'skill-router-test'

const reply = (text: string): Reply => ({
  model: MODEL,
  text,
  stopReason: 'end_turn',
  explanation: null,
  usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
})
const route = (skill: string, request: string) => reply(JSON.stringify({
  route: { skill, request, reason: `This belongs to ${skill}.` },
}))
const call = (tool: string, args: Record<string, unknown>) => reply(JSON.stringify({
  call: tool, args, why: 'Use the selected ERP skill.',
}))
const answer = (text: string) => reply(JSON.stringify({ answer: text }))

async function main() {
  const company = await createCompanyWithYear({ code: 'SKL', name: 'Skill Router Ltd.' }, ACTOR)
  const ledgerId = company.ledger.id
  const entityId = company.company.id
  const owner = await createFirstOwner({
    email: 'owner@skills.test', firstName: 'Owner', lastName: null,
    password: 'a long ordinary sentence',
  })
  // Current Project opt-in must be explicit even in a routing fixture.
  await setCompanyModules(owner,{entityId,modules:MODULE_PATHS})
  const clerk = await createUser({
    email: 'clerk@skills.test', firstName: 'Clerk', lastName: null,
    password: 'a long ordinary sentence', kind: 'user', actor: ACTOR,
  })
  await setGrants({
    userId: clerk.id, entityIds: [entityId], modules: ['/assistant', '/parties'], actor: ACTOR,
  })
  const worker = await createUser({
    email: 'worker@skills.test', firstName: 'Worker', lastName: null,
    password: 'a long ordinary sentence', kind: 'user', actor: ACTOR,
  })
  await setGrants({
    userId: worker.id, entityIds: [entityId], modules: ['/crm'], actor: ACTOR,
  })

  const service = serviceFrom({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'router-key', model: MODEL })!
  const ownerCtx: ToolContext = {
    ledgerId, entityId, entityName: company.company.name, user: owner,
  }

  // SK1 — the rail remains the authority: every ERP door except Assistant is
  // owned by exactly one skill, and no registry path was invented.
  {
    const nav = LEDGER_NAV.filter((item) => item.path !== '/assistant').map((item) => item.path)
    const declared = ASSISTANT_SKILLS.flatMap((skill) => skill.paths)
    const wrong = nav.filter((path) => declared.filter((candidate) => candidate === path).length !== 1)
    const invented = declared.filter((path) => !nav.includes(path))
    check(wrong.length === 0 && invented.length === 0
          && nav.every((path) => skillForNavPath(path) !== null),
      'SK1 every ERP navigation door is owned by exactly one skill',
      `${nav.length} doors, ${ASSISTANT_SKILLS.length} skills; wrong ${wrong.join(',') || 'none'}; invented ${invented.join(',') || 'none'}`)
  }

  // Owners remain entitled to enabled company modules; each navigation-only
  // route must also survive the database's persisted skill constraint.
  {
    const ownerSkills = await availableSkills(ledgerId, owner)
    check(ownerSkills.length === ASSISTANT_SKILLS.length,
      'SK21 an owner can route requests to every enabled company module', `${ownerSkills.length} skills`)
    for (const id of ['projects', 'documents', 'cheques', 'automation', 'inventory', 'assets'] as const) {
      let turn = 0
      const q = await inquireRouted({ ledgerId, question: `Open ${id}`, user: owner, service, prices: null }, async () => {
        if (turn++ === 0) return route(id, `Open ${id}`)
        if (turn === 2) return call('module_link', {})
        return answer(`Open ${id} using the provided link.`)
      })
      check(q.route?.skill === id && q.steps.some(s => s.tool === 'module_link' && s.result?.includes(`/ledger/${ledgerId}/${id}`)) && q.steps.at(-1)?.outcome === 'answer',
        `SK22 ${id} navigation is scoped and its routing decision persists`, q.steps.map(s => s.outcome).join(', '))
    }
  }

  // SK2 — the declared tool boundary and the actual offered boundary agree.
  {
    const drift: string[] = []
    for (const skill of ASSISTANT_SKILLS) {
      const actual = (await toolList({ ...ownerCtx, skill: skill.id }, skill.id)).map((tool) => tool.name).sort()
      const declared = [...skill.tools].sort()
      if (actual.join('|') !== declared.join('|')) drift.push(skill.id)
    }
    const unsafe = ASSISTANT_SKILLS.filter((skill) => skill.id !== 'crm'
      && (skill.mode !== 'read' || skill.tools.some((tool) => tool.startsWith('crm_draft_'))))
    check(drift.length === 0 && unsafe.length === 0,
      'SK2 each skill exposes exactly its declared tools and only CRM can propose writes',
      `tool drift ${drift.join(',') || 'none'}; non-CRM write surfaces ${unsafe.map((x) => x.id).join(',') || 'none'}`)
  }

  // SK3 — the router sees only modules this person may actually open.
  {
    const skills = await availableSkills(ledgerId, clerk)
    const ids = skills.map((skill) => skill.id)
    const rejected = parseSkillRoute(JSON.stringify({
      route: { skill: 'crm', request: 'List leads', reason: 'CRM request' },
    }), new Set(ids))
    check(ids.join(',') === 'books,parties' && rejected.kind === 'unreadable',
      'SK3 module permissions shape the router and an unauthorized route is rejected',
      `clerk sees ${ids.join(',')}; CRM route parsed as ${rejected.kind}`)
  }

  // SK4 — ambiguity stops after the router and persists the question it asks.
  {
    let sent = 0
    const q = await inquireRouted({
      ledgerId, question: 'Show me the customer information', user: owner, service, prices: null,
    }, async () => {
      sent++
      return reply(JSON.stringify({
        clarify: 'Do you mean the shared Party record or the CRM sales relationship?',
        choices: ['parties', 'crm'],
      }))
    })
    check(sent === 1 && q.route === null && q.steps.length === 1 && q.steps[0].outcome === 'clarify'
          && q.steps[0].result?.includes('shared Party record') === true,
      'SK4 an ambiguous request asks one clarification and enters no module',
      `${sent} request; ${q.steps[0].outcome}; route ${q.route?.skill ?? 'none'}`)
  }

  // SK5 — both prompts are committed before they leave, and the selected
  // skill gets only its normalized request and its own tools.
  let proposalId = ''
  let proposalStep = 0
  {
    const question = 'Add North Shore Design as a lead from the trade show'
    let turn = 0
    let routerWasStored = false
    let skillWasStored = false
    const send = async (request: Request): Promise<Reply> => {
      if (turn++ === 0) {
        const [stored] = await db.execute<{ system: string; question: string }>(raw`
          SELECT system, question FROM ai_inquiry WHERE question = ${question}`)
        routerWasStored = stored?.system === request.system && stored?.question === request.question
        return route('crm', 'Add North Shore Design as a trade-show lead')
      }
      if (turn === 2) {
        const [stored] = await db.execute<{ system: string; request: string; skill: string }>(raw`
          SELECT r.system, r.request, r.skill FROM ai_inquiry_skill r
          JOIN ai_inquiry q ON q.id = r.inquiry_id WHERE q.question = ${question}`)
        skillWasStored = stored?.system === request.system && stored?.request === 'Add North Shore Design as a trade-show lead'
          && stored?.skill === 'crm' && request.question.startsWith('Question: Add North Shore Design as a trade-show lead')
        return call('crm_draft_lead', { organisation_name: 'North Shore Design', source: 'Trade show' })
      }
      return answer('The lead is ready for your confirmation; it has not been saved.')
    }
    const q = await inquireRouted({ ledgerId, question, user: owner, service, prices: null }, send)
    const draft = q.steps.find((step) => step.tool === 'crm_draft_lead')
    proposalId = q.id
    proposalStep = draft?.n ?? 0
    check(routerWasStored && skillWasStored && turn === 3 && q.route?.skill === 'crm'
          && q.steps.map((step) => step.outcome).join(',') === 'route,call,answer'
          && draft?.result?.startsWith(CRM_PROPOSAL_PREFIX) === true,
      'SK5 routing is persisted before either model stage leaves and CRM returns a proposal, not a write',
      `router stored ${routerWasStored}; skill stored ${skillWasStored}; ${turn} requests; steps ${q.steps.map((x) => x.outcome).join(',')}`)
  }

  // SK6 — confirmation, the CRM row, its ordinary audit event and the
  // execution marker commit together; replay cannot create a second row.
  {
    const said = await confirmSkillCommand({ ledgerId, inquiryId: proposalId, stepN: proposalStep, user: owner })
    const [counts] = await db.execute<{ leads: string; audits: string; runs: string }>(raw`
      SELECT
        (SELECT count(*) FROM crm_lead WHERE entity_id = ${entityId}::uuid
          AND organisation_name = 'North Shore Design')::text AS leads,
        (SELECT count(*) FROM audit_log WHERE entity_id = ${entityId}::uuid
          AND action = 'create_crm_lead' AND target_label = 'North Shore Design')::text AS audits,
        (SELECT count(*) FROM ai_skill_command_execution
          WHERE inquiry_id = ${proposalId}::uuid AND step_n = ${proposalStep})::text AS runs`)
    let replay = ''
    try {
      await confirmSkillCommand({ ledgerId, inquiryId: proposalId, stepN: proposalStep, user: owner })
    } catch (e) { replay = errorText(e) }
    const [after] = await db.execute<{ leads: string }>(raw`
      SELECT count(*)::text AS leads FROM crm_lead WHERE entity_id = ${entityId}::uuid
       AND organisation_name = 'North Shore Design'`)
    check(said.includes('Lead added') && counts.leads === '1' && counts.audits === '1' && counts.runs === '1'
          && replay.includes('already used') && after.leads === '1',
      'SK6 a confirmed proposal writes business data, audit and idempotency once',
      `${counts.leads} lead, ${counts.audits} audit, ${counts.runs} execution; replay ${replay.includes('already used') ? 'refused' : 'not refused'}`)
  }

  // SK7 — if a condition changes after the proposal, the command marker rolls
  // back with the failed CRM write rather than recording false success.
  {
    const question = 'Add a lead assigned to Worker'
    let turn = 0
    const q = await inquireRouted({ ledgerId, question, user: owner, service, prices: null }, async () => {
      turn++
      if (turn === 1) return route('crm', question)
      if (turn === 2) return call('crm_draft_lead', { organisation_name: 'Rollback Lead', owner_user_id: worker.id })
      return answer('Ready for confirmation.')
    })
    const draft = q.steps.find((step) => step.tool === 'crm_draft_lead')!
    await setGrants({ userId: worker.id, entityIds: [entityId], modules: [], actor: ACTOR })
    let failed = ''
    try {
      await confirmSkillCommand({ ledgerId, inquiryId: q.id, stepN: draft.n, user: owner })
    } catch (e) { failed = errorText(e) }
    const [counts] = await db.execute<{ leads: string; runs: string }>(raw`
      SELECT
        (SELECT count(*) FROM crm_lead WHERE entity_id = ${entityId}::uuid
          AND organisation_name = 'Rollback Lead')::text AS leads,
        (SELECT count(*) FROM ai_skill_command_execution
          WHERE inquiry_id = ${q.id}::uuid AND step_n = ${draft.n})::text AS runs`)
    check(failed.includes('active person with CRM access') && counts.leads === '0' && counts.runs === '0',
      'SK7 a failed confirmed write leaves neither business row nor success marker',
      `${failed.split(' | ')[0]}; ${counts.leads} leads, ${counts.runs} executions`)
  }

  // SK8 — the model cannot mint a URL. It asks for the selected module and
  // the server chooses both the address and the currently permitted entry.
  {
    const ownerLink = await runTool({ ...ownerCtx, skill: 'backup' }, 'module_link', {}, new Set())
    const clerkLink = await runTool({ ...ownerCtx, user: clerk, skill: 'backup' }, 'module_link', {}, new Set())
    const clerkBooksLink = await runTool({ ...ownerCtx, user: clerk, skill: 'books' }, 'module_link', {}, new Set())
    const escaped = await runTool({ ...ownerCtx, skill: 'backup' }, 'journal', {}, new Set())
    check(ownerLink.includes(`/ledger/${ledgerId}/backup`) && !clerkLink.includes(`/ledger/${ledgerId}/backup`)
          && clerkLink.includes('no longer have access') && !clerkBooksLink.includes(`/ledger/${ledgerId}/`)
          && clerkBooksLink.includes('no longer have access') && escaped.includes('no tool by that name in Backup'),
      'SK8 module links are server-chosen and a selected skill cannot call another skill',
      `owner link exact ${ownerLink.includes(`/ledger/${ledgerId}/backup`)}; clerk module and overview refused; cross-skill refused`)
  }

  // SK9 — routed facts are append-only like the inquiry they explain.
  {
    let routeEdit = '', executionDelete = ''
    try { await db.execute(raw`UPDATE ai_inquiry_skill SET route_reason = 'changed' WHERE inquiry_id = ${proposalId}::uuid`) }
    catch (e) { routeEdit = errorText(e) }
    try { await db.execute(raw`DELETE FROM ai_skill_command_execution WHERE inquiry_id = ${proposalId}::uuid`) }
    catch (e) { executionDelete = errorText(e) }
    check(routeEdit.includes('AI_INQUIRY_IMMUTABLE') && executionDelete.includes('AI_INQUIRY_IMMUTABLE'),
      'SK9 routes and confirmed-command facts are append-only',
      `route edit ${routeEdit.includes('IMMUTABLE') ? 'refused' : 'allowed'}; execution delete ${executionDelete.includes('IMMUTABLE') ? 'refused' : 'allowed'}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await conn.end()
  process.exit(1)
})

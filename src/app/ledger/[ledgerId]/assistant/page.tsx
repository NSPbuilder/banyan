
import { PageHeading } from '@/components/DialogHeading'
import { formatNumber } from '@/lib/numbers'
import { requireUser } from '@/lib/gate'
import {refuseForLedger} from '@/lib/access'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { QUESTION_MAX, costOf, earlierQuestionsFor } from '@/lib/assistant'
import { panelStateFrom, serviceState } from '@/lib/ai-service'
import {
  confirmSkillCommandAction, inquireAction, keepLookingAction,
} from '@/app/actions'
import { ConfirmSkillCommandForm, InquireForm, KeepLookingForm } from './InquireForm'
import { AiServiceStatus } from '@/components/AiServiceStatus'
import { ledgerHead } from '@/lib/ledger-head'
import { REFUSAL } from '@/lib/ui'
import {
  answerOf, answerParts, costOfInquiry, inquiriesFor, keepLookingOffer, parseReply, stopLine, type Step,
} from '@/lib/inquiry'
import { availableSkills, CRM_PROPOSAL_PREFIX, isCrmDraftTool, skillById } from '@/lib/assistant-skills'
import { AiModeNav } from '@/components/AiModeNav'

export const dynamic = 'force-dynamic'

const when = (iso: string) => iso.replace('T', ' ').slice(0, 16)

function StepDetail({ step }: { step: Step }) {
  if (step.outcome === 'more') {
    return <li className="text-neutral-500">{when(step.at)} · {step.asked_by} asked it to keep looking</li>
  }
  const parsed = parseReply(step.model_text)
  return (
    <li>
      <p className="text-neutral-500">
        {step.n}. {step.outcome.replaceAll('_', ' ')}
        {step.tool && <> · <span className="font-mono">{step.tool}</span> {step.args && <span className="font-mono">{JSON.stringify(step.args)}</span>}</>}
      </p>
      {parsed.kind === 'call' && parsed.why && <p className="text-neutral-500">{parsed.why}</p>}
      {step.error !== null && <p className="text-neutral-500">{step.error}</p>}
      {step.result !== null && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono">{step.result}</pre>
      )}
    </li>
  )
}

/**
 * The assistant's page: the person's service, one box to ask the books in,
 * and the questions asked here — the viewer's own, or every one for an owner
 * (not a person merely granted every seat), since a question's look-ups carry what its asker's
 * seats let the tools read.
 */
export default async function Assistant({
  params, searchParams,
}: { params: Promise<{ ledgerId: string }>; searchParams: Promise<{ from?: string }> }) {
  const user = await requireUser()
  const { ledgerId } = await params
  const { from } = await searchParams
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()

  const [inquiries, earlier, state, skills] = await Promise.all([
    inquiriesFor(ledgerId, user), earlierQuestionsFor(ledgerId, user), serviceState(user.id),
    availableSkills(ledgerId, user),
  ])
  // What the panel shows: never the key, never the ciphertext (AI19).
  const panel = panelStateFrom(state)
  const startFrom = from ? inquiries.find((q) => q.id === from) : undefined
  const start = startFrom ? answerOf(startFrom.steps)?.text : undefined

  return (
    <main className="mx-auto w-full max-w-4xl px-8 py-10 font-sans">
      <PageHeading className="mt-2" title={<>AI</>} />
      <div className="mt-1 flex flex-wrap gap-x-1 text-sm text-neutral-500">
        <p>{head.entity}</p>

      </div>
      <AiModeNav ledgerId={ledgerId} active="ask" showInbox={!(await refuseForLedger(user,ledgerId,'/automation'))}/>
      <p className="mt-3 text-sm"><Link href={`/ledger/${ledgerId}/assistant/mcp`} className="underline underline-offset-4">Review your MCP proposals</Link></p>
      <p className="mt-4 max-w-2xl text-sm text-neutral-500" data-ai-privacy-boundary>
        Every question sends this company&apos;s lookup results to your saved service. What went out is kept with the answer.
      </p>
      <p className="mt-2 max-w-2xl text-xs text-neutral-500">
        AI receives names, amounts, notes and descriptions. Employee SIN fields and other companies
        are excluded; SINs typed in free text are sent.
      </p>
      <div className="mt-4 max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Available ERP skills</p>
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Available ERP skills">
          {skills.map((skill) => (
            <li key={skill.id} className="rounded-full border border-neutral-300 px-2.5 py-1 text-xs dark:border-neutral-700">
              {skill.label}{skill.mode === 'confirm' ? ' · confirm changes' : ''}
            </li>
          ))}
        </ul>

      </div>

      <AiServiceStatus ledgerId={ledgerId} state={panel} />
      {state.kind === 'ready' && (
        <InquireForm ledgerId={ledgerId} action={inquireAction} max={QUESTION_MAX} start={start} />
      )}

      <h2 className="mt-10 mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
        Asked so far{inquiries.length >= 30 ? ' — the most recent 30' : ''}
      </h2>
      {inquiries.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing yet.</p>
      ) : (
        <ol className="space-y-6">
          {inquiries.map((q) => {
            const answer = answerOf(q.steps)
            const stop = stopLine(q.steps)
            const cost = costOfInquiry(q)
            const tokens = q.steps.reduce((t, s) => t + s.input_tokens + s.cache_read_tokens, 0)
            const out = q.steps.reduce((t, s) => t + s.output_tokens, 0)
            const capped = q.steps.some((s) => s.capped)
            const offer = keepLookingOffer(q, user.email, state.kind === 'ready' ? state.saved.service : null)
            const clarification = q.steps.find((step) => step.outcome === 'clarify')?.result
            const pending = q.steps.filter((step) => isCrmDraftTool(step.tool)
              && step.result?.startsWith(CRM_PROPOSAL_PREFIX)
              && !(q.executions ?? []).some((execution) => execution.step_n === step.n))
            return (
              <li key={q.id} className="rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
                <p className="text-xs text-neutral-500">
                  {when(q.asked_at)} · {q.asked_by} · {q.service ?? 'unknown service'} · {q.model}
                  {' · '}{tokens} in, {out} out
                  {cost !== null && <> · {q.price_unit ?? '$'}{formatNumber(cost.toFixed(4))}</>}
                </p>
                <p className="mt-2 whitespace-pre-wrap font-medium">{q.question}</p>
                {q.route && (
                  <p className="mt-2 text-xs text-neutral-500">
                    Routed to <span className="font-semibold text-neutral-700 dark:text-neutral-300">
                      {skillById(q.route.skill).label}
                    </span> · {q.route.route_reason}
                  </p>
                )}
                {clarification && (
                  <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                    {clarification}
                  </p>
                )}
                {answer && (
                  <p className="mt-3 whitespace-pre-wrap">
                    {answerParts(answer.text, q.steps, ledgerId).map((part, i) => part.href
                      ? <Link key={i} href={part.href} className="underline">{part.text}</Link>
                      : part.unverified
                        ? <span key={i} className="underline decoration-amber-500 decoration-2"
                                title="This figure is not in anything it looked up">{part.text}</span>
                        : <span key={i}>{part.text}</span>)}
                  </p>
                )}
                {answer?.unformatted && (
                  <p className="mt-1 text-xs text-neutral-500">Not in the agreed format — shown as it came back.</p>
                )}
                {stop && (
                  <p className={`mt-3 ${q.steps.at(-1)?.outcome === 'refusal' || q.steps.at(-1)?.outcome === 'error' ? REFUSAL : 'text-xs text-neutral-500'}`}>
                    {stop}
                    {capped && answer && (
                      <> <Link href={`/ledger/${ledgerId}/assistant?from=${q.id}`} className="underline">Start a narrower question from its answer</Link></>
                    )}
                  </p>
                )}
                {offer === 'button' && <KeepLookingForm ledgerId={ledgerId} inquiryId={q.id} action={keepLookingAction} />}
                {offer === 'elsewhere' && (
                  <p className="mt-3 text-xs text-neutral-500">
                    Keep looking goes only to the service this was asked with ({q.service ?? 'unknown service'} · {q.model}),
                    and yours has changed since. Ask it again.
                  </p>
                )}
                {pending.map((step) => (
                  <div key={step.n} className="mt-3 rounded border border-clay-300 bg-clay-50 p-3 dark:border-clay-900 dark:bg-clay-950">
                    <pre className="whitespace-pre-wrap font-sans text-sm">{step.result}</pre>
                    {q.asked_by === user.email && (
                      <ConfirmSkillCommandForm ledgerId={ledgerId} inquiryId={q.id} stepN={step.n}
                                               action={confirmSkillCommandAction} />
                    )}
                  </div>
                ))}
                {(q.executions ?? []).length > 0 && (
                  <p className="mt-3 text-xs text-neutral-500">
                    {formatNumber((q.executions ?? []).length)} confirmed proposal{(q.executions ?? []).length === 1 ? '' : 's'} saved.
                  </p>
                )}
                {q.steps.length > 0 && (
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-neutral-500">What it looked up</summary>
                    <ol className="mt-2 space-y-3">
                      {q.steps.map((s) => <StepDetail key={s.n} step={s} />)}
                    </ol>
                  </details>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {earlier.length > 0 && (
        <>
          <h2 className="mt-10 mb-3 text-xs font-semibold uppercase tracking-widest text-neutral-500">
            Earlier questions{earlier.length >= 30 ? ' — the most recent 30' : ''}
          </h2>
          <ol className="space-y-6">
            {earlier.map((x) => {
              const cost = costOf(x)
              return (
                <li key={x.id} className="rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
                  <p className="text-xs text-neutral-500">
                    {when(x.asked_at)} · {x.asked_by} · {x.service ?? 'unknown service'} · {x.model}
                    {' · '}{x.input_tokens + x.cache_read_tokens + x.cache_write_tokens} in, {x.output_tokens} out
                    {cost !== null && <> · {x.price_unit ?? '$'}{formatNumber(cost.toFixed(4))}</>}
                    {x.books_sent !== null ? ' · the books were sent' : ' · nothing from the books was sent'}
                  </p>
                  <p className="mt-2 whitespace-pre-wrap font-medium">{x.question}</p>
                  {x.answer !== null && <p className="mt-3 whitespace-pre-wrap">{x.answer}</p>}
                  {x.error !== null && (
                    <p className={`mt-3 ${REFUSAL}`}>
                      {x.stop_reason === 'refusal' ? 'The model declined: ' : 'The call failed: '}{x.error}
                    </p>
                  )}
                  {x.books_sent !== null && (
                    <details className="mt-3 text-xs text-neutral-500">
                      <summary className="cursor-pointer">What the books contributed</summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono">{x.books_sent}</pre>
                    </details>
                  )}
                </li>
              )
            })}
          </ol>
        </>
      )}
    </main>
  )
}

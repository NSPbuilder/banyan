'use client'

import { DataTable } from '@/components/Table'

import { formatNumber } from '@/lib/numbers'
import { useState } from 'react'
import Link from 'next/link'
import { ActionForm, useActionForm, type FormAction } from '@/components/ActionForm'
import { SRED_FIELDS as F } from '@/lib/sred-fields'
import { formatMoney } from '@/lib/money'
import { DateInput } from '@/components/DateInput'
import {
  EVIDENCE_KINDS, LINE_CATEGORIES, PROJECT_STATUS, matchesCost,
} from '@/lib/sred-kinds'
import type {
  Allocatable, CostLens, EvidenceRow, SredClaim, SredProject, SredTimeRow, WorkingPaper,
} from '@/lib/sred-kinds'
import { BUTTON, CARD, FIELD, LABEL, QUIET, REFUSAL } from '@/lib/ui'

/**
 * One project, in the order a claim is actually built: the record first, the
 * money second.
 *
 * WHY THE TABS ARE IN THIS ORDER. Evidence and time are what a claim is lost
 * on and what cannot be recovered after the year ends; the allocation and the
 * working paper can be done in an afternoon in month eighteen. Putting the
 * money first would be putting the easy part first.
 *
 * NO BLANK BOXES AT REST (owner, 2026-09-16: 「SRED 的页面非常凌乱，有太多空
 * 需要填了，如果这样不如做成一个表格」). Every list is a table of what is on
 * file. Changing a row is pressing its Edit, which turns THAT row into boxes;
 * adding one is a button that opens a floating form (`time/new`,
 * `evidence/new`). The project and the year's three answers read as text until
 * they are edited the same way.
 */

type Actions = {
  openClaim: FormAction; saveClaim: FormAction
  allocate: FormAction; unallocate: FormAction
  fileClaim: FormAction; unfileClaim: FormAction
  /** A year's claim opened by mistake, deleted while unfiled (0084). */
  deleteClaim: FormAction
  updateProject: FormAction; deleteProject: FormAction
  updateTime: FormAction; deleteTime: FormAction
  updateEvidence: FormAction; deleteEvidence: FormAction
}

const TABS = ['record', 'time', 'money', 'paper'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = {
  record: 'What was uncertain',
  time: 'Time',
  money: 'What it cost',
  paper: 'Working paper',
}

const money = (n: bigint) => formatMoney(n, { sign: 'accounting' })

const TH = 'py-2 pr-3 font-medium'
const HEAD = 'border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700'
const EDIT = 'text-xs text-neutral-500 underline-offset-2 hover:text-neutral-900 hover:underline dark:hover:text-white'
const YEAR_BUTTON = 'inline-flex h-[34px] shrink-0 items-center rounded-md border px-2 text-xs font-medium'

/**
 * The project itself, correctable — and the three of its columns no screen
 * could reach.
 *
 * `field_of_science`, `status` and `ended_on` have been in 0068 since the
 * module was built and the only door that touched them was the INSERT, which
 * set the first to whatever the form did not send and the other two to their
 * defaults. A column a person cannot set is a column that will hold whatever it
 * was born with, which for `status` means every project is `active` forever —
 * including the ones that were abandoned, and work that did not resolve its
 * uncertainty is still SR&ED (0068's own words).
 *
 * Read as text until Edit is pressed. `initialEditing` is where the harness
 * starts it: a form nobody has opened is not in the markup to be read.
 */
export function ProjectFields({ ledgerId, project, actions, initialEditing = false }: {
  ledgerId: string; project: SredProject; actions: Actions; initialEditing?: boolean
}) {
  const [editing, setEditing] = useState(initialEditing)
  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg font-semibold">The project</h2>
        {!editing && <button type="button" onClick={() => setEditing(true)} className={QUIET}>Edit</button>}
      </div>
      {editing ? (
        <>
          <ActionForm action={actions.updateProject} submit="Save" working="…"
                      onSucceeded={() => setEditing(false)}
                      className="mt-3 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
            <input type="hidden" name={F.ledgerId} value={ledgerId} />
            <input type="hidden" name={F.projectId} value={project.id} />
            <label className="text-xs text-neutral-500">
              <span className={LABEL}>Code</span>
              <input name={F.code} required defaultValue={project.code} className={`mt-1 w-24 ${FIELD}`} />
            </label>
            <label className="text-xs text-neutral-500">
              <span className={LABEL}>What was uncertain</span>
              <input name={F.title} required defaultValue={project.title} className={`mt-1 w-96 ${FIELD}`} />
            </label>
            <label className="text-xs text-neutral-500">
              <span className={LABEL}>Field of science</span>
              <input name={F.fieldOfScience} defaultValue={project.field_of_science ?? ''} className={`mt-1 w-64 ${FIELD}`} />
            </label>
            <label className="text-xs text-neutral-500">
              <span className={LABEL}>Started</span>
              <DateInput name={F.startedOn} required defaultValue={project.started_on}
                         className={`mt-1 ${FIELD}`} />
            </label>
            <label className="text-xs text-neutral-500">
              <span className={LABEL}>Ended</span>
              <DateInput name={F.endedOn} defaultValue={project.ended_on ?? ''} className={`mt-1 ${FIELD}`} />
            </label>
            <label className="text-xs text-neutral-500">
              <span className={LABEL}>Status</span>
              <select name={F.status} defaultValue={project.status} className={`mt-1 ${FIELD}`}>
                {PROJECT_STATUS.map((st) => <option key={st} value={st}>{st}</option>)}
              </select>
            </label>
          </ActionForm>
          <button type="button" onClick={() => setEditing(false)} className={`mt-2 ${EDIT}`}>Cancel</button>

          <div className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <ActionForm action={actions.deleteProject} submit="Delete this project" working="…"
                        className="inline" buttonClassName={QUIET}>
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
              <input type="hidden" name={F.projectId} value={project.id} />
            </ActionForm>
            <span className="ml-3 text-xs text-neutral-500">
              Its claims, hours and evidence go with it. Refused once any year of it has been filed.
            </span>
          </div>
        </>
      ) : (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-neutral-500">Code</dt><dd className="font-mono">{project.code}</dd>
          <dt className="text-neutral-500">What was uncertain</dt><dd>{project.title}</dd>
          <dt className="text-neutral-500">Field of science</dt><dd>{project.field_of_science ?? '—'}</dd>
          <dt className="text-neutral-500">Started</dt><dd className="font-mono">{project.started_on}</dd>
          <dt className="text-neutral-500">Ended</dt><dd className="font-mono">{project.ended_on ?? '—'}</dd>
          <dt className="text-neutral-500">Status</dt><dd>{project.status}</dd>
        </dl>
      )}
    </section>
  )
}

/**
 * A batch, pasted.
 *
 * EXPORTED for `scripts/render-sred-record.tsx`: what this box accepts is a
 * contract with `docs/design/34-sred-intake.md`, and a contract nobody renders
 * is a contract. The names it prints are `TIME_PASTE_FIELDS` and
 * `EVIDENCE_PASTE_FIELDS` from sred-kinds.ts — THE SAME ARRAYS THE PARSERS
 * COUNT AGAINST — so the number of fields this box asks for cannot drift from
 * the number the parser reads. Their ORDER is not shared; see the note on those
 * constants (independent critic, 2026-09-12).
 *
 * It lives in the add forms now (`time/new`, `evidence/new`), under the one-row
 * form, because a batch is a way of adding.
 */
export function PasteBox({ ledgerId, projectId, action, fields }: {
  ledgerId: string; projectId: string; action: FormAction
  fields: readonly string[]
}) {
  return (
    <details className="mt-6">
      <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-white">
        Paste a batch
      </summary>
      <p className="mt-2 font-mono text-xs text-neutral-500">{fields.join(' | ')}</p>
      <ActionForm action={action} submit="Add the batch" working="…"
                  className="mt-2" buttonClassName={QUIET}>
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        <input type="hidden" name={F.projectId} value={projectId} />
        <textarea name={F.paste} rows={6} required
                  aria-label="Rows to add"
                  className={`w-full font-mono text-xs ${FIELD}`} />
      </ActionForm>
    </details>
  )
}

/**
 * The hours already recorded — a table, each row correctable in place once its
 * Edit is pressed.
 *
 * EXPORTED for the same reason as `YearStrip`: which row's id a form carries is
 * the whole of what "edit" means here, and it lives in markup. `initialEditing`
 * opens a row for the harness, since a row nobody has opened carries no form.
 */
export function TimeTable({ ledgerId, projectId, time, actions, initialEditing = null }: {
  ledgerId: string; projectId?: string; time: SredTimeRow[]; actions: Actions; initialEditing?: string | null
}) {
  const [editing, setEditing] = useState<string | null>(initialEditing)
  if (time.length === 0) return <p className="mt-3 text-sm text-neutral-500">No hours recorded yet.</p>
  return (
    <DataTable density="reading" className="mt-3 w-full text-sm">
      <thead>
        <tr className={HEAD}>
          <th className={TH}>Day</th>
          <th className={TH}>Who</th>
          <th className={`${TH} text-right`}>Hours</th>
          <th className={TH}>What was done</th>
          <th className={TH}>Written down</th>
          <th className="py-2 font-medium" />
        </tr>
      </thead>
      <tbody>
        {time.map((t) => {
          if (editing !== t.id) {
            return (
              <tr key={t.id} data-time={t.id} className="border-b border-neutral-100 dark:border-neutral-900">
                <td className="py-1.5 pr-3 font-mono text-xs text-neutral-500">{t.on_date}</td>
                <td className="py-1.5 pr-3">{t.who}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{t.hours}</td>
                <td className="py-1.5 pr-3">{t.activity}</td>
                <td className={`py-1.5 pr-3 text-xs ${t.lag_days > 30 ? 'text-amber-700 dark:text-amber-400' : 'text-neutral-500'}`}>
                  {t.lag_days === 0 ? 'same day' : `${t.lag_days} days later`}
                </td>
                <td className="py-1.5 text-right">
                  {projectId && <Link href={`/ledger/${ledgerId}/sred/${projectId}/time/new?copy=${t.id}`}
                        className={`${EDIT} mr-3`}>Copy</Link>
                  }
                  <button type="button" onClick={() => setEditing(t.id)} className={EDIT} aria-label={`Edit the hours of ${t.on_date}`}>
                    Edit
                  </button>
                </td>
              </tr>
            )
          }
          // ONE PLACE THE ROW'S ID IS WRITTEN, used by both forms. Two copies of
          // it is two chances for one of them to end up naming a different row,
          // and "this button acts on this row" is the whole of what correcting
          // in place means.
          const which = (
            <>
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
              <input type="hidden" name={F.timeId} value={t.id} />
            </>
          )
          return (
          <tr key={t.id} data-time={t.id} className="border-b border-neutral-100 bg-neutral-50 dark:border-neutral-900 dark:bg-neutral-950">
            <td colSpan={6} className="py-2">
              <div className="flex flex-wrap items-end gap-2">
                <span className="text-xs text-neutral-500">{t.who}</span>
                <ActionForm action={actions.updateTime} submit="Save" working="…"
                            onSucceeded={() => setEditing(null)}
                            className="flex flex-wrap items-end gap-2" buttonClassName={QUIET}>
                  {which}
                  <DateInput name={F.onDate} required defaultValue={t.on_date}
                             aria-label="Day" className={`${FIELD} py-1 text-xs`} />
                  <input name={F.hours} required inputMode="decimal" defaultValue={t.hours}
                         aria-label="Hours" className={`w-16 ${FIELD} py-1 text-xs`} />
                  <input name={F.activity} required defaultValue={t.activity}
                         aria-label="What was done" className={`w-72 ${FIELD} py-1 text-xs`} />
                </ActionForm>
                <ActionForm action={actions.deleteTime} submit="Delete" working="…"
                            className="inline" buttonClassName={QUIET}>
                  {which}
                </ActionForm>
                <button type="button" onClick={() => setEditing(null)} className={EDIT}>Cancel</button>
              </div>
            </td>
          </tr>
          )
        })}
      </tbody>
    </DataTable>
  )
}

/** The paper already listed — a table, each row correctable once its Edit is pressed. Exported for the harness. */
export function EvidenceTable({ ledgerId, projectId, evidence, actions, initialEditing = null }: {
  ledgerId: string; projectId?: string; evidence: EvidenceRow[]; actions: Actions; initialEditing?: string | null
}) {
  const [editing, setEditing] = useState<string | null>(initialEditing)
  if (evidence.length === 0) return <p className="mt-3 text-sm text-neutral-500">No evidence listed yet.</p>
  const label = (kind: string) => EVIDENCE_KINDS.find((k) => k.kind === kind)?.label ?? kind
  return (
    <DataTable density="reading" className="mt-4 w-full text-sm">
      <thead>
        <tr className={HEAD}>
          <th className={TH}>Dated</th>
          <th className={TH}>Kind</th>
          <th className={TH}>What it is</th>
          <th className={TH}>File</th>
          <th className="py-2 font-medium" />
        </tr>
      </thead>
      <tbody>
        {evidence.map((e) => {
          if (editing !== e.id) {
            return (
              <tr key={e.id} data-evidence={e.id} className="border-b border-neutral-100 dark:border-neutral-900">
                <td className="py-1.5 pr-3 font-mono text-xs text-neutral-500">{e.on_date}</td>
                <td className="py-1.5 pr-3 text-xs">{label(e.kind)}</td>
                <td className="py-1.5 pr-3">{e.title}</td>
                <td className="py-1.5 pr-3 text-xs text-neutral-500">{e.filename ?? ''}</td>
                <td className="py-1.5 text-right">
                  {projectId && <Link href={`/ledger/${ledgerId}/sred/${projectId}/evidence/new?copy=${e.id}`}
                        className={`${EDIT} mr-3`}>Copy</Link>
                  }
                  <button type="button" onClick={() => setEditing(e.id)} className={EDIT} aria-label={`Edit ${e.title}`}>
                    Edit
                  </button>
                </td>
              </tr>
            )
          }
          // Same reason as the hours table: one place the row's id is written.
          const which = (
            <>
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
              <input type="hidden" name={F.evidenceId} value={e.id} />
            </>
          )
          return (
          <tr key={e.id} data-evidence={e.id} className="border-b border-neutral-100 bg-neutral-50 dark:border-neutral-900 dark:bg-neutral-950">
            <td colSpan={5} className="py-2">
              <div className="flex flex-wrap items-end gap-2">
                <ActionForm action={actions.updateEvidence} submit="Save" working="…"
                            onSucceeded={() => setEditing(null)}
                            className="flex flex-wrap items-end gap-2" buttonClassName={QUIET}>
                  {which}
                  <DateInput name={F.onDate} required defaultValue={e.on_date}
                             aria-label="Dated" className={`${FIELD} py-1 text-xs`} />
                  <select name={F.kind} defaultValue={e.kind} aria-label="Kind"
                          className={`${FIELD} py-1 text-xs`}>
                    {EVIDENCE_KINDS.map((k) => (
                      <option key={k.kind} value={k.kind}>{k.label}</option>
                    ))}
                  </select>
                  <input name={F.title} required defaultValue={e.title}
                         aria-label="What it is" className={`w-80 ${FIELD} py-1 text-xs`} />
                  <input name={F.note} defaultValue={e.note ?? ''}
                         aria-label="Note" className={`w-64 ${FIELD} py-1 text-xs`} />
                </ActionForm>
                <ActionForm action={actions.deleteEvidence} submit="Delete" working="…"
                            className="inline" buttonClassName={QUIET}>
                  {which}
                </ActionForm>
                <button type="button" onClick={() => setEditing(null)} className={EDIT}>Cancel</button>
              </div>
            </td>
          </tr>
          )
        })}
      </tbody>
    </DataTable>
  )
}

/**
 * The year buttons, and the button that opens the year being looked at.
 *
 * EXPORTED so a render harness can read the opener back: the year the button
 * submits, and whether it is there at all, were half of the defect `viewedYear`
 * in sred-kinds.ts sets out. Whether the button shows is decided by the year in
 * front of you, not by whether the project has any claim anywhere. `S30` renders
 * it on a year with no claim while another year has one.
 */
export function YearStrip({ ledgerId, projectId, years, claims, yearId, openClaim }: {
  ledgerId: string
  projectId: string
  years: Array<{ id: string; name: string }>
  claims: Array<{ fiscal_year_id: string }>
  yearId: string | null
  openClaim: FormAction
}) {
  const unclaimed = yearId !== null && !claims.some((c) => c.fiscal_year_id === yearId)
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <span className="text-xs text-neutral-500">Year</span>
      {years.map((y) => {
        const has = claims.some((c) => c.fiscal_year_id === y.id)
        return (
          <Link key={y.id} href={`/ledger/${ledgerId}/sred/${projectId}?year=${y.id}`}
                className={`${YEAR_BUTTON} ${
                  yearId === y.id
                    ? 'border-clay-600 bg-clay-600 text-white'
                    : 'border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300'}`}>
            {y.name}{has ? '' : ' ·'}
          </Link>
        )
      })}
      {unclaimed && (
        <ActionForm action={openClaim} submit="Start a claim for this year" working="…"
                    buttonClassName={QUIET} className="inline">
          <input type="hidden" name={F.ledgerId} value={ledgerId} />
          <input type="hidden" name={F.projectId} value={projectId} />
          <input type="hidden" name={F.fiscalYearId} value={yearId} />
        </ActionForm>
      )}
    </div>
  )
}

export function ProjectBody({
  ledgerId, project, years, claims, claim, yearId, paper, time, evidence, standing,
  salary, lines, allocations, actions,
}: {
  ledgerId: string
  project: SredProject
  years: Array<{ id: string; name: string; start_date: string; end_date: string }>
  claims: SredClaim[]
  claim: SredClaim | null
  /** The year being looked at, which is not always a year that has a claim. */
  yearId: string | null
  paper: WorkingPaper | null
  time: SredTimeRow[]
  evidence: EvidenceRow[]
  standing: Array<{ answers: 'why' | 'how' | 'cost'; kinds: number; held: number; missing: string[] }>
  salary: Allocatable[]
  lines: Allocatable[]
  allocations: Array<{ id: string; source_kind: string; source_id: string; category: string; percent: string; basis: string }>
  actions: Actions
}) {
  const [tab, setTab] = useState<Tab>('record')
  const allocated = new Map(allocations.map((a) => [`${a.source_kind}:${a.source_id}`, a]))

  return (
    <>
      <YearStrip ledgerId={ledgerId} projectId={project.id} years={years} claims={claims}
                 yearId={yearId} openClaim={actions.openClaim} />

      <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-neutral-200 text-sm dark:border-neutral-800">
        {TABS.map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
                  className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 ${t === tab
                    ? 'border-clay-600 font-medium'
                    : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-white'}`}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>

      {tab === 'record' && (
        <Record ledgerId={ledgerId} project={project} claim={claim} evidence={evidence}
                standing={standing} actions={actions} />
      )}
      {tab === 'time' && (
        <Time ledgerId={ledgerId} project={project} time={time} actions={actions} />
      )}
      {tab === 'money' && (
        <Money ledgerId={ledgerId} claim={claim} salary={salary} lines={lines}
               allocated={allocated} actions={actions} />
      )}
      {tab === 'paper' && (
        <Paper paper={paper} ledgerId={ledgerId} claim={claim} actions={actions} />
      )}
    </>
  )
}

// ------------------------------------------------------------- the record --

const QUESTIONS = [
  ['242', 'uncertainty', 'uncertainty_text', 'What scientific or technological uncertainty did you try to overcome?', 350,
   'Not what you built — what you did not know would work, and why standard practice could not tell you.'],
  ['244', 'workDone', 'work_done_text', 'What work did you do in the year to overcome it?', 700,
   'The systematic part: hypothesis, what you tried, what happened, what you concluded.'],
  ['246', 'advancement', 'advancement_text', 'What advancement did you achieve?', 350,
   'Knowledge counts. "It cannot be done this way, and here is why" is an advancement.'],
] as const

const words = (s: string | null) => (s ?? '').trim().split(/\s+/).filter(Boolean).length

/**
 * The year's three answers, the method and the assistance question — read as
 * text, and a form only once Edit is pressed. Exported for `S38`, which renders
 * it at rest.
 */
export function ClaimAnswers({ ledgerId, claim, actions }: { ledgerId: string; claim: SredClaim; actions: Actions }) {
  const [editing, setEditing] = useState(false)
  const { state, pending, formProps } = useActionForm(actions.saveClaim, { onSucceeded: () => setEditing(false) })

  if (!editing) {
    return (
      <section className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-lg font-semibold">The three questions</h2>
          {!claim.filed_on && <button type="button" onClick={() => setEditing(true)} className={QUIET}>Edit</button>}
        </div>

        {state.ok && (
          <p role="status" className="mt-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            {state.ok}
          </p>
        )}
        {QUESTIONS.map(([line, , column, question, limit]) => {
          const text = claim[column]
          return (
            <div key={line} className="mt-5">
              <p className={LABEL}>Line {line} · {question}</p>
              {text
                ? <p className="mt-1 whitespace-pre-wrap text-sm">{text}</p>
                : <p className="mt-1 text-sm text-red-700 dark:text-red-400">Not answered yet.</p>}
              <p className="mt-0.5 text-xs text-neutral-400">{words(text)} words written · {limit} allowed</p>
            </div>
          )
        })}
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-neutral-500">Overhead method</dt>
          <dd>{claim.method === 'proxy' ? 'Proxy — 55% of the salary base' : 'Traditional — actual overhead, tracked'}</dd>
          <dt className="text-neutral-500">Government assistance</dt>
          <dd className={claim.assistance_answered_on ? '' : 'text-amber-700 dark:text-amber-400'}>
            {claim.assistance_answered_on
              ? (claim.assistance_note || 'Answered.')
              : 'Not answered — the line CRA adjusts most often.'}
          </dd>
        </dl>
      </section>
    )
  }

  return (
    <form {...formProps} className={CARD}>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <input type="hidden" name={F.claimId} value={claim.id} />
      <h2 className="font-serif text-lg font-semibold">The three questions</h2>

      {QUESTIONS.map(([line, field, column, question, limit]) => (
        <label key={line} className="mt-5 block">
          <span className={LABEL}>Line {line} · {question}</span>

          <textarea name={F[field]} defaultValue={claim[column] ?? ''} rows={5}
                    className={`mt-1 w-full ${FIELD}`} />
          <span className="mt-0.5 block text-xs text-neutral-400">
            {words(claim[column])} words written · {limit} allowed
          </span>
        </label>
      ))}

      <div className="mt-5 flex flex-wrap items-end gap-4">
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Overhead method</span>
          <select name={F.method} defaultValue={claim.method} className={`mt-1 ${FIELD}`}
                  disabled={!!claim.filed_on}>
            <option value="proxy">Proxy — 55% of the salary base</option>
            <option value="traditional">Traditional — actual overhead, tracked</option>
          </select>

        </label>
      </div>

      <div className="mt-5 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
        <label className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
          <input type="checkbox" name={F.assistanceAnswered} value="yes" className="mt-1"
                 defaultChecked={!!claim.assistance_answered_on} />
          <span>
            <span className="font-medium">
              Government assistance, grants, IRAP, or anybody paying for this work.
            </span>

          </span>
        </label>
        <input name={F.assistanceNote} aria-label="Assistance details" defaultValue={claim.assistance_note ?? ''}
               className={`mt-2 w-full ${FIELD}`} />
      </div>

      {state.error && (
        <p role="alert" className={`mt-4 ${REFUSAL}`}>
          {state.error}
        </p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <button type="submit" disabled={pending} className={BUTTON}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => setEditing(false)} className={EDIT}>Cancel</button>
      </div>
    </form>
  )
}

function Record({ ledgerId, project, claim, evidence, standing, actions }: {
  ledgerId: string; project: SredProject; claim: SredClaim | null
  evidence: EvidenceRow[]
  standing: Array<{ answers: 'why' | 'how' | 'cost'; kinds: number; held: number; missing: string[] }>
  actions: Actions
}) {
  return (
    <div className="mt-6 space-y-6">
      <ProjectFields ledgerId={ledgerId} project={project} actions={actions} />
      {claim === null ? (
        <p className={CARD}>Start a claim for a year above, and the three questions appear here.</p>
      ) : (
        <ClaimAnswers key={claim.id} ledgerId={ledgerId} claim={claim} actions={actions} />
      )}

      <section className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-lg font-semibold">Evidence</h2>
          <Link href={`/ledger/${ledgerId}/sred/${project.id}/evidence/new`} className={BUTTON}>Add evidence</Link>
        </div>

        <div className="mt-3 flex flex-wrap gap-4 text-xs">
          {standing.map((s) => (
            <span key={s.answers} className={s.held === 0 ? 'text-red-700 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-300'}>
              <span className="font-medium uppercase tracking-wide">{s.answers}</span> {s.held}/{s.kinds}
              {s.missing.length > 0 && <span className="text-neutral-400"> · missing {s.missing.slice(0, 3).join(', ')}</span>}
            </span>
          ))}
        </div>

        <EvidenceTable ledgerId={ledgerId} projectId={project.id} evidence={evidence} actions={actions} />
      </section>
    </div>
  )
}

// --------------------------------------------------------------- the time --

function Time({ ledgerId, project, time, actions }: {
  ledgerId: string; project: SredProject; time: SredTimeRow[]
  actions: Actions
}) {
  return (
    <div className="mt-6 space-y-6">
      <section className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-lg font-semibold">Time on this project</h2>
          <Link href={`/ledger/${ledgerId}/sred/${project.id}/time/new`} className={BUTTON}>Record time</Link>
        </div>

        <TimeTable ledgerId={ledgerId} projectId={project.id} time={time} actions={actions} />
      </section>
    </div>
  )
}

// -------------------------------------------------------------- the money --

/**
 * How many cost rows one page of the allocation table shows.
 *
 * A year of a real ledger is hundreds of lines and this screen rendered every
 * one of them — the owner would have met a wall the first time they opened it
 * on their own books (2026-09-10). Same figure as the bank feed, for the same
 * reason: a page you can scan.
 */
const PER_PAGE = 50

/**
 * Exported for `scripts/render-sred-money.tsx`, which `S24` and `S25` run: the
 * ordering, the defaults a tagged account produces and the page size are claims
 * about a SCREEN, and a screen claim nobody renders is a claim.
 *
 * Every cost reads as a row of text — what is claimed of it, and why — with a
 * Claim or Change button; pressing it turns that one row into the three boxes
 * (2026-09-16). Fifty rows of three boxes each was the wall of blanks the owner
 * named. `initialOpen` is the row the harness starts open, by its key.
 */
export function Money({
  ledgerId, claim, salary, lines, allocated, actions,
  initialQuery = '', initialLens = 'all', initialOpen = null,
}: {
  ledgerId: string; claim: SredClaim | null
  salary: Allocatable[]; lines: Allocatable[]
  allocated: Map<string, { id: string; category: string; percent: string; basis: string }>
  actions: Actions
  /** Where the box and the lens START. The harness sets these; the screen does not. */
  initialQuery?: string
  initialLens?: CostLens
  initialOpen?: string | null
}) {
  // CLIENT state, not the URL: this is how you are leafing through a list right
  // now, it changes on every keystroke, and a round trip per letter would make
  // the box feel broken. The bank feed settled this the same way.
  const [query, setQuery] = useState(initialQuery)
  const [only, setOnly] = useState<CostLens>(initialLens)
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<string | null>(initialOpen)

  if (!claim) return <p className={`mt-6 ${CARD}`}>Start a claim for a year first.</p>

  // The predicate lives in sred-kinds.ts, where a check can call it. See the
  // note there: as a closure here it was unreachable and the harness said it
  // was being checked.
  const shown = lines.filter((a) => matchesCost(a, query, only))
  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE))
  const at = Math.min(page, pages - 1)
  const visible = shown.slice(at * PER_PAGE, at * PER_PAGE + PER_PAGE)

  const row = (a: Allocatable, categories: readonly string[]) => {
    const key = `${a.source_kind}:${a.source_id}`
    const at = allocated.get(key)
    const left = 100 - a.claimed_percent + (at ? Number(at.percent) : 0)
    const editing = open === key
    return (
      <tr key={key} className="border-b border-neutral-100 align-middle dark:border-neutral-900"
          data-allocatable={a.source_id}>
        <td className="py-1.5 pr-3 font-mono text-xs text-neutral-500">{a.on_date}</td>
        <td className="max-w-0 truncate py-1.5 pr-3" title={a.what}>
          {a.what}
          {a.is_specified && (
            <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-300">
              specified employee
            </span>
          )}
          {a.arms_length === false && (
            <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-300">
              not at arm&apos;s length
            </span>
          )}
          {a.suggested && !at && (
            <span data-suggested={a.suggested}
                  className="ml-2 rounded bg-clay-100 px-1 text-xs text-clay-900 dark:bg-clay-900 dark:text-clay-200">
              this account is SR&amp;ED · {a.suggested}
            </span>
          )}
        </td>
        <td className="py-1.5 pr-3 text-right font-mono text-xs tabular-nums">{money(a.amount)}</td>
        <td className="py-1.5 pr-3 text-xs text-neutral-500">
          {a.claimed_percent > 0 ? `${a.claimed_percent}% claimed` : ''}
        </td>
        <td className="py-1.5">
          {!editing ? (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-xs" title={at?.basis}>
                {at ? <>{at.category} · {at.percent}% · <span className="text-neutral-500">{at.basis}</span></> : ''}
              </span>
              <button type="button" onClick={() => setOpen(key)} className={at ? EDIT : QUIET}>
                {at ? 'Change' : 'Claim'}
              </button>
            </div>
          ) : (
            <>
              <ActionForm action={actions.allocate} submit={at ? 'Change' : 'Claim'} working="…"
                          onSucceeded={() => setOpen(null)}
                          className="flex flex-wrap items-end gap-2" buttonClassName={QUIET}>
                <input type="hidden" name={F.ledgerId} value={ledgerId} />
                <input type="hidden" name={F.claimId} value={claim.id} />
                <input type="hidden" name={F.sourceKind} value={a.source_kind} />
                <input type="hidden" name={F.sourceId} value={a.source_id} />
                {categories.length === 1 ? (
                  <input type="hidden" name={F.category} value={categories[0]} />
                ) : (
                  <select name={F.category}
                          defaultValue={at?.category ?? a.suggested ?? categories[0]}
                          aria-label="Category" className={`${FIELD} py-1 text-xs`}>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                )}
                <input name={F.percent}
                       defaultValue={at?.percent ?? (a.suggested ? '100' : '')} required
                       inputMode="decimal"
                       aria-label="Percent" className={`w-16 ${FIELD} py-1 text-xs`} />
                <input name={F.basis} defaultValue={at?.basis ?? ''} required
                       aria-label="Why this share"
                       className={`w-72 ${FIELD} py-1 text-xs`} />
                <span className="text-xs text-neutral-400">{left}% free</span>
              </ActionForm>
              <div className="mt-1 flex gap-3">
                <button type="button" onClick={() => setOpen(null)} className={EDIT}>Cancel</button>
                {at && (
                  <ActionForm action={actions.unallocate} submit="Drop the claim on this" working="…"
                              className="inline" buttonClassName="text-xs text-neutral-500 hover:underline">
                    <input type="hidden" name={F.ledgerId} value={ledgerId} />
                    <input type="hidden" name={F.allocationId} value={at.id} />
                  </ActionForm>
                )}
              </div>
            </>
          )}
        </td>
      </tr>
    )
  }

  return (
    <div className="mt-6 space-y-8">
      <section>
        <h2 className="font-serif text-lg font-semibold">Salary</h2>

        <DataTable density="reading" className="mt-3 w-full table-fixed text-sm">
          <colgroup><col className="w-24" /><col /><col className="w-28" /><col className="w-28" /><col className="w-[34rem]" /></colgroup>
          <tbody>{salary.map((a) => row(a, ['salary']))}</tbody>
        </DataTable>
        {salary.length === 0 && <p className="mt-2 text-sm text-neutral-500">No posted pay in this year.</p>}
      </section>

      <section>
        <h2 className="font-serif text-lg font-semibold">Everything else</h2>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }}
                 aria-label="Search the costs"
                 className={`w-64 ${FIELD} py-1 text-xs`} />
          <select value={only} aria-label="Which costs"
                  onChange={(e) => { setOnly(e.target.value as CostLens); setPage(0) }}
                  className={`${FIELD} py-1 text-xs`}>
            <option value="all">Everything</option>
            <option value="tagged">SR&amp;ED accounts only</option>
            <option value="unclaimed">Nothing claimed yet</option>
            {LINE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="text-xs text-neutral-500">
            {shown.length === lines.length
              ? `${formatNumber(lines.length)} cost${lines.length === 1 ? '' : 's'}`
              : `${formatNumber(shown.length)} of ${formatNumber(lines.length)}`}
            {pages > 1 && ` · page ${at + 1} of ${pages}`}
          </span>
          {pages > 1 && (
            <span className="flex gap-2">
              <button type="button" disabled={at === 0} onClick={() => setPage(at - 1)}
                      className={`${QUIET} disabled:opacity-40`}>Back</button>
              <button type="button" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}
                      className={`${QUIET} disabled:opacity-40`}>Next</button>
            </span>
          )}
        </div>

        <DataTable density="reading" className="mt-3 w-full table-fixed text-sm">
          <colgroup><col className="w-24" /><col /><col className="w-28" /><col className="w-28" /><col className="w-[34rem]" /></colgroup>
          <tbody>{visible.map((a) => row(a, LINE_CATEGORIES))}</tbody>
        </DataTable>
        {lines.length === 0 && <p className="mt-2 text-sm text-neutral-500">No posted costs in this year.</p>}
        {lines.length > 0 && shown.length === 0 && (
          <p className="mt-2 text-sm text-neutral-500">Nothing here matches that.</p>
        )}
      </section>
    </div>
  )
}

// ------------------------------------------------------- the working paper --

/** A button, and the one box it needs only once pressed — marking a year filed, or taking that back. */
function Reveal({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false)
  if (!open) return <button type="button" onClick={() => setOpen(true)} className={`mt-3 ${QUIET}`}>{label}</button>
  return <>{children(() => setOpen(false))}</>
}

/**
 * Marking the year filed, or taking that back — the box it needs appears only
 * once its button is pressed. Exported for `S38`, which renders it at rest.
 */
export function Filing({ ledgerId, claim, actions }: {
  ledgerId: string; claim: SredClaim; actions: Pick<Actions, 'fileClaim' | 'unfileClaim' | 'deleteClaim'>
}) {
  return (
    <div className={CARD}>
      <h3 className="font-serif text-base font-semibold">
        {claim.filed_on ? 'This year has been filed' : 'When the return has gone'}
      </h3>
      {claim.filed_on ? (
        <>
          <p className="mt-1 text-sm">
            Filed on <span className="font-mono">{claim.filed_on}</span>. The method, the three
            narratives, the assistance answer and every allocation are fixed — this is a record
            now, not a draft.
          </p>
          <Reveal label="Un-file this year…">
            {(close) => (
              <>
                <ActionForm action={actions.unfileClaim} submit="Un-file this year" working="…"
                            className="mt-3 flex flex-wrap items-end gap-3" buttonClassName={QUIET}>
                  <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <input type="hidden" name={F.claimId} value={claim.id} />
                  <label className="text-xs text-neutral-500">
                    <span className={LABEL}>Why</span>
                    <input name={F.reason} required className={`mt-1 w-[28rem] ${FIELD}`} />
                  </label>
                </ActionForm>
                <button type="button" onClick={close} className={`mt-2 ${EDIT}`}>Cancel</button>
              </>
            )}
          </Reveal>
          <p className="mt-1 text-xs text-neutral-500">
            Taking this back says a return this system recorded as gone did not go, or went on
            another day. The reason is kept in the audit trail.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs text-neutral-500">
            Filing locks this year&rsquo;s method, narratives, assistance and allocations.
          </p>
          <Reveal label="Mark this year filed…">
            {(close) => (
              <>
                <ActionForm action={actions.fileClaim} submit="Mark this year filed" working="…"
                            className="mt-3 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
                  <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <input type="hidden" name={F.claimId} value={claim.id} />
                  <label className="text-xs text-neutral-500">
                    <span className={LABEL}>Filed on</span>
                    <DateInput name={F.filedOn} required className={`mt-1 ${FIELD}`} />
                  </label>
                </ActionForm>
                <button type="button" onClick={close} className={`mt-2 ${EDIT}`}>Cancel</button>
              </>
            )}
          </Reveal>
          {/* A claim started for the wrong year, or by mistake (owner,
              2026-09-16: 「所有的紀錄儘量都可以編輯刪除」). Not offered once filed:
              that year is a record, and un-filing asks for the reason first. */}
          <Reveal label="Delete this year's claim…">
            {(close) => (
              <>
                <p className="mt-2 text-xs text-neutral-500">
                  The narratives, the method and every allocation for this year go. The project, its hours
                  and its evidence stay.
                </p>
                <ActionForm action={actions.deleteClaim} submit="Delete this year's claim" working="…"
                            className="mt-2 flex flex-wrap items-end gap-3" buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
                  <input type="hidden" name={F.ledgerId} value={ledgerId} />
                  <input type="hidden" name={F.claimId} value={claim.id} />
                </ActionForm>
                <button type="button" onClick={close} className={`mt-2 ${EDIT}`}>Cancel</button>
              </>
            )}
          </Reveal>
        </>
      )}
    </div>
  )
}

function Paper({ paper, ledgerId, claim, actions }: {
  paper: WorkingPaper | null; ledgerId: string; claim: SredClaim | null; actions: Actions
}) {
  if (!paper || !claim) return <p className={`mt-6 ${CARD}`}>Start a claim for a year first.</p>

  const side = (which: 'proxy' | 'traditional') => (
    <div className={`${CARD} flex-1`}>
      <h3 className="font-serif text-base font-semibold">
        {which === 'proxy' ? 'Proxy method' : 'Traditional method'}
        {paper.method === which && <span className="ml-2 text-xs font-normal text-clay-700 dark:text-clay-300">chosen</span>}
      </h3>
      <DataTable density="reading" className="mt-3 w-full text-sm">
        <tbody>
          {paper[which].lines.map((l) => (
            <tr key={l.label} className="border-b border-neutral-100 align-top dark:border-neutral-900">
              <td className="w-14 py-1.5 font-mono text-xs text-neutral-400">{l.t661}</td>
              <td className="py-1.5">
                {l.label}
                {l.note && <span className="mt-0.5 block text-xs text-neutral-500">{l.note}</span>}
                {l.from.length > 0 && (
                  <span className="mt-0.5 block text-xs text-neutral-400">
                    {formatNumber(l.from.length)} allocation{l.from.length === 1 ? '' : 's'}
                  </span>
                )}
              </td>
              <td className="w-32 py-1.5 text-right font-mono tabular-nums">{money(l.amount)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td />
            <td className="py-2">Qualified SR&amp;ED expenditures</td>
            <td className="py-2 text-right font-mono tabular-nums">{money(paper[which].qualified)}</td>
          </tr>
        </tbody>
      </DataTable>
    </div>
  )

  return (
    <div className="mt-6 space-y-6">
      <div className={CARD}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-serif text-lg font-semibold">{paper.entity} · {paper.year.name}</h2>
          <span className={`text-sm ${paper.daysLeft < 90 ? 'font-semibold text-red-700 dark:text-red-400' : 'text-neutral-500'}`}>
            File by {paper.deadline} · {paper.daysLeft < 0 ? 'passed' : `${paper.daysLeft} days`}
          </span>
        </div>

      </div>

      <div className="flex flex-wrap gap-4">{side('proxy')}{side('traditional')}</div>

      <div className={CARD}>
        <h3 className="font-serif text-base font-semibold">Not in the total</h3>
        {paper.excluded.map((l) => (
          <div key={l.label} className="mt-2 flex items-baseline justify-between gap-4">
            <span className="text-sm">
              {l.label}
              {l.note && <span className="mt-0.5 block text-xs text-neutral-500">{l.note}</span>}
            </span>
            <span className="font-mono text-sm tabular-nums">{money(l.amount)}</span>
          </div>
        ))}
      </div>

      <div className={CARD}>
        <h3 className="font-serif text-base font-semibold">What it is worth</h3>
        <DataTable density="reading" className="mt-3 w-full text-sm">
          <tbody>
            <tr className="border-b border-neutral-100 dark:border-neutral-900">
              <td className="py-2">Federal investment tax credit
                <span className="mt-0.5 block text-xs text-neutral-500">{paper.credits.federal.basis}</span>
              </td>
              <td className="w-32 py-2 text-right font-mono tabular-nums">{money(paper.credits.federal.amount)}</td>
            </tr>
            <tr>
              <td className="py-2">British Columbia
                <span className="mt-0.5 block text-xs text-neutral-500">{paper.credits.bc.basis}</span>
              </td>
              <td className="py-2 text-right font-mono tabular-nums">{money(paper.credits.bc.amount)}</td>
            </tr>
          </tbody>
        </DataTable>
      </div>

      <Filing ledgerId={ledgerId} claim={claim} actions={actions} />

      {paper.toConfirm.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <h3 className="font-medium text-amber-900 dark:text-amber-200">
            Settle these before this becomes a return
          </h3>
          <ul className="mt-2 space-y-1 text-xs text-amber-800 dark:text-amber-300">
            {paper.toConfirm.map((t, i) => <li key={i}>· {t}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

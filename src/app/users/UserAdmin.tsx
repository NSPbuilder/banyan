'use client'

import { formatNumber } from '@/lib/numbers'
import { useEffect, useRef, useState } from 'react'
import { FormError, useActionForm, type FormAction } from '@/components/ActionForm'
import { USER_FIELDS as F, type UserFormResult } from '@/lib/forms'
import { type UserKind, assignableBy, mayManage } from '@/lib/user-kinds'
import { BUTTON, DANGER_COMPACT, FIELD, FIELD_COMPACT, LABEL, QUIET_COMPACT, REFUSAL, SUCCESS } from '@/lib/ui'
import { Floating } from '@/components/Floating'
import { PageHeader } from '@/components/PageHeader'
import { DataTable, TableColumns, TableViewport } from '@/components/Table'

type User = {
  id: string; email: string
  first_name: string; last_name: string | null
  /** Derived by the reader from the two above — never a third stored copy. */
  display_name: string
  kind: UserKind
  is_owner: boolean; webdav_enabled: boolean; is_active: boolean; last_seen_at: string | null
}
type Company = { id: string; code: string; name: string; archived?: boolean; enabledModules?: string[] }
type Module = { path: string; label: string }
type Grants = Record<string, { entities: string[]; modules: string[]; grants?: string[] }>

/**
 * The six doors, handed in by the server page rather than imported here. A
 * client file that imported the actions would drag `server-only` in behind
 * them, and then no harness could render this screen — `US33` renders it as
 * an owner and as a superadmin and reads the buttons back, the way the
 * reconcile panel is rendered with its action paths handed in.
 */
export type PeopleActions = {
  create: FormAction; status: FormAction; password: FormAction
  grants: FormAction; kind: FormAction; remove: FormAction
  /** A name and email put right (0084). */
  identity: FormAction
}

const input =
  `mt-1 w-full ${FIELD}`
const label = LABEL
const btn = `${QUIET_COMPACT} whitespace-nowrap`

/**
 * All / none, for one group of checkboxes.
 *
 * Buttons and not a tri-state master checkbox: a master box has to say what it
 * means when some are ticked, and every answer to that is a small lie. Two
 * verbs say exactly what they do.
 */
function AllNone({ name, setAll }: { name: string; setAll: (name: string, on: boolean) => void }) {
  return (
    <span className="flex gap-2 text-xs">
      <button type="button" onClick={() => setAll(name, true)}
              className="text-neutral-500 underline-offset-2 hover:underline">All</button>
      <span aria-hidden className="text-neutral-300 dark:text-neutral-700">·</span>
      <button type="button" onClick={() => setAll(name, false)}
              className="text-neutral-500 underline-offset-2 hover:underline">None</button>
    </span>
  )
}
const danger = `${DANGER_COMPACT} whitespace-nowrap`
const select = `w-full min-w-0 ${FIELD_COMPACT}`

/**
 * Report whichever of several forms' results changed LAST. One banner for
 * the whole screen, and the newest result owns it — the first version kept
 * any refusal on screen until that same form ran again, so one refused
 * Delete outlived every later successful save (critic, 2026-09-04).
 */
function useReport(states: UserFormResult[], report: (r: UserFormResult) => void) {
  const seen = useRef(states)
  useEffect(() => {
    const i = states.findIndex((s, k) => s !== seen.current[k])
    seen.current = states
    if (i >= 0) report(states[i])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, states)
}

export function UserAdmin({
  me, people, sessions, companies, modules, grants, actions, signOut,
}: {
  me: User; people: User[]; sessions: number
  companies: Company[]
  /** The nav seats, derived from LEDGER_NAV — never a second list of names. */
  modules: Module[]
  grants: Grants
  actions: PeopleActions
  /**
   * The sign-out form, rendered by the SERVER component and handed in.
   *
   * It binds a server action to a form's action prop, which `V96` forbids in a
   * client component — because a refused save there wipes what somebody typed.
   * This form holds no fields, and the same exception is already on the record
   * for `RebuildButton`. Passing it in keeps the exception where it is
   * justified instead of widening the rule.
   */
  signOut: React.ReactNode
}) {
  const add = useActionForm(actions.create)
  const [banner, setBanner] = useState<UserFormResult>({})
  useReport([add.state], setBanner)
  // One person's access open at a time. The grants used to be a wall of
  // forms under the table — every person's, always open (owner, 2026-09-04:
  // "隐藏到每个人的那行，需要编辑的时候再弹出来").
  const [editing, setEditing] = useState<string | null>(null)
  // The kinds THIS person may hand out — the same ladder the server refuses
  // with, so the screen never offers a rung the save would refuse.
  const kinds = assignableBy(me)

  return (
    <>
      <PageHeader title="People" backTo="/companies" backLabel="Back to Companies">
        <Floating label="Add somebody" title="Add somebody" buttonClassName={BUTTON}>
          {add.state.error && <p role="alert" className={`mt-4 ${REFUSAL}`}>{add.state.error}</p>}
          {add.state.ok && (
            <p role="status" className={`mt-4 ${SUCCESS}`}>
              {add.state.ok}
            </p>
          )}
          <form {...add.formProps} className="mt-4 max-w-3xl space-y-4">
            <div className="flex flex-wrap gap-4">
              <div className="w-44">
                <label htmlFor="nu-first" className={label}>First name</label>
                <input id="nu-first" name={F.firstName} type="text" required className={input} />
              </div>
              <div className="w-44">
                <label htmlFor="nu-last" className={label}>Last name</label>
                <input id="nu-last" name={F.lastName} type="text" className={input} />
              </div>
              <div className="w-64">
                <label htmlFor="nu-email" className={label}>Email</label>
                <input id="nu-email" name={F.email} type="email" required className={input} />
              </div>
            </div>
            <div className="flex flex-wrap gap-4">
              <div className="w-64">
                <label htmlFor="nu-pw" className={label}>First password</label>
                <input id="nu-pw" name={F.password} type="password" required minLength={12}
                       className={input} />

              </div>
              <div className="w-44">
                <label htmlFor="nu-kind" className={label}>Type</label>
                {kinds.length > 1 ? (
                  <select id="nu-kind" name={F.kind} defaultValue="user" className={input}>
                    {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                ) : (
                  <>
                    <input type="hidden" name={F.kind} value="user" />
                    <p id="nu-kind" className="mt-1 px-3 py-2 text-sm">user</p>
                  </>
                )}
                <p className="mt-1 text-xs text-neutral-500">
                  {me.kind === 'superadmin'
                    ? 'An owner manages users and takes backups. There is one superadmin: you.'
                    : 'An owner adds users; only the superadmin can add an owner.'}
                </p>
              </div>
            </div>
            <button type="submit" disabled={add.pending}
                    className={BUTTON}>
              {add.pending ? 'Adding…' : 'Add'}
            </button>
          </form>
        </Floating>
      </PageHeader>
      {banner.error && (
        <p role="alert" className={`mt-4 ${REFUSAL}`}>
          {banner.error}
        </p>
      )}
      {banner.ok && (
        <p role="status" className={`mt-4 ${SUCCESS}`}>
          {banner.ok}
        </p>
      )}

      <TableViewport label="People" className="mt-4">
      <DataTable className="ui-table-spaced table-fixed min-w-[64rem]">
        <TableColumns columns={[{width:"18%"},{width:"23%"},{width:"10%"},{width:"12%"},{width:"37%"}]} />
        <thead>
          <tr className="text-left">
            <th scope="col" className="py-2 font-medium">Name</th>
            <th scope="col" className="py-2 font-medium">Email</th>
            <th scope="col" className="py-2 font-medium">Type</th>
            <th scope="col" className="py-2 font-medium">Last signed in</th>
            <th scope="col" className="py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <PersonRow key={p.id} me={me} p={p} companies={companies} modules={modules}
                       grants={grants[p.id]} actions={actions} kinds={kinds}
                       open={editing === p.id}
                       onToggle={(open) => setEditing(open ? p.id : null)}
                       report={setBanner} />
          ))}
        </tbody>
      </DataTable>
      </TableViewport>

      <h2 className="mt-6 text-section-title font-semibold">This is you</h2>
      <p className="mt-1 text-sm text-neutral-500">
        {me.display_name} · {me.email} · {formatNumber(sessions)} {sessions === 1 ? 'session' : 'sessions'} open
      </p>
      {signOut}
    </>
  )
}

/**
 * One person, one row, ITS OWN forms. `useActionForm` keeps one form ref per
 * hook, so a single hook spread over every row reset whichever row mounted
 * last — the password typed in row one stayed in its box after "Set password"
 * worked (critic, 2026-09-04). What appears is what the ladder allows: a
 * button the save would refuse is not drawn.
 */
function PersonRow({
  me, p, companies, modules, grants, actions, kinds, open, onToggle, report,
}: {
  me: User; p: User; companies: Company[]; modules: Module[]
  grants: Grants[string] | undefined; actions: PeopleActions; kinds: UserKind[]
  open: boolean; onToggle: (open: boolean) => void
  report: (r: UserFormResult) => void
}) {
  const status = useActionForm(actions.status)
  const copy = useActionForm(actions.create)
  const password = useActionForm(actions.password)
  const kind = useActionForm(actions.kind)
  const remove = useActionForm(actions.remove)
  const identity = useActionForm(actions.identity)
  const access = useActionForm(actions.grants, { onSucceeded: () => onToggle(false) })
  /**
   * TICK THEM ALL, OR NONE (owner, 2026-09-16: 「没有一个全选的选项，一个个
   * 点击很累」).
   *
   * Written through the DOM rather than by lifting every box into state: what
   * is ticked IS the grant — the form posts the boxes and the door replaces
   * the set wholesale — so the checkboxes are already the source of truth, and
   * mirroring them into React state would be a second copy to keep in step.
   *
   * Scoped to THIS form by the ref. Every row on this screen renders its own
   * access form with the same field names, so a document-wide query would tick
   * somebody else's companies too.
   */
  const accessForm = useRef<HTMLFormElement>(null)
  const setAll = (name: string, on: boolean) => {
    const boxes = accessForm.current?.querySelectorAll<HTMLInputElement>(
      `input[type="checkbox"][name="${name}"]`)
    boxes?.forEach((box) => { box.checked = on })
  }
  useReport([status.state, password.state, kind.state, remove.state, access.state, identity.state, copy.state], report)
  const manageable = mayManage(me, p)
  const isMe = p.id === me.id

  return (
    <>
      <tr data-person-id={p.id} data-row className={p.is_active ? '' : 'text-ink-muted'}>
        <td data-column="name">
          <div className="flex min-h-control min-w-0 flex-wrap items-center gap-x-2">
            <span className="min-w-0 break-words">{p.display_name}</span>
            {isMe && <span className="text-caption text-ink-muted">you</span>}
            {!p.is_active && <span className="text-caption text-ink-muted">signed off</span>}
          </div>
        </td>
        <td data-column="email" className="text-ink-muted">
          <span className="flex min-h-control items-center break-all">{p.email}</span>
        </td>
        <td data-column="type">
          {/* A superadmin re-kinds anybody but themselves, and the select
              saves on change — a Type is one choice, not a form. Everybody
              else reads it. */}
          {me.kind === 'superadmin' && !isMe ? (
            <form {...kind.formProps}>
              <input type="hidden" name={F.userId} value={p.id} />
              <select key={p.kind} name={F.kind} defaultValue={p.kind}
                      disabled={kind.pending} aria-label={`Type of ${p.display_name}`}
                      onChange={(e) => {
                        const box = e.currentTarget
                        // The submit reads the form NOW, new value included…
                        box.form?.requestSubmit()
                        // …and the box goes back to what is saved, so a
                        // refused change does not leave a kind on screen that
                        // nobody has (critic). A saved one comes back through
                        // the page, and `key` remounts the box with it.
                        box.value = p.kind
                      }}
                      className={select}>
                {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </form>
          ) : <span className="inline-flex min-h-control items-center">{p.kind}</span>}
        </td>
        <td data-column="last-signed-in" data-date className="text-ink-muted">
          <span className="inline-flex min-h-control items-center">{p.last_seen_at?.slice(0, 10) ?? 'never'}</span>
        </td>
        <td data-column="actions">
          <div className="flex flex-wrap items-center gap-1">
            {manageable && kinds.includes(p.kind) && (
              <Floating label="Copy" title={`Copy ${p.display_name}`} buttonClassName={btn}>

                <form {...copy.formProps} className="mt-4 flex flex-wrap items-end gap-3">
                  <label className={label}>First name
                    <input name={F.firstName} required defaultValue={p.first_name} className={input} />
                  </label>
                  <label className={label}>Last name
                    <input name={F.lastName} defaultValue={p.last_name ?? ''} className={input} />
                  </label>
                  <label className={label}>Email
                    <input name={F.email} type="email" required className={input} />
                  </label>
                  <label className={label}>First password
                    <input name={F.password} type="password" required minLength={12} className={input} />
                  </label>
                  <label className={label}>Type
                    <select name={F.kind} defaultValue={p.kind} className={input}>
                      {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </label>
                  <button type="submit" disabled={copy.pending} className={BUTTON}>
                    {copy.pending ? 'Adding…' : 'Add person'}
                  </button>
                </form>
              </Floating>
            )}
            {manageable && (
              <form {...status.formProps}>
                <input type="hidden" name={F.userId} value={p.id} />
                <input type="hidden" name="setActive" value={String(!p.is_active)} />
                <button type="submit" disabled={status.pending} className={btn}>
                  {p.is_active ? 'Sign off' : 'Let back in'}
                </button>
              </form>
            )}
            {(manageable || isMe) && (
              <Floating label="Password" title={`Set password — ${p.display_name}`} buttonClassName={btn}>
                <form {...password.formProps} className="mt-4 max-w-sm space-y-3">
                  <FormError state={password.state} />
                  {password.state.ok && <p role="status" className={SUCCESS}>{password.state.ok}</p>}
                  <input type="hidden" name={F.userId} value={p.id} />
                  <div>
                    <label htmlFor={`pw-${p.id}`} className={label}>New password</label>
                    <input id={`pw-${p.id}`} name={F.password} type="password" autoComplete="new-password"
                           minLength={12} required className={input} />
                  </div>
                  <p className="text-metadata text-ink-muted">Signs out all sessions and revokes WebDAV passwords.</p>
                  <button type="submit" disabled={password.pending} className={BUTTON}>
                    {password.pending ? 'Saving…' : 'Set password'}
                  </button>
                </form>
              </Floating>
            )}
            {(manageable || isMe) && (
              // A name typed wrong, an email that changed (owner, 2026-09-16:
              // 「所有的紀錄儘量都可以編輯刪除」). Floats, like adding somebody.
              <Floating label="Edit" title={`Name and email — ${p.display_name}`} buttonClassName={btn}>
                <form {...identity.formProps} className="mt-4 flex flex-wrap items-end gap-4">
                  <input type="hidden" name={F.userId} value={p.id} />
                  <div className="w-44">
                    <label htmlFor={`id-first-${p.id}`} className={label}>First name</label>
                    <input id={`id-first-${p.id}`} name={F.firstName} required defaultValue={p.first_name} className={input} />
                  </div>
                  <div className="w-44">
                    <label htmlFor={`id-last-${p.id}`} className={label}>Last name</label>
                    <input id={`id-last-${p.id}`} name={F.lastName} defaultValue={p.last_name ?? ''} className={input} />
                  </div>
                  <div className="w-64">
                    <label htmlFor={`id-email-${p.id}`} className={label}>Email</label>
                    <input id={`id-email-${p.id}`} name={F.email} type="email" required defaultValue={p.email} className={input} />
                  </div>
                  <button type="submit" disabled={identity.pending} className={BUTTON}>
                    {identity.pending ? 'Saving…' : 'Save'}
                  </button>
                </form>
              </Floating>
            )}
            {(manageable || (isMe && me.is_owner)) && (
              <button type="button" aria-expanded={open} onClick={() => onToggle(!open)}
                      className={btn}>
                {open ? 'Close access' : 'Access'}
              </button>
            )}
            {manageable && (
              <Floating label="Delete" title={`Delete ${p.display_name}`} buttonClassName={danger}>
                <form {...remove.formProps} className="mt-4 space-y-3">
                  <FormError state={remove.state} />
                  {remove.state.ok && <p role="status" className={SUCCESS}>{remove.state.ok}</p>}
                  <input type="hidden" name={F.userId} value={p.id} />
                  <p className="text-body">Delete {p.display_name}?</p>
                  <button type="submit" disabled={remove.pending} className={danger}>
                    {remove.pending ? 'Deleting…' : 'Yes, delete'}
                  </button>
                </form>
              </Floating>
            )}
          </div>
        </td>
      </tr>

      {open && (
        <tr className="border-b border-neutral-200 dark:border-neutral-800">
          <td colSpan={5} className="py-3">
            <form {...access.formProps} ref={accessForm}
                  className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
              <input type="hidden" name={F.userId} value={p.id} />
              <input type="hidden" name={F.grantMode} value={p.kind === 'user' ? 'matrix' : 'webdav'} />
              <p className="text-sm font-medium">What {p.display_name} may open</p>

              <label className="mt-3 flex items-start gap-2 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <input type="checkbox" name={F.webdavEnabled} value="true"
                       defaultChecked={p.webdav_enabled} className="mt-0.5" />
                <span>
                  <span className="font-medium">WebDAV folder access</span>

                </span>
              </label>

              {p.kind === 'user' && (
                <>
                  <p className="mt-3 text-metadata text-ink-muted">Company switches also apply. A saved user grant takes effect when its company module is enabled.</p>
                  <div className="mt-3 flex items-baseline gap-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                      Company and module
                    </p>
                    <AllNone name={F.grant} setAll={setAll} />
                  </div>
                  <div className="mt-2 max-h-[28rem] space-y-3 overflow-auto pr-1">
                    {companies.map((c) => (
                      <section key={c.id} className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
                        <p className={`text-sm font-medium${c.archived ? ' text-neutral-400' : ''}`}>
                          {c.code} — {c.name}{c.archived && <span className="text-xs"> (archived)</span>}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                          {modules.map((m) => {
                            const value = `${c.id}|${m.path}`
                            return (
                              <label key={value} className="flex items-center gap-2 text-sm">
                                <input type="checkbox" name={F.grant} value={value}
                                       defaultChecked={grants?.grants?.includes(value)
                                         ?? (!!grants?.entities.includes(c.id) && !!grants?.modules.includes(m.path))} />
                                {m.label}{c.enabledModules && !c.enabledModules.includes(m.path) && <span className="text-caption text-ink-muted">(company disabled)</span>}
                              </label>
                            )
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                </>
              )}

              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className={`min-w-0 max-w-sm flex-1 ${LABEL}`}>
                  <span className="block">Reason for this access change</span>
                  <input name={F.reason} required maxLength={500}
                         className={input} />
                </label>
                <button type="submit" disabled={access.pending} className={btn}>
                  {access.pending ? 'Saving…' : p.kind === 'user' ? 'Save what they may see' : 'Save WebDAV access'}
                </button>
                <button type="button" onClick={() => onToggle(false)} className={btn}>
                  Close
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  )
}

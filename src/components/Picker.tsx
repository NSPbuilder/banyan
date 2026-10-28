'use client'

import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import type { FormAction } from '@/components/ActionForm'
import { matches } from '@/lib/picker-matching'
export { matches } from '@/lib/picker-matching'
import { BUTTON, FIELD, GHOST, LABEL, REFUSAL_QUIET } from '@/lib/ui'

const PartyCreateDialog = lazy(() => import('./PartyCreateDialog'))

/**
 * PICKING ONE THING OUT OF A LIST, by typing.
 *
 * Every place that chose a party or an account was a plain `<select>` — the
 * whole chart, the whole address book, in the order they happen to be in,
 * and no way to type. The owner asked for two things in one breath
 * (2026-09-07): narrow the list as you type, and let the thing you were
 * looking for be CREATED from inside the list when it turns out not to
 * exist. This is both, once, so no call site can drift from another.
 *
 * WHAT IT POSTS IS WHAT THE SELECT POSTED: a hidden input under the same
 * `name`, carrying the same id. NOTHING THAT READS THE PICKED ID CHANGED —
 * that is the narrow claim, and it is the one that matters: a widget that
 * changed what arrives would have made this a change to twenty doors rather
 * than to twenty screens. (The two CREATING doors did change, in ways that
 * have nothing to do with this: they now derive the company from the ledger
 * and they answer with what they made.)
 *
 * NATIVE VALIDITY IS KEPT. The forms here call `reportValidity()` before
 * they dispatch (the entry form's three buttons do), so a required picker
 * must be able to fail that the way a required select does. The visible
 * input carries the requirement and `setCustomValidity` speaks for it, which
 * also means the browser scrolls to it and says so in the person's language.
 *
 * The creating half arrives as a prop, like every action in this project, so
 * a check can render this without a server runtime.
 */

export type PickerOption = {
  id: string
  label: string
  /** Shown after the label in smaller type: a role, an account type. */
  hint?: string
  /** Options with the same group are shown under one heading. */
  group?: string
}

export type PickerCreate = {
  /** Parties use the full floating form; other creators keep their existing row. */
  presentation?: 'party'
  /** The heading over the creating row: "New expense account". */
  title: string
  /** The door. A prop, so this file needs nothing that imports server-only. */
  action: FormAction
  /**
   * Hidden fields the door needs and the person should not have to type:
   * the ledger, the role a party is being picked for, the type an account
   * must be. The visible fields are `fields`.
   */
  hidden: Record<string, string>
  /**
   * What the person fills in. The one marked `takesTyped` starts with
   * whatever they had typed into the picker — they were, after all, already
   * writing the name.
   */
  fields: Array<{
    name: string
    label: string
    width?: string
    takesTyped?: boolean
    /**
     * Given, the field is a small list rather than a box. For the answers the
     * screen cannot supply and a person should not have to spell — what type
     * an account is when the line could be any of them, which role a party is
     * being made in when the row does not say. The first option is what it
     * opens on.
     */
    options?: Array<{ value: string; label: string }>
  }>
}

export function Picker({
  name, options, defaultValue, value, required, placeholder, disabled, create, className, ariaLabel,
  onChange, onCreated, form,
}: {
  /**
   * What the hidden input is called — the same name the `<select>` had, so no
   * reader on the server changes. LEFT OUT when the form does not serialise
   * this field itself: the journal entry posts all its lines as one JSON
   * string, and a stray `accountId` beside it would be a field nothing reads
   * and everything could start reading by accident.
   */
  name?: string
  options: PickerOption[]
  defaultValue?: string
  /**
   * Controlled: the parent owns the choice. Given, this follows it — so a
   * form that clears its rows after posting clears the words in the box too,
   * rather than showing a name for a line that no longer exists.
   */
  value?: string
  required?: boolean
  placeholder?: string
  disabled?: boolean
  create?: PickerCreate
  className?: string
  ariaLabel?: string
  /**
   * For a parent that keeps the row's own state — the invoice line editor
   * counts filled rows and adds them up from what it holds, so a choice made
   * only inside this widget would leave the total on the screen stale while
   * the hidden input posted the right thing. Told the id, never the label.
   */
  onChange?: (id: string) => void
  /** The label is available before the refreshed choices arrive. */
  onCreated?: (made: { id: string; label: string }) => void
  /**
   * The form this belongs to, when it does not sit inside it.
   *
   * A table cannot hold a form that spans its cells, so the bank screen puts
   * one form in the row's last cell and points every control at it by id —
   * which is the HTML answer, and the same one the batch checkbox has used
   * since it was written. Without this the hidden input would not be
   * submitted and `required` would be validated by nobody.
   */
  form?: string
}) {
  const uid = useId()
  // Built with `+` rather than a template, and named rather than repeated:
  // the mutation battery anchors its blocks on whole source lines, and a
  // line carrying a template literal cannot be one (mutations.sh).
  const inputId = uid + '-input'
  const listId = uid + '-list'
  const chosenAt = (id: string) => options.find((o) => o.id === id)
  const [uncontrolledId, setUncontrolledId] = useState(defaultValue ?? '')
  const candidateId = value ?? uncontrolledId
  const chosen = chosenAt(candidateId)
  const [draft, setDraft] = useState<{
    forId: string
    text: string
    query: string
  } | null>(null)
  // Props own a controlled choice. Local state owns only an uncontrolled
  // choice and the words actively being typed; labels are derived from the
  // current options, so changed or removed options cannot leave stale text.
  const optimistic = draft?.forId === candidateId && draft.query === '' && !!draft.text
  const id = chosen || optimistic ? candidateId : ''
  const currentDraft = draft?.forId === id ? draft : null
  const typed = currentDraft
    ? (currentDraft.query === '' && chosen ? chosen.label : currentDraft.text)
    : (chosen?.label ?? '')
  const query = currentDraft?.query ?? ''
  const selectId = (next: string) => {
    if (value === undefined) setUncontrolledId(next)
    onChange?.(next)
  }
  /**
   * WHAT WAS TYPED, which is not what is in the box.
   *
   * Choosing puts the option's label in the box. Filtering on the box would
   * then mean that opening a picker which already holds an account shows that
   * account and nothing else — the person has to clear the words before they
   * can see the list they came to look at. It also meant a chosen picker
   * rendered ONE option into the markup, so the "every choice is in the page"
   * guarantee quietly held only for empty ones (critic, 2026-09-07).
   *
   * So: empty until somebody types, and empty again the moment they choose.
   */
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const creationDialog = useRef<HTMLDialogElement>(null)
  const creationActive = useRef(false)
  const restoringFocus = useRef(false)

  // The DOM stays beside its control (so form ownership and modal focus stay
  // intact), while the native popover top layer escapes table scroll clips.
  useLayoutEffect(() => {
    const panel = menu.current
    const anchor = input.current
    if (!panel || !anchor) return
    if (!open || disabled) { if (panel.matches(':popover-open')) panel.hidePopover(); return }
    if (panel.showPopover && !panel.matches(':popover-open')) panel.showPopover()
    const viewport = window.visualViewport
    const position = () => {
      const rect = anchor.getBoundingClientRect()
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      const menuWidth = Math.min(Math.max(rect.width, creating ? 384 : 240), width - 24)
      const below = height - rect.bottom - 12
      const above = rect.top - 12
      const goesUp = below < 180 && above > below
      const available = Math.max(80, Math.min(320, goesUp ? above : below))
      panel.style.width = `${menuWidth}px`
      panel.style.maxHeight = `${available}px`
      panel.style.left = `${Math.max(12, Math.min(rect.left, width - menuWidth - 12))}px`
      // Anchor either edge without reading layout again after the writes.
      panel.style.top = goesUp ? 'auto' : `${rect.bottom + 4}px`
      panel.style.bottom = goesUp ? `${height - rect.top + 4}px` : 'auto'
    }
    position()
    let frame = 0
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; position() }) }
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    viewport?.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      viewport?.removeEventListener('resize', schedule)
      if (panel.matches(':popover-open')) panel.hidePopover()
    }
  }, [open, disabled, creating])

  useEffect(() => {
    const formElement = input.current?.form
    const reset = () => { if (value === undefined) setUncontrolledId(defaultValue ?? ''); setDraft(null); setOpen(false); setCreating(false); creationActive.current = false }
    formElement?.addEventListener('reset', reset)
    return () => formElement?.removeEventListener('reset', reset)
  }, [defaultValue, value, form])

  // Native validity, so `reportValidity()` behaves as it did with a select.
  useEffect(() => {
    input.current?.setCustomValidity(required && !id ? 'Choose one from the list.' : '')
  }, [required, id])

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (creationActive.current) return
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false); setCreating(false)
        // Typing that chose nothing is not a choice: put back the label of
        // what IS chosen, so the box never shows a name it did not pick.
        setDraft(null)
      }
    }
    const focusAway = (e: FocusEvent) => {
      if (creationActive.current) return
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false); setCreating(false); setDraft(null)
      }
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('focusin', focusAway)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('focusin', focusAway) }
  }, [])

  const shown = useMemo(() => options.filter((o) => matches(o, query)), [options, query])
  const groups = useMemo(() => {
    const out = new Map<string, PickerOption[]>()
    for (const o of shown) {
      const g = o.group ?? ''
      out.set(g, [...(out.get(g) ?? []), o])
    }
    return [...out.entries()]
  }, [shown])

  const choose = (o: PickerOption) => {
    selectId(o.id); setDraft(null); setOpen(false); setCreating(false)
  }

  const finishCreation = (made: { id: string; label: string } | null) => {
    if (made) {
      selectId(made.id)
      setDraft({ forId: made.id, text: made.label, query: '' })
      onCreated?.(made)
    }
    setCreating(false); setOpen(false)
    if (create?.presentation === 'party') {
      creationDialog.current?.close()
      requestAnimationFrame(() => {
        restoringFocus.current = true
        input.current?.focus({ preventScroll: true })
        restoringFocus.current = false
        creationActive.current = false
      })
    }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => {
        const next = e.key === 'ArrowDown' ? a + 1 : a - 1
        return Math.max(0, Math.min(shown.length - 1, next))
      })
    } else if (e.key === 'Enter' && open) {
      // Enter inside an open list chooses; it must not submit the form
      // underneath, which is what a bare Enter in a text box would do.
      e.preventDefault()
      if (shown[active]) choose(shown[active])
    } else if (e.key === 'Escape' && open) {
      e.preventDefault(); e.stopPropagation()
      setOpen(false); setCreating(false); setDraft(null)
    }
  }

  return (
    <div ref={box} className={`relative ${className ?? ''}`} data-picker={name ?? ariaLabel}>
      {name && <input type="hidden" name={name} value={id} form={form} />}
      <input
        ref={input}
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && shown[active] ? `${listId}-opt-${active}` : undefined}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        form={form}
        disabled={disabled}
        required={required}
        value={typed}
        placeholder={placeholder}
        onChange={(e) => {
          const text = e.target.value
          setDraft({ forId: '', text, query: text }); setOpen(true); setActive(0)
          // Typing after a choice un-chooses: the box must never post an id
          // that does not match the words in it.
          if (candidateId) selectId('')
        }}
        onFocus={() => { if (!restoringFocus.current) setOpen(true) }}
        onClick={() => setOpen(true)}
        onKeyDown={onKey}
        className={`w-full ${FIELD}`}
      />
      {/*
        * RENDERED WHETHER OR NOT IT IS OPEN, and hidden by the attribute.
        *
        * A `<select>` puts every choice in the markup, and a great deal of
        * this project's evidence reads exactly that: "the form offers this
        * account" is checked by finding the account among the options the
        * screen rendered. A list built only after a click is a list no
        * static render can see, so replacing selects with this would have
        * quietly blinded those checks rather than failing them (2026-09-07).
        * It also means the choices are in the page for anything that reads a
        * page without running it.
        */}
      <div ref={menu} id={listId} role="listbox" popover="manual" hidden={!open || disabled}
           className="picker-menu fixed z-50 overflow-auto rounded-panel border border-line-subtle bg-surface-elevated">
          {shown.length === 0 && !create && (
            <p className="px-3 py-2 text-body text-ink-muted">No matches.</p>
          )}
          {groups.map(([group, list]) => (
            <div key={group}>
              {group && (
                <p className="px-3 py-1 text-metadata font-medium text-ink-muted">{group}</p>
              )}
              {list.map((o) => {
                const i = shown.indexOf(o)
                return (
                  <button key={o.id} type="button" role="option" aria-selected={o.id === id}
                          id={`${listId}-opt-${i}`}
                          data-option={o.id}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseEnter={() => setActive(i)}
                          onClick={() => choose(o)}
                          className={`picker-option block min-h-control w-full rounded-control px-3 py-1 text-left text-body ${
                            i === active ? 'bg-surface-hover' : ''}`}>
                    {o.label}
                    {o.hint && <span className="ml-2 text-metadata text-ink-muted">{o.hint}</span>}
                  </button>
                )
              })}
            </div>
          ))}
          {create && !creating && (
            <button type="button" data-create
                    aria-haspopup={create.presentation === 'party' ? 'dialog' : undefined}
                    onClick={() => {
                      if (create.presentation === 'party') { creationActive.current = true; setOpen(false) }
                      setCreating(true)
                    }}
                    className="flex min-h-control w-full items-center gap-2 border-t border-line-subtle px-3 py-1 text-left text-body font-medium text-ink hover:bg-surface-hover">
              <Icon name="plus" /> {create.title}{query.trim() && <> called “{query.trim()}”</>}
            </button>
          )}
          {create && creating && create.presentation !== 'party' && (
            <CreateRow create={create} typed={query} onDone={finishCreation} />
          )}
      </div>
      {create?.presentation === 'party' && creating && (
        <Suspense fallback={<p role="status" className="mt-2 text-metadata text-ink-muted">Opening party form…</p>}>
          <PartyCreateDialog create={create} typed={query} dialogRef={creationDialog} onDone={finishCreation}/>
        </Suspense>
      )}
    </div>
  )
}

/**
 * The creating row. Its own `<form>` is impossible — this widget lives INSIDE
 * a form, and a form cannot nest — so it posts through the action itself and
 * reports back with what was made.
 */
function CreateRow({ create, typed, onDone }: {
  create: PickerCreate
  typed: string
  onDone: (made: { id: string; label: string } | null) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(create.fields.map((f) =>
      [f.name, f.takesTyped ? typed.trim() : (f.options?.[0]?.value ?? '')])))
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const submit = async () => {
    if (typeof create.action === 'string') return
    setWorking(true); setError(null)
    const data = new FormData()
    for (const [k, v] of Object.entries(create.hidden)) data.set(k, v)
    for (const [k, v] of Object.entries(values)) data.set(k, v)
    const result = await create.action({}, data)
    setWorking(false)
    if (result.error) { setError(result.error); return }
    onDone(result.madeId ? { id: result.madeId, label: result.madeLabel ?? '' } : null)
  }

  return (
    <div className="border-t border-line-subtle p-3">
      <p className="text-label font-medium text-ink-secondary">{create.title}</p>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        {create.fields.map((f) => (
          <label key={f.name} className={LABEL}>
            <span className="block">{f.label}</span>
            {f.options ? (
              <select value={values[f.name] ?? ''} style={{ width: f.width ?? '11rem', maxWidth: '100%' }}
                      onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                      className={`mt-1 ${FIELD}`}>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input value={values[f.name] ?? ''} style={{ width: f.width ?? '11rem', maxWidth: '100%' }}
                     onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                     onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }}
                     className={`mt-1 ${FIELD}`} />
            )}
          </label>
        ))}
        <button type="button" disabled={working} onClick={() => void submit()}
                className={BUTTON}>
          {working ? 'Creating…' : 'Create'}
        </button>
        <button type="button" onClick={() => onDone(null)}
                className={GHOST}>Cancel</button>
      </div>
      {error && (
        <p role="alert" className={`mt-2 ${REFUSAL_QUIET}`}>
          {error}
        </p>
      )}
    </div>
  )
}

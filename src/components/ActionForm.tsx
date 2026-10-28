'use client'

import { startTransition, useActionState, useEffect, useRef, useState } from 'react'
import { unstable_rethrow } from 'next/navigation'
import type { FormState } from '@/app/actions'
import { REFUSAL, SUCCESS } from '@/lib/ui'

/**
 * The `<form>` element and the action bound to it. Nothing else.
 *
 * Nothing about it is specific to any one feature; it started life beside the
 * sales tax screen and moved here when the bank import needed the same thing.
 * A second copy would have been a second place for the "render this outside a
 * server runtime" trick below to be got wrong.
 *
 * The inputs arrive as `children`, rendered by the server component that has
 * the data. That is the point: for five rounds every fix extracted a smaller
 * renderable piece, and whatever handed that piece its arguments became the
 * next unwatched seam — the row's index, then the row list's array, then the
 * array handed to the whole form. Each time the fix moved the boundary instead
 * of closing it.
 *
 * This component cannot corrupt a field because it is never given one. It
 * receives an already-built tree and puts it inside a form. And the fields
 * cannot end up outside the form for the same reason — `children` are inside
 * it by construction, not by a line of JSX that could be moved.
 *
 * The action arrives as a prop rather than by import. That is what lets the
 * page's whole markup be rendered by a check: importing `@/app/actions` pulls
 * in `server-only`, which throws outside a server runtime, so any component
 * that imported it was unrenderable and everything it was handed went
 * unobserved.
 */

/**
 * The `useActionState` reducer the app passes, or a plain string when a check
 * renders this outside a server runtime.
 */
export type FormAction<T extends FormState = FormState> =
  | string
  | ((prev: T, formData: FormData) => Promise<T>)

export function FormError({ state }: { state: FormState }) {
  const message = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (!state.error) return
    message.current?.focus({ preventScroll: true })
    message.current?.scrollIntoView({ block: 'nearest' })
  }, [state])
  if (state.error) return (
    <p ref={message} role="alert" tabIndex={-1} className={`mb-3 whitespace-pre-line ${REFUSAL}`}>
      {state.error}
    </p>
  )
  return null
}

function Message({ state }: { state: FormState }) {
  if (state.error) return <FormError state={state} />
  if (state.ok) return (
    <p role="status" className={`mt-3 whitespace-pre-line ${SUCCESS}`}>
      {state.ok}
    </p>
  )
  return null
}

/**
 * The submit wiring on its own, for screens whose layout ActionForm's shape
 * does not fit. Returns the state, the pending flag, and the props to spread
 * onto the `<form>` — WHICH IS THE POINT: a form that takes `formProps` cannot
 * also bind the dispatcher to `action=`, so it cannot regress into the
 * React-resets-on-refusal wiring one attribute at a time. `V96` additionally
 * scans every screen for a bound `action=` and refuses the ninth form the
 * grep above this sentence would otherwise never meet.
 */
export function useActionForm<T extends FormState = FormState>(
  bind: FormAction<T>,
  opts?: { onSucceeded?: (state: T) => void; initialState?: T; requestError?: string },
) {
  const formRef = useRef<HTMLFormElement>(null)
  const submittedForm = useRef<HTMLFormElement>(null)
  const bound = typeof bind === 'string' ? async () => ({})
    : bind as unknown as (previous: FormState, formData: FormData) => Promise<FormState>
  const reducer = !opts?.requestError ? bound : async (previous: FormState, formData: FormData): Promise<FormState> => {
    try {
      return await bound(previous, formData)
    } catch (error) {
      if (!opts?.requestError) throw error
      unstable_rethrow(error)
      // A lost response cannot tell us whether the server committed. Keep the
      // fields and ask the person to check; never automatically submit again.
      return { error: opts.requestError }
    }
  }
  const [rawState, dispatch, pending] = useActionState<FormState, FormData>(
    reducer, opts?.initialState ?? {})
  const state = rawState as T
  const onSucceeded = opts?.onSucceeded

  useEffect(() => {
    if (state.version) (formRef.current ?? submittedForm.current)?.dispatchEvent(new CustomEvent('figtree:document-version', { bubbles: true, detail: state }))
    if (state.ok) {
      formRef.current?.reset()
      onSucceeded?.(state)
      ;(formRef.current ?? submittedForm.current)?.dispatchEvent(new CustomEvent('figtree:form-saved', { bubbles: true, detail: state }))
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    state,
    pending,
    /**
     * For a form with SEVERAL actions (the entry form's save/post/amend), where
     * `formProps` cannot pick one: a button calls `submitWith(button.form)`
     * from onClick after `reportValidity()`, and the form itself carries
     * `onSubmit={preventDefault}` so Enter cannot fall through to a native
     * submit. Same dispatch, same no-reset-on-refusal, one wiring.
     */
    submitWith: (form: HTMLFormElement) => {
      submittedForm.current = form
      const data = new FormData(form)
      startTransition(() => dispatch(data))
    },
    formProps: {
      ref: formRef,
      'data-pending': pending ? 'true' : undefined,
      action: typeof bind === 'string' ? bind : undefined,
      onSubmit: typeof bind === 'string' ? undefined : (e: React.FormEvent<HTMLFormElement>) => {
        // Native validation has already passed or this event does not fire.
        e.preventDefault()
        const data = new FormData(e.currentTarget)
        const submitter = (e.nativeEvent as SubmitEvent).submitter as
          | HTMLButtonElement | HTMLInputElement | null
        if (submitter?.name) data.set(submitter.name, submitter.value)
        startTransition(() => dispatch(data))
      },
    },
  }
}

export function ActionForm({
  action: bind, submit, working, className, buttonClassName, onSucceeded, children, id, stickyActions, secondaryActions, requestError,
}: {
  action: FormAction
  submit: string
  working: string
  className?: string
  buttonClassName: string
  stickyActions?: boolean
  /** Cancel and other secondary controls share the committing action's row. */
  secondaryActions?: React.ReactNode
  /** An inline recovery message for a rejected request, with unknown outcome. */
  requestError?: string
  /**
   * For inputs that live OUTSIDE the form — a tick in each row of a table
   * whose rows carry forms of their own, so the tick cannot sit inside this
   * one. HTML's `form="<id>"` attribute associates them, and `FormData(form)`
   * then includes them. The id has to be on the FORM element: the first
   * version put it on a hidden span beside it, and per the form-owner rules a
   * `form=` naming a non-form element associates with nothing, so every tick
   * was dropped and batch accept always posted no rows (critic, 2026-09-04).
   */
  id?: string
  /**
   * Called once each time the action comes back having WORKED. It exists for
   * fields this component cannot reset, which means fields holding their own
   * value rather than the browser's — the invoice line editor's rows live in
   * React state, and `form.reset()` cannot see them.
   *
   * It is a callback about this component's own state, not a field handed in —
   * there is still no way for anything here to alter what a field posts. It
   * is handed the state so a screen that replaces the form can say what the
   * action actually said, not what it hoped (the bill door, critic).
   */
  onSucceeded?: (state: FormState) => void
  children: React.ReactNode
}) {
  // One wiring for the whole app, defined once above. Success clears the form
  // EXPLICITLY in the hook — the form is submitted through `onSubmit` rather
  // than through the `action` prop precisely so that React's own reset never
  // runs: `startHostTransition` schedules `requestFormReset` BEFORE it calls
  // the action, so a form submitted the ordinary way is cleared on the way out
  // whatever the action returns. An eight-field bill refused over one typo
  // came back empty, with the error naming a field that no longer held
  // anything. Refusals now keep every field.
  const { state, pending, formProps } = useActionForm(bind, { onSucceeded, requestError })

  return (
      <form {...formProps} id={id} className={className}>
        <Message state={state} />
        {children}
        {stickyActions || secondaryActions ? <div className="form-actions">
          {secondaryActions}
          <button type="submit" disabled={pending} className={buttonClassName}>
            {pending ? working : submit}
          </button>
        </div> : (
        <button type="submit" disabled={pending} className={buttonClassName}>
          {pending ? working : submit}
        </button>
        )}
      </form>
  )
}

/**
 * True for a while after `value` becomes truthy, then false: for an inline
 * "saved" that should not stand beside the control for the rest of the
 * session (whole-project audit, 2026-09-13). A panel that is REPLACED by the
 * next render does not need this; a word beside a control does. Hand it the
 * STATE OBJECT (or something new per submission), not the message: an action
 * that answers the same string twice would otherwise show "saved" once.
 */
export function useFades(value: unknown, ms = 8_000): boolean {
  // `value` itself is the generation: callers hand this hook the action
  // state object, which is new for every response. A new generation is shown
  // immediately by derivation; the timer only records that this generation
  // has finished its stay. No effect has to synchronously manufacture the
  // visible state that the current render already knows.
  const [fadedValue, setFadedValue] = useState<unknown>(null)
  useEffect(() => {
    if (!value) return
    const t = setTimeout(() => setFadedValue(() => value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return !!value && fadedValue !== value
}

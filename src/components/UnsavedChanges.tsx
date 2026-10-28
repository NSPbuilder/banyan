'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { BUTTON, DANGER, QUIET } from '@/lib/ui'

/** Compare submitted values, including external form controls and files.
 * Amounts stay strings; this is a change detector, never an accounting reader. */
function fingerprint(form: HTMLFormElement) {
  // Submission nonces and edit proofs change independently of user input,
  // including after another form on the same document successfully saves.
  return JSON.stringify([...new FormData(form)].filter(([key])=>!['requestKey','expectedVersion','editTab','editToken','editGeneration'].includes(key)).map(([key, value]) => [key,
    typeof value === 'string' ? value : value.name ? [value.name, value.size, value.lastModified] : null]))
}

export function useUnsavedChanges(root: React.RefObject<HTMLElement | null>) {
  const initial = useRef(new Map<HTMLFormElement, string>())
  const capture = () => {
    initial.current = new Map([...root.current?.querySelectorAll<HTMLFormElement>('form') ?? []]
      .map((form) => [form, fingerprint(form)]))
  }
  const isDirty = useCallback(() => [...initial.current].some(([form, value]) =>
    form.isConnected && form.getClientRects().length > 0 && fingerprint(form) !== value), [])
  useEffect(() => {
    initial.current = new Map([...root.current?.querySelectorAll<HTMLFormElement>('form') ?? []]
      .map((form) => [form, fingerprint(form)]))
    const saved = (event: Event) => {
      const form = event.target as HTMLFormElement
      requestAnimationFrame(() => { if (form.isConnected) initial.current.set(form, fingerprint(form)) })
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (isDirty()) { event.preventDefault(); event.returnValue = '' }
    }
    const element = root.current
    element?.addEventListener('figtree:form-saved', saved)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      element?.removeEventListener('figtree:form-saved', saved)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [isDirty, root])
  return { capture, isDirty }
}

export function useConfirmExit(isDirty: () => boolean, exit: () => void, root: React.RefObject<HTMLElement | null>, retainsDraft = false) {
  const dialog = useRef<HTMLDialogElement>(null)
  const nextExit = useRef(exit)
  const titleId = useId()
  const [saving, setSaving] = useState(false)
  const requestExit = (next: () => void) => {
    nextExit.current = next
    const pending = !!root.current?.querySelector('form[data-pending="true"]')
    if (!pending && !isDirty()) { next(); return }
    setSaving(pending)
    dialog.current?.showModal()
  }
  const requestClose = () => requestExit(exit)
  const prompt = (
    <dialog ref={dialog} aria-labelledby={titleId} className="unsaved-dialog">
      <h2 id={titleId} className="text-lg font-semibold">{saving ? 'Saving is in progress' : retainsDraft ? 'Close without saving?' : 'Discard unsaved changes?'}</h2>
      <p className="mt-2 text-sm text-neutral-500">{saving
        ? 'Wait for the save to finish before closing this form.'
        : 'Your changes have not been saved.'}</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" autoFocus className={saving ? BUTTON : QUIET} onClick={() => dialog.current?.close()}>
          {saving ? 'Keep waiting' : 'Keep editing'}
        </button>
        {!saving && <button type="button" className={DANGER} onClick={() => { dialog.current?.close(); nextExit.current() }}>{retainsDraft ? 'Close without saving' : 'Discard changes'}</button>}
      </div>
    </dialog>
  )
  return { requestClose, requestExit, prompt }
}

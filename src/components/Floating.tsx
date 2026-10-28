'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { DialogHeader } from './DialogHeader'
import { useConfirmExit, useUnsavedChanges } from './UnsavedChanges'

/**
 * A FORM IN A FLOATING PAGE, opened by a button — for a form that belongs to
 * the screen it sits on and needs no address of its own.
 *
 * The owner's rule (2026-09-16): 「所有添加记录的功能都以表单形式以悬浮页面
 * 呈现，不要再像 corporate records 一样，直接有空可以填」. The big create doors
 * float as intercepting routes (`@modal`) because they are also places a link
 * or a reading lands on. The small ones — the next fiscal year, a bank
 * statement, a role at this company, a registration, a user — have nowhere
 * else to be reached from, so they float here instead, over the page, from a
 * native `<dialog>`.
 *
 * Native, and ALWAYS IN THE MARKUP. `showModal()` gives the backdrop, Escape,
 * the focus trap and the top layer without a line of it being written here;
 * and because the dialog's contents render whether or not it is open, every
 * check that renders a screen and reads back the fields its forms would
 * submit still reads them — the form moved into a floating page, not out of
 * the page.
 *
 * It looks like `OverlayPanel`, the routed kind, so a person meets one kind of
 * floating page, whichever way it was built.
 */
export function Floating({ label, title, buttonClassName, children, ariaLabel, wide = false }: {
  /** The button that opens it. */
  label: string
  /** The heading inside it. */
  title: string
  buttonClassName: string
  /** For a button whose words are the same in every row: "Add here" on each party. */
  ariaLabel?: string
  /** Extra room for editors with a full document preview. */
  wide?: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [portalTarget,setPortalTarget]=useState<HTMLElement|null>(null)
  const close = () => ref.current?.close()
  const { capture, isDirty } = useUnsavedChanges(ref)
  const { requestClose, prompt } = useConfirmExit(isDirty, close, ref, true)
  const panel=<dialog ref={ref} aria-label={title}
    onClick={e=>{if(e.target===ref.current)requestClose()}}
    onCancel={e=>{if(e.target===ref.current){e.preventDefault();requestClose()}}}
    className={`floating-surface fixed inset-y-6 right-6 left-auto m-0 h-auto max-h-none w-[calc(100%-3rem)] ${wide ? 'max-w-6xl' : 'max-w-4xl'} overflow-auto whitespace-normal rounded-lg bg-white p-0 text-left text-neutral-900 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100`}>
    <div className="min-h-full"><DialogHeader title={title} onClose={requestClose}/><div className="overlay-content pb-6 font-sans">{children}</div></div>{prompt}
  </dialog>
  return (
    <>
      <button type="button" onClick={() => {
        // A menu closes after choosing its action. Move its dialog to the body
        // first, so the menu's display:none cannot hide the open modal.
        if(ref.current?.closest('[popover]'))flushSync(()=>setPortalTarget(document.body))
        capture();ref.current?.showModal()
      }} className={buttonClassName}
              aria-label={ariaLabel} aria-haspopup="dialog">
        {label}
      </button>
      {portalTarget?createPortal(panel,portalTarget):panel}
    </>
  )
}

/** A floating page opened by a control inside another form. Its portal keeps
 * the two forms separate, including when the original form is itself a dialog. */
export function FloatingPanel({ title, dialogRef, children, onClose }: {
  title: string
  dialogRef: React.RefObject<HTMLDialogElement | null>
  children: (requestClose: () => void) => React.ReactNode
  onClose: () => void
}) {
  const { isDirty } = useUnsavedChanges(dialogRef)
  const { requestClose, prompt } = useConfirmExit(isDirty, onClose, dialogRef)
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => { if (dialog.open) dialog.close() }
  }, [dialogRef])
  if (typeof document === 'undefined') return null
  return createPortal(
    <dialog ref={dialogRef} aria-label={title}
      onSubmit={event => event.stopPropagation()}
      onReset={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); if (event.target === dialogRef.current) requestClose() }}
      onCancel={event => { if (event.target === dialogRef.current) { event.preventDefault(); requestClose() } }}
      className="floating-surface fixed inset-y-6 right-6 left-auto m-0 h-auto max-h-none w-[calc(100%-3rem)] max-w-4xl overflow-auto whitespace-normal rounded-lg bg-white p-0 text-left text-neutral-900 backdrop:bg-black/40 dark:bg-neutral-900 dark:text-neutral-100">
      <div className="min-h-full"><DialogHeader title={title} onClose={requestClose}/>
        <div className="overlay-content pb-6 font-sans">{children(requestClose)}</div>
      </div>{prompt}
    </dialog>, document.body,
  )
}

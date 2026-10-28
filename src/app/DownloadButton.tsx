'use client'

import { useEffect, useState } from 'react'

/**
 * The backup download's form and button. The form POSTs to a route that
 * streams a pg_dump, so the browser stays on the page and nothing on it
 * changed while the dump was being taken — a press looked like a press that
 * did nothing. It says it is working, and lets go after a while: the
 * browser's save dialog is the only "done" there is, and this cannot see it.
 *
 * The busy state is set from the form's submit event, and a tick later:
 * the first version set it in the button's onClick, React flushed the
 * update before the browser's activation behaviour ran, and a submitter
 * that is disabled by then submits nothing — the press did nothing, for
 * real this time (independent critic, 2026-09-13, real clicks in Chromium).
 */
export function DownloadForm({ action, label, working }: { action: string; label: string; working: string }) {
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => setPending(false), 20_000)
    return () => clearTimeout(t)
  }, [pending])
  return (
    <form method="post" action={action} className="inline"
          onSubmit={() => { setTimeout(() => setPending(true), 0) }}>
      <button type="submit" aria-busy={pending} disabled={pending}
              className="underline underline-offset-2 disabled:no-underline disabled:opacity-70">
        {pending ? working : label}
      </button>
    </form>
  )
}

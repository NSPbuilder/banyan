'use client'

import { useEffect, useRef, useState } from 'react'
import { ToolAction } from './ToolAction'
import { TOOL_BUTTON, REFUSAL } from '@/lib/ui'

/** Print the complete exported PDF, including pages absent from the HTML preview. */
export function PdfPrintButton({ href }: { href: string }) {
  const active = useRef<{ abort: AbortController; release: () => void } | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => () => {
    active.current?.abort.abort()
    active.current?.release()
    active.current = null
  }, [])

  async function print() {
    active.current?.abort.abort()
    active.current?.release()
    const job = { abort: new AbortController(), release: () => {} }
    active.current = job
    setBusy(true)
    setAttempted(true)
    setError('')
    const fail = (message: string) => {
      if (active.current !== job) return
      job.abort.abort()
      job.release()
      active.current = null
      setBusy(false)
      setError(message)
    }
    try {
      const response = await fetch(href, { cache: 'no-store', credentials: 'same-origin', signal: job.abort.signal })
      if (!response.ok || response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/pdf') {
        throw new Error('The complete Receipt PDF could not be prepared. Open the PDF to check its attachments before printing.')
      }
      const pdf = await response.blob()
      if (await pdf.slice(0, 5).text() !== '%PDF-') throw new Error('The Receipt PDF could not be read. Open the PDF to try again.')
      if (job.abort.signal.aborted) return
      const url = URL.createObjectURL(pdf)
      const frame = document.createElement('iframe')
      frame.title = 'Receipt PDF for printing'
      frame.setAttribute('aria-hidden', 'true')
      frame.setAttribute('data-pdf-print-frame', '')
      frame.tabIndex = -1
      frame.style.cssText = 'position:fixed;right:100%;top:0;width:800px;height:1000px;border:0'
      let removeAfterPrint = () => {}
      const timer = setTimeout(() => fail('The print preview took too long to load. Open the PDF and use its Print control.'), 30_000)
      job.release = () => {
        clearTimeout(timer)
        frame.onload = null
        frame.onerror = null
        removeAfterPrint()
        frame.remove()
        URL.revokeObjectURL(url)
      }
      frame.onload = () => {
        if (active.current !== job) return
        clearTimeout(timer)
        frame.onload = null
        try {
          const view = frame.contentWindow
          if (!view) throw new Error('No PDF print window')
          const finished = () => {
            job.release()
            if (active.current === job) active.current = null
          }
          view.addEventListener('afterprint', finished, { once: true })
          removeAfterPrint = () => view.removeEventListener('afterprint', finished)
          setBusy(false)
          view.focus()
          view.print()
          // Keep the frame and Blob alive until afterprint or unmount: print()
          // may return while a browser's native dialog is still using the PDF.
        } catch {
          fail('The browser could not start printing. Open the PDF and use its Print control.')
        }
      }
      frame.onerror = () => fail('The PDF print preview could not load. Open the PDF to print it.')
      frame.src = url
      document.body.appendChild(frame)
    } catch (cause) {
      if (!job.abort.signal.aborted) fail(cause instanceof Error ? cause.message : 'The PDF could not be prepared for printing.')
    }
  }

  return <>
    <button type="button" onClick={print} disabled={busy} className={TOOL_BUTTON} title="Print">
      <ToolAction kind="print">{busy ? 'Preparing…' : 'Print'}</ToolAction>
    </button>
    {attempted && <p className={`w-full text-right ${error ? REFUSAL : 'text-caption text-ink-muted'}`} role="status">
      {error ? `${error} ` : 'If no print dialog opens, '}
      <a href={href} target="_blank" rel="noopener" className="underline">Open PDF</a>{!error && ' and use its Print control.'}
    </p>}
  </>
}

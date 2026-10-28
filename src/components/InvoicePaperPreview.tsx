'use client'

import { useEffect, useRef } from 'react'
import type { InvoiceDocument } from '@/lib/customer-docs'
import { InvoiceDocView } from '@/app/ledger/[ledgerId]/invoices/[invoiceId]/print/InvoiceDocView'
import styles from './InvoicePaperPreview.module.css'

/** Letter at 96 CSS pixels per inch; resize the whole sheet, never its layout. */
export function InvoicePaperPreview({ doc }: { doc: InvoiceDocument }) {
  const viewport = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = viewport.current, page = sheet.current, scaled = frame.current
    if (!container || !page || !scaled) return
    let pending = 0, previous = ''
    const update = () => {
      pending = 0
      const width = container.clientWidth, height = page.offsetHeight
      if (!width) return // Native dialogs are mounted while closed.
      const scale = Math.min(1, width / 816)
      const dimensions = `${scale}:${height}`
      if (dimensions === previous) return
      previous = dimensions
      scaled.style.setProperty('--preview-scale', String(scale))
      scaled.style.setProperty('--preview-width', `${816 * scale}px`)
      scaled.style.setProperty('--preview-height', `${height * scale}px`)
      scaled.style.setProperty('--preview-visibility', 'visible')
    }
    const observer = new ResizeObserver(() => {
      if (!pending) pending = requestAnimationFrame(update)
    })
    observer.observe(container)
    observer.observe(page)
    update()
    return () => { observer.disconnect(); cancelAnimationFrame(pending) }
  }, [])

  return <div ref={viewport} className={styles.viewport} data-invoice-preview>
    <div ref={frame} className={styles.frame}>
      <div ref={sheet} className={styles.sheet}>
        <InvoiceDocView controls={false} doc={doc} />
      </div>
    </div>
  </div>
}

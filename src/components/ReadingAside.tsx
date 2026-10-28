import Link from 'next/link'
import type { Reading } from '@/lib/bill-reading'

/**
 * The bill beside the form it filled in: the picture, what the document says
 * its totals are, and the model's notes — so the review is a comparison, not
 * an act of faith. Server-rendered; the picture comes through its own guarded
 * route.
 */
export function ReadingAside({ ledgerId, reading }: { ledgerId: string; reading: Reading }) {
  const p = reading.proposal
  return (
    <aside className="mt-6 flex flex-wrap gap-6 rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800"
           data-reading-aside={reading.id}>
      {/* A picture is shown; a PDF is a link, because an <img> of a PDF is a
          broken image icon and nothing else (2026-09-07). A reading from a
          sentence alone has neither (0077). */}
      {reading.filename !== null && (
      <a href={`/ledger/${ledgerId}/readings/${reading.id}/file`} target="_blank" className="shrink-0">
        {reading.mime === 'application/pdf' ? (
          <span className="flex h-40 w-32 items-center justify-center rounded border border-neutral-200 text-xs text-neutral-500 dark:border-neutral-800">
            Open the PDF
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/ledger/${ledgerId}/readings/${reading.id}/file`} alt={reading.filename}
               className="max-h-80 max-w-xs rounded border border-neutral-200 object-contain dark:border-neutral-800" />
        )}
      </a>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-neutral-500">{reading.filename !== null ? 'From the document' : 'From what was written'}</p>
        <p className="mt-1">{reading.filename ?? 'What was written'}, read by {reading.read_by}. Some boxes below may be filled in from it —
          check each against {reading.filename !== null ? 'the document' : 'what was written'}, then post. Nothing is entered until you do.</p>
        {reading.sentence && <p className="mt-2 whitespace-pre-wrap">“{reading.sentence}”</p>}
        {p && (
          <p className="mt-2 text-xs text-neutral-500">
            On the document:
            {p.subtotal !== null && <> subtotal {p.subtotal} ·</>}
            {p.gst !== null && <> GST {p.gst} ·</>}
            {p.pst !== null && <> PST {p.pst} ·</>}
            {p.total !== null ? <> total {p.total}</> : <> no total read</>}
            {p.currency !== 'CAD' && <> · <span className="text-amber-700 dark:text-amber-400">in {p.currency}; the books are in CAD</span></>}
          </p>
        )}
        {p?.notes && <p className="mt-2 text-xs text-neutral-500">The model notes: “{p.notes}”</p>}
        <p className="mt-2 text-xs">
          <Link href={`/ledger/${ledgerId}/readings`} className="underline underline-offset-2">Not this one — back to AI</Link>
        </p>
      </div>
    </aside>
  )
}

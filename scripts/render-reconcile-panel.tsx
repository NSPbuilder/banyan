/**
 * Renders the reconcile panel and prints what a person would see, as JSON:
 *
 *   npx tsx scripts/render-reconcile-panel.tsx '<props>'
 *
 * Same split as render-reconcile.tsx: the suite fetches, this renders. What it
 * reads back: the four figures as cents, which forms are offered (Finish,
 * Undo), and how many cleared and pending rows are listed.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { parse } from './json-bigint'
import { ReconcilePanel } from '../src/app/ledger/[ledgerId]/bank/[accountId]/reconcile/ReconcilePanel'
import type { ReconcileView } from '../src/lib/bank'
import { reconcileFigures } from '../src/lib/recon-display'

const input = parse<{ ledgerId: string; accountId: string; view: ReconcileView }>(process.argv[2])

const markup = renderToStaticMarkup(
  <ReconcilePanel ledgerId={input.ledgerId} accountId={input.accountId} view={input.view}
                  actions={{ finish: '/finish', undo: '/undo' }} />)

const text = (s: string) => s.replace(/<[^>]+>/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean)
const cents = (raw: string) => {
  const m = /^\(?-?([\d,]+)\.(\d\d)\)?$/.exec(raw.trim())
  if (!m) return null
  const v = BigInt(m[1].replace(/,/g, '')) * 100n + BigInt(m[2])
  return raw.trim().startsWith('-') || raw.trim().startsWith('(') ? -v : v
}

// Each figure is a labelled box; the amount is the first money line after its
// label. The labels come from recon-display, the one place they are spelled.
const lines = text(markup)
const figures: Record<string, string> = {}
for (const [label] of reconcileFigures(input.view)) {
  const i = lines.indexOf(label)
  const amount = lines.slice(i + 1, i + 4).map(cents).find((v) => v !== null)
  if (i >= 0 && amount !== undefined) figures[label] = String(amount)
}

const forms = [...markup.matchAll(/<form\b[^>]*action="([^"]*)"/g)].map((m) => m[1])
const cleared = (markup.match(/aria-label="cleared"/g) ?? []).length
// Data rows name themselves; the header and the Total line do not.
const pending = (/Not yet cleared([\s\S]*?)<\/table>/.exec(markup)?.[1].match(/<tr[^>]*data-line=/g) ?? []).length

process.stdout.write(JSON.stringify({ figures, forms, cleared, pending }))

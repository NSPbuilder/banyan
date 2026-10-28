/**
 * Renders the two invoice screens and prints what a person would see, as JSON:
 *
 *   npx tsx scripts/render-invoice-screens.tsx '<props>'
 *
 * Props are passed in, not fetched — this process cannot reach the database, for
 * the reason `render-reconcile.tsx` explains at length.
 *
 * The library and form checks prove what `createInvoiceFromForm` does with a
 * FormData somebody built. They cannot prove the SCREEN builds that FormData:
 * that every field of line 3 is named for line 3, or that the Post button under
 * an invoice carries that invoice's id. Nothing that reads the source can see
 * either, and the sales tax round spent six rounds on exactly that seam.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { unescape } from './suite'
import { parse } from './json-bigint'
import { PartyLedgerScreen } from '../src/app/ledger/[ledgerId]/PartyLedgerScreen'
import type { LedgerRow } from '../src/lib/browse'
import type { Choice } from '../src/lib/forms'
import { NewInvoiceForm } from '../src/app/ledger/[ledgerId]/invoices/new/NewInvoiceForm'
import {
  InvoiceDetail, type DetailLine,
} from '../src/app/ledger/[ledgerId]/invoices/[invoiceId]/InvoiceDetail'

const input = parse<{
  ledgerId: string
  /** The by-party browse's own rows: the invoice list is gone, and its
   *  checks moved onto the page that replaced it (owner, 2026-09-03). */
  ledgerRows: LedgerRow[]
  parties: { sales: Choice[]; purchase: Choice[] }
  controlAccounts: { sales: Choice[]; purchase: Choice[] }
  lineAccounts: Choice[]
  detail: {
    invoiceId: string
    direction: 'sales' | 'purchase'
    status: 'draft' | 'posted' | 'void'
    entryNo: string | null
    lines: DetailLine[]
    total: bigint
  }
}>(process.argv[2])

/** Every input/select/textarea in the markup, as name -> the value it would post. */
function fieldsOf(markup: string) {
  const out: Array<{ name: string; value: string; tag: string }> = []
  for (const m of markup.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]
    const name = /\bname="([^"]*)"/.exec(attrs)?.[1]
    if (!name) continue
    const value = m[1] === 'textarea' ? markup.slice(m.index! + m[0].length, markup.indexOf('</textarea>', m.index))
      : /\bvalue="([^"]*)"/.exec(attrs)?.[1] ?? ''
    out.push({ name: unescape(name), value: unescape(value),
               tag: m[1] })
  }
  return out
}

// The list and the form are separate screens now (the form floats over the
// list as an overlay), so each is rendered where its checks look: links and
// row-links in the list, fields and line rows in the form. Concatenated where
// a check reads across both — nothing a person sees is outside the two.
const listOnlyMarkup = renderToStaticMarkup(
  <PartyLedgerScreen ledgerId={input.ledgerId} direction="in" rows={input.ledgerRows} mayJournal />)
const journalDeniedMarkup = renderToStaticMarkup(
  <PartyLedgerScreen ledgerId={input.ledgerId} direction="in" rows={input.ledgerRows} mayJournal={false} />)
const formMarkup = renderToStaticMarkup(
  <NewInvoiceForm
    ledgerId={input.ledgerId} parties={input.parties}
    controlAccounts={input.controlAccounts} lineAccounts={input.lineAccounts}
    today="2026-09-01" action="/create" />)
const listMarkup = listOnlyMarkup + formMarkup

// And the same screen after somebody has edited its lines — rows removed and
// moved, so no row's key is its position any more.
//
// A blank form cannot show whether a button is wired to the row or to the place
// the row is sitting in, because on a blank form those are the same number. The
// suite's own fixtures cannot reach this state either: adding and removing rows
// is a click, and nothing here can press one. So the state is handed in.
const editedMarkup = renderToStaticMarkup(
  <NewInvoiceForm
    ledgerId={input.ledgerId} parties={input.parties}
    controlAccounts={input.controlAccounts} lineAccounts={input.lineAccounts}
    today="2026-09-01" action="/create"
    openWith={{ nextKey: 10, rows: [
      { key: 5, account: '', description: 'moved up from the bottom', amount: '1.00', taxCode: 'OUT_OF_SCOPE' },
      { key: 2, account: '', description: 'stayed', amount: '2.00', taxCode: 'OUT_OF_SCOPE' },
      { key: 9, account: '', description: 'added last', amount: '3.00', taxCode: 'OUT_OF_SCOPE' },
    ] }} />)

// Once per status. The suite used to render whichever invoice it found first,
// so the Void form in the `posted` branch — which carries its own hidden id —
// was never rendered and never checked.
const detailByStatus = Object.fromEntries((['draft', 'posted', 'void'] as const).map((status) => {
  const markup = renderToStaticMarkup(
    <InvoiceDetail
      ledgerId={input.ledgerId} invoiceId={input.detail.invoiceId}
      direction={input.detail.direction} kind="invoice" status={status}
      entryNo={input.detail.entryNo} lines={input.detail.lines} total={input.detail.total}
      actions={{ post: '/post', delete: '/delete' }} />)
  return [status, {
    forms: formsOf(markup),
    text: markup.replace(/<[^>]+>/g, '\n').split('\n')
      .map((l) => unescape(l.trim())).filter(Boolean),
  }]
}))

const detailMarkup = renderToStaticMarkup(
  <InvoiceDetail
    ledgerId={input.ledgerId} invoiceId={input.detail.invoiceId}
    direction={input.detail.direction} kind="invoice" status={input.detail.status}
    entryNo={input.detail.entryNo} lines={input.detail.lines} total={input.detail.total}
    actions={{ post: '/post', delete: '/delete' }} />)

// Each FORM and the fields inside it, so "every button carries this invoice's
// id" can be asked of every form rather than of the fields that happen to exist.
// A form carrying no id at all, or carrying it under another name, is the case
// a flat list of fields cannot see.
function formsOf(markup: string) {
  return [...markup.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)]
    .map((m) => fieldsOf(m[1]).map((f) => ({ name: f.name, value: f.value })))
}

// Each ROW and the hrefs inside it, so a row linking to another row's invoice
// is visible. Scraping every href from the page cannot see that.
function rowLinksOf(markup: string) {
  return [...markup.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((m) => [...m[1].matchAll(/href="([^"]*)"/g)].map((h) => unescape(h[1])))
    .filter((hrefs) => hrefs.length > 0)
}

// Line slots, grouped by the number in the field name. The point of the shape
// is that a slot's three fields carry the SAME number, so this reports them
// grouped and a check can say so.
const slots: Record<string, string[]> = {}
for (const f of fieldsOf(listMarkup)) {
  const m = /^line\.(\d+)\.(\w+)$/.exec(f.name)
  if (!m) continue
  ;(slots[m[1]] ??= []).push(m[2])
}

// Each LINE ROW as a whole: the key it declares, the field numbers inside it,
// and what the buttons inside it say they act on.
//
// The two numbers in a row are different numbers — the position names the
// fields, the key identifies the row — and the only place they can be seen
// together is the markup. A remove button carrying a position, or carrying
// another row's key, is invisible to the grouped `slots` below, to anything
// reading the source, and to every library check: all of those would still show
// three well-formed fields per row.
// Sliced on the markers themselves rather than on any class name: a row runs
// from its own marker to the next one, and the last runs to the Add button.
function lineRowsOf(markup: string) {
  const marks = [...markup.matchAll(/\bdata-line-row="(\d+)"/g)]
  const end = markup.indexOf('data-does="add"')
  return marks.map((m, n) => ({
    m,
    body: markup.slice(m.index!, n + 1 < marks.length ? marks[n + 1].index! : (end < 0 ? markup.length : end)),
  }))
    .map(({ m, body }) => ({
      key: m[1],
      fieldIndices: [...new Set([...body.matchAll(/name="line\.(\d+)\.\w+"/g)].map((f) => f[1]))],
      // The row's CONTROLS, which are the buttons that say what they do. A
      // row also contains the account picker, and a picker renders one button
      // per account it offers plus one to create a new one (2026-09-07);
      // those are choices, not controls, and counting them here made every
      // row look as though it had ten buttons wired to nothing. `V88b` is
      // what holds a control to declaring itself: a control that lost its
      // marker is a missing control there, not a silent pass here.
      buttons: [...body.matchAll(/<button\b([^>]*\bdata-does="[^"]*"[^>]*)>/g)].map((b) => ({
        actsOn: /\bdata-acts-on="([^"]*)"/.exec(b[1])?.[1] ?? null,
        does: /\bdata-does="([^"]*)"/.exec(b[1])?.[1] ?? null,
        label: unescape(/\baria-label="([^"]*)"/.exec(b[1])?.[1] ?? ''),
        // `disabled=""`, not `disabled` — the class list carries Tailwind's
        // `disabled:opacity-30`, and a word-boundary match read that as the
        // attribute and reported every button dead.
        disabled: /\sdisabled=""/.test(b[1]),
      })),
    }))
}

// What the rows point at, so "the row's link opens that row" is checkable
// rather than assumed. Both destinations now: a document row opens its
// document, an entry row opens its entry.
const links = [...listMarkup.matchAll(/href="([^"]*(?:invoices|entries)\/[^"]*)"/g)].map((m) => unescape(m[1]))

/**
 * The SHAPE of the by-party list: how many tables it is, how many columns its
 * header declares, and how many cells each data row actually has.
 *
 * Columns line up across parties only if there is ONE table — the first
 * version gave each party its own, so each party's dates and numbers were
 * measured against that party's own widest cell and no two lines agreed
 * (owner, 2026-09-03). Nothing that reads the source can see that, and neither
 * can a check on the data: every figure was right and the page still looked
 * ragged. A row that is a cell short of the header is the same defect from the
 * other end.
 */
const listShape = {
  tables: (listOnlyMarkup.match(/<table\b/g) ?? []).length,
  headerCols: ((/<thead\b[\s\S]*?<tr\b[^>]*>([\s\S]*?)<\/tr>/.exec(listOnlyMarkup)?.[1] ?? '')
    .match(/<th\b/g) ?? []).length,
  // Data rows only, by the marker the renderer puts on them: a group's
  // heading row carries a <th> and the subtotal and is not a row of the
  // register. Selecting on "contains a link" instead let a row whose first
  // cell is a badge disappear from the count entirely — a missing row cannot
  // be reported ragged.
  dataRowCells: [...listOnlyMarkup.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)]
    .filter((m) => m[1].includes('data-row'))
    .map((m) => (m[2].match(/<td\b/g) ?? []).length),
}

function entryLinksOf(markup: string) {
  return [...markup.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)]
    .filter(m => m[1].includes('data-row'))
    .map(m => {
      const cells = [...m[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
      return [...(cells[3]?.[1] ?? '').matchAll(/href="([^"]*)"/g)].map(link => unescape(link[1]))
    })
}

process.stdout.write(JSON.stringify({
  slots,
  lineRows: lineRowsOf(listMarkup),
  lineRowsEdited: lineRowsOf(editedMarkup),
  typedTotal: /<span[^>]*data-typed-total[^>]*>([^<]*)</.exec(listMarkup)?.[1] ?? null,
  addButtons: [...listMarkup.matchAll(/<button\b[^>]*\bdata-does="add"[^>]*>/g)].length,
  listFields: fieldsOf(listMarkup).filter((f) => !f.name.startsWith('line.')).map((f) => f.name),
  links,
  listShape,
  rowLinks: rowLinksOf(listMarkup),
  entryLinks: entryLinksOf(listOnlyMarkup),
  deniedEntryLinks: entryLinksOf(journalDeniedMarkup),
  detailByStatus,
  detailFields: fieldsOf(detailMarkup).map((f) => ({ name: f.name, value: f.value })),
  detailText: detailMarkup.replace(/<[^>]+>/g, '\n').split('\n')
    .map((l) => unescape(l.trim())).filter(Boolean),
}))

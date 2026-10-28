/**
 * Renders the bank feed and the book-side summary and prints what a person
 * would see, as JSON:
 *
 *   npx tsx scripts/render-reconcile.tsx '<props>'
 *
 * The props are passed in, not fetched. This process cannot reach the database:
 * `react-dom/server` will not load under `--conditions=react-server`, and
 * `src/db/client.ts` is `server-only`, which throws without it. So the suite
 * fetches and this renders — the same split `render-tax-fields.tsx` arrived at.
 *
 * The library checks prove what `reconciliation`, `bankRows` and
 * `candidateEntries` decide. They cannot prove the screen shows it, or that the
 * button under a row posts that row's id — which is exactly the seam the sales
 * tax round spent six rounds on, because nothing that only reads the source can
 * see it.
 *
 * Since 19 the feed is three tabs. All three are rendered here, so `states`
 * counts every row the way it did when they shared one table; the suggestion
 * on each open row is decided by the same pure function the server uses.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { unescape } from './suite'
import { parse } from './json-bigint'
import { FeedScreen } from '../src/app/ledger/[ledgerId]/bank/[accountId]/FeedScreen'
import { Summary } from '../src/app/ledger/[ledgerId]/bank/[accountId]/Summary'
import type { BankRowRecord, Candidate, FeedRow, MatchRecord, Reconciliation } from '../src/lib/bank'
import { FEED_TABS, suggestionFor } from '../src/lib/bank-feed'

const input = parse<{
  ledgerId: string
  accountId: string
  recon: Reconciliation
  views: Array<{ row: BankRowRecord; matches: MatchRecord[]; candidates: Candidate[] }>
  contraAccounts: Array<{ id: string; code: string; name: string; bank?: boolean }>
  /** Who an Add may name, and which tax tags the chart can honour (both optional). */
  parties?: Array<{ id: string; label: string }>
  tags?: { recoverable: boolean; payable: boolean; pstPayable: boolean }
}>(process.argv[2])

const { recon, contraAccounts } = input
const parties = (input.parties ?? []).map((party) => ({
  ...party, role: 'supplier', role_label: 'Supplier', held_from: '0001-01-01', held_to: null,
}))
const tags = input.tags ?? { recoverable: false, payable: false, pstPayable: false }

const rows: FeedRow[] = input.views.map((v) => {
  const open = v.row.state === 'unmatched' || v.row.state === 'part'
  return { ...v, suggestion: open ? suggestionFor(v.row, v.candidates, null) : { kind: 'none' } }
})
const byTab = {
  pending: rows.filter((v) => v.row.state === 'unmatched' || v.row.state === 'part'),
  posted: rows.filter((v) => v.row.state === 'matched'),
  excluded: rows.filter((v) => v.row.state === 'ignored'),
}
const counts = { pending: byTab.pending.length, posted: byTab.posted.length, excluded: byTab.excluded.length }

{
  const actions = { match: '/match', unmatch: '/unmatch', ignore: '/ignore',
                    unignore: '/unignore', remove: '/remove', post: '/post', accept: '/accept' }
  const markup = FEED_TABS.map((tab) => renderToStaticMarkup(
    <FeedScreen
      ledgerId={input.ledgerId} accountId={input.accountId}
      accountLabel="1000 — Cash" tab={tab} counts={counts} rows={byTab[tab]}
      contraAccounts={contraAccounts.map((a) => ({ ...a, bank: a.bank ?? false }))}
      parties={parties} tags={tags}
      actions={actions} />)).join('\n')
  const summaryMarkup = renderToStaticMarkup(<Summary recon={recon} />)

/**
 * THE PER-ROW PLUMBING. A table cannot hold a form that spans its cells, so
 * the bank row puts one form in its last cell and every box points at it by
 * id. A box naming a form that does not exist looks exactly like a box that
 * works and submits nothing — which is what the first version of this screen
 * did to the tax and party boxes on any row with a suggested match.
 */
const formIds = new Set([...markup.matchAll(/<form\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]))
const pointedAt = [...markup.matchAll(/\bform="([^"]+)"/g)].map((m) => m[1])
const orphaned = [...new Set(pointedAt.filter((id) => !formIds.has(id)))]

  /** Every form on the page, with the fields it would submit. */
  const forms: Array<{ action: string; fields: Record<string, string>; submit: string }> = []
  for (const m of markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const fields: Record<string, string> = {}
    for (const tag of m[2].matchAll(/<input\b[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(tag[0])
      if (name) fields[name[1]] = unescape(/value="([^"]*)"/.exec(tag[0])?.[1] ?? '')
    }
    for (const tag of m[2].matchAll(/<select\b[^>]*name="([^"]+)"/g)) fields[tag[1]] = '(select)'
    // Inputs OUTSIDE the form that name it by `form="<id>"` are its fields
    // too — but only if the id is the FORM's. The first version of the feed
    // put the id on a span beside the form, every tick associated with
    // nothing, and this harness could not see it because it only looked
    // inside (critic, 2026-09-04). So: the id is read off the <form> tag, and
    // only an input naming THAT id counts.
    const id = /\bid="([^"]+)"/.exec(m[1])?.[1]
    if (id) {
      for (const tag of markup.matchAll(new RegExp('<input\\b[^>]*\\bform="' + id + '"[^>]*>', 'g'))) {
        const name = /name="([^"]+)"/.exec(tag[0])
        if (name) fields[name[1]] = (fields[name[1]] ? fields[name[1]] + ',' : '')
          + unescape(/value="([^"]*)"/.exec(tag[0])?.[1] ?? '')
      }
    }
    forms.push({
      action: /action="([^"]*)"/.exec(m[1])?.[1] ?? '',
      fields,
      submit: (/<button[^>]*>([\s\S]*?)<\/button>/.exec(m[2])?.[1] ?? '')
        .replace(/<[^>]+>/g, '').trim(),
    })
  }

  /**
   * How many rows the screen shows in each state — read off the rows the
   * screen actually rendered, each of which names its state, rather than off
   * the props handed in.
   */
  const states: Record<string, number> = {}
  for (const m of markup.matchAll(/<tr[^>]*data-state="([a-z]+)"/g)) {
    states[m[1]] = (states[m[1]] ?? 0) + 1
  }

  const summary = (/Made up of([\s\S]*?)<\/table>/.exec(summaryMarkup)?.[1] ?? '')
    .replace(/<[^>]+>/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean)

  // The money as printed, in cents, so a check can add up what the screen shows
  // rather than what the library returned. The two are not the same question:
  // the screen splits one of the three explanations in half, and that split
  // lives here and nowhere else.
  const cents = (raw: string) => {
    const t = raw.trim()
    const m = /^\(?-?([\d,]+)\.(\d\d)\)?$/.exec(t)
    if (!m) return null
    const v = BigInt(m[1].replace(/,/g, '')) * 100n + BigInt(m[2])
    return t.startsWith('-') || t.startsWith('(') ? -v : v
  }
  const amountsIn = (table: string) =>
    table.replace(/<[^>]+>/g, '\n').split('\n')
      .map((l) => cents(l.trim())).filter((v): v is bigint => v !== null)

  const partAmounts = amountsIn(/Made up of([\s\S]*?)<\/table>/.exec(summaryMarkup)?.[1] ?? '')
  const totals = amountsIn(/<table[\s\S]*?<\/table>/.exec(summaryMarkup)?.[0] ?? '')

  /**
   * The suggestion each open row shows, by row id, read off the MARKUP: a
   * match form with a hidden entry id on the row, or an add form with a hidden
   * contra account and the words "as last time". Not from the props — that
   * would echo `suggestionFor` back and prove nothing about the screen.
   */
  const suggested: Record<string, string> = {}
  for (const m of markup.matchAll(/<tr[^>]*data-row="([^"]+)"[^>]*data-state="(?:unmatched|part)"[\s\S]*?<\/tr>/g)) {
    const [rowMarkup, rowId] = m
    const matchForm = /<form[^>]*action="\/match"[^>]*>(?:(?!<\/form>)[\s\S])*?name="entryId" value="([^"]+)"(?:(?!<\/form>)[\s\S])*?<\/form>/.exec(
      rowMarkup.split('<details')[0])
    const addForm = /<form[^>]*action="\/post"[^>]*>(?:(?!<\/form>)[\s\S])*?name="contraAccountId" value="([^"]+)"(?:(?!<\/form>)[\s\S])*?as last time/.exec(
      rowMarkup.split('<details')[0])
    suggested[rowId] = matchForm ? `match:${matchForm[1]}` : addForm ? `add:${addForm[1]}` : 'none'
  }

  process.stdout.write(JSON.stringify({
    states, forms, summary, suggested,
    partAmounts: partAmounts.map(String),
    totals: totals.map(String),
    formIds: [...formIds],
  orphaned,
}))
}

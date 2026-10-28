import 'server-only'
import {
  moneyFrom,
  g,
  QUICK_FIELDS as F, READING_FIELD, documentRefFrom, lineAccount, lineAmount, lineDescription,
  lineIndicesIn, lineTaxCode, lineGst, linePst,
} from './forms'
import { BillReadingError, attachReadingTo, readingRefusal } from './bill-reading'
import { attachIfAny } from './attach-forms'
import { TAX_CODES, computeEnteredTax, parseTaxOverride, type TaxCode } from './tax-rates'
import { QuickEntryError, postQuickEntry, type QuickItem, type QuickKind } from './quick'

/**
 * Reading the quick expense/income form. Separate from `app/actions.ts` for
 * the reason every *-forms.ts is: a check can call this and cannot call a
 * server action.
 */

export type FormResult = { ok?: string; error?: string; entryId?: string }


const sentenceOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 160)

const money = (raw: string, what: string) => moneyFrom(raw, what, (m) => new QuickEntryError('BAD_AMOUNT', m))

export async function quickEntryFromForm(f: FormData, actor: string): Promise<FormResult> {
  try {
    const kind = g(f, F.kind)
    if (kind !== 'expense' && kind !== 'income') {
      throw new QuickEntryError('BAD_KIND', 'Is this an expense or income?')
    }
    const entryDate = g(f, F.entryDate)
    if (!entryDate) throw new QuickEntryError('NO_DATE', 'When did the money move?')
    // The description is not required (owner, 2026-09-07). A receipt often has
    // nothing to add that the line and the account do not already say. The
    // journal still needs something to call the entry, so the fallback is said
    // out loud here rather than left to whatever an empty string becomes: the
    // first line that carried its own wording, then the plainest true sentence.
    const typed = g(f, F.description)
    // The bill this form was filled in from (0064), looked at BEFORE the
    // posting: a reading that is gone or already entered refuses the whole
    // form here, while nothing is in the books yet. Refusing after the
    // posting would leave the entry and invite a second one.
    const readingId = g(f, READING_FIELD)
    if (readingId) {
      const why = await readingRefusal(g(f, F.ledgerId), readingId)
      if (why) throw new QuickEntryError('READING_REFUSED', why)
    }
    // Rows first — the SAME line.{i}.* names and the SAME index reader the
    // invoice form uses (forms.ts): a second row convention would be a second
    // spelling of "which lines arrived". A row left entirely blank is an
    // unused extra, not an error. Per-row tax tags, ONE arithmetic
    // (computeTax), the same the screen previews with.
    const inclusive = g(f, F.amounts) === 'inclusive'
    const rowTax = (typed: bigint, code: string, gst?: bigint, pst?: bigint) => {
      code ||= 'OUT_OF_SCOPE'
      if (!TAX_CODES.some((t) => t.code === code)) {
        throw new QuickEntryError('BAD_TAX_CODE', `"${code}" is not a tax tag this ledger knows.`)
      }
      return computeEnteredTax(typed, code as TaxCode, inclusive, entryDate, { gst, pst })
    }

    const indices = lineIndicesIn([...f.keys()])
    const firstWording = indices.map((i) => g(f, lineDescription(i))).find((w) => w) ?? ''
    const description = typed || firstWording || (kind === 'expense' ? 'Expense' : 'Income')
    let posted
    if (indices.length > 0) {
      const items: QuickItem[] = []
      for (const i of indices) {
        const accountId = g(f, lineAccount(i))
        const amountRaw = g(f, lineAmount(i))
        const wording = g(f, lineDescription(i))
        const gstRaw = g(f, lineGst(i)), pstRaw = g(f, linePst(i))
        // Blank means BLANK: an unused "+ Add a line" costs nothing, but a row
        // someone typed words into is a row they meant — dropping it silently
        // would lose the item and the money with it.
        if (!accountId && !amountRaw && !wording && !gstRaw && !pstRaw) continue
        if (!accountId) throw new QuickEntryError('NO_ACCOUNT', 'A line is filled in but has no account.')
        if (!amountRaw) throw new QuickEntryError('NO_AMOUNT', 'A line is filled in but has no amount.')
        const t = rowTax(money(amountRaw, 'an amount of money'), g(f, lineTaxCode(i)),
          parseTaxOverride(gstRaw), parseTaxOverride(pstRaw))
        items.push({
          accountId,
          description: wording || undefined,
          amount: t.base, gst: t.gst, pst: t.pst,
        })
      }
      if (items.length === 0) {
        throw new QuickEntryError('NO_AMOUNT', 'How much? Every line is empty.')
      }
      posted = await postQuickEntry({
        ledgerId: g(f, F.ledgerId), kind: kind as QuickKind, entryDate, description,
        documentRef: documentRefFrom(f, F.documentRef),
        bankAccountId: g(f, F.bankAccountId), partyId: g(f, F.partyId) || undefined,
        fundingPartyId: g(f, F.fundingPartyId) || undefined,
        items, actor,
      })
    } else {
      // The single-amount shape, kept for callers written when there was one.
      const amountRaw = g(f, F.amount)
      if (!amountRaw) throw new QuickEntryError('NO_AMOUNT', 'How much? The amount is empty.')
      const typed = money(amountRaw, 'an amount of money')
      const code = g(f, F.taxCode)
      let amount = typed, gst = 0n, pst = 0n
      if (code) {
        const gstRaw = g(f, F.gst), pstRaw = g(f, F.pst)
        const t = rowTax(typed, code,
          parseTaxOverride(gstRaw), parseTaxOverride(pstRaw))
        amount = t.base; gst = t.gst; pst = t.pst
      } else {
        const gstRaw = g(f, F.gst)
        const pstRaw = g(f, F.pst)
        gst = gstRaw ? money(gstRaw, 'an amount of GST') : 0n
        pst = pstRaw ? money(pstRaw, 'an amount of PST') : 0n
      }
      posted = await postQuickEntry({
        ledgerId: g(f, F.ledgerId), kind: kind as QuickKind, entryDate, description,
        documentRef: documentRefFrom(f, F.documentRef),
        accountId: g(f, F.accountId), bankAccountId: g(f, F.bankAccountId),
        partyId: g(f, F.partyId) || undefined,
        fundingPartyId: g(f, F.fundingPartyId) || undefined,
        amount, gst, pst, actor,
      })
    }
    // The same bill, filed against the entry it became. After the posting,
    // never before: an entry that was refused leaves the reading unused and
    // ready to try again.
    let filed = ''
    if (readingId) {
      try {
        const { filed: onPaper } = await attachReadingTo({ ledgerId: g(f, F.ledgerId), readingId, entryId: posted.entry.id, actor })
        // A reading from a sentence alone has nothing to file; saying it was filed would send the person looking for it.
        filed = onPaper ? ' The document is filed against it.' : ' The reading is marked entered.'
      } catch (e) {
        // The entry IS posted. Returning an error here would say it was not,
        // and invite a second posting of the same bill; say what happened.
        filed = ` The document could not be filed against it (${sentenceOf(e)}); attach it from the entry by hand.`
        // A reading entered meanwhile, or gone, says what that means for the books — not "attach it by hand".
        if (e instanceof BillReadingError) filed = ` ${sentenceOf(e)}`
      }
    }
    // And the receipt the person had in their hand while they typed.
    const paper = await attachIfAny(f, {
      ledgerId: g(f, F.ledgerId), entryId: posted.entry.id, actor,
    })
    return { ok: `Posted as ${posted.entry.entryNo}.${filed}${paper}`, entryId: posted.entry.id }
  } catch (e) {
    if (e instanceof QuickEntryError) return { error: e.message }
    // The posting layer's and the database's refusals arrive as sentences too.
    const msg = e instanceof Error ? e.message : String(e)
    return { error: msg.split('\n')[0].slice(0, 200) }
  }
}

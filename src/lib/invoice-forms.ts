import 'server-only'
import { InvoiceTemplateError } from './invoice-templates'
import { ROLE } from './roles'
import {
  type FormResult,
  g,
  INVOICE_FIELDS as F, READING_FIELD, lineAccount, lineAmount, lineDescription, lineIndicesIn,
  lineTaxCode, lineGst, linePst,
  ATTACH_FIELD,
} from './forms'
import { BillReadingError, attachReadingTo, readingRefusal } from './bill-reading'
import { attachIfAny } from './attach-forms'
import { parseMoney } from './money'
import { TAX_CODES, computeEnteredTax, parseTaxOverride, type TaxCode, type TaxOverrides } from './tax-rates'
import { taxRoleAccount } from './quick'
import { editInvoice, deleteInvoice,
  InvoiceError, createInvoice, postInvoice,
  type Direction, type DocumentKind, type InvoiceLineInput,
} from './invoices'
import { refuseUnlessOurs } from './ours'
import { withDocumentWrite, EditConflict } from './edit-leases'
import type { EditContext } from './edit-proof'
import { db } from '@/db/client'
import type { Runner } from './acting'

/**
 * Reading the invoice screen.
 *
 * Separate from `app/actions.ts` for the reason `opening-forms.ts` is: a check
 * can call this and cannot call a server action. When the two live in one file,
 * what gets checked is a function the shipped page never runs.
 */

export type { FormResult }


/**
 * THE SIGN, which is the one conversion on this screen and the one thing that
 * can be silently backwards.
 *
 * The person types **what the line adds to the invoice** — 2,000 for work done,
 * −300 for a discount. Positive is the ordinary case on both kinds of document,
 * because nobody types a minus sign in front of every line of a bill.
 *
 * The ledger stores **what the line does to its account**, which is the
 * opposite for a sale (revenue is credited) and the same for a purchase (an
 * expense is debited). So the direction — not the typist — decides the sign:
 *
 *   sales    2,000 added  ->  −2,000 against revenue  ->  +2,000 debit to AR
 *   purchase   400 added  ->    +400 against expense  ->    −400 credit to AP
 *
 * The opening balance screen asks for signed figures instead, and that is not
 * an inconsistency: there, every account has a different normal side and the
 * sign is the information. Here every line of one document goes the same way,
 * and the direction already says which.
 */
/**
 * From "what this line adds to the document" to the ledger's signed cents —
 * the exact inverse of `asEnteredAmount`, keyed on the SAME pair. Keying on
 * direction alone was the defect that made every credit-note edit flip its
 * own signs and refuse itself: a sales credit note's lines debit where a
 * sales invoice's credit, and the kind is the only thing that says so.
 */
export function ledgerAmount(direction: Direction, kind: DocumentKind, addedToInvoice: bigint): bigint {
  const debitsControl = (direction === 'sales') === (kind === 'invoice')
  return debitsControl ? -addedToInvoice : addedToInvoice
}

export type ParsedLine = {
  index: number
  line: InvoiceLineInput
  /** What the person typed, in the as-entered sense — the tax base's raw material. */
  typed: bigint
  taxCode: TaxCode
  overrides?: TaxOverrides
  position?: number
}

/**
 * The lines, read from the rows that were filled in.
 *
 * A row with an account and no amount, or an amount and no account, is a
 * half-finished line and is refused by name — silently dropping it would post
 * an invoice for less than the screen showed.
 *
 * The rows read are the rows that ARRIVED. This used to loop to a fixed six,
 * which was fine while the form rendered exactly six and stopped being fine the
 * moment a person could add a seventh: the invoice would save, short by that
 * line, with every figure on it agreeing. `lineIndicesIn` is in `forms.ts`
 * beside the makers of the names it reads.
 *
 * `position` is where the row sat on screen, counting only the rows that came
 * back, so "Line 3" in an error means the third row the person is looking at.
 * The index in the field name is not that number once a row has been removed
 * from the middle — the form renumbers on render, but a reader that had
 * quietly kept the old numbering would point at the wrong row while sounding
 * certain.
 */
export function linesFrom(
  f: FormData, direction: Direction, kind: DocumentKind,
  nameOf: (accountId: string) => string,
): { lines: ParsedLine[]; error?: string } {
  const lines: ParsedLine[] = []
  const indices = lineIndicesIn(f.keys())

  for (let position = 0; position < indices.length; position++) {
    const i = indices[position]
    const n = position + 1
    const account = g(f, lineAccount(i))
    const rawAmount = g(f, lineAmount(i))
    const description = g(f, lineDescription(i))
    const gstRaw = g(f, lineGst(i)), pstRaw = g(f, linePst(i))

    if (!account && !rawAmount && !gstRaw && !pstRaw) continue

    if (!account) {
      return { lines: [], error: `Line ${n} has an amount but no account.` }
    }
    if (!rawAmount) {
      return { lines: [], error: `Line ${n} (${nameOf(account)}) has no amount.` }
    }

    // `parseMoney` throws on nonsense and returns 0n for several things that
    // are not amounts — '' and '.' among them. Both are refused here, by name
    // and naming the line: an amount silently read as zero is an invoice that
    // is short by exactly that line, and every total on the screen agrees with
    // it. The bank reader shipped that once, with a lone bracket reading 0.00.
    let added: bigint
    try {
      added = parseMoney(rawAmount)
    } catch {
      return { lines: [], error: `"${rawAmount}" on line ${n} is not an amount.` }
    }
    if (added === 0n) {
      return {
        lines: [],
        error: `Line ${n} (${nameOf(account)}) is for nothing — "${rawAmount}" reads as zero.`,
      }
    }

    const taxCode = (g(f, lineTaxCode(i)) || 'OUT_OF_SCOPE') as TaxCode
    if (!TAX_CODES.some((t) => t.code === taxCode)) {
      return { lines: [], error: `"${taxCode}" on line ${n} is not a tax tag this ledger knows.` }
    }
    let overrides: TaxOverrides
    try {
      overrides = {
        gst: parseTaxOverride(gstRaw),
        pst: parseTaxOverride(pstRaw),
      }
    } catch { return { lines: [], error: `GST or PST on line ${n} is not an amount with at most two decimals.` } }
    lines.push({
      index: i,
      position: n,
      typed: added,
      taxCode,
      overrides,
      line: {
        accountId: account,
        amount: ledgerAmount(direction, kind, added),
        description: description || undefined,
        taxCode,
      },
    })
  }

  return { lines }
}

/**
 * Turn tagged, typed lines into the rows the document stores — resident tax
 * computation, ONE arithmetic (computeTax) shared with the quick forms.
 *
 * Sales: each line stores its base; the taxes aggregate into generated lines
 * on the role-picked accounts (collected, so payable). Purchase: GST
 * aggregates onto the recoverable account; PST FOLDS INTO EACH LINE — in BC
 * it is not claimable, the thing simply cost that much. Inclusive mode backs
 * the base out of each typed amount first. Discounts (negative lines) carry
 * negative tax, shrinking the aggregates — a discount refunds its tax too.
 */
export async function resolveTaggedLines(
  ledgerId: string, direction: Direction, kind: DocumentKind,
  parsed: ParsedLine[], inclusive: boolean,
  /** The day the document is dated — the rates in force then are the ones applied. */
  issuedOn: string,
  on: Runner = db,
): Promise<{ lines: InvoiceLineInput[]; error?: string }> {
  let gst = 0n
  let pst = 0n
  const out: InvoiceLineInput[] = []
  for (const p of parsed) {
    let t: ReturnType<typeof computeEnteredTax>
    try { t = computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, p.overrides) }
    catch (e) { return { lines: [], error: `Line ${p.position ?? p.index + 1}: ${e instanceof Error ? e.message : 'Invalid tax amount.'}` } }
    gst += t.gst
    pst += t.pst
    const entered = direction === 'purchase'
      ? t.base + t.pst   // the fold
      : t.base
    out.push({ ...p.line, amount: ledgerAmount(direction, kind, entered),
      inputAmount: p.typed, inputInclusive: inclusive,
      gstOverride: p.overrides?.gst, pstOverride: p.overrides?.pst })
  }
  if (gst !== 0n) {
    const [acct] = await taxRoleAccount(ledgerId,
      direction === 'sales' ? ROLE.gstPayable : ROLE.gstRecoverable, on)
    if (!acct) {
      return { lines: [], error: `A line is tagged GST but no account carries the `
        + `${direction === 'sales' ? ROLE.gstPayable : ROLE.gstRecoverable} role — `
        + `register in the sales tax module first.` }
    }
    out.push({ accountId: acct.id, amount: ledgerAmount(direction, kind, gst),
               description: 'GST', taxCode: 'OUT_OF_SCOPE', generatedFor: 'GST' })
  }
  if (pst !== 0n && direction === 'sales') {
    const [acct] = await taxRoleAccount(ledgerId, 'qst_pst_payable', on)
    if (!acct) {
      return { lines: [], error: 'A line is tagged PST but no account carries the '
        + 'qst_pst_payable role — register for PST in the sales tax module first.' }
    }
    out.push({ accountId: acct.id, amount: ledgerAmount(direction, kind, pst),
               description: 'PST', taxCode: 'OUT_OF_SCOPE', generatedFor: 'PST' })
  }
  return { lines: out }
}

async function attempt<T>(run: () => Promise<T>, ok: string,
                          okFor?: (result: T) => string | undefined): Promise<FormResult> {
  try {
    const result = await run()
    return { ok: okFor?.(result) ?? ok, ...(result && typeof result === 'object' && 'version' in result ? {version:String(result.version)} : {}) }
  } catch (e) {
    if (e instanceof InvoiceError || e instanceof InvoiceTemplateError || e instanceof EditConflict) return { error: e.message }
    // The posting layer's refusals are sentences too (PERIOD_CLOSED and kin).
    if (e instanceof Error && e.name === 'PostingError') return { error: e.message }
    throw e
  }
}

export async function createInvoiceFromForm(
  f: FormData, nameOf: (accountId: string) => string, actor: string,
): Promise<FormResult> {
  const direction = (g(f, F.direction) || 'sales') as Direction
  // The KIND comes from the form too. The first version hardcoded 'invoice'
  // here while the field existed and the edit reader honoured it — so a
  // credit note created through this reader silently became an invoice,
  // debited the receivable, and was found only when its application was
  // refused. The seed company tripped it on day one.
  const kind = (g(f, F.kind) || 'invoice') as DocumentKind
  const { lines, error } = linesFrom(f, direction, kind, nameOf)
  if (error) return { error }
  if (lines.length === 0) {
    return { error: 'Nothing on it yet. Add at least one line saying what it is for.' }
  }

  // Open books: saving IS entering the books — no separate post step. A
  // refusal from the posting half leaves the created draft visible in the
  // list, where it can be fixed or deleted; nothing is silently half-done.
  const resolved = await resolveTaggedLines(
    g(f, F.ledgerId), direction, kind, lines, g(f, F.amounts) === 'inclusive', g(f, F.issuedOn))
  if (resolved.error) return { error: resolved.error }

  // The bill this form was filled in from (0064), looked at BEFORE the
  // posting: gone or already entered refuses the form while nothing is in
  // the books yet — refusing after would leave the bill and invite a second.
  const readingId = g(f, READING_FIELD)
  if (readingId) {
    const why = await readingRefusal(g(f, F.ledgerId), readingId)
    if (why) return { error: why }
  }
  return attempt(async () => {
    const inv = await createInvoice({
      ledgerId: g(f, F.ledgerId),
      direction,
      kind,
      partyId: g(f, F.partyId),
      controlAccountId: g(f, F.controlAccountId),
      issuedOn: g(f, F.issuedOn),
      dueOn: g(f, F.dueOn),
      number: g(f, F.number) || undefined,
      theirRef: g(f, F.theirRef) || undefined,
      note: g(f, F.note) || undefined,
      template: g(f, F.template) || undefined,
      lines: resolved.lines,
      actor,
    })
    const posted = await postInvoice(inv.id, actor)
    // The bill this form was filled in from, filed against the entry the
    // document raised (0064) — after the posting, never before: a refused
    // posting leaves the reading unused and ready to try again. And a bill
    // that could not be filed is still a saved bill: an error here would
    // say otherwise and invite a second one.
    const paper = await attachIfAny(f, {
      ledgerId: g(f, F.ledgerId), entryId: posted.entryId, actor,
    })
    if (!readingId) return paper
    try {
      const { filed } = await attachReadingTo({ ledgerId: g(f, F.ledgerId), readingId, entryId: posted.entryId, actor })
      return filed ? `${paper} The document is filed against its entry.` : `${paper} The reading is marked entered.`
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 160)
      // A reading entered meanwhile, or gone, says what that means for the books — not "attach it by hand".
      if (e instanceof BillReadingError) return `${paper} ${why}`
      return `${paper} The document could not be filed against it (${why}); attach it from the entry by hand.`
    }
  }, 'Saved to the books.', (note) => `Saved to the books.${note}`)
}

/** Edit a live invoice: same fields, same line reader, its own door. */
export async function updateInvoiceFromForm(
  f: FormData, nameOf: (accountId: string) => string, actor: string, context?: EditContext,
): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['invoice', g(f, F.invoiceId)]], g(f, F.ledgerId))
  if (nope) return nope
  const direction = (g(f, F.direction) || 'sales') as Direction
  // The KIND is identity: the edit form carries the document's own, because
  // the sign of every line depends on it — a credit note's lines run the
  // other way from an invoice's in the same direction.
  const kind = (g(f, F.kind) || 'invoice') as DocumentKind
  const { lines, error } = linesFrom(f, direction, kind, nameOf)
  if (error) return { error }
  if (lines.length === 0) {
    return { error: 'Nothing on it yet. Add at least one line saying what it is for.' }
  }
  const resolved = await resolveTaggedLines(
    g(f, F.ledgerId), direction, kind, lines, g(f, F.amounts) === 'inclusive', g(f, F.issuedOn))
  if (resolved.error) return { error: resolved.error }

  return attempt(async () => {
    const command = (on: Runner, who: string) => editInvoice(g(f, F.invoiceId), {
      partyId: g(f, F.partyId),
      controlAccountId: g(f, F.controlAccountId),
      issuedOn: g(f, F.issuedOn),
      dueOn: g(f, F.dueOn),
      number: g(f, F.number) || undefined,
      theirRef: g(f, F.theirRef) || undefined,
      note: g(f, F.note) || undefined,
      template: g(f, F.template) || undefined,
      lines: resolved.lines,
      actor: who,
    }, on)
    const r = context ? await withDocumentWrite({ledgerId:g(f,F.ledgerId),type:'invoice',id:g(f,F.invoiceId)},context,command)
      : await command(db,actor)
    // The paper, at THIS door too. The edit form offers the same file box as
    // the create form — it is the same component — and until now nothing read
    // it: a person picked a file, got "Save changes", and the file was
    // dropped without a word (critic, 2026-09-07).
    const upload = f.get(ATTACH_FIELD)
    const paper = r.entryId
      ? await attachIfAny(f, { ledgerId: g(f, F.ledgerId), entryId: r.entryId, actor })
      : upload instanceof File && upload.size > 0 ? ' The file was not attached. Post this draft first, then attach it.' : ''
    return { ...r, paper }
  }, 'Saved. The entry moved with it.',
     (r) => r.cascadedApplications > 0
       ? `Saved. ${r.cascadedApplications} payment application(s) were released back to on-account — re-apply what still fits.${r.paper}`
       : r.entryId ? `Saved. The entry moved with it.${r.paper}` : `Draft saved. Review and post when ready.${r.paper}`)
}

export async function deleteInvoiceFromForm(f: FormData, actor: string, context?: EditContext): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['invoice', g(f, F.invoiceId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(async () => context ? withDocumentWrite({ledgerId:g(f,F.ledgerId),type:'invoice',id:g(f,F.invoiceId)},context,(tx,who)=>deleteInvoice(g(f,F.invoiceId),who,tx)) : deleteInvoice(g(f,F.invoiceId),actor),
    'Deleted. The number stays retired; the audit log keeps the document.',
    (r) => r.cascadedApplications > 0
      ? `Deleted. ${r.cascadedApplications} payment application(s) were released back to on-account.`
      : undefined)
}

export async function postInvoiceFromForm(f: FormData, actor: string, context?: EditContext): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['invoice', g(f, F.invoiceId)]], g(f, F.ledgerId))
  if (nope) return nope
  return attempt(() => context ? withDocumentWrite({ledgerId:g(f,F.ledgerId),type:'invoice',id:g(f,F.invoiceId)},context,(tx,who)=>postInvoice(g(f,F.invoiceId),who,tx)) : postInvoice(g(f,F.invoiceId),actor), 'Posted.')
}

/**
 * Invoices: one document type, two directions, one door into the ledger.
 *   npm run db:verify-invoices   (resets the database first)
 *
 * The claims this suite exists to make earned:
 *
 *   a sales invoice and a purchase bill are one table with a direction
 *   an invoice PRODUCES a journal entry; it is not one
 *   the party is named on the control line and nowhere else
 *   posted means frozen — correct it by voiding and issuing another
 *   nothing here holds a balance
 */
import './env'
import { errorText, expectCode, expectDbRefusal, reporter } from './suite'
// The attachment store for this run is a scratch directory, set BEFORE the
// lib is ever called: the create doors now file paper, and the dev store must
// never be touched by a suite.
import nodePath from 'node:path'
import nodeOs from 'node:os'
import { mkdtempSync as mkTemp } from 'node:fs'
process.env.ATTACHMENTS_DIR = mkTemp(nodePath.join(nodeOs.tmpdir(), 'erp-inv-'))
import { byHand } from './by-hand'
import { trailNamesPeople } from './actor-trail'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { createAccount, importAccounts, parseAccountsCsv, setAccountRoles } from '../src/lib/accounts'
import { attachmentsOf } from '../src/lib/attachments'
import { createParty } from '../src/lib/parties'
import { amendEntry, reverseEntry } from '../src/lib/posting'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  ATTACH_FIELD, INVOICE_FIELDS as F, INVOICE_LINE_SLOTS, lineAccount, lineAmount, lineDescription,
  lineIndicesIn,
} from '../src/lib/forms'
import {
  addRow, editRow, moveRow, moveRowTo, removeRow, typedTotal, type RowState,
} from '../src/lib/invoice-rows'
import { IconButton } from '../src/components/IconButton'
import { InvoiceLinesContent } from '../src/app/ledger/[ledgerId]/invoices/InvoiceLines'
import { formatMoney, parseMoney } from '../src/lib/money'
import { stringify } from './json-bigint'
import {
  createInvoiceFromForm, deleteInvoiceFromForm, ledgerAmount, linesFrom, resolveTaggedLines, updateInvoiceFromForm, postInvoiceFromForm,
} from '../src/lib/invoice-forms'
import {
  controlMovementOf, createInvoice, deleteInvoice, editInvoice,
  invoiceDetail, invoicesFor, lineAccountsFor, movesTheRightWay, postInvoice,
  totalOf, voidInvoice, type Direction, type DocumentKind,
} from '../src/lib/invoices'
import { entriesByParty, partyLedger } from '../src/lib/browse'
import { documentNumber } from '../src/lib/doc-number'
import { recordPayment, balanceOf, openItemsFor } from '../src/lib/payments'
import { gstHstReturn } from '../src/lib/tax'

const CHART = `1000,Cash,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
1210,Other Receivable,asset,,other_receivables
2000,Accounts Payable,liability,,trade_payables
2300,GST/HST Collected,liability,,gst_hst_payable
2310,GST/HST Recoverable,asset,,gst_hst_recoverable
2350,PST Payable,liability,,qst_pst_payable
3000,Share Capital,equity,,share_capital
4000,Consulting Revenue,revenue,,revenue_from_contracts
5000,Subcontractors,expense,,other_operating_expenses`

const r = reporter(56)
const { fail, check } = r

/** A door that throws marks its check red instead of killing the suite —
 *  a mutated tree refuses loudly, and a dead suite records nothing. */
const tryDoor = async <T,>(label: string, run: () => Promise<T>): Promise<T | null> => {
  try { return await run() } catch (e) {
    fail(label, `it threw: ${(e as Error).message.slice(0, 80)}`)
    return null
  }
}

/**
 * Every element in a rendered tree, itself included.
 *
 * `InvoiceLinesContent` receives its rows, setter and drag bindings as props,
 * which is what makes this possible: the component can be CALLED, and what
 * comes back is a tree of plain objects whose `onClick` props are the real
 * closures the browser would run. So a check can press a button.
 *
 * That matters because everything else about this screen is read rather than
 * exercised. A review found the hole exactly: `data-acts-on` and the `onClick`
 * beside it were two separate expressions, so a check comparing the marker to
 * the row was comparing `row.key` with `row.key` and would stay green while the
 * handler acted on a position. Both sides spelled the same, which this project
 * has already written down as not being a check.
 */
type ElementProps = Record<string, unknown> & {
  children?: unknown
  onClick?: () => void
  onChange?: (arg: unknown) => void
}
type RenderedElement = { type: unknown; props: ElementProps }

function* elements(node: unknown): Generator<RenderedElement> {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) yield* elements(n); return }
  const el = node as { type?: unknown; props?: ElementProps }
  if (!el.props) return
  if (el.type === IconButton && typeof el.props.label === 'string' && typeof el.props.icon === 'string') {
    yield* elements(IconButton(el.props as unknown as Parameters<typeof IconButton>[0])); return
  }
  yield el as RenderedElement
  yield* elements(el.props.children)
}

/** The row elements of a rendered line editor, each with its own buttons. */
function editorRows(state: RowState, setState: (s: RowState) => void) {
  const tree = InvoiceLinesContent({ state, setState, lineAccounts: [], fieldClass: '', drag: {
    containerRef: { current: null }, helpId: 'test-line-order', message: '', isDragging: false,
    handleProps: () => ({}), rowProps: key => ({ 'data-sort-row': key,
      'data-sort-dragging': undefined, 'data-sort-before': undefined, 'data-sort-after': undefined }),
  } })
  const all = [...elements(tree)]
  return {
    all,
    rows: all.filter((e) => e.props['data-line-row'] !== undefined).map((row) => ({
      /** What the ROW div says it is. */
      declares: row.props['data-line-row'] as number,
      /**
       * What a BUTTON in this row says it acts on. A different attribute on a
       * different element from `declares`, and that is the point: `V92b` used
       * to read `declares` while its label said `data-acts-on`, so changing
       * every button's `data-acts-on` to the position left it green.
       */
      actsOn: (does: string) =>
        [...elements(row)].find((e) => e.type === 'button' && e.props['data-does'] === does)
          ?.props['data-acts-on'] as number | undefined,
      fieldNames: [...elements(row)].filter((e) => typeof e.props.name === 'string')
        .map((e) => e.props.name as string),
      button: (does: string) =>
        [...elements(row)].find((e) => e.type === 'button' && e.props['data-does'] === does)!,
      field: (name: string) =>
        [...elements(row)].find((e) => e.props.name === name),
    })),
  }
}

type LineRowMarkup = {
  key: string
  fieldIndices: string[]
  buttons: Array<{ actsOn: string | null; does: string | null; label: string; disabled: boolean }>
}

const expectDbError = expectDbRefusal(r, { passSlice: 78, failSlice: 140 })

const expectError = expectCode(r, { passSlice: 76, failText: (e) => errorText(e).slice(0, 90), sayingSlice: 70 })

async function main() {
  const co = await createCompany({ code: 'INV', name: 'Invoicing Inc.' }, 'alicio@example.test')
  await createFiscalYear(co.ledger.id, '2026-12-31', 'alicio@example.test')
  const accounts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const at = (code: string) => accounts.find((a) => a.code === code)!

  const customer = await createParty({
    kind: 'organisation', name: 'Northwind Ltd.',
    roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }],
    actor: 'alicio@example.test',
  })
  const supplier = await createParty({
    kind: 'organisation', name: 'Ironbark Supply Co.',
    roles: [{ entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
    actor: 'alicio@example.test',
  })

  const salesLines = [{ accountId: at('4000').id, amount: -150000n, description: 'March work' }]

  // ------------------------------------------------------------ the total --

  {
    // Two questions, deliberately separate. What the DOCUMENT says is positive
    // either way — nobody is sent a bill for minus four hundred dollars. Which
    // way the CONTROL ACCOUNT moves is signed, and the sign is what says which
    // kind of document it is: a receivable is debited, a payable is credited.
    const purchaseLines = [{ accountId: at('5000').id, amount: 40000n }]
    check(totalOf(salesLines, 'sales') === 150000n
          && totalOf(purchaseLines, 'purchase') === 40000n,
      'V01 what the document says is positive either way',
      `sales ${totalOf(salesLines, 'sales')}, purchase ${totalOf(purchaseLines, 'purchase')}`)

    check(controlMovementOf(salesLines) === 150000n
          && controlMovementOf(purchaseLines) === -40000n
          && movesTheRightWay('sales', 150000n) && movesTheRightWay('purchase', -40000n)
          && !movesTheRightWay('sales', -1n) && !movesTheRightWay('purchase', 1n),
      'V01b while the control account moves the way the direction says',
      `sales ${controlMovementOf(salesLines)}, purchase ${controlMovementOf(purchaseLines)}`)

    await expectError('V02 an invoice with no lines is refused', 'NO_LINES', () =>
      createInvoice({
        ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
        controlAccountId: at('1200').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
        lines: [], actor: 'alicio@example.test',
      }))

    await expectError('V03 and one due before it was issued', 'DUE_BEFORE_ISSUE', () =>
      createInvoice({
        ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
        controlAccountId: at('1200').id, issuedOn: '2026-03-31', dueOn: '2026-03-01',
        lines: salesLines, actor: 'alicio@example.test',
      }), '2026-03-01')

    // Lines that move the control account the WRONG WAY for this kind of
    // document. On a sales invoice that is a credit note; on a purchase bill it
    // is a supplier credit. Both are real documents with different rules and
    // neither is built — posting one through here would put the money on the
    // wrong side and read as an ordinary invoice afterwards.
    await expectError('V04 a sales invoice whose lines net to a credit is refused',
      'WRONG_WAY', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
          controlAccountId: at('1200').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
          lines: [{ accountId: at('4000').id, amount: 5000n }], actor: 'alicio@example.test',
        }), 'credit note')

    // The pair, and the half that would have been missed: the rule is not
    // "the total must be positive". A purchase bill's control movement is
    // NEGATIVE and correct; what is refused is the opposite of whichever way
    // this direction should go.
    await expectError('V04b and so is a purchase bill whose lines net to a debit',
      'WRONG_WAY', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
          controlAccountId: at('2000').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
          lines: [{ accountId: at('5000').id, amount: -5000n }], actor: 'alicio@example.test',
        }))
  }

  // ------------------------------------------------- the control account --

  {
    // A sales invoice landing in an expense account balances and is nonsense.
    // The ROLE says which accounts are receivables, not the code.
    await expectDbError('V05 a sales invoice must land in trade receivables',
      'INVOICE_CONTROL_ROLE', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
          controlAccountId: at('5000').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
          lines: salesLines, actor: 'alicio@example.test',
        }))

    // The pair, and the discriminating half: 1210 is a receivable and an ASSET,
    // so a check that only looked at the account type would let it through.
    // It is not tagged `trade_receivables`, which is what the rule asks.
    await expectDbError('V06 and not merely in something receivable-shaped',
      'INVOICE_CONTROL_ROLE', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
          controlAccountId: at('1210').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
          lines: salesLines, actor: 'alicio@example.test',
        }))

    await expectDbError('V07 a purchase bill must land in trade payables',
      'INVOICE_CONTROL_ROLE', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
          controlAccountId: at('1200').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
          lines: [{ accountId: at('5000').id, amount: 40000n }], actor: 'alicio@example.test',
        }))
  }

  // ------------------------------------------------------------- posting --

  let salesInvoiceId = ''
  {
    const inv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
      number: 'INV-001', lines: salesLines, actor: 'alicio@example.test',
    })
    salesInvoiceId = inv.id
    check(inv.status === 'draft' && inv.entry_id === null,
      'V08 a new invoice is a draft and has produced nothing yet', inv.status)

    const posted = await postInvoice(inv.id, 'alicio@example.test')
    check(posted.total === 150000n && posted.entryNo?.startsWith('INV-') === true,
      'V09 posting it produces one journal entry, numbered by its door',
      `${posted.entryNo}, ${posted.total}`)

    const [entry] = await db.execute<{
      source_type: string; source_id: string | null; lines: string; total: bigint
    }>(raw`
      SELECT e.source_type, e.source_id::text,
             count(jl.*)::text AS lines, coalesce(sum(jl.amount), 0)::bigint AS total
        FROM journal_entry e JOIN journal_line jl ON jl.entry_id = e.id
       WHERE e.id = ${posted.entryId}::uuid
       GROUP BY e.source_type, e.source_id`)
    check(entry.source_type === 'ar_invoice' && entry.source_id === inv.id
          && entry.lines === '2' && entry.total === 0n,
      'V10 that knows which invoice it came from, and balances',
      `${entry.source_type} ${entry.source_id?.slice(0, 8)}, ${entry.lines} lines`)

    // The party is on the CONTROL line only. On every line, any per-party
    // figure read off the ledger would be double what it should be.
    const named = await db.execute<{ code: string; party: string | null; amount: bigint }>(raw`
      SELECT a.code, jl.party_id::text AS party, jl.amount
        FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${posted.entryId}::uuid ORDER BY a.code`)
    const withParty = named.filter((l) => l.party !== null)
    check(withParty.length === 1 && withParty[0].code === '1200'
          && withParty[0].amount === 150000n,
      'V11 with the party on the control line and nowhere else',
      named.map((l) => `${l.code}${l.party ? '*' : ''} ${l.amount}`).join(' '))
  }

  // ----------------------------------------------------- posted is frozen --

  {
    await expectError('V12 posting it twice is refused', 'ALREADY_POSTED', () =>
      postInvoice(salesInvoiceId, 'alicio@example.test'))

    await expectDbError('V13 a posted invoice bounces raw SQL', 'INVOICE_RAW_SQL', () =>
      byHand((tx) => tx.execute(raw`
        UPDATE invoice SET due_on = '2026-06-30' WHERE id = ${salesInvoiceId}::uuid`)))

    await expectDbError('V14 and so do its lines', 'INVOICE_RAW_SQL', () =>
      db.execute(raw`
        UPDATE invoice_line SET amount = -1 WHERE invoice_id = ${salesInvoiceId}::uuid`))

    await expectDbError('V15 and so does a raw delete', 'INVOICE_RAW_SQL', () =>
      byHand((tx) => tx.execute(raw`DELETE FROM invoice WHERE id = ${salesInvoiceId}::uuid`)))

    // The pair: a DRAFT is editable and deletable, so the guard is about being
    // posted and not about refusing every change.
    const scratch = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-04-01', dueOn: '2026-04-30',
      lines: salesLines, actor: 'alicio@example.test',
    })
    await byHand((tx) => tx.execute(raw`
      UPDATE invoice SET due_on = '2026-05-15' WHERE id = ${scratch.id}::uuid`))
    await byHand((tx) => tx.execute(raw`DELETE FROM invoice WHERE id = ${scratch.id}::uuid`))
    const [gone] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM invoice WHERE id = ${scratch.id}::uuid`)
    check(gone.n === '0', 'V16 while a draft can be changed and thrown away', 'deleted')
  }

  // ------------------------------------------------- pointing at an entry --

  {
    // `entry_id` must be the entry this invoice produced. Otherwise it is a
    // hint, and the aging — which reads the LEDGER — would put a debt against
    // the wrong party while both documents looked right on their own.
    const other = await createInvoice({
      ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
      controlAccountId: at('2000').id, issuedOn: '2026-03-05', dueOn: '2026-04-05',
      lines: [{ accountId: at('5000').id, amount: 40000n }],
      actor: 'alicio@example.test',
    })
    const otherPosted = await postInvoice(other.id, 'alicio@example.test')

    const [salesEntry] = await db.execute<{ id: string }>(raw`
      SELECT entry_id::text AS id FROM invoice WHERE id = ${salesInvoiceId}::uuid`)

    // Reaching this guard takes some care, and the care is the point: two
    // earlier defences stand in front of it. Setting `entry_id` on a draft
    // fails the table's own CHECK — posted and having an entry are the same
    // fact — and setting it on a posted invoice is refused by V13's guard. The
    // one way through is claiming both at once on a draft, which is what a
    // hand-written repair would look like.
    const claimant = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-03-02', dueOn: '2026-04-02',
      lines: salesLines, actor: 'alicio@example.test',
    })
    await expectDbError('V17 an invoice cannot claim another invoice\'s entry',
      'INVOICE_ENTRY_MISMATCH', () =>
        byHand((tx) => tx.execute(raw`
          UPDATE invoice SET status = 'posted', entry_id = ${salesEntry.id}::uuid
           WHERE id = ${claimant.id}::uuid`)))

    // The defence in front of it, on its OWN draft. Sharing `claimant` meant
    // that when a mutation switched off the guard above, the claim succeeded,
    // `claimant` became posted, and this check then met a different refusal —
    // failing for a reason that had nothing to do with what it asks.
    const another = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-03-03', dueOn: '2026-04-03',
      lines: salesLines, actor: 'alicio@example.test',
    })
    // The needle is the constraint's FULL name. It used to be `invoice_check`,
    // which is a different constraint — the due-date one — and happens to be a
    // prefix of this one's auto-generated `invoice_check1`. The check passed by
    // substring, and would have passed just as well if the statement had
    // tripped the due date instead. 0029 names both constraints so the two
    // cannot be confused again.
    await expectDbError('V17b while a draft cannot hold an entry at all',
      'invoice_posted_has_entry', () =>
        byHand((tx) => tx.execute(raw`
          UPDATE invoice SET entry_id = ${salesEntry.id}::uuid
           WHERE id = ${another.id}::uuid`)))

    check(otherPosted.total === 40000n,
      'V18 a purchase bill posts the same way, the other way round', `${otherPosted.total}`)

    const [payable] = await db.execute<{ amount: bigint; party: string | null }>(raw`
      SELECT jl.amount, jl.party_id::text AS party
        FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${otherPosted.entryId}::uuid AND a.code = '2000'`)
    check(payable.amount === -40000n && payable.party === supplier.id,
      'V19 with the payable credited and the supplier named on it',
      `${payable.amount}, party ${payable.party?.slice(0, 8)}`)
  }

  // ------------------------------------------------------- what is absent --

  {
    // The design says an invoice holds no balance. That is a claim about what
    // does NOT exist, so it is checked by looking.
    const cached = await db.execute<{ name: string }>(raw`
      SELECT table_name || '.' || column_name AS name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'invoice%'
         AND (column_name LIKE '%paid%' OR column_name LIKE '%balance%'
              OR column_name LIKE '%outstanding%' OR column_name LIKE '%total%')`)
    check(cached.length === 0,
      'V20 an invoice holds no balance — the ledger answers what is still owed',
      cached.map((c) => c.name).join(', ') || 'no such column on invoice or invoice_line')

    // And the number the list shows is computed from the lines, not stored.
    const list = await invoicesFor(co.ledger.id, 'sales')
    const one = list.find((i) => i.number === 'INV-001')
    check(one?.total === 150000n,
      'V21 and the total on the list is computed from the lines', `${one?.total}`)

    const detail = await invoiceDetail(salesInvoiceId)
    check(detail?.total === 150000n && detail.lines.length === 1,
      'V22 as is the one on the invoice itself', `${detail?.total}, ${detail?.lines.length} line`)
  }

  // ---------------------------------------------- the party rule still holds --

  {
    // Two rules, at two levels, and the difference matters.
    //
    // The LEDGER's rule (0025/0026) says a journal line's party must hold SOME
    // transacting role. That is right for a ledger: a line does not know
    // whether it is a sale or a purchase.
    //
    // The INVOICE's rule (0030) says a sales invoice goes to a CUSTOMER. That
    // one was missing, and the screen renders customers and suppliers into one
    // select as two groups — so a supplier was one click away on a sales
    // invoice, and it posted, because `supplier` satisfies the ledger.
    const director = await createParty({
      kind: 'organisation', name: 'Unknown Party Ltd.',
      roles: [{ entityId: co.company.id, role: 'director', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    await expectDbError('V23 an invoice to someone who is not a customer here is refused',
      'INVOICE_PARTY_ROLE', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', partyId: director.id,
          controlAccountId: at('1200').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
          lines: salesLines, actor: 'alicio@example.test',
        }))

    // And refused at CREATION, not at posting — nothing is left sitting in the
    // list to be discovered later.
    const [leftBehind] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM invoice WHERE party_id = ${director.id}::uuid`)
    check(leftBehind.n === '0',
      'V24 with no draft left behind to be found later', `${leftBehind.n} invoices`)

    // THE case the screen makes easy: a real supplier, on a sales invoice. The
    // ledger would have allowed it — `supplier` is a transacting role — so this
    // is the half only the invoice rule catches. The message says what they are
    // here, because "not a customer" beside a list that offered them is not a
    // sentence anybody can act on.
    await expectDbError('V24b and so is a supplier on a sales invoice, saying what they are',
      'they are supplier here', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', partyId: supplier.id,
          controlAccountId: at('1200').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
          lines: salesLines, actor: 'alicio@example.test',
        }))

    // The pair, both ways round: each direction accepts its own kind.
    const okSale = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
      lines: salesLines, actor: 'alicio@example.test',
    })
    const okBill = await createInvoice({
      ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
      controlAccountId: at('2000').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
      lines: [{ accountId: at('5000').id, amount: 10000n }], actor: 'alicio@example.test',
    })
    check(okSale.id !== '' && okBill.id !== '',
      'V24c while a customer on a sale and a supplier on a bill both go through',
      'both created')

    // A relationship that ended before the invoice date is refused too — the
    // date is the invoice's own, not today's.
    const former = await createParty({
      kind: 'organisation', name: 'Former Customer Ltd.',
      roles: [{ entityId: co.company.id, role: 'customer',
                heldFrom: '2026-01-01', heldTo: '2026-02-28' }],
      actor: 'alicio@example.test',
    })
    await expectDbError('V24d and one whose customer relationship had already ended',
      'INVOICE_PARTY_ROLE', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', partyId: former.id,
          controlAccountId: at('1200').id, issuedOn: '2026-03-01', dueOn: '2026-03-31',
          lines: salesLines, actor: 'alicio@example.test',
        }))
  }

  // -------------------------------------------------- more than one line --

  {
    // Every fixture above has exactly one line, so nothing had exercised the
    // shape the design actually describes: one control line plus one entry line
    // PER invoice line, in order, each carrying its own description and
    // dimensions and none carrying the party.
    //
    // The lines straddle zero on purpose — a discount is a line the other way —
    // so "the control movement is the opposite of their sum" is tested against
    // an invoice where that is not the same as "the opposite of one number".
    // One line carries a dimension and the others do not, so `V35b` can tell
    // "carried through" from "put on everything".
    // The ledger refuses a dimension nobody declared (`NO_DIMENSION`), which is
    // right and is why this has to be set up rather than made up.
    await db.execute(raw`
      INSERT INTO dimension (entity_id, code, name)
      VALUES (${co.company.id}::uuid, 'project', 'Project')`)
    await db.execute(raw`
      INSERT INTO dimension_value (dimension_id, code, name)
      SELECT id, 'NORTHWIND-1', 'Northwind, first engagement'
        FROM dimension WHERE entity_id = ${co.company.id}::uuid AND code = 'project'`)

    const many = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-06-01', dueOn: '2026-06-30',
      number: 'INV-MANY', actor: 'alicio@example.test',
      lines: [
        { accountId: at('4000').id, amount: -200000n, description: 'April work',
          dimensions: { project: 'NORTHWIND-1' } },
        { accountId: at('4000').id, amount: -50000n, description: 'Expenses recharged' },
        { accountId: at('4000').id, amount: 30000n, description: 'Goodwill discount' },
      ],
    })
    const posted = await postInvoice(many.id, 'alicio@example.test')
    check(posted.total === 220000n,
      'V33 an invoice of several lines totals what they come to, discount and all',
      `${posted.total}`)

    const entryLines = await db.execute<{
      line_no: number; code: string; amount: bigint; description: string | null
      party: string | null
    }>(raw`
      SELECT jl.line_no, a.code, jl.amount, jl.description, jl.party_id::text AS party
        FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${posted.entryId}::uuid ORDER BY jl.line_no`)
    check(entryLines.length === 4
          && entryLines[0].code === '1200' && entryLines[0].amount === 220000n,
      'V34 producing one control line and one per invoice line, control first',
      entryLines.map((l) => `${l.code}:${l.amount}`).join(' '))

    // The order the lines were given, kept. A per-line description landing on
    // the wrong line is invisible in every total.
    check(entryLines[1].description === 'April work'
          && entryLines[2].description === 'Expenses recharged'
          && entryLines[3].description === 'Goodwill discount',
      'V35 each keeping its own description, in the order they were given',
      entryLines.slice(1).map((l) => l.description).join(' | '))

    // The comment above used to claim dimensions were covered here. They were
    // not — no fixture set one, and `dimensions` appeared nowhere else in this
    // file. Now the first line carries one and only that line does.
    const dims = await db.execute<{ line_no: number; dimensions: Record<string, string> }>(raw`
      SELECT line_no, dimensions FROM journal_line
       WHERE entry_id = ${posted.entryId}::uuid ORDER BY line_no`)
    check(dims[1].dimensions.project === 'NORTHWIND-1'
          && Object.keys(dims[0].dimensions).length === 0
          && Object.keys(dims[2].dimensions).length === 0,
      'V35b and its own dimensions, which only the line that had them carries',
      dims.map((d) => `${d.line_no}:${JSON.stringify(d.dimensions)}`).join(' '))

    // "Nowhere else" over more than one non-control line, which is what the
    // single-line fixture could not establish.
    check(entryLines.filter((l) => l.party !== null).length === 1
          && entryLines[0].party === customer.id,
      'V36 and still only the control line names the party',
      `${entryLines.filter((l) => l.party !== null).length} of ${entryLines.length}`)
  }

  // ------------------------------------- and it keeps saying it afterwards --

  {
    // 0028 enforced each rule where the row it was about got written. Three of
    // them did not survive operations this system offers — the same question
    // 0026 answered for parties, asked again here.
    const inv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-05-01', dueOn: '2026-05-31',
      number: 'INV-KEEP', lines: salesLines, actor: 'alicio@example.test',
    })
    const live = await postInvoice(inv.id, 'alicio@example.test')

    // 1 — the control account losing the role that made it one. `setAccountRoles`
    //     deletes every role and re-inserts, so this is not a hand-written
    //     DELETE; it is what the accounts screen does.
    await expectDbError('V25 the control account cannot lose the role that made it one',
      'CONTROL_ROLE_STILL_NEEDED', () => setAccountRoles(at('1200').id, [], 'alicio@example.test'))

    // The pair, and the reason the trigger is DEFERRED: `setAccountRoles` deletes
    // every role and re-inserts, so the role is momentarily gone in the middle
    // of an ordinary retag. Judged at commit it survives; judged per statement
    // this call would be refused and the accounts screen would stop working.
    let retagged = false
    try {
      await setAccountRoles(at('1200').id, ['trade_receivables'], 'alicio@example.test')
      retagged = true
    } catch (e) {
      fail('V26 while a retag that keeps the role goes through',
        `it was refused: ${errorText(e).slice(0, 70)}`)
    }
    if (retagged) {
      const [stillTagged] = await db.execute<{ n: string }>(raw`
        SELECT count(*)::text AS n FROM account_role
         WHERE account_id = ${at('1200').id}::uuid AND role = 'trade_receivables'`)
      check(stillTagged.n === '1',
        'V26 while a retag that keeps the role goes through',
        `${stillTagged.n} still tagged, through a delete-then-reinsert`)
    }

    // 2 — the void hop. 0028 froze only `posted -> posted`, so voiding and
    //     posting again changed the party, the due date and the control account
    //     of a posted invoice while the entry stayed put.
    await expectDbError('V27 a posted invoice cannot be voided back into a draft',
      'INVOICE_TRANSITION', () =>
        byHand((tx) => tx.execute(raw`
          UPDATE invoice SET status = 'draft', entry_id = NULL WHERE id = ${inv.id}::uuid`)))

    await expectDbError('V28 nor can its party be changed on the way to void',
      'INVOICE_RAW_SQL', () =>
        byHand((tx) => tx.execute(raw`
          UPDATE invoice SET status = 'void', entry_id = NULL, party_id = ${supplier.id}::uuid
           WHERE id = ${inv.id}::uuid`)))

    // `number` is what the entry's description was built from, so changing it
    // afterwards makes the ledger name a document that no longer exists.
    await expectDbError('V29 nor the number the ledger already named it by',
      'INVOICE_RAW_SQL', () =>
        byHand((tx) => tx.execute(raw`
          UPDATE invoice SET number = 'INV-OTHER' WHERE id = ${inv.id}::uuid`)))

    // Who issued it and who posted it. The freeze names its columns one by one,
    // so anything added later — or overlooked — is mutable until somebody
    // notices. On a document that cannot otherwise be edited, rewriting the
    // name attached to it is the change that leaves no trace: the audit row
    // records the status change, not a later edit of the actor on it.
    await expectDbError('V29b nor who issued it', 'INVOICE_RAW_SQL', () =>
      byHand((tx) => tx.execute(raw`
        UPDATE invoice SET created_by = 'somebody else' WHERE id = ${inv.id}::uuid`)))

    await expectDbError('V29c nor who posted it', 'INVOICE_RAW_SQL', () =>
      byHand((tx) => tx.execute(raw`
        UPDATE invoice SET posted_by = 'somebody else' WHERE id = ${inv.id}::uuid`)))

    // The pair, and the reason `posted_by` is a conditional rather than a flat
    // freeze: the posting itself writes it, so NULL to a name has to be allowed
    // once. V09 above already exercises that path — this asserts the value it
    // left behind.
    const [whoPosted] = await db.execute<{ by: string | null }>(raw`
      SELECT posted_by AS by FROM invoice WHERE id = ${inv.id}::uuid`)
    check(whoPosted.by === 'alicio@example.test',
      'V29d while the posting was allowed to write it in the first place',
      whoPosted.by ?? 'null')

    // 3 — the entry reversed out from under it. `amendEntry` carries
    //     source_type/source_id to the replacement on purpose, so without this
    //     the invoice would point at a reversed entry while the live figure sat
    //     somewhere else and every screen went on showing the old total.
    await expectDbError('V30 and the entry it names cannot be reversed under it',
      'ENTRY_HOLDS_AN_INVOICE', () =>
        reverseEntry(live.entryId, '2026-05-02', 'wrong amount', 'alicio@example.test'))

    // Its own invoice, for the reason V32 has its own: with the guard off, V30
    // really reverses `live`, and an amend of an already-reversed entry is then
    // refused by `reverseEntryCore` in JavaScript before it ever reaches the
    // guard — a red check for the wrong reason, which is the same thing as a
    // green one.
    const amendable = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-05-05', dueOn: '2026-06-05',
      number: 'INV-AMENDABLE', lines: salesLines, actor: 'alicio@example.test',
    })
    const amendableLive = await postInvoice(amendable.id, 'alicio@example.test')
    await expectDbError('V31 nor amended, which is a reversal wearing a hat',
      'ENTRY_HOLDS_AN_INVOICE', () =>
        amendEntry(amendableLive.entryId, {
          entryDate: '2026-05-05', description: 'Corrected', actor: 'alicio@example.test',
          lines: [
            { accountId: at('1200').id, amount: 99000n, partyId: customer.id },
            { accountId: at('4000').id, amount: -99000n },
          ],
        }, 'alicio@example.test'))

    // The pair: void the invoice first and the reversal goes through. Without
    // it, a guard that refused every reversal would pass V30 and V31.
    //
    // Its OWN invoice and entry. Sharing `inv` meant that under a mutation V30
    // really reversed it, and this then tried to reverse an already-reversed
    // entry — killing the suite where a red check belonged.
    const spare = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-05-03', dueOn: '2026-06-03',
      number: 'INV-VOIDABLE', lines: salesLines, actor: 'alicio@example.test',
    })
    const spareLive = await postInvoice(spare.id, 'alicio@example.test')
    await byHand((tx) => tx.execute(raw`
      UPDATE invoice SET status = 'void', entry_id = NULL WHERE id = ${spare.id}::uuid`))
    let refused = false
    try {
      await reverseEntry(spareLive.entryId, '2026-05-04', 'wrong amount', 'alicio@example.test')
    } catch (e) {
      // The catch and the check below both print V32's label. Without this flag
      // one refusal emitted TWO `FAIL V32` lines and the block's summary
      // counted two failures for one assertion.
      refused = true
      fail('V32 while voiding the invoice first lets it be reversed',
        `it was refused: ${errorText(e).slice(0, 70)}`)
    }
    if (!refused) {
      const [reversed] = await db.execute<{ s: string }>(raw`
        SELECT status AS s FROM journal_entry WHERE id = ${spareLive.entryId}::uuid`)
      check(reversed.s === 'reversed',
        'V32 while voiding the invoice first lets it be reversed', reversed.s)
    }
  }

  // ---------------------------------------------------- voiding, for real --

  {
    // Every guard above says "void it and issue another". Until `voidInvoice`
    // existed that sentence named an operation nobody could perform: no code
    // set status='void', so the only route was raw SQL — and raw SQL that
    // released `entry_id` left the entry STANDING, posted, named by nothing,
    // with the debt on the party for ever. `V32` did exactly that by hand,
    // which is how the gap stayed invisible.
    const wrong = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-07-01', dueOn: '2026-07-31',
      number: 'INV-WRONG', lines: salesLines, actor: 'alicio@example.test',
    })
    const wrongLive = await postInvoice(wrong.id, 'alicio@example.test')

    await expectError('V37 voiding without a reason is refused', 'NO_REASON', () =>
      voidInvoice(wrong.id, { reason: '  ', actor: 'alicio@example.test' }), 'six months')

    const voided = await voidInvoice(wrong.id, {
      reason: 'billed the wrong customer', actor: 'alicio@example.test',
    })
    check(voided.reversalId !== null,
      'V38 voiding a posted invoice reverses its entry in the same breath',
      `${voided.reversalId?.slice(0, 8)}`)

    // The point of doing both halves together: the ledger nets to nothing for
    // that party, and the invoice no longer claims anything. Read off the
    // ledger, because that is where aging will read it.
    // The reversal carries `source_type = 'adjustment'`, not the invoice's own
    // source — so summing by `source_id` finds the debit and misses the credit,
    // which is how this check first read 150000 and looked like a real defect.
    // The pair is the original entry and the one that reverses it.
    const [owed] = await db.execute<{ total: string }>(raw`
      SELECT COALESCE(sum(jl.amount), 0)::text AS total
        FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
       WHERE jl.party_id = ${customer.id}::uuid
         AND (je.id = ${wrongLive.entryId}::uuid OR je.reverses_id = ${wrongLive.entryId}::uuid)`)
    const after = await invoiceDetail(wrong.id)
    check(owed.total === '0' && after?.invoice.status === 'void'
          && after.invoice.entry_id === null,
      'V39 leaving nothing owed and nothing claimed', `${owed.total}, ${after?.invoice.status}`)

    // And the entry is not left standing. This is the half hand-voiding lost.
    const [entryNow] = await db.execute<{ s: string }>(raw`
      SELECT status AS s FROM journal_entry WHERE id = ${wrongLive.entryId}::uuid`)
    check(entryNow.s === 'reversed',
      'V40 with the entry it produced taken out of the ledger, not orphaned',
      entryNow.s)

    await expectError('V41 and voiding it twice is refused', 'ALREADY_VOID', () =>
      voidInvoice(wrong.id, { reason: 'again', actor: 'alicio@example.test' }))

    // A draft has produced nothing, so voiding it reverses nothing. The
    // transition rule permits draft->void and until now nothing used it.
    const neverSent = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-07-02', dueOn: '2026-08-02',
      lines: salesLines, actor: 'alicio@example.test',
    })
    const draftVoid = await voidInvoice(neverSent.id, {
      reason: 'never sent', actor: 'alicio@example.test',
    })
    check(draftVoid.reversalId === null
          && (await invoiceDetail(neverSent.id))?.invoice.status === 'void',
      'V42 while voiding a draft reverses nothing, because it produced nothing',
      `${draftVoid.reversalId ?? 'no reversal'}`)
  }

  // ------------------------------------------------ the two uncovered arms --

  {
    // `INVOICE_ENTRY_NOT_LIVE` is the last line of defence and it takes some
    // work to reach, which is the point of writing down how.
    //
    // Every ordinary route is already shut: void cannot go back to posted, a
    // posted invoice's entry cannot be re-pointed, and a draft cannot hold an
    // entry at all. What is left is hand-written SQL that first FABRICATES an
    // entry carrying this invoice's source and a status of 'reversed', then
    // claims it. `INVOICE_ENTRY_MISMATCH` covers the case where the entry
    // belongs to someone else; this is the case where it belongs to this
    // invoice and is no longer standing.
    const claimant2 = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-07-03', dueOn: '2026-08-03',
      lines: salesLines, actor: 'alicio@example.test',
    })
    // Header and lines in ONE transaction. The ledger's balance check is
    // deferred, so a header inserted on its own commits by itself and dies —
    // twice, before this was written the way the ledger requires.
    const fabricated = await db.transaction(async (tx) => {
      const [e] = await tx.execute<{ id: string }>(raw`
        INSERT INTO journal_entry (ledger_id, entry_date, description, source_type,
                                   source_id, status, entry_no, period_id, posted_at,
                                   total_debit, total_credit)
        SELECT ${co.ledger.id}::uuid, '2026-07-03'::date, 'fabricated', 'ar_invoice',
               ${claimant2.id}::uuid, 'reversed', 'JE-FAKE-1', fp.id, now(), 150000, 150000
          FROM fiscal_period fp
         WHERE fp.ledger_id = ${co.ledger.id}::uuid
           AND '2026-07-03'::date BETWEEN fp.start_date AND fp.end_date
        RETURNING id::text`)
      await tx.execute(raw`
        INSERT INTO journal_line (entry_id, line_no, account_id, amount)
        VALUES (${e.id}::uuid, 1, ${at('1200').id}::uuid, 150000),
               (${e.id}::uuid, 2, ${at('4000').id}::uuid, -150000)`)
      return e
    })

    await expectDbError('V43 an invoice cannot claim its own entry once it is no longer live',
      'INVOICE_ENTRY_NOT_LIVE', () =>
        byHand((tx) => tx.execute(raw`
          UPDATE invoice SET status = 'posted', entry_id = ${fabricated.id}::uuid
           WHERE id = ${claimant2.id}::uuid`)))

    // `one_live_entry_per_invoice` was asserted to make two live entries
    // impossible "whatever route is found next", with nothing testing it.
    const twice = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-07-04', dueOn: '2026-08-04',
      lines: salesLines, actor: 'alicio@example.test',
    })
    await postInvoice(twice.id, 'alicio@example.test')
    await expectDbError('V44 and one invoice cannot have two live entries',
      'one_live_entry_per_invoice', () =>
        byHand((tx) => tx.execute(raw`
          INSERT INTO journal_entry (ledger_id, entry_date, description, source_type,
                                     source_id, status, entry_no, period_id, posted_at)
          SELECT ledger_id, entry_date, 'a second one', source_type, source_id,
                 'posted', 'JE-DUP-1', period_id, now()
            FROM journal_entry WHERE source_id = ${twice.id}::uuid AND status = 'posted'`)))
  }

  // ---------------------------------------------------- credit notes --

  {
    // The second axis. Two directions times two kinds is four combinations, and
    // the sign falls out of the PAIR — written as four branches, the fourth is
    // the one that gets copied wrong.
    const table: Array<[Direction, DocumentKind, bigint, boolean]> = [
      ['sales', 'invoice', 1n, true], ['sales', 'invoice', -1n, false],
      ['sales', 'credit_note', -1n, true], ['sales', 'credit_note', 1n, false],
      ['purchase', 'invoice', -1n, true], ['purchase', 'invoice', 1n, false],
      ['purchase', 'credit_note', 1n, true], ['purchase', 'credit_note', -1n, false],
    ]
    const wrongCell = table.find(([d, k, m, want]) => movesTheRightWay(d, m, k) !== want)
    check(wrongCell === undefined,
      'V71 all four combinations move the control account the way they should',
      wrongCell ? `${wrongCell[0]}/${wrongCell[1]} ${wrongCell[2]}` : 'four cells, both signs each')

    // Guarded from here down. A mutation that collapses the two axes makes
    // `createInvoice` refuse EVERY credit note, and each check below reads a
    // document that was never created — which killed the suite and recorded a
    // stack trace where four red checks belonged.
    let note: Awaited<ReturnType<typeof createInvoice>> | null = null
    try {
      note = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', kind: 'credit_note',
      partyId: customer.id, controlAccountId: at('1200').id,
      issuedOn: '2026-04-20', dueOn: '2026-04-20', number: 'CN-001', actor: 'alicio@example.test',
        lines: [{ accountId: at('4000').id, amount: 30000n, description: 'Overcharged' }],
      })
    } catch (e) {
      fail('V72 a sales credit note credits the receivable, under the customer',
        `it was refused: ${errorText(e).slice(0, 70)}`)
    }

    if (!note) {
      // Same again, and it was worse here: five assertion labels printed by one
      // precondition. V73, V75, V78 and V79 appear red in the evidence ONLY
      // through this branch.
      fail('V72g a credit note exists for V73 to V79 to act on',
        'no credit note could be created')
    } else {
    const notePosted = await postInvoice(note.id, 'alicio@example.test')
    const [creditedAR] = await db.execute<{ amount: bigint; party: string | null }>(raw`
      SELECT jl.amount, jl.party_id::text AS party
        FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${notePosted.entryId}::uuid AND a.code = '1200'`)
    check(creditedAR.amount === -30000n && creditedAR.party === customer.id,
      'V72 a sales credit note credits the receivable, under the customer',
      `${creditedAR.amount}, party ${creditedAR.party?.slice(0, 8)}`)

    // And says 300.00, not −300.00. The document total is positive on all four.
    check(notePosted.total === 30000n,
      'V73 while the document still says what it is for, positively',
      `${notePosted.total}`)

    // The same lines as an INVOICE are refused, and the message names the
    // document they would be.
    await expectError('V74 the same lines as an invoice are refused, naming what they are',
      'WRONG_WAY', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
          controlAccountId: at('1200').id, issuedOn: '2026-04-20', dueOn: '2026-04-20',
          lines: [{ accountId: at('4000').id, amount: 30000n }], actor: 'alicio@example.test',
        }), 'credit note')

    // A purchase credit note is the mirror: the payable is DEBITED.
    const supplierCredit = await createInvoice({
      ledgerId: co.ledger.id, direction: 'purchase', kind: 'credit_note',
      partyId: supplier.id, controlAccountId: at('2000').id,
      issuedOn: '2026-04-21', dueOn: '2026-04-21', number: 'SC-001', actor: 'alicio@example.test',
      lines: [{ accountId: at('5000').id, amount: -20000n, description: 'Returned' }],
    })
    const scPosted = await postInvoice(supplierCredit.id, 'alicio@example.test')
    const [debitedAP] = await db.execute<{ amount: bigint }>(raw`
      SELECT jl.amount FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${scPosted.entryId}::uuid AND a.code = '2000'`)
    check(debitedAP.amount === 20000n && scPosted.total === 20000n,
      'V75 and a purchase credit note debits the payable', `${debitedAP.amount}`)

    // The SQL copy of the sign rule, checked against the TypeScript one rather
    // than trusted. `invoicesFor` cannot import `totalOf`, so the rule is
    // written twice — and a rule written twice is a rule that drifts.
    const listed = await invoicesFor(co.ledger.id)
    const mismatched: string[] = []
    for (const row of listed) {
      const detail = await invoiceDetail(row.id)
      if (detail && detail.total !== row.total) {
        mismatched.push(`${row.number ?? row.id.slice(0, 8)}: list ${row.total} vs ${detail.total}`)
      }
    }
    // "all four combinations" used to be a constant in the message rather than
    // something computed — true by accident of the fixture, and it would have
    // gone on saying so if a cell were removed. Now it is counted, and a
    // missing cell fails the check rather than decorating it.
    const cells = new Set(listed.map((r) => `${r.direction}/${r.document_kind}`))
    check(mismatched.length === 0 && cells.size === 4,
      'V76 and the SQL total agrees with the TypeScript one on all four cells',
      mismatched.join('; ') || `${listed.length} documents across ${[...cells].sort().join(', ')}`)

    // The kind is part of what a posted document is, so it freezes with the
    // rest. A new column is unfrozen until somebody remembers.
    await expectDbError('V77 the kind of a posted document cannot be changed',
      'INVOICE_RAW_SQL', () =>
        byHand((tx) => tx.execute(raw`
          UPDATE invoice SET document_kind = 'invoice' WHERE id = ${note.id}::uuid`)))

    // Numbering is per kind: the same number on an invoice and on a credit note
    // are two different documents.
    //
    // On its OWN number, not `note`'s. Sharing CN-001 with V77 meant that when
    // a mutation let V77's UPDATE through, CN-001 turned into an invoice — and
    // this creation then collided with it, threw, and killed the suite in the
    // exact run where V77's red check was the point. A check that only works
    // while the check above it is failing correctly is not independent of it.
    const ownNote = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', kind: 'credit_note',
      partyId: customer.id, controlAccountId: at('1200').id,
      issuedOn: '2026-04-24', dueOn: '2026-04-24', number: 'CN-002', actor: 'alicio@example.test',
      lines: [{ accountId: at('4000').id, amount: 2000n }],
    })
    const sameNumber = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', kind: 'invoice',
      partyId: customer.id, controlAccountId: at('1200').id,
      issuedOn: '2026-04-24', dueOn: '2026-05-24', number: 'CN-002', actor: 'alicio@example.test',
      lines: salesLines,
    })
    check(sameNumber.id !== ownNote.id,
      'V78 while an invoice may take a number a credit note already has',
      'CN-002 exists as both')

    await expectError('V79 and two of the same kind may not, naming the kind',
      'DUPLICATE_NUMBER', () =>
      createInvoice({
        ledgerId: co.ledger.id, direction: 'sales', kind: 'credit_note',
        partyId: customer.id, controlAccountId: at('1200').id,
        issuedOn: '2026-04-25', dueOn: '2026-04-25', number: 'CN-002', actor: 'alicio@example.test',
        lines: [{ accountId: at('4000').id, amount: 1000n }],
      }), 'credit note')
    }
  }

  // ------------------------------------------------------------------ tax --

  {
    // Tax is an ORDINARY LINE. There is no tax field on an invoice and no tax
    // rate anywhere: the PRD freezes automatic calculation as a non-goal, so
    // the figure is typed. What that buys is this — `gstHstReturn` reads the
    // ledger by role and picks the line up with no new code at all.
    const taxed = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-04-15', dueOn: '2026-05-15',
      number: 'INV-TAX', actor: 'alicio@example.test',
      lines: [
        { accountId: at('4000').id, amount: -100000n, description: 'Work' },
        { accountId: at('2300').id, amount: -5000n, description: 'GST 5%' },
      ],
    })
    // Before and after, because this ledger already has other invoices in the
    // window: an absolute figure here would be asserting the whole fixture, and
    // the first version of this check did exactly that and failed for a reason
    // that had nothing to do with tax.
    const before = await gstHstReturn(co.ledger.id, '2026-04-01', '2026-06-30')
    const posted = await postInvoice(taxed.id, 'alicio@example.test')
    check(posted.total === 105000n,
      'V62 an invoice with a tax line bills the total including it', `${posted.total}`)

    const [receivable] = await db.execute<{ amount: bigint }>(raw`
      SELECT jl.amount FROM journal_line jl JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${posted.entryId}::uuid AND a.code = '1200'`)
    check(receivable.amount === 105000n,
      'V63 and the receivable is the total, not the net', `${receivable.amount}`)

    // The point of tax being a line: nothing in `tax.ts` knows what an invoice
    // is, and the return finds it anyway.
    const after = await gstHstReturn(co.ledger.id, '2026-04-01', '2026-06-30')
    const movedCollected = after!.lines.collected.amount - before!.lines.collected.amount
    const movedSales = after!.lines.sales.amount - before!.lines.sales.amount
    check(movedCollected === 5000n,
      'V64 and the GST return picks it up without knowing what an invoice is',
      `line 105 moved by ${movedCollected}`)
    check(movedSales === 100000n,
      'V65 with the net in line 101 and the tax not counted twice',
      `line 101 moved by ${movedSales}`)

    // Which SIDE the tax line points is the one thing that can be silently
    // wrong. Collected tax in the recoverable account is claiming back tax you
    // charged somebody else: the entry balances, and the return is wrong in
    // both boxes at once.
    await expectDbError('V66 a sale cannot put its tax in the recoverable account',
      'TAX_WRONG_SIDE', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
          controlAccountId: at('1200').id, issuedOn: '2026-04-15', dueOn: '2026-05-15',
          actor: 'alicio@example.test',
          lines: [
            { accountId: at('4000').id, amount: -100000n },
            { accountId: at('2310').id, amount: -5000n },
          ],
        }))

    await expectDbError('V67 nor a purchase put its tax in the collected account',
      'TAX_WRONG_SIDE', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
          controlAccountId: at('2000').id, issuedOn: '2026-04-15', dueOn: '2026-05-15',
          actor: 'alicio@example.test',
          lines: [
            { accountId: at('5000').id, amount: 100000n },
            { accountId: at('2300').id, amount: 5000n },
          ],
        }))

    // The pair: each direction accepts its OWN side, so the rule is about which
    // side and not about refusing tax lines.
    const bill = await createInvoice({
      ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
      controlAccountId: at('2000').id, issuedOn: '2026-04-16', dueOn: '2026-05-16',
      actor: 'alicio@example.test',
      lines: [
        { accountId: at('5000').id, amount: 100000n },
        { accountId: at('2310').id, amount: 5000n, description: 'GST paid' },
      ],
    })
    const billPosted = await postInvoice(bill.id, 'alicio@example.test')
    const afterBill = await gstHstReturn(co.ledger.id, '2026-04-01', '2026-06-30')
    const movedItcs = afterBill!.lines.itcs.amount - after!.lines.itcs.amount
    check(billPosted.total === 105000n && movedItcs === 5000n,
      'V68 while a purchase\'s tax goes to the recoverable side, and into line 108',
      `bill ${billPosted.total}, line 108 moved by ${movedItcs}`)

    // 0031 asked which ACCOUNT the tax names and never asked about the sign.
    // That left this: the right account, pointing the wrong way. Every other
    // rule is satisfied — the control movement is still +95,000, which is how a
    // sales invoice must move — and the posted entry DEBITS GST payable, so the
    // return shows tax remitted rather than collected, in the very box 0031's
    // comment is about.
    await expectDbError('V69a a sale cannot debit the tax it collected',
      'TAX_WRONG_WAY', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
          controlAccountId: at('1200').id, issuedOn: '2026-04-17', dueOn: '2026-05-17',
          actor: 'alicio@example.test',
          lines: [
            { accountId: at('4000').id, amount: -100000n },
            { accountId: at('2300').id, amount: 5000n },
          ],
        }))

    await expectDbError('V69b nor a purchase credit the tax it reclaimed',
      'TAX_WRONG_WAY', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
          controlAccountId: at('2000').id, issuedOn: '2026-04-17', dueOn: '2026-05-17',
          actor: 'alicio@example.test',
          lines: [
            { accountId: at('5000').id, amount: 100000n },
            { accountId: at('2310').id, amount: -5000n },
          ],
        }))

    // A CREDIT NOTE points the other way, and its tax with it. The rule is not
    // "tax is always a credit on a sale" — it is "the tax line goes the way the
    // rest of the document goes", and the two axes decide which.
    // Guarded: a mutation that makes credit notes impossible at all would kill
    // the suite here rather than turn this check red. The credit-note block
    // above learned that; this fixture was added later and had not.
    let taxedCredit: Awaited<ReturnType<typeof createInvoice>> | null = null
    try {
      taxedCredit = await createInvoice({
        ledgerId: co.ledger.id, direction: 'sales', kind: 'credit_note',
        partyId: customer.id, controlAccountId: at('1200').id,
        issuedOn: '2026-04-18', dueOn: '2026-04-18', number: 'CN-TAX', actor: 'alicio@example.test',
        lines: [
          { accountId: at('4000').id, amount: 20000n },
          { accountId: at('2300').id, amount: 1000n, description: 'GST on the credit' },
        ],
      })
    } catch (e) {
      fail('V69c while a credit note debits the tax it is giving back',
        `it was refused: ${errorText(e).slice(0, 70)}`)
    }
    if (taxedCredit) {
      check(taxedCredit.id !== '',
        'V69c while a credit note debits the tax it is giving back', 'created')
    }

    await expectDbError('V69d and cannot credit it, which is what an invoice does',
      'TAX_WRONG_WAY', () =>
        createInvoice({
          ledgerId: co.ledger.id, direction: 'sales', kind: 'credit_note',
          partyId: customer.id, controlAccountId: at('1200').id,
          issuedOn: '2026-04-18', dueOn: '2026-04-18', actor: 'alicio@example.test',
          lines: [
            { accountId: at('4000').id, amount: 20000n },
            { accountId: at('2300').id, amount: -1000n },
          ],
        }))

    // Voiding takes the tax back off the return. Both halves — the original and
    // its reversal — are inside `status IN ('posted','reversed')`, so they net.
    // Counting only 'posted' would drop the original and leave the reversal,
    // and the return would show NEGATIVE tax collected.
    const beforeVoiding = await gstHstReturn(co.ledger.id, '2026-04-01', '2026-06-30')
    await voidInvoice(taxed.id, {
      reason: 'billed the wrong rate', reversedOn: '2026-04-16', actor: 'alicio@example.test',
    })
    const afterVoiding = await gstHstReturn(co.ledger.id, '2026-04-01', '2026-06-30')
    check(afterVoiding!.lines.collected.amount
          === beforeVoiding!.lines.collected.amount - 5000n,
      'V69e voiding a taxed invoice takes its tax back off the return',
      `${beforeVoiding!.lines.collected.amount} -> ${afterVoiding!.lines.collected.amount}`)

    // And the half that is a real filing hazard: `reversedOn` decides which
    // RETURN the credit lands in. Reverse into a later quarter and the first
    // return keeps the tax while the second gets the credit — which is correct
    // if the first was already filed, and wrong if it was not. Nothing stops
    // either, so the least this can do is be a fact somebody can find.
    const q2 = await gstHstReturn(co.ledger.id, '2026-04-01', '2026-06-30')
    const withLateReversal = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-06-15', dueOn: '2026-07-15',
      number: 'INV-STRADDLE', actor: 'alicio@example.test',
      lines: [
        { accountId: at('4000').id, amount: -60000n },
        { accountId: at('2300').id, amount: -3000n },
      ],
    })
    await postInvoice(withLateReversal.id, 'alicio@example.test')
    await voidInvoice(withLateReversal.id, {
      reason: 'issued in the wrong quarter', reversedOn: '2026-07-05', actor: 'alicio@example.test',
    })
    const q2After = await gstHstReturn(co.ledger.id, '2026-04-01', '2026-06-30')
    const q3 = await gstHstReturn(co.ledger.id, '2026-07-01', '2026-09-30')
    check(q2After!.lines.collected.amount === q2!.lines.collected.amount + 3000n
          && q3!.lines.collected.amount === -3000n,
      'V69f while a reversal dated into the next quarter credits THAT return',
      `Q2 keeps ${q2After!.lines.collected.amount - q2!.lines.collected.amount}, Q3 gets ${q3!.lines.collected.amount}`)

    // And the account list marks which side is which, so the refusal above is
    // not arbitrary when it happens.
    const forSales = await lineAccountsFor(co.company.id, 'sales')
    const forPurchase = await lineAccountsFor(co.company.id, 'purchase')
    check(forSales.find((a) => a.code === '2300')?.tax_role === 'gst_hst_payable'
          && forSales.find((a) => a.code === '2310')?.tax_role === null
          && forPurchase.find((a) => a.code === '2310')?.tax_role === 'gst_hst_recoverable',
      'V69 and the account list marks the tax account for THIS direction',
      `sales: 2300=${forSales.find((a) => a.code === '2300')?.tax_role}`)

    // The control account is marked too, so a screen can keep it out of the
    // line list — putting a sales invoice's own receivable on a line doubles it.
    check(forSales.find((a) => a.code === '1200')?.is_control === true
          && forSales.find((a) => a.code === '4000')?.is_control === false,
      'V70 and marks the control accounts, which are not line accounts',
      `1200 control=${forSales.find((a) => a.code === '1200')?.is_control}`)
  }

  // ------------------------------------------------------------- the form --

  {
    // What the page actually runs. The library above is not the shipped path.
    const nameOf = (id: string) => {
      const a = accounts.find((x) => x.id === id)
      return a ? `${a.code} — ${a.name}` : id
    }
    const fd = (pairs: Record<string, string>) => {
      const f = new FormData()
      f.set(F.ledgerId, co.ledger.id)
      f.set(F.partyId, customer.id)
      f.set(F.controlAccountId, at('1200').id)
      f.set(F.direction, 'sales')
      f.set(F.issuedOn, '2026-09-01')
      f.set(F.dueOn, '2026-09-30')
      // Every row the form renders, blanks included — which is what a browser
      // sends: an empty input posts its name with an empty value, it is not
      // left out. Building only the filled ones made a fixture that no browser
      // produces, and the row NUMBER in a refusal is counted over the rows that
      // arrived, so a check on that wording was reading its own shortcut.
      for (let i = 0; i < INVOICE_LINE_SLOTS; i++) {
        f.set(lineAccount(i), '')
        f.set(lineDescription(i), '')
        f.set(lineAmount(i), '')
      }
      for (const [k, v] of Object.entries(pairs)) f.set(k, v)
      return f
    }

    // THE SIGN. The person types what the line adds to the invoice; the ledger
    // stores what it does to the account, which is the opposite for a sale.
    // Getting this backwards produces an invoice that posts, balances, and
    // credits the customer instead of billing them.
    const typed = fd({
      [F.number]: 'INV-FORM-1',
      [lineAccount(0)]: at('4000').id,
      [lineDescription(0)]: 'August work',
      [lineAmount(0)]: '1,200.00',
    })
    const made = await createInvoiceFromForm(typed, nameOf, 'alicio@example.test')
    check(made.ok === 'Saved to the books.',
      'V45 the form saves straight to the books', made.ok ?? made.error ?? '')

    // Guarded, because a mutation that breaks the sign makes `createInvoice`
    // refuse the whole document — and every check below reads the invoice that
    // was not created. Unguarded, this suite died there and the block recorded
    // a stack trace instead of its red check.
    const formInvoice = (await invoicesFor(co.ledger.id, 'sales'))
      .find((i) => i.number === 'INV-FORM-1')
    const formDetail = formInvoice ? await invoiceDetail(formInvoice.id) : null
    check(formDetail?.lines[0].amount === -120000n && formDetail?.total === 120000n,
      'V46 typing 1,200 on a sales invoice credits revenue and bills 1,200',
      formDetail
        ? `line ${formDetail.lines[0].amount}, total ${formDetail.total}`
        : 'the invoice was never created')

    // The pair, and the half a "just negate it" rule would fail: on a purchase
    // the SAME typed figure has to keep its sign, because an expense is
    // debited. `ledgerAmount` is where the direction decides.
    check(ledgerAmount('sales', 'invoice', 120000n) === -120000n
          && ledgerAmount('purchase', 'invoice', 120000n) === 120000n
          && ledgerAmount('sales', 'invoice', -30000n) === 30000n
          // The kind flips the pair: a credit note's lines run the OTHER way
          // in the same direction — the defect that refused every credit-note
          // edit was ledgerAmount not being asEnteredAmount's true inverse.
          && ledgerAmount('sales', 'credit_note', 120000n) === 120000n
          && ledgerAmount('purchase', 'credit_note', 120000n) === -120000n,
      'V47 the sign keys on direction AND kind, like its inverse',
      `${ledgerAmount('sales', 'invoice', 120000n)} / ${ledgerAmount('sales', 'credit_note', 120000n)}`)

    // The lines are numbered, and the numbering has to bind fields WITHIN a
    // row. Filled in a scrambled order — slot 4 first, slot 1 last — every
    // amount must still be against the account typed beside it. The sales tax
    // screen lost six rounds to the other shape.
    const scrambled = new FormData()
    scrambled.set(F.ledgerId, co.ledger.id)
    scrambled.set(F.partyId, customer.id)
    scrambled.set(F.controlAccountId, at('1200').id)
    scrambled.set(F.direction, 'sales')
    scrambled.set(F.issuedOn, '2026-09-02')
    scrambled.set(F.dueOn, '2026-09-30')
    // The LAST slot and the FIRST, deliberately — filled in that order. With
    // only middle slots filled, a reader bounded at `i < 5`, or one starting at
    // 1, would pass this and lose a line the screen had shown.
    const last = INVOICE_LINE_SLOTS - 1
    scrambled.set(lineAmount(last), '55.00')
    scrambled.set(lineAccount(last), at('1210').id)
    scrambled.set(lineDescription(0), 'first slot, filled last')
    scrambled.set(lineAmount(0), '11.00')
    scrambled.set(lineAccount(0), at('4000').id)

    const { lines: scrambledLines, error: scrambledError } =
      linesFrom(scrambled, 'sales', 'invoice', nameOf)
    check(scrambledError === undefined && scrambledLines.length === 2
          && scrambledLines[0].index === 0
          && scrambledLines[0].line.accountId === at('4000').id
          && scrambledLines[0].line.amount === -1100n
          && scrambledLines[1].index === last
          && scrambledLines[1].line.accountId === at('1210').id
          && scrambledLines[1].line.amount === -5500n,
      'V48 each amount stays with the account typed beside it, whatever the order',
      scrambledLines.map((l) => `${l.index}:${l.line.amount}`).join(' '))

    // And it reads as many rows as arrive, PAST the number the form opens with.
    // The reader used to loop to `INVOICE_LINE_SLOTS` and the form used to
    // render exactly that many, and the constant was described as the place
    // they agreed. Once a row could be added, that agreement would have been a
    // seventh line saved nowhere: the invoice posts, short by exactly that
    // line, and every figure on the saved document agrees with every other.
    const beyond = INVOICE_LINE_SLOTS + 3
    const allSlots = new FormData()
    allSlots.set(F.direction, 'sales')
    for (let i = 0; i < beyond; i++) {
      allSlots.set(lineAccount(i), at('4000').id)
      allSlots.set(lineAmount(i), '1.00')
    }
    const { lines: everySlot } = linesFrom(allSlots, 'sales', 'invoice', nameOf)
    check(everySlot.length === beyond && everySlot[everySlot.length - 1].index === beyond - 1,
      'V48b and it reads every row that arrives, past the number the form opens with',
      `${everySlot.length} of ${beyond}, form opens with ${INVOICE_LINE_SLOTS}`)

    // The three makers of a line's field names and the one reader of them, held
    // together. They are four functions over one string shape; if the reader's
    // pattern and a maker ever disagree the form saves nothing at all and says
    // "Nothing on it yet", which is at least loud — but only one of the three
    // has to drift for one FIELD to go unread, and that is silent.
    const madeNames = [lineAccount(7), lineDescription(7), lineAmount(7)]
    const readBack = madeNames.map((nm) => lineIndicesIn([nm]))
    check(readBack.every((r) => r.length === 1 && r[0] === 7),
      'V80 the reader recognises every name the form makes, and takes the row number from it',
      madeNames.map((nm, k) => `${nm}->${JSON.stringify(readBack[k])}`).join(' '))

    // And recognises nothing else. A pattern loose enough to match a header
    // field would read a row that does not exist and refuse the invoice for a
    // line nobody typed.
    const notLines = lineIndicesIn([F.number, F.note, 'line.account', 'line.2', 'line.x.amount',
                                    'line.2.total', 'xline.2.amount'])
    check(notLines.length === 0,
      'V80b and nothing else, so a header field cannot be read as a row',
      notLines.length === 0 ? 'none of 7 mistaken for a row' : JSON.stringify(notLines))

    // Row numbers on screen are POSITIONS, and the positions of the rows that
    // came back — not the numbers in the field names. Once a middle row is
    // removed the form renumbers on the next render, but a submission in flight
    // carries the old numbering, and an error naming "Line 8" of a five-row
    // form points at nothing.
    const gappy = new FormData()
    gappy.set(F.direction, 'sales')
    gappy.set(lineAccount(0), at('4000').id)
    gappy.set(lineAmount(0), '10.00')
    gappy.set(lineAccount(4), at('4000').id)
    gappy.set(lineAmount(4), '20.00')
    gappy.set(lineAmount(9), '30.00')            // no account: the one refused
    const gapped = linesFrom(gappy, 'sales', 'invoice', nameOf)
    check(gapped.error === 'Line 3 has an amount but no account.',
      'V81 and it counts rows the way the screen does, not the way the names are numbered',
      gapped.error ?? 'no error')

    // ---------------------------------------------------------------------
    // The line editor. Adding and removing a row is a click, and a check can
    // render this screen once and read the markup — it cannot press anything.
    // So the transitions live in `invoice-rows.ts` as functions over a list,
    // and they are checked here; `V88` and `V89` then check that the screen
    // wires its buttons to them by key.
    // ---------------------------------------------------------------------
    const three: RowState = {
      nextKey: 3,
      rows: [
        { key: 0, account: at('4000').id, description: 'first', amount: '10.00', taxCode: 'OUT_OF_SCOPE' },
        { key: 1, account: at('4000').id, description: 'second', amount: '20.00', taxCode: 'OUT_OF_SCOPE' },
        { key: 2, account: at('5000').id, description: 'third', amount: '30.00', taxCode: 'OUT_OF_SCOPE' },
      ],
    }

    // A row is removed by KEY, and the key survives the row moving. Removing by
    // position instead would take out whichever row is sitting there NOW — and
    // after one move that is a different row, with a different account and a
    // different figure, and the form still shows two well-formed lines.
    const moved = moveRow(three, 0, 1)                    // positions become 1, 0, 2
    const afterRemove = removeRow(moved, 0)
    check(afterRemove.rows.map((r) => r.key).join(',') === '1,2'
          && afterRemove.rows[0].description === 'second'
          && afterRemove.rows[0].amount === '20.00'
          && afterRemove.rows[1].description === 'third',
      'V82 a row is removed by its key, which survives the row having moved',
      `moved to ${moved.rows.map((r) => r.key).join(',')}, left ${afterRemove.rows.map((r) => `${r.key}:${r.description}`).join(' ')}`)

    // The paired half: had it removed by POSITION 0 it would have taken the row
    // written above as `second`. Stated as a check so the one above is known to
    // be distinguishing something rather than agreeing with both answers.
    check(moved.rows[0].key === 1 && moved.rows[0].description === 'second'
          && afterRemove.rows.some((r) => r.description === 'second'),
      'V82b and position 0 at that moment held a different row, so the two answers differ',
      `position 0 held key ${moved.rows[0].key}`)

    // Emptying the form leaves somewhere to type. A form with no rows can only
    // be got out of by reloading the page, and the person who removed the last
    // row was clearing it, not leaving.
    const emptied = removeRow({ nextKey: 9, rows: [{ key: 4, account: '', description: '', amount: '', taxCode: 'OUT_OF_SCOPE' }] }, 4)
    check(emptied.rows.length === 1 && emptied.rows[0].key !== 4
          && emptied.rows[0].account === '' && emptied.rows[0].amount === '',
      'V83 removing the last row leaves a blank one rather than an empty form',
      `${emptied.rows.length} row, key ${emptied.rows[0]?.key}`)

    // A move carries the whole row — its account, its description, its amount.
    // Moving a value without its account is the failure this screen is shaped
    // to prevent, and it posts.
    const up = moveRow(three, 2, -1)
    check(up.rows.map((r) => `${r.key}:${r.description}:${r.amount}`).join(' ')
          === '0:first:10.00 2:third:30.00 1:second:20.00',
      'V84 a move carries the whole row, account and figure together',
      up.rows.map((r) => `${r.key}:${r.amount}`).join(' '))

    // Off either end nothing happens. The buttons are disabled there, which is
    // a courtesy; this is the guarantee.
    const offTop = moveRow(three, 0, -1)
    const offEnd = moveRow(three, 2, 1)
    const gone = moveRow(three, 99, 1)
    check(offTop.rows.map((r) => r.key).join(',') === '0,1,2'
          && offEnd.rows.map((r) => r.key).join(',') === '0,1,2'
          && gone.rows.map((r) => r.key).join(',') === '0,1,2',
      'V84b and off either end, or on a row that is gone, it does nothing',
      'order held in all three')

    // Typing goes to the row the key names, after that row has moved. By
    // position it would land on the row now sitting there — the same silent
    // shape as removing by position, and harder to notice because the figure
    // that appears is the one that was typed.
    const edited = editRow(moveRow(three, 0, 1), 0, 'amount', '99.00')
    check(edited.rows.find((r) => r.key === 0)?.amount === '99.00'
          && edited.rows.find((r) => r.key === 1)?.amount === '20.00',
      'V85 typing lands in the row the key names, after that row has moved',
      edited.rows.map((r) => `${r.key}:${r.amount}`).join(' '))

    // Keys are handed out once. Reusing a key that a removed row held would let
    // a button rendered before the removal act on the row that took its number.
    const grown = addRow(removeRow(addRow(three), 1))
    const usedKeys = grown.rows.map((r) => r.key)
    check(new Set(usedKeys).size === usedKeys.length
          && Math.max(...usedKeys) < grown.nextKey
          && !usedKeys.includes(1),
      'V86 keys are handed out once and never reused after a removal',
      `keys ${usedKeys.join(',')}, next ${grown.nextKey}`)

    // THE FIGURE UNDER THE FORM IS THE FIGURE THE READER WILL GET.
    //
    // A running total is a second reading of what has been typed, and a second
    // reading that disagrees is the one kind of wrong this screen cannot show:
    // the form adds up to one number, the saved invoice to another, and both
    // are internally consistent. So it is asked of both and compared.
    const posted = new FormData()
    posted.set(F.direction, 'sales')
    three.rows.forEach((r, i) => {
      posted.set(lineAccount(i), r.account)
      posted.set(lineDescription(i), r.description)
      posted.set(lineAmount(i), r.amount)
    })
    const readerSaw = linesFrom(posted, 'sales', 'invoice', nameOf)
    const screenSaw = typedTotal(three.rows)
    check(readerSaw.error === undefined
          && totalOf(readerSaw.lines.map((l) => l.line), 'sales') === screenSaw.total
          && screenSaw.total === 6000n && screenSaw.filled === 3 && screenSaw.unreadable === 0,
      'V87 the figure under the form is the figure the reader gets for the same rows',
      `screen ${formatMoney(screenSaw.total)}, reader ${formatMoney(totalOf(readerSaw.lines.map((l) => l.line), 'sales'))}`)

    // And on a purchase, where the reader flips every sign, the figure the
    // person reads is the same one. The typed sense is what the line ADDS to
    // the document; the direction is the ledger's business, not the reader's.
    const purchaseRead = linesFrom(posted, 'purchase', 'invoice', nameOf)
    check(totalOf(purchaseRead.lines.map((l) => l.line), 'purchase') === screenSaw.total,
      'V87b and the same figure on a purchase, where every ledger sign is the other way',
      `${formatMoney(totalOf(purchaseRead.lines.map((l) => l.line), 'purchase'))} both ways`)

    // A row with something in it that is not an amount is COUNTED, not guessed
    // at. Treating it as zero would show a confident total that the invoice
    // will not be saved for — and this reader refuses that invoice by name, so
    // the screen would be promising a save that cannot happen.
    const messy = typedTotal([
      { key: 0, account: at('4000').id, description: '', amount: '10.00', taxCode: 'OUT_OF_SCOPE' },
      { key: 1, account: at('4000').id, description: '', amount: 'twelve', taxCode: 'OUT_OF_SCOPE' },
      { key: 2, account: at('4000').id, description: '', amount: '.', taxCode: 'OUT_OF_SCOPE' },
      { key: 3, account: '', description: '', amount: '', taxCode: 'OUT_OF_SCOPE' },
    ])
    check(messy.total === 1000n && messy.filled === 3 && messy.unreadable === 2,
      'V87c and a row that is not yet an amount is counted apart, not read as zero',
      `${formatMoney(messy.total)} across ${messy.filled - messy.unreadable} of ${messy.filled}`)

    // Half a line is refused by name rather than dropped. Dropping it posts an
    // invoice for less than the screen showed, and every total agrees.
    const halfA = await createInvoiceFromForm(
      fd({ [lineAccount(0)]: at('4000').id, [lineAmount(0)]: '' }), nameOf, 'alicio@example.test')
    check(halfA.error?.includes('has no amount') === true
          && halfA.error?.includes('4000') === true,
      'V49 a line with an account and no amount is refused, naming the account',
      halfA.error ?? 'no error')

    const halfB = await createInvoiceFromForm(
      fd({ [lineAmount(2)]: '10.00' }), nameOf, 'alicio@example.test')
    check(halfB.error?.includes('Line 3') === true,
      'V50 and one with an amount and no account, naming the line', halfB.error ?? 'no error')

    // A lone dot parses as zero. The bank reader shipped that once and
    // fabricated a 0.00 transaction; here it would be a line for nothing.
    const dot = await createInvoiceFromForm(
      fd({ [lineAccount(0)]: at('4000').id, [lineAmount(0)]: '.' }), nameOf, 'alicio@example.test')
    check(dot.error?.includes('reads as zero') === true,
      'V51 and an amount that reads as zero is refused, quoting what was typed',
      dot.error ?? 'no error')

    const junk = await createInvoiceFromForm(
      fd({ [lineAccount(0)]: at('4000').id, [lineAmount(0)]: 'twelve' }), nameOf, 'alicio@example.test')
    check(junk.error?.includes('not an amount') === true,
      'V52 as is one that is not a number at all', junk.error ?? 'no error')

    const empty = await createInvoiceFromForm(fd({}), nameOf, 'alicio@example.test')
    check(empty.error?.includes('Nothing on it yet') === true,
      'V53 and an invoice with no lines at all', empty.error ?? 'no error')

    // Posting and voiding through the form, which is what the buttons do.
    if (!formInvoice) {
      // ONE id for the precondition, not the labels of the three assertions
      // downstream. Printing theirs meant a mutation that only stopped the
      // invoice being created reddened V54, V55 and V56 — and the coverage
      // count, which keys on the label, recorded three assertions as made to
      // fail when none of them ran. V54 and V56 were credited that way and
      // nothing else ever reddened them.
      fail('V53g the form made an invoice for V54 to V56 to act on',
        'the invoice was never created')
    } else {
    // Open books: the save already entered it. V54 pins that — the document
    // is posted with an entry behind it before any button is pressed — and
    // V55/V56 exercise the doors that replaced Post and Void: edit and delete
    // through the form layer.
    const savedDetail = await invoiceDetail(formInvoice.id)
    check(savedDetail?.invoice.status === 'posted' && savedDetail.invoice.entry_id !== null,
      'V54 the save has already entered the books', savedDetail?.invoice.status ?? 'missing')

    const uf = fd({
      [F.invoiceId]: formInvoice.id, [F.direction]: 'sales',
      [F.partyId]: formInvoice.party_id, [F.controlAccountId]: at('1200').id,
      [F.issuedOn]: formInvoice.issued_on, [F.dueOn]: formInvoice.due_on,
      [F.number]: formInvoice.number ?? '',
      [lineAccount(0)]: at('4000').id,
      [lineDescription(0)]: 'August work, more of it',
      [lineAmount(0)]: '1,300.00',
    })
    const editedByForm = await updateInvoiceFromForm(uf, nameOf, 'alicio@example.test')
    check(editedByForm.ok !== undefined
          && (await invoiceDetail(formInvoice.id))?.total === 130000n,
      'V55 the edit form moves the document and its entry',
      editedByForm.ok ?? editedByForm.error ?? '')

    const df = new FormData()
    df.set(F.ledgerId, co.ledger.id)
    df.set(F.invoiceId, formInvoice.id)
    const deletedByForm = await deleteInvoiceFromForm(df, 'alicio@example.test')
    const [afterDelete] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry
       WHERE source_id = ${formInvoice.id}::uuid AND source_type = 'ar_invoice'`)
    check(deletedByForm.ok !== undefined && afterDelete.n === '0',
      'V56 and the delete form takes document and entry together',
      `${deletedByForm.ok ?? deletedByForm.error}, entries left ${afterDelete.n}`)
    }
  }

  // ------------------------------------------------------- what is rendered --

  // The reader's own source, so V58 asks what it actually reads rather than
  // what somebody remembered to list beside it.
  const readerSource = readFileSync('src/lib/invoice-forms.ts', 'utf8')

  {
    // The form checks prove what the reader does with a FormData somebody
    // built. They cannot prove the SCREEN builds that FormData. Nothing that
    // reads the source can see it either.
    const rows = await invoicesFor(co.ledger.id)
    const one = rows.find((r) => r.status === 'draft') ?? rows[0]
    const detail = await invoiceDetail(one.id)
    // The page these checks read is the by-party browse now: the invoice list
    // is gone, and a document row sits on it beside the payments that settled
    // it (owner, 2026-09-03). Money IN, because this fixture's paper is
    // mostly sales.
    // A PARTLY settled document, so the Unpaid column has something to be
    // right or wrong about: on a document nobody has paid, what is owed and
    // what it was for are the same number, and a page showing the wrong one
    // of them looks perfect (spot-proof of block 290 found V115 blind).
    const toSettle = (await openItemsFor(co.ledger.id))
      .find((i) => i.direction === 'sales' && i.document_kind === 'invoice' && i.balance > 200n)
    if (toSettle) {
      await recordPayment({
        invoiceId: toSettle.invoice_id, bankAccountId: at('1000').id,
        amount: toSettle.balance / 2n, paidOn: '2026-09-01', actor: 'alicio@example.test',
      })
    }
    const ledgerRows = await partyLedger(co.ledger.id, 'in', '2000-01-01', '2099-12-31')

    const rendered = JSON.parse(execFileSync('npx',
      ['tsx', 'scripts/render-invoice-screens.tsx', stringify({
        ledgerId: co.ledger.id,
        ledgerRows,
        parties: { sales: [{ id: customer.id, label: 'Northwind Ltd.' }],
                   purchase: [{ id: supplier.id, label: 'Ironbark Supply Co.' }] },
        controlAccounts: { sales: [{ id: at('1200').id, label: '1200 — AR' }],
                           purchase: [{ id: at('2000').id, label: '2000 — AP' }] },
        lineAccounts: accounts.map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` })),
        detail: {
          invoiceId: one.id, direction: one.direction, status: one.status,
          entryNo: 'JE-2026-99999', lines: detail!.lines, total: detail!.total,
        },
      })],
      { encoding: 'utf-8', env: { ...process.env, NODE_OPTIONS: '' } })) as {
        slots: Record<string, string[]>
        lineRows: LineRowMarkup[]
        lineRowsEdited: LineRowMarkup[]
        typedTotal: string | null
        addButtons: number
        listFields: string[]
        links: string[]
        listShape: { tables: number; headerCols: number; dataRowCells: number[] }
        rowLinks: string[][]
        entryLinks: string[][]
        deniedEntryLinks: string[][]
        detailByStatus: Record<string, {
          forms: Array<Array<{ name: string; value: string }>>; text: string[]
        }>
        detailFields: Array<{ name: string; value: string }>
        detailText: string[]
      }

    // THE shape claim: a slot's three fields all carry the same number. That is
    // what makes numbering safe here — re-order the rows and a whole row moves.
    const slotNumbers = Object.keys(rendered.slots)
    const everySlotComplete = slotNumbers.every((n) =>
      ['account', 'description', 'amount'].every((f) => rendered.slots[n].includes(f)))
    check(slotNumbers.length === INVOICE_LINE_SLOTS && everySlotComplete,
      'V57 every line slot renders its account, description and amount under one number',
      `${slotNumbers.length} slots, ${JSON.stringify(rendered.slots['0'])}`)

    // THE TWO NUMBERS, seen together. A row carries a position — which names
    // its fields and which the person reads — and a key, which identifies it.
    // Every button inside a row must act on THAT row's key.
    //
    // Nothing else in this suite can see this. `V57` above would be just as
    // green if every remove button carried row 0's key: three well-formed
    // fields per row, grouped correctly, and a remove button that empties the
    // wrong line. The library checks would be green too — `removeRow` would be
    // doing exactly what it is asked. The mistake lives in the wiring, and the
    // wiring is only visible in the markup.
    // Asked of a blank form AND of one that has been edited. On the blank one
    // key 3 sits in position 3, so a button wired to the position looks
    // perfect; the edited render is where the two numbers come apart. The
    // blank one is still asked, because it is the form people actually open.
    const allRows = [...rendered.lineRows, ...rendered.lineRowsEdited]
    const wrongButton = allRows.filter((r) =>
      r.buttons.some((b) => b.does !== 'add' && b.actsOn !== r.key))
    const eachRowOneNumber = allRows.every((r) => r.fieldIndices.length === 1)
    check(rendered.lineRows.length === INVOICE_LINE_SLOTS
          && rendered.lineRowsEdited.length === 3
          && wrongButton.length === 0 && eachRowOneNumber,
      'V88 every button in a row acts on that row, and that row names one position',
      wrongButton.length > 0
        ? `row ${wrongButton[0].key} has a button on ${JSON.stringify(wrongButton[0].buttons.map((b) => b.actsOn))}`
        : `${allRows.length} rows across both renders, each button on its own key`)

    // And the edited render is actually distinguishing something. If its keys
    // ever line up with its positions again — a fixture tidied, a default
    // restored — `V88` and `V89` would go on passing while checking nothing,
    // which is the failure this whole suite keeps finding in itself.
    const keysDifferFromPositions = rendered.lineRowsEdited
      .filter((r, i) => Number(r.key) !== i).length
    check(keysDifferFromPositions >= 2,
      'V88a and the edited render has keys that are not positions, or it proves nothing',
      rendered.lineRowsEdited.map((r, i) => `${i}<-key ${r.key}`).join(' '))

    // Both row controls are present. A row that
    // renders its fields and no controls is a line editor that cannot edit, and
    // `V88` would pass on it — every one of its zero buttons acts on its own
    // key.
    const missingControls = allRows.filter((r) =>
      !['reorder', 'duplicate', 'remove'].every((d) => r.buttons.some((b) => b.does === d)))
    check(missingControls.length === 0 && rendered.addButtons === 1,
      'V88b every row carries a drag handle, Duplicate and Remove, with one Add for the form',
      missingControls.length > 0
        ? `row ${missingControls[0].key} has ${JSON.stringify(missingControls[0].buttons.map((b) => b.does))}`
        : `reorder/remove on ${allRows.length} rows, ${rendered.addButtons} Add`)

    // The positions run 0, 1, 2 … with no gap, and the number the person is
    // told is that position plus one. A form that renumbered its fields but not
    // its labels would refuse "Line 4" while the reader meant the fifth row.
    const numbering = (rows: LineRowMarkup[]) => ({
      positions: rows.map((r) => Number(r.fieldIndices[0])),
      labelled: rows.every((r, i) => r.buttons
        .every((b) => b.label === `${b.does === 'reorder' ? 'Reorder' : b.does === 'duplicate' ? 'Duplicate' : 'Remove'} line ${i + 1}`)),
    })
    const blank = numbering(rendered.lineRows)
    const editedNum = numbering(rendered.lineRowsEdited)
    check(blank.positions.every((n, i) => n === i) && blank.labelled
          && editedNum.positions.every((n, i) => n === i) && editedNum.labelled,
      'V89 positions run without a gap, and the number a person is shown is that position',
      `blank ${blank.positions.join(',')}, edited ${editedNum.positions.join(',')} `
        + `over keys ${rendered.lineRowsEdited.map((r) => r.key).join(',')}`)

    // Every row, including either end, can be dragged to any other position.
    // Pointer, keyboard and singleton disabling are exercised in browser QA.
    const handlesLive = allRows.every(r => r.buttons.some(b => b.does === 'reorder' && !b.disabled))
    const arrowsAbsent = allRows.every(r => !r.buttons.some(b => b.does === 'up' || b.does === 'down'))
    check(handlesLive && arrowsAbsent,
      'V89b every multi-row drag handle is enabled and arrow controls are absent',
      `handles enabled ${handlesLive}, arrows absent ${arrowsAbsent}`)

    // The reader reads every row the SCREEN renders, by the numbers the screen
    // used. `V48b` reads nine rows it built itself, which proves the reader is
    // unbounded and proves nothing about the form. This asks the reader for the
    // form's own field names.
    const asRendered = new FormData()
    asRendered.set(F.direction, 'sales')
    for (const r of rendered.lineRows) {
      asRendered.set(`line.${r.fieldIndices[0]}.account`, at('4000').id)
      asRendered.set(`line.${r.fieldIndices[0]}.amount`, '1.00')
    }
    const { lines: readRendered } = linesFrom(asRendered, 'sales', 'invoice', (id) => id)
    check(readRendered.length === rendered.lineRows.length,
      'V90 and the reader reads every row the screen rendered, by the screen\'s own names',
      `${readRendered.length} of ${rendered.lineRows.length}`)

    // An empty form adds up to nothing, and says so rather than saying nothing.
    check(rendered.typedTotal === formatMoney(0n),
      'V90b a form with nothing typed in it shows a total of nothing',
      rendered.typedTotal ?? 'no total rendered')

    // The lines are cleared when a save WORKS, and only then.
    //
    // Read out of the source, and this check is worth exactly what that is:
    // it pins the wiring and can see nothing about what happens at runtime. It
    // is here because the alternative is nothing at all — the callback is a
    // prop, invisible in markup, and it fires from an effect that no static
    // render runs. Without it, deleting the line would leave a form that keeps
    // its lines after saving and offers to save them again, and every check in
    // this suite would stay green.
    const screenSource = readFileSync('src/app/ledger/[ledgerId]/invoices/new/NewInvoiceForm.tsx', 'utf8')
    const formSource = readFileSync('src/components/ActionForm.tsx', 'utf8')
    const v91 = [
      // A form opened from a bill the assistant read (0064) is done rather
      // than cleared on success; every other new invoice clears its lines.
      ...(/onSucceeded=\{edit \? undefined : start \? \(s\) => setDone\(s\.ok \?\? 'Saved to the books\.'\) : \(\) => \{\s*setLineRows\(initialRows\(\)\); setInclusive\(false\)[^}]*\}\}/.test(screenSource)
        ? [] : ['the screen does not pass onSucceeded']),
      ...(/if \(state\.ok\) \{\s*\n[^]*?formRef\.current\?\.reset\(\)\s*\n\s*onSucceeded\?\.\(state\)/.test(formSource)
        ? [] : ['ActionForm does not reset-and-notify inside the state.ok branch']),
    ]
    check(v91.length === 0,
      'V91 the form clears its lines when a save works, and on nothing else (read from source)',
      v91.join('; ') || 'wired on both sides')

    // V96 — a REFUSED save keeps what was typed, on every screen at once.
    //
    // React clears an uncontrolled form whose `action` prop dispatched,
    // success or refusal alike, because the reset is scheduled before the
    // action runs. ActionForm therefore must submit through onSubmit with the
    // default prevented and dispatch inside its own transition; the moment it
    // hands the dispatcher back to the `action` prop, every uncontrolled field
    // on all nine screens goes back to being wiped by its own error messages.
    // Source-level, like V91: there is no browser here to type into.
    const v96 = [
      ...(/onSubmit: typeof bind === 'string' \? undefined : \(e: React\.FormEvent<HTMLFormElement>\) => \{/.test(formSource)
        ? [] : ['the wiring does not submit through its own handler']),
      ...(formSource.includes('e.preventDefault()')
        ? [] : ['the native submit (and its reset) is not prevented']),
      // What gets dispatched is THE FORM THE PERSON SUBMITTED. A review found
      // the first four conditions all stayed green with `new FormData()` —
      // every save posting empty — because nothing pinned the argument.
      ...(formSource.includes('const data = new FormData(e.currentTarget)')
        ? [] : ['the dispatched FormData is not read from the submitted form']),
      ...(/startTransition\(\(\) => dispatch\(data\)\)/.test(formSource)
        ? [] : ['the dispatch does not run in its own transition']),
      ...(/action: typeof bind === 'string' \? bind : undefined,/.test(formSource)
        ? [] : ['the action prop still carries the dispatcher, so React resets on refusal']),
    ]

    // The CLASS, not the instance. The first fix rewired ActionForm and called
    // the defect closed while eight other forms still dispatched through their
    // action prop and wiped typed fields on every refusal. So: the dispatcher
    // hook exists in exactly one file, and no client component binds a form's
    // action to anything but a string. (`RebuildButton` binds an inline server
    // action from a SERVER component and holds nothing but a button — the scan
    // covers 'use client' files, where a wiped field is a wiped person.)
    const { readdirSync: rd, statSync } = await import('node:fs')
    const walkTsx = (dir: string): string[] => rd(dir).flatMap((n) => {
      const full = `${dir}/${n}`
      if (statSync(full).isDirectory()) return walkTsx(full)
      return /\.tsx$/.test(n) ? [full] : []
    })
    for (const f of [...walkTsx('src/app'), ...walkTsx('src/components')]) {
      if (f.endsWith('components/ActionForm.tsx')) continue
      const src = readFileSync(f, 'utf8')
      if (src.includes('useActionState')) {
        v96.push(`${f} wires its own dispatcher instead of useActionForm`)
      }
      if (src.includes("'use client'") && /<form action=\{/.test(src)) {
        v96.push(`${f} binds a client form's action prop`)
      }
    }
    check(v96.length === 0,
      'V96 a refused save keeps every field, on every screen, because only one wiring exists',
      v96.join('; ') || 'one hook, no bound dispatchers anywhere')

    // ---------------------------------------------------------------------
    // PRESSING THE BUTTONS.
    //
    // Everything above reads: the row functions as functions, the markup as
    // text, the wiring as source. A review found what that leaves open — the
    // marker and the handler were two separate expressions, so `V88` compared
    // `row.key` to `row.key` and would have stayed green while every button
    // acted on a position instead of a row. Both sides spelled the same.
    //
    // `InvoiceLinesContent` keeps no state of its own, so it can be called and its
    // `onClick` props are the closures a browser would run.
    // ---------------------------------------------------------------------
    const editorState: RowState = { nextKey: 10, rows: [
      { key: 5, account: at('4000').id, description: 'moved up from the bottom', amount: '1.00', taxCode: 'OUT_OF_SCOPE' },
      { key: 2, account: at('4000').id, description: 'stayed', amount: '2.00', taxCode: 'OUT_OF_SCOPE' },
      { key: 9, account: at('5000').id, description: 'added last', amount: '3.00', taxCode: 'OUT_OF_SCOPE' },
    ] }
    const press = (does: string, position: number) => {
      let got: RowState | null = null
      const ed = editorRows(editorState, (s) => { got = s })
      ed.rows[position].button(does).props.onClick!()
      return got as RowState | null
    }

    // The row in the middle is key 2, its fields are named for position 1, and
    // it is neither first nor last — so removing by key, by position, or by
    // anything constant all give different answers.
    const removed = press('remove', 1)
    check(removed !== null && removed.rows.map((r) => r.key).join(',') === '5,9'
          && removed.rows[1].description === 'added last',
      'V92 pressing Remove under a row removes THAT row, not the one in its place',
      removed ? removed.rows.map((r) => `${r.key}:${r.description}`).join(' ') : 'nothing happened')

    // And every button's own `data-acts-on` tells the truth about what pressing
    // it does. This is what makes `V88`'s reading of the markup worth anything:
    // without it the marker is a label the component writes about itself.
    //
    // Read the marker off the BUTTON, not off the row div. The first version
    // read the row's `data-line-row` while its label named `data-acts-on`, so
    // setting every button's `data-acts-on` to the position left it green — the
    // attribute it claimed to guard was never touched.
    const markerLies = editorRows(editorState, () => {}).rows
      .map((r, i) => {
        const claimed = r.actsOn('remove')
        const after = press('remove', i)
        const gone = editorState.rows.filter((row) => !after?.rows.some((x) => x.key === row.key))
        if (claimed === undefined) return `position ${i} has no data-acts-on`
        if (gone.length !== 1) return `position ${i} removed ${gone.length} rows`
        return gone[0].key === claimed ? null : `position ${i} says ${claimed}, removed ${gone[0].key}`
      })
      .filter(Boolean)
    check(markerLies.length === 0,
      'V92b and every button removes the row its own data-acts-on names',
      markerLies.length === 0 ? 'all 3 rows' : markerLies.join(', '))

    // Drag targets are final positions, resolved from stable row keys.
    // These checks cover the pure move; browser QA exercises actual handles.
    const movedDown = moveRowTo(editorState, editorState.rows[0].key, 1)
    check(movedDown !== null && movedDown.rows.map((r) => r.key).join(',') === '2,5,9'
          && movedDown.rows[1].amount === '1.00',
      'V93 moving the first row to a target position carries its values',
      movedDown ? movedDown.rows.map((r) => `${r.key}:${r.amount}`).join(' ') : 'nothing happened')

    // Resolve the last key to the same target to cover movement both ways.
    const movedUp = moveRowTo(editorState, editorState.rows[2].key, 1)
    check(movedUp !== null && movedUp.rows.map((r) => r.key).join(',') === '5,9,2'
          && movedUp.rows[1].amount === '3.00',
      'V93b moving the last row to a target position carries its values',
      movedUp ? movedUp.rows.map((r) => `${r.key}:${r.amount}`).join(' ') : 'nothing happened')

    // Add is outside the rows, so it is found in the whole tree.
    let added: RowState | null = null
    const withAdd = editorRows(editorState, (s) => { added = s })
    withAdd.all.find((e) => e.type === 'button' && e.props['data-does'] === 'add')!
      .props.onClick!()
    const grewBy = added !== null ? (added as RowState).rows.length - editorState.rows.length : 0
    check(grewBy === 1 && (added as RowState | null)?.rows[3]?.key === editorState.nextKey
          && (added as RowState | null)?.rows[3]?.amount === '',
      'V94 pressing Add appends one blank row with a key nothing has held',
      added ? `${(added as RowState).rows.length} rows, new key ${(added as RowState).rows[3].key}` : 'nothing happened')

    // Typing is the same seam. A field's onChange carrying a position instead
    // of its row writes the figure into the line above or below it, and the
    // screen shows exactly what was typed — in the wrong row.
    let typedInto: RowState | null = null
    const typing = editorRows(editorState, (s) => { typedInto = s })
    // The LAST row, whose position (2) and key (9) are different numbers.
    // Guarded rather than asserted with `!`: under a mutation that renames the
    // field this lookup returns nothing, and an unguarded `.props` there throws
    // a stack trace where the suite's own red line belongs.
    const amountField = typing.rows[2]?.field(lineAmount(2))
    if (!amountField) {
      // Its OWN id. This branch says the field is missing; it says nothing
      // about what typing into it would do. Printing V95's label here meant a
      // mutation that only renames the field reddened V95 — and the coverage
      // count, which keys on the label, then recorded the typing assertion as
      // having been made to fail when it had not run. `mutations.md` had that
      // exact line in it. One id per claim; a lookup guard is its own claim.
      fail('V95g the third row has the fields the typing checks look for',
        `no field named ${lineAmount(2)}`)
    } else {
      amountField.props.onChange!({ target: { value: '77.00' } })
      const after = typedInto as RowState | null
      check(after?.rows.find((r) => r.key === 9)?.amount === '77.00'
            && after?.rows.find((r) => r.key === 2)?.amount === '2.00',
        'V95 typing in a row writes that row, and leaves the row beside it alone',
        after ? after.rows.map((r) => `${r.key}:${r.amount}`).join(' ') : 'nothing happened')
    }

    // The other two fields in the row are the same seam as `V95` and were the
    // other two unpressed expressions. Written as a loop over the three field
    // makers rather than three copies, so a fourth field cannot be added to the
    // row and quietly not be here.
    for (const [id, what, article, nameOf, value] of [
      // A literal, not a real account id. `editRow` stores whatever the field
      // hands it, so the value only has to be one the row being typed into does
      // NOT already hold — otherwise the first conjunct below is satisfied
      // before anything is typed and the check asserts nothing. (A value a
      // NEIGHBOUR holds would be harmless: the assertion names key 9.)
      // It also cannot throw: `at('5100')` here was a lookup from another
      // fixture's scope, and it took the suite down with a stack trace where a
      // red line belongs.
      ['V95b', 'account', 'an account', lineAccount, 'no-row-holds-this'],
      ['V95c', 'description', 'a description', lineDescription, 'typed into the last row'],
    ] as const) {
      const label = `${id} typing ${article} writes that row, not the one beside it`
      let wrote: RowState | null = null
      const ed = editorRows(editorState, (st) => { wrote = st })
      // Position 2, key 9 — the two numbers differ, which is the whole point.
      const field = ed.rows[2]?.field(nameOf(2))
      if (!field) {
        fail('V95g the third row has the fields the typing checks look for',
          `no field named ${nameOf(2)}`)
        continue
      }
      // The account is a Picker now, not a select: it reports the id it chose
      // rather than a change event, because a parent that keeps the row's own
      // state must stay in step with it (2026-09-07). The description is
      // still a plain input.
      //
      // Guarded, and with its own id — the same reason `V95g` has one. A
      // picker rendered with no `onChange` is a choice that never reaches the
      // row, and calling `undefined` here would take the suite down with a
      // stack trace where its red line belongs.
      const props = field.props as { onChange?: (arg: unknown) => void }
      if (typeof props.onChange !== 'function') {
        fail(`${id}g the ${what} field reports what was chosen`,
          `the field named ${nameOf(2)} has no onChange`)
        continue
      }
      if (what === 'account') props.onChange(value)
      else props.onChange({ target: { value } })
      const after = wrote as RowState | null
      const before = editorState.rows
      check(after?.rows.find((r) => r.key === 9)?.[what] === value
            && after?.rows.find((r) => r.key === 2)?.[what] === before[1][what]
            && after?.rows.find((r) => r.key === 5)?.[what] === before[0][what],
        label,
        after ? after.rows.map((r) => `${r.key}:${r[what]}`).join(' ') : 'nothing happened')
    }

    // Every header field the READER reads, discovered from the reader's own
    // source rather than from a list typed out beside it. The hand-written twin
    // could only notice the form losing a name someone had remembered to list —
    // never the reader gaining one, which is the drift the label claims to
    // cover. It had already happened: the reader read `note` and the form had
    // no note field, and this check was green.
    const readerReads = Object.entries(F)
      .filter(([key]) => readerSource.includes(`F.${key}`))
      .map(([, name]) => name as string)
    const missing = readerReads
      .filter((w) => w !== F.invoiceId && w !== F.reason)
      .filter((w) => !rendered.listFields.includes(w))
    check(missing.length === 0 && readerReads.includes(F.note),
      'V58 and the form carries every header field the reader reads',
      missing.join(', ') || `${readerReads.length} read by the reader, all rendered`)

    // The button under an invoice posts THAT invoice. This is the seam the
    // sales tax round spent six rounds on: a screen rendering the right
    // controls against the wrong hidden id.
    // EVERY FORM carries exactly one invoiceId, and it is this invoice's.
    //
    // Asked of the fields that happen to exist, a form carrying NONE — or
    // carrying the id under another name — leaves the other form's field
    // behind: the count is still above zero, every value is still right, and
    // the button posts an empty id.
    //
    // Once per status too, because the Void form in the `posted` branch is a
    // different form with its own hidden field, and rendering whichever invoice
    // came first in the list never reached it.
    const formTrouble: string[] = []
    for (const [status, view] of Object.entries(rendered.detailByStatus)) {
      for (const [n, fields] of view.forms.entries()) {
        const ids = fields.filter((f) => f.name === F.invoiceId)
        if (ids.length !== 1) formTrouble.push(`${status} form ${n} has ${ids.length} ids`)
        else if (ids[0].value !== one.id) formTrouble.push(`${status} form ${n} has the wrong id`)
      }
    }
    const formCount = Object.values(rendered.detailByStatus)
      .reduce((n, v) => n + v.forms.length, 0)
    check(formTrouble.length === 0 && formCount >= 3,
      'V59 every form, on every status, carries exactly one correct invoice id',
      formTrouble.join('; ') || `${formCount} forms across draft, posted and void`)

    // Each row's link, taken from INSIDE that row. Scraping every href off the
    // page and comparing the two collections is satisfied by a screen that put
    // row A's link on row B — which is the only mistake here worth catching.
    // Grouped the way the screen groups: parties in name order, each party's
    // rows in the order the reader returned them. The check states the
    // grouping rule in its own words rather than assuming the fixture has one
    // party — it did, so this passed by the shape of the fixture rather than
    // by the shape of the page (critic, 2026-09-03).
    //
    // And each row's destination is its OWN: a document row opens its
    // document, an entry row opens its entry. Sending a payment to the
    // invoice it settled would look perfectly reasonable and be wrong.
    const names = [...new Set(ledgerRows.map((r) => r.party_name))]
      .sort((a, b) => (a ?? '\uffff').localeCompare(b ?? '\uffff'))
    const ordered = names.flatMap((n) => ledgerRows.filter((r) => r.party_name === n))
    const expected = ordered.map((r) => r.href.kind === 'invoice'
      ? `/ledger/${co.ledger.id}/invoices/${r.href.id}`
      : `/ledger/${co.ledger.id}/entries/${r.href.id}`)
    const actual = rendered.rowLinks.map((hrefs) => hrefs[0])
    const wrongAt = expected.findIndex((e, i) => actual[i] !== e)
    check(actual.length === expected.length && wrongAt === -1,
      'V60 and each row links to the document or entry that row is about',
      wrongAt === -1
        ? `${actual.length} rows, each to its own`
        : `row ${wrongAt} links to …${actual[wrongAt]?.slice(-8)}, expected …${expected[wrongAt].slice(-8)}`)

    const journalLinks = ordered.map(row => row.entry_id && row.entry_no
      ? [`/ledger/${co.ledger.id}/entries/${row.entry_id}`] : [])
    check(JSON.stringify(rendered.entryLinks) === JSON.stringify(journalLinks)
      && rendered.deniedEntryLinks.length === ordered.length
      && rendered.deniedEntryLinks.every(links => links.length === 0),
      'V124 Entry cells open their own journal only with journal access',
      `${journalLinks.filter(links => links.length).length} journal links; none offered without journal access`)

    // V111 — the by-party list is ONE table and every row of it has the same
    //        columns. Columns cannot line up across parties otherwise, which
    //        is precisely what the owner saw: a table per party meant each
    //        party's dates were measured against that party's own text
    //        (2026-09-03). Every figure was right and the page was ragged, so
    //        no check on the data could have seen it — this one reads the
    //        rendered SHAPE.
    const shape = rendered.listShape
    const ragged = shape.dataRowCells.filter((n) => n !== shape.headerCols)
    check(shape.tables === 1 && shape.headerCols > 0
          && shape.dataRowCells.length > 0 && ragged.length === 0,
      'V111 the by-party list is one table, every row the same columns',
      `${shape.tables} table(s), ${shape.headerCols} header columns, ${shape.dataRowCells.length} rows`
      + (ragged.length ? `, ragged rows with ${[...new Set(ragged)].join('/')} cells` : ''))

    // What the reader sees for an amount is what they typed, not the ledger's
    // sign — otherwise the screen disagrees with itself between entering a
    // figure and reading it back.
    // A LINE cell, not the total. The total is rendered WITHOUT `asEntered`, so
    // asserting it proves nothing about the read-back sign — this check stayed
    // green with `asEntered` made the identity, which is the one thing it
    // exists to catch.
    //
    // The line chosen is one whose stored sign differs from what it must show:
    // a sales line is stored negative and has to read back positive. Both
    // halves are asserted, because "the right string is somewhere on the page"
    // is also true of a page showing both.
    const storedNegative = detail!.lines.find((l) => l.amount < 0n)
    const mustShow = storedNegative ? formatMoney(-storedNegative.amount) : ''
    const mustNotShow = storedNegative ? formatMoney(storedNegative.amount) : ''
    check(storedNegative !== undefined
          && rendered.detailText.includes(mustShow)
          && !rendered.detailText.includes(mustNotShow),
      'V61 and a line reads back the way it was typed, not the way it is stored',
      `${mustShow} shown, ${mustNotShow} absent`)
  }

  // ============================================================ open books ==
  // V100+: a live invoice is edited and deleted through its own door, and the
  // ledger, the balance cache, and the applications move with it in one
  // transaction (docs/design/14-open-books.md).
  {
    // Dedicated accounts: an earlier block FABRICATES a journal entry with
    // raw SQL (deliberately, to prove a defense) and that entry never touches
    // the balance cache — so a ledger-wide drift probe here would report the
    // fixture, not the door. These two accounts see only open-book traffic.
    const obAccts = await importAccounts(co.company.id, [
      { entityId: co.company.id, code: '1250', name: 'AR — Open Books', accountType: 'asset' },
      { entityId: co.company.id, code: '4100', name: 'Revenue — Open Books', accountType: 'revenue' },
    ], 'alicio@example.test')
    await setAccountRoles(obAccts[0].id, ['trade_receivables'], 'alicio@example.test')
    await setAccountRoles(obAccts[1].id, ['revenue_from_contracts'], 'alicio@example.test')
    const obAt = (code: string) => obAccts.find((a) => a.code === code)!
    const obDrift = async () => (await db.execute<{ account_code: string }>(raw`
      SELECT account_code FROM check_balance_integrity(${co.ledger.id}::uuid)`))
      .filter((d) => d.account_code === '1250' || d.account_code === '4100')

    const inv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: obAt('1250').id, issuedOn: '2026-07-05', dueOn: '2026-07-25',
      number: 'INV-OB-1', lines: [{ accountId: obAt('4100').id, amount: -parseMoney('600.00') }],
      actor: 'alicio@example.test',
    })
    await postInvoice(inv.id, 'alicio@example.test')

    // V100 — the edit changes figures and dates; the entry follows in the
    //        same breath, under the same number; the cache does not drift.
    const before = await invoiceDetail(inv.id)
    await tryDoor('V100 an edit moves the document and its entry together', () => editInvoice(inv.id, {
      partyId: customer.id, controlAccountId: obAt('1250').id,
      issuedOn: '2026-07-06', dueOn: '2026-07-28', number: 'INV-OB-1R',
      lines: [{ accountId: obAt('4100').id, amount: -parseMoney('750.00') }],
      actor: 'alicio@example.test',
    }))
    const after = await invoiceDetail(inv.id)
    const [entryAfter] = await db.execute<{ entry_date: string; description: string; total_debit: string; entry_no: string }>(raw`
      SELECT je.entry_date::text, je.description, je.total_debit::text, je.entry_no
        FROM journal_entry je JOIN invoice i ON i.entry_id = je.id
       WHERE i.id = ${inv.id}::uuid`)
    check(before!.total === parseMoney('600.00') && after!.total === parseMoney('750.00')
          && entryAfter.entry_date === '2026-07-06' && entryAfter.total_debit === '75000'
          && entryAfter.description.includes('INV-OB-1R') && entryAfter.entry_no.startsWith('INV-'),
      'V100 an edit moves the document and its entry together',
      `600.00 -> 750.00, entry ${entryAfter.entry_no} follows to ${entryAfter.entry_date}`)
    const drift = await obDrift()
    check(drift.length === 0, 'V100b and the cache moved with it',
      drift.length === 0 ? 'no drift on the accounts this door touched' : `${drift.length} disagreements`)

    // V101 — a payment applied to it is CASCADE-released by the next edit
    //        (the owner's decision): the money returns to on-account, the
    //        invoice's balance returns to its face.
    await recordPayment({
      invoiceId: inv.id, bankAccountId: at('1000').id, amount: parseMoney('200.00'),
      paidOn: '2026-07-10', actor: 'alicio@example.test',
    })
    const paid = await balanceOf(inv.id)
    const edited = await tryDoor('V101 an edit releases what was applied, and says how much', () => editInvoice(inv.id, {
      partyId: customer.id, controlAccountId: obAt('1250').id,
      issuedOn: '2026-07-06', dueOn: '2026-07-28', number: 'INV-OB-1R',
      lines: [{ accountId: obAt('4100').id, amount: -parseMoney('800.00') }],
      actor: 'alicio@example.test',
    }))
    const unpaid = await balanceOf(inv.id)
    check(paid.balance === parseMoney('550.00')
          && edited?.cascadedApplications === 1
          && unpaid.balance === parseMoney('800.00') && unpaid.applied === 0n,
      'V101 an edit releases what was applied, and says how much',
      `balance 550.00 -> 800.00, ${edited?.cascadedApplications} application released`)

    // V102 — the payment ENTRY survived the cascade: the money is real and
    //        stays on account; only the pairing died.
    const [payEntry] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM journal_entry
       WHERE ledger_id = ${co.ledger.id}::uuid AND source_type = 'payment' AND status = 'posted'
         AND entry_date = '2026-07-10'`)
    check(payEntry.n === '1', 'V102 the released payment survives on account', 'entry intact, pairing gone')

    // V103 — delete: document gone, entry gone, cache clean, audit keeps the
    //        whole document, and the invoice number is free for reuse.
    const del = await tryDoor('V103 a delete takes document and entry together, audited', () => deleteInvoice(inv.id, 'alicio@example.test'))
    const [gone] = await db.execute<{ docs: string; entries: string }>(raw`
      SELECT (SELECT count(*) FROM invoice WHERE id = ${inv.id}::uuid)::text AS docs,
             (SELECT count(*) FROM journal_entry WHERE source_id = ${inv.id}::uuid)::text AS entries`)
    const [auditRow] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM audit_log
       WHERE action = 'delete' AND table_name = 'invoice' AND record_id = ${inv.id}`)
    const drift2 = await obDrift()
    check(gone.docs === '0' && gone.entries === '0' && auditRow?.n === '1' && drift2.length === 0
          && del?.number === 'INV-OB-1R',
      'V103 a delete takes document and entry together, audited',
      `${del?.number} gone, cache clean, audit holds the document`)

    // V104 — a closed period refuses the edit with the period's own sentence.
    const inv2 = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: obAt('1250').id, issuedOn: '2026-08-05', dueOn: '2026-08-25',
      number: 'INV-OB-2', lines: [{ accountId: obAt('4100').id, amount: -parseMoney('100.00') }],
      actor: 'alicio@example.test',
    })
    await postInvoice(inv2.id, 'alicio@example.test')
    await byHand((tx) => tx.execute(raw`
      UPDATE fiscal_period SET status = 'closed'
       WHERE ledger_id = ${co.ledger.id}::uuid AND period_no = 8`))
    await expectError('V104 a closed period refuses the edit', 'PERIOD_CLOSED', () =>
      editInvoice(inv2.id, {
        partyId: customer.id, controlAccountId: obAt('1250').id,
        issuedOn: '2026-08-05', dueOn: '2026-08-25', number: 'INV-OB-2',
        lines: [{ accountId: obAt('4100').id, amount: -parseMoney('101.00') }],
      }))
    await expectError('V104b and the delete', 'PERIOD_CLOSED', () => deleteInvoice(inv2.id))
    await byHand((tx) => tx.execute(raw`
      UPDATE fiscal_period SET status = 'open'
       WHERE ledger_id = ${co.ledger.id}::uuid AND period_no = 8`))
    await tryDoor('V104c cleanup delete', () => deleteInvoice(inv2.id, 'alicio@example.test'))
  }

  // ------------------------------------------------------------- tax tags --
  // V105+: a line's tag computes its tax on save (14-open-books §4). One
  // arithmetic with the quick forms; the stored rows say which lines a person
  // typed and which the tags generated, so an edit recomputes exactly the
  // generated ones.
  {
    const nameOf = (id: string) => {
      const a = accounts.find((x) => x.id === id)
      return a ? `${a.code} — ${a.name}` : id
    }
    const fd = (pairs: Record<string, string>) => {
      const f = new FormData()
      f.set(F.ledgerId, co.ledger.id)
      for (const [k, v] of Object.entries(pairs)) f.set(k, v)
      return f
    }
    const tagged = (over: Record<string, string>) => fd({
      [F.direction]: 'sales', [F.partyId]: customer.id,
      [F.controlAccountId]: at('1200').id,
      [F.issuedOn]: '2026-09-03', [F.dueOn]: '2026-09-23',
      [lineAccount(0)]: at('4000').id,
      [lineDescription(0)]: 'work',
      [lineAmount(0)]: '100.00',
      [`line.0.taxCode`]: 'GST_PST',
      ...over,
    })

    // V105 — sales: base stays on the line; the taxes land as GENERATED lines
    //        on the role-picked accounts; the document total carries all three.
    const made = await createInvoiceFromForm(tagged({ [F.number]: 'INV-TAG-1' }), nameOf, 'alicio@example.test')
    const tag1 = (await invoicesFor(co.ledger.id, 'sales')).find((i) => i.number === 'INV-TAG-1')
    const d1 = tag1 && await invoiceDetail(tag1.id)
    const genGst = d1?.lines.find((l) => l.generated_for === 'GST')
    const genPst = d1?.lines.find((l) => l.generated_for === 'PST')
    check(made.ok !== undefined && d1?.total === parseMoney('112.00')
          && genGst?.code === '2300' && BigInt(genGst.amount) === -parseMoney('5.00')
          && genPst?.code === '2350' && BigInt(genPst.amount) === -parseMoney('7.00'),
      'V105 a sales tag generates the collected-tax lines',
      `total ${d1 ? formatMoney(d1.total) : '?'}; GST -> ${genGst?.code}, PST -> ${genPst?.code}`)

    // V106 — purchase: GST goes to the recoverable account; PST FOLDS into
    //        the typed line, because in BC it is cost, not a claim.
    const madeP = await createInvoiceFromForm(tagged({
      [F.direction]: 'purchase', [F.partyId]: supplier.id,
      [F.controlAccountId]: at('2000').id, [F.theirRef]: 'BILL-TAG-1',
      [lineAccount(0)]: at('5000').id,
    }), nameOf, 'alicio@example.test')
    const tagP = (await invoicesFor(co.ledger.id, 'purchase')).find((i) => i.their_ref === 'BILL-TAG-1')
    const dP = tagP && await invoiceDetail(tagP.id)
    const pLine = dP?.lines.find((l) => !l.generated_for)
    const pGst = dP?.lines.find((l) => l.generated_for === 'GST')
    check(Boolean(madeP.ok !== undefined && dP && dP.total === parseMoney('112.00')
          && pLine && BigInt(pLine.amount) === parseMoney('107.00')
          && pGst?.code === '2310' && BigInt(pGst.amount) === parseMoney('5.00')
          && dP.lines.every((l) => l.generated_for !== 'PST')),
      'V106 a purchase folds PST into the cost and claims only the GST',
      `line ${pLine ? formatMoney(BigInt(pLine.amount)) : '?'}, GST -> ${pGst?.code}`)

    // V107 — inclusive: typing the till receipt's 112.00 stores the same
    //        three figures, and the total reproduces the receipt to the cent.
    const madeI = await createInvoiceFromForm(tagged({
      [F.number]: 'INV-TAG-2', [F.amounts]: 'inclusive', [lineAmount(0)]: '112.00',
    }), nameOf, 'alicio@example.test')
    const tagI = (await invoicesFor(co.ledger.id, 'sales')).find((i) => i.number === 'INV-TAG-2')
    const dI = tagI && await invoiceDetail(tagI.id)
    check(madeI.ok !== undefined && dI?.total === parseMoney('112.00')
          && dI.lines.filter((l) => l.generated_for).length === 2,
      'V107 inclusive amounts back the base out and keep the total',
      `total ${dI ? formatMoney(dI.total) : '?'}`)

    // V107b — an edit reloads only the typed lines and recomputes the rest:
    //         retagging the line to GST alone drops the PST line.
    if (tag1) {
      const reEdit = await updateInvoiceFromForm(fd({
        [F.invoiceId]: tag1.id, [F.direction]: 'sales', [F.partyId]: customer.id,
        [F.controlAccountId]: at('1200').id,
        [F.issuedOn]: '2026-09-03', [F.dueOn]: '2026-09-23', [F.number]: 'INV-TAG-1',
        [lineAccount(0)]: at('4000').id, [lineAmount(0)]: '100.00',
        [`line.0.taxCode`]: 'GST',
      }), nameOf, 'alicio@example.test')
      const d1b = await invoiceDetail(tag1.id)
      check(reEdit.ok !== undefined && d1b?.total === parseMoney('105.00')
            && d1b.lines.every((l) => l.generated_for !== 'PST'),
        'V107b retagging recomputes the generated lines, nothing else',
        `total ${d1b ? formatMoney(d1b.total) : '?'}`)
    }

    // V110 — the CREATE reader honours the kind. It hardcoded 'invoice'
    //        while the edit reader honoured the field: a credit note made
    //        through the form silently became an invoice and debited the
    //        receivable — the seed company found it when the application
    //        bounced off 0034.
    const cnMade = await createInvoiceFromForm(fd({
      [F.direction]: 'sales', [F.kind]: 'credit_note',
      [F.partyId]: customer.id, [F.controlAccountId]: at('1200').id,
      [F.issuedOn]: '2026-09-12', [F.dueOn]: '2026-09-12', [F.number]: 'CN-OB-2',
      [lineAccount(0)]: at('4000').id, [lineDescription(0)]: 'Returned work',
      [lineAmount(0)]: '50.00', ['line.0.taxCode']: 'GST',
    }), nameOf, 'alicio@example.test')
    const cn2 = (await invoicesFor(co.ledger.id, 'sales')).find((i) => i.number === 'CN-OB-2')
    const cn2ctl = cn2 ? (await db.execute<{ amount: string }>(raw`
      SELECT jl.amount::text FROM journal_line jl
        JOIN invoice i ON i.entry_id = jl.entry_id
       WHERE i.id = ${cn2.id}::uuid AND jl.account_id = ${at('1200').id}::uuid`))[0] : undefined
    check(cnMade.ok !== undefined && cn2?.document_kind === 'credit_note'
          && cn2ctl?.amount === (-parseMoney('52.50')).toString(),
      'V110 the create form mints a real credit note, receivable credited',
      `${cn2?.document_kind}; control ${cn2ctl?.amount ?? 'no line'}`)

    // V109 — THE ONE THE BLOCK VERDICT WAS FOR: a credit note saved through
    //        the edit door UNCHANGED keeps its own signs. ledgerAmount keyed
    //        on direction alone flipped every CN line and refused the save
    //        with a sentence blaming the person.
    // Guarded: block 139's mutation makes the CREATE of this very fixture
    //          throw, and an unguarded fixture killed a whole evidence run.
    const cn = await tryDoor('V109 a credit note saved unchanged stays itself', async () => {
      const made = await createInvoice({
        ledgerId: co.ledger.id, direction: 'sales', kind: 'credit_note',
        partyId: customer.id, controlAccountId: at('1200').id,
        issuedOn: '2026-09-10', dueOn: '2026-09-10', number: 'CN-OB-1',
        lines: [{ accountId: at('4000').id, amount: parseMoney('80.00') }],
        actor: 'alicio@example.test',
      })
      await postInvoice(made.id, 'alicio@example.test')
      return made
    })
    if (cn) {
      const cnBefore = await invoiceDetail(cn.id)
      const cnEdit = await updateInvoiceFromForm(fd({
        [F.invoiceId]: cn.id, [F.direction]: 'sales', [F.kind]: 'credit_note',
        [F.partyId]: customer.id, [F.controlAccountId]: at('1200').id,
        [F.issuedOn]: '2026-09-10', [F.dueOn]: '2026-09-10', [F.number]: 'CN-OB-1',
        [lineAccount(0)]: at('4000').id, [lineAmount(0)]: '80.00',
      }), nameOf, 'alicio@example.test')
      const cnAfter = await invoiceDetail(cn.id)
      check(cnEdit.ok !== undefined && cnBefore?.total === parseMoney('80.00')
            && cnAfter?.total === parseMoney('80.00'),
        'V109 a credit note saved unchanged stays itself',
        cnEdit.ok ?? cnEdit.error ?? '')
    }

    // V108 — a tag with no account in the role is refused BY NAME, before
    //        anything is created. The first version of this check asserted
    //        the happy arm and its comment claimed this one — green for the
    //        wrong reason, caught by critic round 1.
    const bareCo = await createCompany({ code: 'BARE2', name: 'No Roles Ltd.' }, 'alicio@example.test')
    const bareRefusal = await resolveTaggedLines(bareCo.ledger.id, 'sales', 'invoice', [{
      index: 0, typed: parseMoney('10.00'), taxCode: 'GST',
      line: { accountId: at('4000').id, amount: -parseMoney('10.00'), taxCode: 'GST' },
    }], false, '2026-05-01')
    const bareOk = await resolveTaggedLines(co.ledger.id, 'sales', 'invoice', [{
      index: 0, typed: parseMoney('10.00'), taxCode: 'GST',
      line: { accountId: at('4000').id, amount: -parseMoney('10.00'), taxCode: 'GST' },
    }], false, '2026-05-01')
    check(bareRefusal.error?.includes('gst_hst_payable') === true
          && bareOk.error === undefined && bareOk.lines.length === 2,
      'V108 a tag with no role account is refused by name, else it resolves',
      bareRefusal.error?.slice(0, 60) ?? 'no refusal')

    // V112 — the expenses browse shows the SUPPLIER's own number for a bill.
    //        The bill already holds it (`their_ref`); the browse must read it
    //        from there rather than from a copy, and must not fall back to our
    //        own number while theirs exists — showing OUR number under the
    //        heading "their invoice #" is the failure that looks fine.
    const withRef = await createInvoice({
      ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
      controlAccountId: at('2000').id, issuedOn: '2026-09-12', dueOn: '2026-10-12',
      number: 'OURS-1', theirRef: 'SUP-7788',
      lines: [{ accountId: at('5000').id, amount: parseMoney('55.00') }],
      actor: 'alicio@example.test',
    })
    const refPosted = await postInvoice(withRef.id, 'alicio@example.test')
    const browsed = await entriesByParty(co.ledger.id, 'expense', '2026-09-12', '2026-09-12')
    const refRow = browsed.find((r) => r.entry_id === refPosted.entryId)
    check(refRow?.doc_ref === 'SUP-7788',
      'V112 a bill browses under the supplier\'s own number',
      refRow ? `doc_ref ${refRow.doc_ref ?? 'null'} (ours is OURS-1)` : 'the bill is not in the browse')

    // V114 — the merged page counts what hit the BOOKS and nothing else.
    //        A bill and the payment that settled it are two rows about one
    //        thousand dollars, and adding them would make two thousand of
    //        nothing (owner, 2026-09-03: "balance 就是真正的未付余额" — two
    //        questions, so two columns). The first column must therefore sum
    //        to exactly what `entriesByParty` — the reader X32 ties to the
    //        trial balance — already said, with payments and unposted paper
    //        contributing none of it.
    const merged = await partyLedger(co.ledger.id, 'in', '2000-01-01', '2099-12-31')
    const mergedSum = merged.reduce((n, r) => n + BigInt(r.pl_amount ?? 0n), 0n)
    // The other side is the JOURNAL, read flat — not `entriesByParty`, whose
    // rows this page copies verbatim, so comparing against it was an
    // identity dressed as a tie (critic, 2026-09-03). This is the same shape
    // X32 uses, with the same exclusions.
    const [movement] = await db.execute<{ m: string }>(raw`
      SELECT COALESCE(SUM(jl.amount), 0)::text AS m
        FROM journal_entry je
        JOIN journal_line jl ON jl.entry_id = je.id
        JOIN account a ON a.id = jl.account_id
       WHERE je.ledger_id = ${co.ledger.id}::uuid
         AND je.status IN ('posted', 'reversed')
         AND je.source_type NOT IN ('opening_balance', 'period_close')
         AND a.account_type = 'revenue'::account_type`)
    const plainSum = BigInt(movement.m)
    const payments = merged.filter((r) => r.kind === 'Payment')
    const paymentsCounted = payments.filter((r) => r.pl_amount !== null)
    check(mergedSum === plainSum && payments.length > 0 && paymentsCounted.length === 0,
      'V114 the merged page adds up the books, not the payments as well',
      mergedSum !== plainSum
        ? `the page adds to ${formatMoney(mergedSum)}, the journal to ${formatMoney(plainSum)}`
        : paymentsCounted.length > 0
        ? `${paymentsCounted.length} payment row(s) carry a p&l figure`
        : payments.length === 0 ? 'no payment rows in the fixture — nothing was proved'
        : `${formatMoney(mergedSum)} both ways, ${payments.length} payments counted as none of it`)

    // V121 — money out that touched no expense account is still money out.
    //        A quick "expense" that bought a laptop lands on 1500, so the
    //        account-type read never returns it and the balances read only
    //        while it is owed: paid on the spot, it vanished from the page.
    //        It is a row now — with NO p&l figure, so the tie above holds —
    //        and the row says where the money went.
    {
      const { postQuickEntry } = await import('../src/lib/quick')
      const shop = await createParty({ kind: 'organisation', name: 'Laptop Land',
        roles: [{ entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' }], actor: 'alicio@example.test' })
      // This fixture's chart has no fixed-asset account; one is made for the purchase.
      const equipment = await createAccount({ entityId: co.company.id, code: '1500', name: 'Equipment',
        accountType: 'asset' }, 'alicio@example.test')
      await postQuickEntry({
        ledgerId: co.ledger.id, kind: 'expense', entryDate: '2026-09-05', description: 'New laptop for the office',
        bankAccountId: at('1000').id, partyId: shop.id, accountId: equipment.id, amount: parseMoney('2500.00'),
        actor: 'alicio@example.test',
      })
      const out = await partyLedger(co.ledger.id, 'out', '2026-09-01', '2026-09-30')
      const laptop = out.find((r) => r.description === 'New laptop for the office')
      const outSum = out.reduce((n, r) => n + BigInt(r.pl_amount ?? 0n), 0n)
      const [expenseMovement] = await db.execute<{ m: string }>(raw`
        SELECT COALESCE(SUM(jl.amount), 0)::text AS m
          FROM journal_entry je
          JOIN journal_line jl ON jl.entry_id = je.id
          JOIN account a ON a.id = jl.account_id
         WHERE je.ledger_id = ${co.ledger.id}::uuid
           AND je.status IN ('posted', 'reversed')
           AND je.source_type NOT IN ('opening_balance', 'period_close')
           AND je.entry_date BETWEEN '2026-09-01' AND '2026-09-30'
           AND a.account_type = 'expense'::account_type`)
      check(laptop !== undefined && laptop.pl_amount === null && laptop.kind === 'Expense'
        && (laptop.note ?? '').includes('1500') && laptop.party_name === 'Laptop Land'
        && outSum === BigInt(expenseMovement.m),
        'V121 a purchase that landed on the balance sheet is on the money-out page, outside the total',
        laptop
          ? `"${laptop.description}" — ${laptop.kind}, p&l ${laptop.pl_amount ?? 'none'}, note "${laptop.note ?? ''}"; `
            + `the page adds to ${formatMoney(outSum)}, the expense accounts moved ${formatMoney(BigInt(expenseMovement.m))}`
          : `the laptop is not on the page (${out.length} rows)`)
    }

    // V115 — and the second column is `payments.ts`'s own answer, not a
    //        second one. Every document row's Unpaid must equal what
    //        `balanceOf` says for that document, negated for a credit note; a row that never reached the
    //        books owes nothing at all.
    // Over a NARROW range, deliberately. The first version asked only over
    // all time, and the Unpaid column was silently scoped to whatever the
    // range picker held: a bill issued before the window had no row at all
    // and its debt vanished from the column and the subtotal, while the page
    // called it a position (critic, 2026-09-03). A debt is owed today or it
    // is not, so it must survive a window that excludes the day it was
    // raised.
    const narrow = await partyLedger(co.ledger.id, 'in', '2026-09-02', '2026-09-03')
    const owedNarrow = narrow.filter((r) => r.unpaid && BigInt(r.unpaid) !== 0n)
    const owedWide = merged.filter((r) => r.unpaid && BigInt(r.unpaid) !== 0n)
    const sum = (rs: typeof merged) => rs.reduce((n, r) => n + BigInt(r.unpaid ?? 0n), 0n)

    const docRows = merged.filter((r) => r.href.kind === 'invoice' && r.state === 'posted')
    const owedApart: string[] = []
    // And at least one document must be PARTLY settled, or the column cannot
    // discriminate: on a document nobody has paid, what is owed and what it
    // was for are the same number, and a page showing the wrong one of them
    // looks perfect (spot-proof of block 290).
    let discriminating = 0
    for (const r of docRows) {
      const owed = await balanceOf(r.href.id)
      if (owed.debt !== owed.balance) discriminating++
      const expected = r.kind === 'Credit note' ? -owed.balance : owed.balance
      if (String(expected) !== String(r.unpaid)) {
        owedApart.push(`${r.doc_ref ?? r.key}: page ${r.unpaid}, payments.ts ${expected}`)
      }
    }
    const unposted = merged.filter((r) => r.state === 'draft' || r.state === 'void')
    // Unposted paper must be ON the page as well as owing nothing: a draft
    // nobody can see is the state this merge was meant to end, and
    // `every()` over an empty list is true.
    check(docRows.length >= 2 && owedApart.length === 0 && unposted.length > 0
          && discriminating > 0
          && owedNarrow.length === owedWide.length && sum(owedNarrow) === sum(owedWide)
          && unposted.every((r) => r.unpaid === null),
      'V115 what a document still owes is payments.ts answering, once',
      owedApart.length > 0 ? owedApart.join('; ')
        : discriminating === 0 ? 'every document is either untouched or fully settled — nothing to tell apart'
        : owedNarrow.length !== owedWide.length || sum(owedNarrow) !== sum(owedWide)
          ? `a two-day window sees ${owedNarrow.length} open documents (${formatMoney(sum(owedNarrow))});`
            + ` all time sees ${owedWide.length} (${formatMoney(sum(owedWide))}) — the debt moved with the range`
        : unposted.length === 0 ? 'no draft or void document reached the page'
        : `${docRows.length} documents agree with balanceOf (${discriminating} partly settled);`
          + ` ${unposted.length} unposted owe nothing`)

    const journals = await db.execute<{ id: string; entry_no: string; invoice_id: string | null }>(raw`
      SELECT je.id::text, je.entry_no, i.id::text AS invoice_id
        FROM journal_entry je LEFT JOIN invoice i ON i.entry_id = je.id
       WHERE je.ledger_id = ${co.ledger.id}::uuid`)
    const byEntry = new Map(journals.map(j => [j.id, j]))
    const byInvoice = new Map(journals.filter(j => j.invoice_id).map(j => [j.invoice_id, j]))
    const outRows = await partyLedger(co.ledger.id, 'out', '2000-01-01', '2099-12-31')
    const inspected = [...merged, ...outRows, ...narrow]
    const wrongJournal = inspected.filter(row => {
      if (row.state === 'draft' || row.state === 'void') return row.entry_id !== null || row.entry_no !== null
      const journal = row.href.kind === 'invoice' ? byInvoice.get(row.href.id) : byEntry.get(row.href.id)
      return !journal || row.entry_id !== journal.id || row.entry_no !== journal.entry_no
    })
    check(wrongJournal.length === 0 && inspected.some(row => row.kind === 'Payment')
      && inspected.some(row => row.href.kind === 'invoice' && row.entry_id && row.entry_id !== row.href.id)
      && inspected.some(row => row.state === 'draft')
      && outRows.some(row => row.note && row.entry_id),
      'V123 every browse record carries the real journal identity, including capital and carried debts',
      wrongJournal.length ? wrongJournal.map(row => row.key).join(', ')
        : `${inspected.length} rows checked independently against journal_entry/invoice; drafts have no entry`)

    // V113 — one rule, stated twice because it has to be. `documentNumber`
    //        decides what the invoice list prints; the browse decides the
    //        same thing inside a SQL aggregate, where TypeScript cannot be
    //        called. Hold every posted document in the fixture against both
    //        readers. Before this, the list preferred OUR number on both
    //        directions and the browse preferred theirs on purchases, so one
    //        bill was filed under two different numbers on two pages that
    //        render the same component (critic, 2026-09-03).
    const everyDoc = await invoicesFor(co.ledger.id)
    const browsedRefs = new Map<string, string | null>()
    for (const t of ['expense', 'revenue'] as const) {
      for (const r of await entriesByParty(co.ledger.id, t, '2000-01-01', '2099-12-31')) {
        browsedRefs.set(r.entry_id, r.doc_ref)
      }
    }
    const compared = everyDoc.filter((i) => i.entry_id && browsedRefs.has(i.entry_id))
    const disagreed = compared.filter((i) => browsedRefs.get(i.entry_id!) !== documentNumber(i))
    check(compared.length >= 3 && disagreed.length === 0,
      'V113 the list and the browse call a document by the same number',
      disagreed.length === 0
        ? `${compared.length} documents, both readers agree`
        : disagreed.slice(0, 3).map((i) =>
            `${i.direction} ${i.number ?? '—'}/${i.their_ref ?? '—'}: list says ${documentNumber(i) ?? 'null'}, browse says ${browsedRefs.get(i.entry_id!) ?? 'null'}`).join('; '))
  }

  // V117 — the supplier's own bill, filed with the invoice that raises the
  //         entry. Nothing under Invoices could take a file at all until now
  //         (owner, 2026-09-07); the panel existed on the journal entry
  //         screen only, and an invoice's entry is the same entry.
  {
    const f = new FormData()
    f.set(F.ledgerId, co.ledger.id); f.set(F.direction, 'purchase'); f.set(F.kind, 'invoice')
    f.set(F.partyId, supplier.id); f.set(F.controlAccountId, at('2000').id)
    f.set(F.issuedOn, '2026-04-11'); f.set(F.dueOn, '2026-05-11'); f.set(F.amounts, 'exclusive')
    f.set(F.theirRef, 'PAPER-1')
    f.set(lineAccount(0), at('5000').id); f.set(lineDescription(0), 'Consulting')
    f.set(lineAmount(0), '300.00')
    f.set(ATTACH_FIELD, new File([Buffer.from('%PDF-1.4 their bill')], 'scan0007.pdf', { type: 'application/pdf' }))
    const saved = await createInvoiceFromForm(f, (id) => id, 'alicio@example.test')
    const [inv] = await db.execute<{ entry_id: string | null }>(raw`
      SELECT entry_id::text FROM invoice WHERE ledger_id = ${co.ledger.id}::uuid AND their_ref = 'PAPER-1'`)
    const filed = inv?.entry_id ? await attachmentsOf(inv.entry_id) : []
    check(!!saved.ok && saved.ok.includes('filed against it') && filed.length === 1
      && filed[0].filename === '2026-04-11 300.00.pdf' && filed[0].uploaded === 'scan0007.pdf',
      'V117 a bill posted with its paper files it against the entry, renamed for the date and amount',
      `${saved.ok ?? saved.error}; ${filed.map((a) => a.filename).join(',') || 'nothing filed'}`)
  }

  // V118 — the line editor's column headings, and the one thing a heading
  //         row over a separate grid can get wrong: the two containers must
  //         resolve the SAME template, or every heading after the flexible
  //         column drifts by the width of the button cluster (critic,
  //         2026-09-07). Read from the rendered markup, so a template that
  //         drifts apart in one of the two places is visible.
  {
    const html = (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-invoice-lines.tsx', JSON.stringify({ rows: 2 }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    // Nested GST/PST fields have their own grid; compare the outer row grids.
    const templates = [...html.matchAll(/grid-cols-\[([^\]]+)\]/g)].map((m) => m[1]).filter(t => t.includes('minmax('))
    const headings = ['Account', 'Line description', 'Amount', 'Tax', 'GST', 'PST'].every((h) => html.includes(`>${h}<`))
    check(templates.length >= 3 && new Set(templates).size === 1 && !templates[0].includes('auto')
      && headings,
      'V118 the line editor has column headings, on the same template as its rows, with no auto track',
      `${templates.length} grid(s), ${new Set(templates).size} distinct template(s): ${templates[0]}; headings ${headings}`)

    // The owner removed normal explanatory copy. Check the actual credit-note
    // amounts instead: this form knows its direction and accepts actual taxes.
    const credit = await resolveTaggedLines(co.ledger.id, 'sales', 'credit_note', [{
      index: 0, typed: 10000n, taxCode: 'GST_PST', overrides: { gst: 475n, pst: 680n },
      line: { accountId: at('4000').id, amount: 10000n },
    }], false, '2026-04-11')
    check(!credit.error && credit.lines.find(l => l.generatedFor === 'GST')?.amount === 475n
      && credit.lines.find(l => l.generatedFor === 'PST')?.amount === 680n,
      'V122 credit-note tax lines preserve actual amounts and direction', 'GST 4.75; PST 6.80')
  }

  // V119 — the EDIT door files its paper too. The edit form is the same
  //         component as the create form, so it showed the same file box, and
  //         nothing read it: a person picked a file, was told the change
  //         saved, and the file was dropped without a word (critic).
  {
    const [made] = await db.execute<{ id: string; entry_id: string }>(raw`
      SELECT id::text, entry_id::text FROM invoice
       WHERE ledger_id = ${co.ledger.id}::uuid AND their_ref = 'PAPER-1'`)
    const e = new FormData()
    e.set(F.ledgerId, co.ledger.id); e.set(F.invoiceId, made.id)
    e.set(F.direction, 'purchase'); e.set(F.kind, 'invoice')
    e.set(F.partyId, supplier.id); e.set(F.controlAccountId, at('2000').id)
    e.set(F.issuedOn, '2026-04-11'); e.set(F.dueOn, '2026-05-11'); e.set(F.amounts, 'exclusive')
    e.set(F.theirRef, 'PAPER-1')
    e.set(lineAccount(0), at('5000').id); e.set(lineDescription(0), 'Consulting, corrected')
    e.set(lineAmount(0), '320.00')
    e.set(ATTACH_FIELD, new File([Buffer.from('%PDF-1.4 a second piece of paper')], 'the-corrected-bill.pdf',
                                 { type: 'application/pdf' }))
    const saved = await updateInvoiceFromForm(e, (id) => id, 'alicio@example.test')
    const filed = await attachmentsOf(made.entry_id)
    check(!!saved.ok && saved.ok.includes('filed against it') && filed.length === 2
      && filed.some((a) => a.uploaded === 'the-corrected-bill.pdf')
      // The entry moved to 320.00, so BOTH receipts are named for what it is now.
      && filed.every((a) => a.filename.startsWith('2026-04-11 320.00')),
      'V119 the edit door files its paper, and every receipt on the entry follows the edit',
      `${saved.ok ?? saved.error}; ${filed.map((a) => a.filename).join(', ')}`)
  }

  // V120 — THE ID BESIDE THE LEDGER. The invoice doors read the invoice id
  //        out of the form and judged only the ledger beside it, so a person
  //        with the Invoices seat on company A could post A's ledger with B's
  //        invoice id and delete, edit or post B's document (audit,
  //        2026-09-13). Each door now asks `ours()` first — the bank doors'
  //        sentence, at every one.
  {
    const theirs = await createCompany({ code: 'THEIRS', name: 'Somebody Else Ltd.' }, 'alicio@example.test')
    await createFiscalYear(theirs.ledger.id, '2026-12-31', 'alicio@example.test')
    const theirAccts = await importAccounts(theirs.company.id,
      parseAccountsCsv('code,name,type,parent,roles\n2000,Their payables,liability,,trade_payables\n5000,Their fees,expense,,professional_fees')
        .map((r) => ({ ...r, entityId: theirs.company.id })), 'alicio@example.test')
    const tid = Object.fromEntries(theirAccts.map((a) => [a.code, a.id]))
    const theirSupplier = await createParty({
      kind: 'organisation', name: 'Their Supplier Ltd.',
      roles: [{ entityId: theirs.company.id, role: 'supplier', heldFrom: '2026-01-01' }], actor: 'alicio@example.test',
    })
    const theirInv = await createInvoice({
      ledgerId: theirs.ledger.id, direction: 'purchase', partyId: theirSupplier.id,
      controlAccountId: tid['2000']!, issuedOn: '2026-03-05', dueOn: '2026-04-05',
      lines: [{ accountId: tid['5000']!, amount: 40000n }], actor: 'alicio@example.test',
    })
    const withA = (fields: Record<string, string>) => {
      const fd = new FormData()
      fd.set(F.ledgerId, co.ledger.id)          // company A's ledger, always
      for (const [k, v] of Object.entries(fields)) fd.set(k, v)
      return fd
    }
    const REFUSED = "not in this company's books"
    const cases: Array<[string, () => Promise<{ error?: string; ok?: string }>]> = [
      ['delete', () => deleteInvoiceFromForm(withA({ [F.invoiceId]: theirInv.id }), 'alicio@example.test')],
      ['post', () => postInvoiceFromForm(withA({ [F.invoiceId]: theirInv.id }), 'alicio@example.test')],
      ['edit', () => updateInvoiceFromForm(withA({ [F.invoiceId]: theirInv.id }), (id) => id, 'alicio@example.test')],
    ]
    const wrong: string[] = []
    for (const [label, fn] of cases) {
      const r = await fn()
      if (!r.error || !r.error.includes(REFUSED)) wrong.push(`${label}: ${r.error ?? r.ok ?? 'nothing said'}`)
    }
    const [still] = await db.execute<{ status: string; n: string }>(raw`
      SELECT status, (SELECT count(*) FROM invoice WHERE ledger_id = ${theirs.ledger.id}::uuid)::text AS n
        FROM invoice WHERE id = ${theirInv.id}::uuid`)
    check(wrong.length === 0 && still?.status === 'draft' && still?.n === '1',
      "V120 deleting, posting or editing another company's invoice under this ledger is refused before anything happens",
      wrong.length ? wrong.join('; ') : `three doors refused; their invoice still ${still?.status}, ${still?.n} in their books`)
  }

  await trailNamesPeople(check, 'V116 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main()

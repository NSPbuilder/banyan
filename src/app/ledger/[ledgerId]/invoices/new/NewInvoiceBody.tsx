import { FxCopyRefusal } from '../../fx/FxDetail'
import { PageHeader } from '@/components/PageHeader'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { createAccountAction, createBillAction, createInvoiceAction, createPartyAction } from '@/app/actions'
import { localToday } from '@/lib/today'
import type { Choice } from '@/lib/forms'
import { partyChoices } from '@/lib/parties'
import { readingById, readingLabel, rememberedAccount } from '@/lib/bill-reading'
import { invoiceInitialFrom, invoiceSideFor, rememberedLines, type InvoiceInitial } from '@/lib/prefill'
import { ReadingAside } from '@/components/ReadingAside'
import { NewInvoiceForm } from './NewInvoiceForm'
import { ledgerHead } from '@/lib/ledger-head'
import { invoiceDetail, type DocumentKind } from '@/lib/invoices'
import { invoiceEditorState } from '@/lib/invoice-editor'
import { ours } from '@/lib/ours'
import { invoiceTemplateChoices } from '@/lib/invoice-templates'
import { invoiceHref, type InvoiceDirection } from '@/lib/invoice-routes'

/**
 * Everything the invoice form needs to offer — parties by role as of today,
 * control accounts by role, every postable account, the tax-assist accounts.
 * ONE assembly, consumed by the create body and the edit body: two would
 * eventually offer two different worlds.
 */
export async function invoiceFormData(ledgerId: string) {
  const head = await ledgerHead(ledgerId)
  if (!head) return null

  // Who can be invoiced here is the party rule, asked once rather than
  // discovered when the database refuses the post. Today's date, because a
  // relationship that ended last month cannot explain an invoice issued now.
  const asOf = localToday()
  const accountsWith = async (role: 'trade_receivables' | 'trade_payables') =>
    (await db.execute<{ id: string; code: string; name: string }>(sql`
      SELECT a.id::text, a.code, a.name
        FROM account a JOIN account_role ar ON ar.account_id = a.id
       WHERE a.entity_id = ${head.entity_id}::uuid AND ar.role = ${role}
         AND a.is_postable AND a.is_active
       ORDER BY a.code`)).map((a): Choice => ({ id: a.id, label: `${a.code} — ${a.name}` }))

  const [{ customers, suppliers }, receivable, payable, lineAccounts, templateData] = await Promise.all([
    // The same two lists the quick forms offer, from the same place.
    partyChoices(head.entity_id, asOf),
    accountsWith('trade_receivables'),
    accountsWith('trade_payables'),
    db.execute<{ id: string; code: string; name: string }>(sql`
      SELECT a.id::text, a.code, a.name FROM account a
       WHERE a.entity_id = ${head.entity_id}::uuid AND a.is_postable AND a.is_active
       ORDER BY a.code`),
    invoiceTemplateChoices(head.entity_id),
  ])

  return {
    entity: head.entity,
    parties: { sales: customers, purchase: suppliers },
    controlAccounts: { sales: receivable, purchase: payable },
    lineAccounts: lineAccounts.map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` })),
    /** The same accounts with their codes, for a proposal to be mapped onto. */
    accounts: lineAccounts,
    today: asOf,
    templateData,
  }
}

/**
 * A new invoice, body only — the full page and the overlay both render exactly
 * this (the one-renderer rule applied to screens).
 */
export async function NewInvoiceBody({ ledgerId, readingId, direction = 'sales', copyId }: {
  ledgerId: string; readingId?: string
  copyId?: string
  direction?: InvoiceDirection
}) {
  const data = await invoiceFormData(ledgerId)
  if (!data) notFound()
  if (copyId && !(await ours('invoice', copyId, ledgerId))) notFound()
  const copy = copyId ? await invoiceDetail(copyId) : null
  if (copy && copy.invoice.direction !== direction) redirect(`${invoiceHref(ledgerId, copy.invoice.direction, 'new')}?copy=${copyId}`)
  if (copy?.invoice.fx_currency) return <FxCopyRefusal ledgerId={ledgerId} />
  const side = invoiceSideFor(copy?.invoice.direction ?? direction)

  // A reading (0064; a sentence alone since 0077), opening this form as a
  // purchase bill or a sales invoice filled in. The reading must be this
  // company's and not yet entered; otherwise the form opens blank and says why.
  // A party the reading names that the books do not have is said here, not made here.
  const reading = readingId ? await readingById(ledgerId, readingId) : null
  let start: InvoiceInitial | undefined
  let readingNote: string | null = null
  if (readingId) {
    if (!reading) readingNote = 'That reading is not in these books; the form opened blank.'
    else if (reading.used_entry_id !== null) readingNote = 'That reading has already been entered; the form opened blank.'
    else if (!reading.proposal) readingNote = `${readingLabel(reading)} could not be read; enter it by hand${reading.filename ? ' from the picture' : ''}.`
    else {
      const remembered = await rememberedAccount(
        ledgerId, reading.proposal.party, side.rememberedType, data.accounts.map((a) => a.id))
      start = invoiceInitialFrom(side.direction, reading.id, reading.proposal, data.accounts, data.today,
                                 data.parties[side.key], data.controlAccounts[side.key][0]?.id ?? '', remembered)
    }
  }
  if (copy) {
    const { invoice } = copy
    const kind = invoice.document_kind as DocumentKind
    start = {
      direction: invoice.direction,
      kind,
      header: {
        partyId: invoice.party_id,
        controlAccountId: invoice.control_account_id,
        issuedOn: invoice.issued_on,
        dueOn: invoice.due_on,
        number: '',
        theirRef: invoice.their_ref ?? '',
        note: invoice.note ?? '',
      },
      rows: invoiceEditorState(copy).rows.map((line) => ({
        accountId: line.account,
        description: line.description,
        amount: line.amount,
        taxCode: line.taxCode,
        fromMemory: false,
      })),
      readingId: '', unknownParty: null,
    }
  }

  return (
    <>
      <PageHeader title={copy ? direction === 'purchase' ? 'Copy bill' : 'Copy invoice' : direction === 'purchase' ? 'New bill' : 'New invoice'} context={data.entity} />
      {readingNote && (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {readingNote}
        </p>
      )}
      {reading && (start || readingNote?.startsWith(readingLabel(reading))) && (
        <ReadingAside ledgerId={ledgerId} reading={reading} />
      )}
      {start?.unknownParty && (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
           data-unknown-supplier>
          The reading names <strong>{start.unknownParty}</strong>, and no {side.role} of that
          name is in the books. <Link href={`/ledger/${ledgerId}/parties`} className="underline">Add the party</Link> with
          the {side.role} role first, then come back to this reading; or choose an existing
          {' '}{side.role} below.
        </p>
      )}
      {start && rememberedLines(start.rows).length > 0 && (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
           data-from-memory>
          The account on line {rememberedLines(start.rows).join(', ')} was not read off the document: it is where this
          party&apos;s money went last time. Check it before saving.
        </p>
      )}
      {start && data.controlAccounts[side.key].length === 0 && (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {side.key === 'sales'
            ? 'No account carries the trade-receivables role, so a sales invoice has nowhere to land. Give one that role in the chart of accounts, or enter this as income received now instead.'
            : 'No account carries the trade-payables role, so a bill has nowhere to land. Give one that role in the chart of accounts, or enter this as an expense paid now instead.'}
        </p>
      )}
      <NewInvoiceForm key={copyId ?? readingId ?? 'new'}
        ledgerId={ledgerId}
        parties={data.parties}
        controlAccounts={data.controlAccounts}
        lineAccounts={data.lineAccounts}
        today={data.today}
        templateData={data.templateData}
        action={direction === 'purchase' ? createBillAction : createInvoiceAction}
        documentDirection={direction}
        start={start}
        openWith={copy ? invoiceEditorState(copy) : undefined}
        newParty={{
          action: createPartyAction,
          hidden: { ledgerId, kind: 'organisation' },
        }}
        newAccount={{ action: createAccountAction, hidden: { ledgerId } }}
      />
    </>
  )
}

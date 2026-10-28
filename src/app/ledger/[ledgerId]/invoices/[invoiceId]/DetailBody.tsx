import { FxInvoiceDetail } from '../../fx/FxDetail'

import { PageHeader } from '@/components/PageHeader'

import {PortalInvite} from '@/components/PortalInvite'
import { SourcePapers,MigrationSources } from '@/components/SourcePapers'
import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { applyCreditAction, createAccountAction, deleteInvoiceAction, deletePaymentAction, payInvoiceAction, postInvoiceAction, unapplyAction } from '@/app/actions'
import { invoiceDetail } from '@/lib/invoices'
import { applicationsOn, balanceOf, openItemsFor, unappliedReceipts } from '@/lib/payments'
import { chequeActionsForEntries } from '@/lib/cheques'
import { formatMoney } from '@/lib/money'
import { localToday } from '@/lib/today'
import { InvoiceDetail } from './InvoiceDetail'
import { PaymentsPanel } from './PaymentsPanel'
import { Attachments } from '../../entries/[entryId]/Attachments'
import { requireUser } from '@/lib/gate'
import { refuseForLedger } from '@/lib/access'
import { moduleFinanceView } from '@/lib/module-extensions'
import { invoiceHref, type InvoiceDirection } from '@/lib/invoice-routes'
import {invoiceMailContacts} from '@/lib/invoice-mail-links'
import {invoiceEmailLink,incomeEmailPath} from '@/lib/workflow-links'

/**
 * One invoice, body only — everything but the page furniture around it.
 *
 * The FULL PAGE at `invoices/[invoiceId]` and the OVERLAY the intercepting
 * route floats over the list both render exactly this component. That is the
 * one-renderer rule applied to screens: if the two assembled their own data,
 * the modal and the deep link would eventually answer differently, and nothing
 * would look wrong from either side alone.
 */
export async function DetailBody({
  ledgerId, invoiceId, crumb, direction = 'sales',
}: {
  ledgerId: string
  invoiceId: string
  direction?: InvoiceDirection
  /**
   * The full page asks for a way back; the overlay does not, because the page
   * it floats over is already behind it. WHERE back is depends on the
   * document's direction — a bill belongs to money out — and this component
   * is the only one here that has loaded the invoice, so it is the only one
   * that can say without a second query (owner, 2026-09-03: the invoice list
   * these used to return to is gone).
   */
  crumb?: boolean
}) {
  const detail = await invoiceDetail(invoiceId)
  if (!detail || detail.invoice.ledger_id !== ledgerId) notFound()
  if (detail.invoice.direction !== direction) redirect(invoiceHref(ledgerId, detail.invoice.direction, invoiceId))
  if (detail.invoice.fx_currency) return <FxInvoiceDetail detail={detail} />
  const me=await requireUser()
  const sourceView = await moduleFinanceView({type:'invoice',id:invoiceId,ledgerId,entityId:detail.invoice.entity_id,user:me})
  const managed = sourceView.managed
  const sourceHref = sourceView.editTarget?.accessible ? sourceView.editTarget.href : undefined

  // The entry's number, read from the ledger rather than kept here. A void
  // invoice has released its claim, so there is nothing to show.
  const [entry] = detail.invoice.entry_id
    ? await db.execute<{ entry_no: string | null; status: string }>(sql`
        SELECT entry_no, status FROM journal_entry
         WHERE id = ${detail.invoice.entry_id}::uuid`)
    : [{ entry_no: null, status: '' }]

  const { invoice } = detail
  const mailAllowed=!(await refuseForLedger(me,ledgerId,'/automation'))&&!(await refuseForLedger(me,ledgerId,'/invoices'))
  const mailRecords=mailAllowed?await db.execute<{id:string;status:string;created_at:string}>(sql`SELECT id::text,status,created_at::text FROM email_message WHERE ledger_id=${ledgerId}::uuid AND invoice_id=${invoiceId}::uuid ORDER BY created_at DESC LIMIT 10`):[]
  const label = invoice.number ?? invoice.their_ref ?? 'Unnumbered'
  const contacts=mailAllowed&&invoice.direction==='sales'?await invoiceMailContacts(ledgerId):null
  const emailAction=contacts?invoiceEmailLink(ledgerId,invoiceId,invoice.party_id,contacts[invoice.party_id],invoice.status):null

  // The payments picture, only for a document that IS a debt (or a credit).
  // Everything below is derived per render; nothing on this page is cached.
  const paymentsData = invoice.status === 'posted'
    ? await (async () => {
        const [item, applications, open] = await Promise.all([
          balanceOf(invoice.id),
          applicationsOn(invoice.id),
          openItemsFor(ledgerId),
        ])
        const bankAccounts = await db.execute<{ id: string; code: string; name: string }>(sql`
          SELECT a.id::text, a.code, a.name
            FROM account a
            JOIN account_role ar ON ar.account_id = a.id
           WHERE ar.role = 'cash_and_cash_equivalents'
             AND a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
             AND a.is_postable AND a.is_active
           ORDER BY a.code`)
        // What this credit note could settle: open INVOICES of the same
        // direction and party — its own kind excluded, itself excluded.
        const openInvoices = open
          .filter((i) => i.document_kind === 'invoice'
                      && i.direction === invoice.direction
                      && i.party_id === invoice.party_id)
          .map((i) => ({
            id: i.invoice_id,
            label: `${i.number ?? 'unnumbered'} — ${formatMoney(i.balance)} open`,
          }))
        // What could settle THIS invoice without new money: the party's open
        // credit notes, and receipts recorded against no invoice. Both were
        // applicable by the library and offered by no screen (2026-09-13).
        const credits = invoice.document_kind === 'invoice'
          ? [
              ...open
                .filter((i) => !managed && i.document_kind === 'credit_note'
                            && i.direction === invoice.direction
                            && i.party_id === invoice.party_id)
                .map((i) => ({ id: i.entry_id, label: `Credit note ${i.number ?? 'unnumbered'} — ${formatMoney(i.balance)} left` })),
              ...(await unappliedReceipts(ledgerId, invoice.party_id, invoice.direction as 'sales' | 'purchase'))
                .map((r) => ({ id: r.entry_id, label: `Receipt ${r.entry_no ?? ''} ${r.entry_date} — ${formatMoney(r.unapplied)} unapplied` })),
            ]
          : []
        return { item, applications, bankAccounts, openInvoices, credits }
      })()
    : null
  const paymentCheques = invoice.direction === 'purchase' && paymentsData
    ? await chequeActionsForEntries(ledgerId, paymentsData.applications
        .filter((a) => a.source_type === 'payment').map((a) => a.entry_id))
    : {}

  const back = { href: invoiceHref(ledgerId, invoice.direction), label: invoice.direction === 'purchase' ? 'Supplier bills' : 'Invoices' }

  return (
    <>
      {crumb && (
        <Link href={back.href} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to {back.label}</ToolAction></Link>
      )}
      <PageHeader title={label} context={invoice.direction === 'sales' ? 'Sales invoice' : 'Purchase bill'}>
        {emailAction&&typeof emailAction==='object'&&<Link href={emailAction.href} className={TOOL_BUTTON}>{emailAction.text}</Link>}
        <Link href={`${invoiceHref(ledgerId, invoice.direction, 'new')}?copy=${invoiceId}`}
              className={TOOL_BUTTON}>
          Copy
        </Link>
        {invoice.status === 'posted' && invoice.direction === 'sales' && (<a href={`/ledger/${ledgerId}/invoices/${invoiceId}/pdf`} target="_blank"
               className={TOOL_BUTTON} title="Download PDF"><ToolAction kind="pdf">PDF</ToolAction></a>)}
      </PageHeader>
      <p className="mt-1 text-sm text-neutral-500">
        {invoice.party_name} · issued {invoice.issued_on} · due {invoice.due_on} ·
        lands in {invoice.control_code}
      </p>

      {sourceView.panels}

      <InvoiceDetail
        ledgerId={ledgerId}
        invoiceId={invoice.id}
        version={invoice.version}
        direction={invoice.direction}
        kind={invoice.document_kind as 'invoice' | 'credit_note'}
        status={invoice.status}
        entryNo={entry?.entry_no ?? null}
        entryId={invoice.entry_id}
        lines={detail.lines}
        total={detail.total}
        actions={{ post: postInvoiceAction, delete: deleteInvoiceAction }}
        managed={managed} sourceHref={sourceHref} sourceLabel={sourceView.editTarget?.label}
      />

      {paymentsData && (
        <PaymentsPanel
          newAccount={createAccountAction}
          ledgerId={ledgerId}
          invoiceId={invoice.id}
          kind={invoice.document_kind as 'invoice' | 'credit_note'}
          chequeEligible={invoice.direction === 'purchase' && invoice.document_kind === 'invoice'}
          chequeActions={paymentCheques}
          balance={paymentsData.item.balance}
          applied={paymentsData.item.applied}
          debt={paymentsData.item.debt}
          today={localToday()}
          applications={paymentsData.applications.map((a) => ({
            id: a.id, entry_id: a.entry_id, entry_no: a.entry_no, entry_date: a.entry_date,
            description: a.description, amount: BigInt(a.amount), source_type: a.source_type,
            bank_account_id: a.bank_account_id,
          }))}
          bankAccounts={paymentsData.bankAccounts.map((b) => ({
            id: b.id, label: `${b.code} — ${b.name}`,
          }))}
          openInvoices={paymentsData.openInvoices}
          credits={paymentsData.credits}
          entryId={invoice.entry_id}
          actions={{ pay: payInvoiceAction, apply: applyCreditAction, unapply: unapplyAction,
                     deletePayment: deletePaymentAction }}
        />
      )}

      {/* The supplier's own bill, or the copy of ours that was sent. Nothing
          under Invoices could take a file until now (owner, 2026-09-07): the
          panel existed, on the journal entry screen only, and an invoice's
          entry is the same entry. A document that is not posted yet has no
          entry to hang paper on, and says so rather than offering a control
          that would do nothing. */}
      {invoice.entry_id
        ? <Attachments ledgerId={ledgerId} entryId={invoice.entry_id} />
        : (
          null
        )}
      <SourcePapers ledgerId={ledgerId} type="invoice" id={invoiceId}/>
      {mailAllowed&&invoice.direction==='sales'&&<section className="mt-6 border-t border-line pt-4"><h2 className="mb-2 font-medium">Customer email</h2>{invoice.status==='draft'?<p className="text-sm text-ink-muted">Post this invoice before emailing it.</p>:invoice.status==='posted'&&!contacts?.[invoice.party_id]?<p className="text-sm">Add a primary customer email in Parties before previewing or sending this invoice.</p>:null}<ul className="mt-3 space-y-2 text-sm">{mailRecords.map(m=><li key={m.id}><Link className="underline" href={incomeEmailPath(ledgerId,m.id)}>{m.created_at.slice(0,10)} · {m.status.replaceAll('_',' ')}</Link></li>)}</ul></section>}
      <MigrationSources ledgerId={ledgerId} type="invoice" id={invoiceId}/>
      {invoice.status==='posted'&&invoice.direction==='sales'&&invoice.document_kind==='invoice'&&invoice.version&&<PortalInvite ledgerId={ledgerId} invoiceId={invoice.id} version={invoice.version}/>}
    </>
  )
}

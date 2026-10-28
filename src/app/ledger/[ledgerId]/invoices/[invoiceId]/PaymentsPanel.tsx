'use client'

import { DataTable } from '@/components/Table'

import { ActionForm, type FormAction } from '@/components/ActionForm'
import Link from 'next/link'
import { PAYMENT_FIELDS as F } from '@/lib/forms'
import { formatMoney, moneyInput } from '@/lib/money'
import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import { BUTTON, FIELD, QUIET } from '@/lib/ui'
import { Floating } from '@/components/Floating'
import { ReceiptLinks } from '@/components/ReceiptLinks'

export type Choice = { id: string; label: string }

export type ApplicationRow = {
  id: string
  entry_no: string
  entry_id: string
  /** 'payment' rows can be deleted whole; a credit note's application only unapplies. */
  source_type: string
  entry_date: string
  description: string | null
  amount: bigint
  bank_account_id?: string | null
}

/**
 * What has been paid against one document, and the door for paying more.
 *
 * Everything shown here is derived: the balance is the ledger's figure minus
 * the applications, computed on the server per render. This panel holds no
 * state of its own — like `InvoiceLines`, that is what lets a check call it as
 * a plain function and read what its forms would POST.
 */
export function PaymentsPanel({
  ledgerId, invoiceId, kind, chequeEligible = false, balance, applied, debt, today,
  applications, bankAccounts, openInvoices, credits = [], entryId, chequeActions = {},
  actions, newAccount,
}: {
  ledgerId: string
  invoiceId: string
  kind: 'invoice' | 'credit_note'
  chequeEligible?: boolean
  chequeActions?: Record<string, string | null>
  balance: bigint
  applied: bigint
  debt: bigint
  today: string
  applications: ApplicationRow[]
  bankAccounts: Choice[]
  /** For a credit note: the still-open invoices it could settle. */
  openInvoices: Choice[]
  /** For an invoice: the party's open credit notes and unapplied receipts, by ENTRY id. */
  credits?: Choice[]
  /** For a credit note: its own entry, the thing that does the settling. */
  entryId: string | null
  actions: { pay: FormAction; apply: FormAction; unapply: FormAction; deletePayment: FormAction }
  /**
   * The door that makes a bank account, so the first payment out of a new
   * account does not send the person to the chart and back (owner,
   * 2026-09-07). A prop, like every action on this screen.
   */
  newAccount?: FormAction
}) {
  return (
    <section className="mt-10" data-payments-panel={invoiceId}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
        {kind === 'credit_note' ? 'Where this note has gone' : 'Payments'}
      </h2>

      <p className="mt-2 text-sm">
        <span className="font-mono tabular-nums">{formatMoney(debt)}</span>
        <span className="text-neutral-500"> total · </span>
        <span className="font-mono tabular-nums">{formatMoney(applied)}</span>
        <span className="text-neutral-500"> {kind === 'credit_note' ? 'used' : 'settled'} · </span>
        <span className="font-mono tabular-nums font-semibold" data-balance-due={balance.toString()}>
          {formatMoney(balance)}
        </span>
        <span className="text-neutral-500"> {kind === 'credit_note' ? 'left to apply' : 'still owed'}</span>
      </p>

      {applications.length > 0 && (
        <DataTable density="reading" className="mt-4 w-full text-sm">
          <tbody>
            <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <td className="py-1">Entry</td>
              <td className="py-1">Date</td>
              <td className="py-1">What</td>
              <td className="py-1 text-right">Amount</td>
              <td className="py-1" />
            </tr>
            {applications.map((a) => (
              <tr key={a.id} className="border-b border-neutral-200 last:border-0 dark:border-neutral-800">
                <td className="py-2 font-mono text-xs">{a.entry_no}</td>
                <td className="py-2 text-neutral-600 dark:text-neutral-400">{a.entry_date}</td>
                <td className="py-2 text-neutral-600 dark:text-neutral-400">{a.description}</td>
                <td className="py-2 text-right font-mono tabular-nums">{formatMoney(a.amount)}</td>
                <td className="py-2 pl-3 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    {kind === 'invoice' && a.source_type === 'payment' && !!a.bank_account_id && <ReceiptLinks href={`/ledger/${ledgerId}/invoices/${invoiceId}/payments/${a.entry_id}/receipt`} />}
                    {a.source_type === 'payment' && openInvoices.length > 0 && (
                      <Floating label="Copy" title={`Copy payment ${a.entry_no}`} buttonClassName={QUIET}>
                        <p className="mt-1 text-xs text-neutral-500">Choose an open invoice and review the amount before saving.</p>
                        <ActionForm action={actions.pay} submit="Record copied payment" working="Recording…"
                                    className="mt-4 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
                          <input type="hidden" name={F.ledgerId} value={ledgerId} />
                          <label className="flex flex-col gap-1 text-xs text-neutral-500">Invoice
                            <Picker name={F.invoiceId} required defaultValue={openInvoices.some((i) => i.id === invoiceId) ? invoiceId : openInvoices[0].id}
                                    options={openInvoices} ariaLabel="Invoice for copied payment" />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-neutral-500">Paid on
                            <DateInput name={F.paidOn} required defaultValue={a.entry_date} className={FIELD} />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-neutral-500">Bank account
                            <Picker name={F.bankAccountId} required defaultValue={a.bank_account_id ?? ''}
                                    options={bankAccounts} ariaLabel="Bank account for copied payment" />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-neutral-500">Amount
                            <input name={F.amount} required inputMode="decimal"
                                   defaultValue={moneyInput(a.amount)} className={`${FIELD} w-28`} />
                          </label>
                          <label className="flex flex-col gap-1 text-xs text-neutral-500">Reference
                            <input name={F.reference} className={FIELD} />
                          </label>
                        </ActionForm>
                      </Floating>
                    )}
                    <ActionForm action={actions.unapply} submit="Unapply" working="…"
                                buttonClassName={QUIET}>
                      <input type="hidden" name={F.ledgerId} value={ledgerId} />
                      <input type="hidden" name={F.applicationId} value={a.id} />
                    </ActionForm>
                    {a.source_type === 'payment' && chequeEligible && Object.hasOwn(chequeActions, a.entry_id) && (
                      <Link href={chequeActions[a.entry_id]
                              ? `/ledger/${ledgerId}/cheques/${chequeActions[a.entry_id]}`
                              : `/ledger/${ledgerId}/cheques/new?entry=${a.entry_id}`}
                            className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
                        {chequeActions[a.entry_id] ? 'Open cheque' : 'Make cheque'}
                      </Link>
                    )}
                    {a.source_type === 'payment' && (
                      <ActionForm action={actions.deletePayment} submit="Delete payment" working="…"
                                  buttonClassName="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50">
                        <input type="hidden" name={F.ledgerId} value={ledgerId} />
                        <input type="hidden" name={F.entryId} value={a.entry_id} />
                      </ActionForm>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {kind === 'invoice' && balance > 0n && (
        <ActionForm action={actions.pay} submit="Record payment" working="Recording…"
                    className="mt-5 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
          <input type="hidden" name={F.ledgerId} value={ledgerId} />
          <input type="hidden" name={F.invoiceId} value={invoiceId} />
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Paid on
            <DateInput name={F.paidOn} defaultValue={today} required className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Bank account
            <Picker name={F.bankAccountId} required options={bankAccounts}
                    ariaLabel="Bank account"
                    create={newAccount ? {
                      title: 'New bank account',
                      action: newAccount,
                      hidden: {
                        ledgerId,
                        accountType: 'asset',
                        role_classification: 'cash_and_cash_equivalents',
                      },
                      fields: [
                        { name: 'code', label: 'Code', width: '6rem' },
                        { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
                      ],

                    } : undefined} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Amount
            <input name={F.amount} inputMode="decimal"
                   required className={`${FIELD} w-28 text-right font-mono`} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Reference
            <input name={F.reference} className={FIELD} />
          </label>
        </ActionForm>
      )}

      {kind === 'invoice' && balance > 0n && credits.length > 0 && (
        <ActionForm action={actions.apply} submit="Apply" working="Applying…"
                    className="mt-3 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
          <input type="hidden" name={F.ledgerId} value={ledgerId} />
          <input type="hidden" name={F.invoiceId} value={invoiceId} />
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Apply an existing credit note or receipt
            <Picker name={F.entryId} required options={credits}
                    ariaLabel="Credit note or receipt" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Amount
            <input name={F.amount} inputMode="decimal"
                   required className={`${FIELD} w-28 text-right font-mono`} />
          </label>
        </ActionForm>
      )}

      {kind === 'credit_note' && balance > 0n && openInvoices.length > 0 && (
        <ActionForm action={actions.apply} submit="Apply to invoice" working="Applying…"
                    className="mt-5 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
          <input type="hidden" name={F.ledgerId} value={ledgerId} />
          {/* The ENTRY does the settling. The first draft of this form had the
              comment saying so and no field carrying it — a form that would
              have POSTed nothing to settle with. */}
          <input type="hidden" name={F.entryId} value={entryId ?? ''} />
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Against
            <Picker name={F.invoiceId} required options={openInvoices}
                    ariaLabel="Open invoice" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Amount
            <input name={F.amount} inputMode="decimal"
                   required className={`${FIELD} w-28 text-right font-mono`} />
          </label>
        </ActionForm>
      )}
    </section>
  )
}
